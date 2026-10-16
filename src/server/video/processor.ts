import { spawn } from "node:child_process";
import os from "node:os";
import type { Point } from "./cv";

// T035–T038 processor. Runs as its own process (scripts/video-processor.ts), never inside a
// browser tab or the web request path. ffmpeg decodes the source to small grayscale frames in
// memory; no frame is written to disk and only aggregated events leave the process.
import { PROCESSOR_VERSION, DETECTOR_VERSIONS } from "./versions";
import type { PersonDetector } from "./detector";
import {
  FrameAnalyzer,
  grayFromRgb,
  type Diagnosis,
  type FrameReport,
} from "./analyzer";
export { PROCESSOR_VERSION, DETECTOR_VERSIONS } from "./versions";
export type VideoLine = {
  id: string;
  name: string;
  a: Point;
  b: Point;
  inSide: 1 | -1;
};
export type VideoZone = {
  id: string;
  name: string;
  polygon: Point[];
  kind: "presence" | "queue" | "shelf" | "workstation";
  queueMin?: number;
  queueSeconds?: number;
};
export type VideoConfig = {
  version: number;
  lines: VideoLine[];
  zones: VideoZone[];
};
export type VideoEvent = {
  seq: number;
  kind:
    | "line_cross"
    | "zone_count"
    | "dwell"
    | "queue_start"
    | "queue_end"
    | "gap"
    | "signal_lost"
    | "shelf_change_suspected"
    | "workstation_state";
  at: string;
  line?: string;
  zone?: string;
  direction?: "in" | "out";
  value?: number;
  until?: string;
  reason?: string;
};
export type Heartbeat = {
  frames: number;
  unusable: number;
  // Processing capacity: frames per second of processing time (what the device could do).
  fps: number;
  // Frames actually received per wall-clock second since the run started (≤ target fps).
  inputFps: number;
  latencyMs: number;
  sourceTime: string;
  // People counted on the latest analyzed frame and when (live screen, never an average).
  now?: {
    at: string;
    visible: number;
    zones: Record<string, number>;
    crossings: Record<string, { in: number; out: number }>;
  } | null;
  diagnosis?: Diagnosis;
};
export type RunSummary = Heartbeat & {
  processor: string;
  detectors: typeof DETECTOR_VERSIONS;
  width: number;
  height: number;
  targetFps: number;
  hardware: { cpu: string; cores: number; platform: string };
  ended: "end_of_stream" | "aborted" | "signal_lost" | "decoder_error";
  events: number;
  // Which people pipeline produced the counts (T057).
  people: {
    mode: "neural" | "motion";
    detector: string | null;
    tracker: "bytetrack" | "nearest";
  };
};
export type FrameImage = {
  data: Uint8Array;
  width: number;
  height: number;
  format: "rgb24" | "gray";
};
export async function processVideo(o: {
  input: string[];
  config: VideoConfig;
  startTime: Date;
  live: boolean;
  width?: number;
  height?: number;
  fps?: number;
  minArea?: number;
  aggregateSeconds?: number;
  onEvents: (events: VideoEvent[]) => Promise<void>;
  onHeartbeat?: (h: Heartbeat) => Promise<void>;
  onFirstFrame?: () => void;
  // Every analyzed frame with what was found on it and the image the analysis saw (neural: the
  // detector's RGB input, stretched; motion: the small grayscale frame). Used for the live view;
  // never stored here.
  onFrame?: (report: FrameReport, image: FrameImage) => void;
  signal?: AbortSignal;
  ffmpeg?: string;
  // T057: people come from a neural detector + ByteTrack instead of moving blobs. Without it the
  // classical motion pipeline runs, and the summary says which one did — never switched silently.
  detector?: PersonDetector;
}): Promise<RunSummary> {
  const fps = o.fps ?? 10,
    a = new FrameAnalyzer({
      config: o.config,
      startTime: o.startTime,
      live: o.live,
      neural: !!o.detector,
      width: o.width,
      height: o.height,
      fps,
      minArea: o.minArea,
      aggregateSeconds: o.aggregateSeconds,
    }),
    w = a.w,
    h = a.h,
    size = w * h;
  const started = Date.now();
  let busyMs = 0,
    pending: Promise<void> = Promise.resolve(),
    sent = 0,
    last: FrameReport | null = null;
  let stop = () => {};
  const flush = () => {
    const batch = a.take();
    if (!batch.length) return;
    sent += batch.length;
    pending = pending.then(() => o.onEvents(batch));
    // A refused delivery (e.g. revoked device token) stops ffmpeg and is raised at the end.
    pending.catch(() => stop());
  };
  const analyze = (
    gray: Uint8Array,
    image: FrameImage,
    people: Parameters<FrameAnalyzer["step"]>[1],
  ) => {
    const t = performance.now();
    if (a.frames === 0) o.onFirstFrame?.();
    const report = a.step(gray, people);
    if (report.usable) last = report;
    if (a.aggregateDue) flush();
    busyMs += performance.now() - t;
    o.onFrame?.(report, image);
  };
  const metrics = (): Heartbeat => ({
    frames: a.frames,
    unusable: a.unusable,
    fps: a.frames ? (a.frames * 1000) / Math.max(busyMs, 1) : 0,
    inputFps: a.frames
      ? Math.round((a.frames * 100000) / Math.max(Date.now() - started, 1)) /
        100
      : 0,
    latencyMs: a.frames ? busyMs / a.frames : 0,
    sourceTime: a.at(a.frames),
    now: last
      ? {
          at: last.at,
          visible: last.visible,
          zones: last.zones,
          crossings: last.crossings,
        }
      : null,
    diagnosis: a.diagnosis,
  });
  const d = o.detector,
    frameSize = d ? d.width * d.height * 3 : size;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...o.input,
    "-an",
    "-vf",
    d
      ? `scale=${d.width}:${d.height},format=rgb24`
      : `scale=${w}:${h},format=gray`,
    "-r",
    String(fps),
    "-f",
    "rawvideo",
    "pipe:1",
  ];
  const child = spawn(o.ffmpeg ?? process.env.FFMPEG_PATH ?? "ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  // ffmpeg errors may contain a credential-bearing RTSP URL. Drain but never persist them.
  child.stderr.resume();
  stop = () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  };
  o.signal?.addEventListener("abort", stop);
  const heartbeat = setInterval(() => {
    // Line crossings reach the app within a heartbeat, not only at the 10 s zone aggregate.
    flush();
    if (o.onHeartbeat) {
      const h = metrics();
      pending = pending.then(() => o.onHeartbeat!(h));
      pending.catch(() => stop());
    }
  }, 5000);
  let failure: unknown = null;
  try {
    let buffer: Buffer = Buffer.alloc(0);
    // Neural mode: frames are processed one at a time; while the model runs, reading from ffmpeg
    // pauses (back-pressure), so a slow device processes fewer frames instead of queueing memory.
    // The grayscale frame for quality, gaps, shelf and workstation is derived from the RGB frame.
    let frameQueue: Promise<void> = Promise.resolve();
    const neural = async (rgb: Uint8Array) => {
      const t = performance.now();
      const people = await d!.detect(rgb);
      // Model time counts as processing time in fps/latency figures.
      busyMs += performance.now() - t;
      analyze(
        grayFromRgb(rgb, d!.width, d!.height, w, h),
        { data: rgb, width: d!.width, height: d!.height, format: "rgb24" },
        people,
      );
    };
    const ended = await new Promise<RunSummary["ended"]>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        if (!d) {
          while (buffer.length >= size) {
            const gray = new Uint8Array(buffer.subarray(0, size));
            analyze(
              gray,
              { data: gray, width: w, height: h, format: "gray" },
              null,
            );
            buffer = buffer.subarray(size);
          }
          return;
        }
        const batch: Uint8Array[] = [];
        while (buffer.length >= frameSize) {
          batch.push(new Uint8Array(buffer.subarray(0, frameSize)));
          buffer = buffer.subarray(frameSize);
        }
        if (!batch.length) return;
        child.stdout.pause();
        frameQueue = frameQueue
          .then(async () => {
            if (failure) return;
            for (const f of batch) await neural(f);
          })
          .catch((e) => {
            // A detector failure ends the run: ffmpeg is stopped, the error is raised below.
            failure ??= e;
            stop();
          })
          .finally(() => child.stdout.resume());
      });
      child.on("error", () => resolve("decoder_error"));
      child.on("close", (code) =>
        frameQueue.then(() =>
          resolve(
            o.signal?.aborted
              ? "aborted"
              : code === 0
                ? o.live
                  ? "signal_lost"
                  : "end_of_stream"
                : a.frames
                  ? "signal_lost"
                  : "decoder_error",
          ),
        ),
      );
    });
    await frameQueue;
    // A detector failure is not a lost signal: it is raised to the operator.
    if (failure) throw failure;
    a.finish(ended);
    flush();
    await pending;
    const cpu = os.cpus()[0]?.model || "unknown";
    const m = metrics();
    return {
      frames: m.frames,
      unusable: m.unusable,
      fps: m.fps,
      inputFps: m.inputFps,
      latencyMs: m.latencyMs,
      sourceTime: m.sourceTime,
      diagnosis: m.diagnosis,
      processor: PROCESSOR_VERSION,
      detectors: DETECTOR_VERSIONS,
      people: d
        ? { mode: "neural", detector: d.version, tracker: "bytetrack" }
        : { mode: "motion", detector: null, tracker: "nearest" },
      width: w,
      height: h,
      targetFps: fps,
      hardware: {
        cpu,
        cores: os.cpus().length,
        platform: `${os.platform()} ${os.arch()}`,
      },
      ended,
      events: sent,
    };
  } finally {
    // Always: no heartbeat timer, abort listener or ffmpeg (and the camera it holds) outlives
    // the run, whatever ended it.
    clearInterval(heartbeat);
    o.signal?.removeEventListener("abort", stop);
    stop();
  }
}
