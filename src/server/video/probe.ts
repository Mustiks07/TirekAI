import { spawn } from "node:child_process";
import { processVideo, type RunSummary } from "./processor";

// T057 source check before an enterprise camera is used: what the stream is (codec, size, frame
// rate), whether this device can decode and process it fast enough, how long the first frame
// takes and how quickly processing stops. Credentials and ffmpeg/ffprobe messages (which can
// echo the URL) never reach the report; failures are reduced to a code.
export function redactSource(source: string) {
  try {
    const u = new URL(source);
    if (!/^(rtsps?|https?|rtmps?|srt|udp|rtp):$/.test(u.protocol))
      return "[local source]";
    if (u.username || u.password) {
      u.username = "***";
      u.password = "";
    }
    u.search = u.search ? "?***" : "";
    return u.toString();
  } catch {
    return "[local source]";
  }
}
export type ProbeError =
  | "unauthorized"
  | "not_found"
  | "connection_refused"
  | "timeout"
  | "no_video_stream"
  | "probe_failed";
const classify = (stderr: string): ProbeError =>
  /401|unauthori[sz]ed/i.test(stderr)
    ? "unauthorized"
    : /404|not found|no such file/i.test(stderr)
      ? "not_found"
      : /refused/i.test(stderr)
        ? "connection_refused"
        : /timed? ?out/i.test(stderr)
          ? "timeout"
          : "probe_failed";
export type Passport = {
  codec: string;
  width: number;
  height: number;
  fps: number | null;
};
export function probeSource(
  input: string[],
  o: { timeoutMs?: number; ffprobe?: string } = {},
) {
  const started = Date.now();
  return new Promise<
    | { ok: true; passport: Passport; probeMs: number }
    | { ok: false; error: ProbeError; probeMs: number }
  >((resolve) => {
    const p = spawn(
      o.ffprobe ?? process.env.FFPROBE_PATH ?? "ffprobe",
      [
        "-v",
        "error",
        ...input,
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,width,height,avg_frame_rate,r_frame_rate",
        "-of",
        "json",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let out = "",
      err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), o.timeoutMs ?? 15_000);
    const done = (r: Parameters<typeof resolve>[0]) => {
      clearTimeout(timer);
      resolve(r);
    };
    p.on("error", () =>
      done({ ok: false, error: "probe_failed", probeMs: Date.now() - started }),
    );
    p.on("close", (code, signal) => {
      const probeMs = Date.now() - started;
      if (signal === "SIGKILL")
        return done({ ok: false, error: "timeout", probeMs });
      if (code !== 0) return done({ ok: false, error: classify(err), probeMs });
      try {
        const s = JSON.parse(out).streams?.[0];
        if (!s?.codec_name)
          return done({ ok: false, error: "no_video_stream", probeMs });
        const rate = (r: string | undefined) => {
          const [n, d] = String(r ?? "0/0")
            .split("/")
            .map(Number);
          return d && n ? Math.round((n / d) * 100) / 100 : null;
        };
        done({
          ok: true,
          passport: {
            codec: s.codec_name,
            width: s.width,
            height: s.height,
            fps: rate(s.avg_frame_rate) ?? rate(s.r_frame_rate),
          },
          probeMs,
        });
      } catch {
        done({ ok: false, error: "probe_failed", probeMs });
      }
    });
  });
}
// Processes the source for a fixed time without zones (decoding and the CV pipeline only) and
// then stops it, measuring time to first frame and stop time. Nothing is sent or stored.
export async function streamTrial(o: {
  input: string[];
  seconds: number;
  live: boolean;
  fps?: number;
  ffmpeg?: string;
}) {
  const controller = new AbortController();
  const started = Date.now();
  let firstFrameMs: number | null = null,
    stopRequested: number | null = null;
  const timer = setTimeout(() => {
    stopRequested = Date.now();
    controller.abort();
  }, o.seconds * 1000);
  const summary: RunSummary = await processVideo({
    input: o.input,
    config: { version: 0, lines: [], zones: [] },
    startTime: new Date(),
    live: o.live,
    fps: o.fps,
    ffmpeg: o.ffmpeg,
    signal: controller.signal,
    aggregateSeconds: 1,
    onEvents: async () => {},
    onFirstFrame: () => (firstFrameMs = Date.now() - started),
  });
  clearTimeout(timer);
  const wallSeconds = (Date.now() - started) / 1000;
  return {
    ended: summary.ended,
    frames: summary.frames,
    unusable: summary.unusable,
    // Frames delivered per wall-clock second vs. the target: below target = source or device too slow.
    deliveredFps: Math.round((summary.frames / wallSeconds) * 100) / 100,
    targetFps: summary.targetFps,
    processingFps: Math.round(summary.fps),
    processingMsPerFrame: Math.round(summary.latencyMs * 100) / 100,
    firstFrameWithinMs: firstFrameMs,
    stopMs: stopRequested === null ? null : Date.now() - stopRequested,
    hardware: summary.hardware,
  };
}
