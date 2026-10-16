import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../../domain/errors";
import {
  reviewTranscript,
  type RecognizedWord,
} from "../../domain/speech-review";
import type { SpeechProvider, Transcription } from "./speech";

// T056 local speech adapter. Whisper runs in a separate long-lived process on this machine
// (scripts/speech-worker.mjs), so the web server's event loop stays free and the ~1 GB model is
// loaded once. Requests are processed one at a time; at most two wait. Audio never leaves the
// machine and is not stored. Only 16 kHz-capable WAV is accepted: the browser converts its
// recording before upload, so no audio codec is needed on the server.
type Answer = {
  id?: string | null;
  ready?: boolean;
  error?: string;
  words?: RecognizedWord[];
  seconds?: number;
  ms?: number;
};
export class LocalWhisperSpeech implements SpeechProvider {
  readonly name = "local-whisper";
  // A minute of audio takes about a minute on a 4-core CPU; the first request also loads the model.
  readonly timeoutMs = 150_000;
  // Upper bound for loading the model (≈30 s on 4 cores; slow disks take longer).
  loadTimeoutMs = 300_000;
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private waiting = new Map<string, (a: Answer) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private idle: NodeJS.Timeout | null = null;
  constructor(
    readonly model = process.env.SPEECH_MODEL ||
      "onnx-community/whisper-large-v3-turbo",
    // SPEECH_WORKER_SCRIPT exists for browser tests (a protocol test double); not for production.
    private readonly script = process.env.SPEECH_WORKER_SCRIPT ||
      resolve(process.cwd(), "scripts/speech-worker.mjs"),
  ) {}
  // Starts the process ahead of the first request (e.g. when the assistant page opens).
  warm() {
    if (this.ready) return this.ready;
    const child = spawn(process.execPath, [this.script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        SPEECH_MODEL: this.model,
        SPEECH_DTYPE: process.env.SPEECH_DTYPE || "q8",
        // Relative paths resolve against the same working directory as the server.
        SPEECH_MODEL_DIR: process.env.SPEECH_MODEL_DIR || ".data/models",
        SPEECH_ALLOW_DOWNLOAD: "0",
      },
    });
    this.child = child;
    // A process that died between requests must not crash the server on the next write.
    child.stdin!.on("error", () => {});
    this.ready = new Promise<void>((ok, fail) => {
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", (line) => {
        let a: Answer;
        try {
          a = JSON.parse(line);
        } catch {
          return;
        }
        if (a.ready === true) ok();
        else if (a.ready === false && a.error)
          fail(new AppError("VOICE_MODEL_MISSING", 503));
        else if (a.id && this.waiting.has(a.id)) {
          this.waiting.get(a.id)!(a);
          this.waiting.delete(a.id);
        }
      });
      child.on("exit", () => {
        fail(new AppError("VOICE_UNAVAILABLE", 503));
        // A replacement process may already be running; only this process is forgotten.
        if (this.child !== child) return;
        for (const done of this.waiting.values())
          done({ error: "VOICE_UNAVAILABLE" });
        this.waiting.clear();
        this.child = null;
        this.ready = null;
      });
    });
    const ready = this.ready;
    // A load that never finishes (stuck disk, out of memory) is ended, so the next request
    // starts a fresh process instead of waiting on a dead one.
    const loading = setTimeout(() => {
      if (this.child === child) this.stop();
    }, this.loadTimeoutMs);
    loading.unref();
    ready.then(
      () => clearTimeout(loading),
      () => clearTimeout(loading),
    );
    // A failed start (e.g. the model is not downloaded yet) is retried by the next request.
    ready.catch(() => {
      if (this.ready === ready) this.stop();
    });
    return ready;
  }
  stop() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    child?.kill();
  }
  async transcribe(r: {
    audio: Buffer;
    mime: string;
    locale: "ru" | "kk";
    signal: AbortSignal;
  }): Promise<Transcription> {
    if (r.mime !== "audio/wav") throw new AppError("VOICE_FORMAT", 415);
    if (this.pending >= 3) throw new AppError("VOICE_BUSY", 429);
    this.pending++;
    try {
      const run = this.queue.then(() => this.once(r));
      this.queue = run.catch(() => {});
      return await run;
    } finally {
      this.pending--;
    }
  }
  private async once(r: {
    audio: Buffer;
    locale: "ru" | "kk";
    signal: AbortSignal;
  }): Promise<Transcription> {
    if (r.signal.aborted) throw new AppError("VOICE_TIMEOUT", 504);
    if (this.idle) clearTimeout(this.idle);
    // The request's deadline also applies while the model is loading. The load itself goes on
    // (the next recording benefits) and is unloaded later if nobody uses it.
    let stopWaiting = () => {};
    const deadline = new Promise<never>((_, fail) => {
      const abort = () => fail(new AppError("VOICE_TIMEOUT", 504));
      r.signal.addEventListener("abort", abort, { once: true });
      stopWaiting = () => r.signal.removeEventListener("abort", abort);
    });
    try {
      await Promise.race([this.warm(), deadline]);
    } catch (error) {
      this.idle = setTimeout(() => this.stop(), 15 * 60_000);
      this.idle.unref();
      throw error;
    } finally {
      stopWaiting();
    }
    const id = randomUUID();
    const answer = await new Promise<Answer>((resolveAnswer) => {
      // The deadline listener lives only as long as this request.
      const done = (a: Answer) => {
        r.signal.removeEventListener("abort", abort);
        resolveAnswer(a);
      };
      this.waiting.set(id, done);
      const abort = () => {
        // The model cannot be interrupted mid-generation: restart the process instead.
        this.waiting.delete(id);
        this.stop();
        done({ error: "VOICE_TIMEOUT" });
      };
      // The deadline may have passed while the process was starting: nothing was sent yet.
      if (r.signal.aborted) {
        this.waiting.delete(id);
        return done({ error: "VOICE_TIMEOUT" });
      }
      r.signal.addEventListener("abort", abort, { once: true });
      this.child!.stdin!.write(
        JSON.stringify({
          id,
          locale: r.locale,
          wav: r.audio.toString("base64"),
        }) + "\n",
      );
    });
    // An idle model frees its memory after 15 minutes; the next request loads it again.
    this.idle = setTimeout(() => this.stop(), 15 * 60_000);
    this.idle.unref();
    if (answer.error) {
      const status =
        answer.error === "VOICE_FORMAT"
          ? 415
          : answer.error === "VOICE_EMPTY"
            ? 422
            : answer.error === "VOICE_TIMEOUT"
              ? 504
              : 503;
      throw new AppError(answer.error, status);
    }
    const review = reviewTranscript(answer.words ?? [], r.locale);
    if (!review.text) throw new AppError("VOICE_EMPTY", 422);
    return {
      text: review.text,
      locale: r.locale,
      confidence: review.confidence,
      uncertain: review.uncertain,
    };
  }
}
let shared: LocalWhisperSpeech | null = null;
export function localSpeech() {
  shared ??= new LocalWhisperSpeech();
  return shared;
}
