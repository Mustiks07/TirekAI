import { spawn } from "node:child_process";
import os from "node:os";
import {
  Background,
  Tracker,
  components,
  dilate,
  crossing,
  frameQuality,
  inside,
  open3,
  type Point,
  type Track,
} from "./cv";

// T035–T038 processor. Runs as its own process (scripts/video-processor.ts), never inside a
// browser tab or the web request path. ffmpeg decodes the source to small grayscale frames in
// memory; no frame is written to disk and only aggregated events leave the process.
import { PROCESSOR_VERSION, DETECTOR_VERSIONS } from "./versions";
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
  fps: number;
  latencyMs: number;
  sourceTime: string;
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
  signal?: AbortSignal;
  ffmpeg?: string;
}): Promise<RunSummary> {
  const w = o.width ?? 320,
    h = o.height ?? 180,
    fps = o.fps ?? 10,
    minArea = o.minArea ?? Math.round((w * h) / 900),
    aggregate = o.aggregateSeconds ?? 10,
    size = w * h;
  const bg = new Background(w, h),
    tracker = new Tracker();
  const events: VideoEvent[] = [];
  let seq = 0,
    frames = 0,
    unusable = 0,
    busyMs = 0,
    prev: Uint8Array | null = null,
    hold: Uint8Array | undefined,
    gapStart: number | null = null,
    pending: Promise<void> = Promise.resolve(),
    sent = 0;
  const at = (frame: number) =>
    new Date(o.startTime.getTime() + (frame * 1000) / fps).toISOString();
  const emit = (e: Omit<VideoEvent, "seq">) =>
    events.push({ ...e, seq: seq++ } as VideoEvent);
  const zoneCounts: Record<string, number[]> = {};
  const queueOpen: Record<string, number | null> = {},
    queueRun: Record<string, number> = {};
  const shelfRef: Record<string, number> = {},
    shelfRun: Record<string, number> = {},
    shelfOpen: Record<string, boolean> = {},
    work: Record<string, { state: boolean; run: number }> = {};
  const zonePixels = new Map<string, number[]>();
  for (const z of o.config.zones) {
    const idx: number[] = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (inside({ x: (x + 0.5) / w, y: (y + 0.5) / h }, z.polygon))
          idx.push(y * w + x);
    zonePixels.set(z.id, idx);
    zoneCounts[z.id] = [];
  }
  const flush = () => {
    if (!events.length) return;
    const batch = events.splice(0, events.length);
    sent += batch.length;
    pending = pending.then(() => o.onEvents(batch));
  };
  const leaveZones = (tr: Track, frame: number) => {
    for (const [zone, since] of Object.entries(tr.zoneSince)) {
      const seconds = (frame - since) / fps;
      if (seconds >= 1)
        emit({
          kind: "dwell",
          at: at(since),
          zone,
          value: Math.round(seconds * 10) / 10,
          until: at(frame),
        });
      delete tr.zoneSince[zone];
    }
  };
  const step = (frame: Uint8Array) => {
    const started = performance.now(),
      i = frames++;
    if (i === 0) o.onFirstFrame?.();
    const q = frameQuality(frame, prev);
    prev = frame;
    if (q.unusable || (q.frozen && o.live)) {
      unusable++;
      if (gapStart === null) gapStart = i;
      busyMs += performance.now() - started;
      return;
    }
    if (gapStart !== null) {
      // A gap of unusable frames is reported as missing data, never as zero visitors.
      if (i - gapStart >= fps)
        emit({
          kind: "gap",
          at: at(gapStart),
          until: at(i),
          reason: "unusable_frames",
        });
      gapStart = null;
    }
    const mask = open3(bg.apply(frame, 28, hold), w, h);
    hold = dilate(mask, w, h, 2);
    const blobs = components(mask, w, h, minArea);
    const ended = tracker.update(blobs, i);
    for (const tr of ended) leaveZones(tr, i);
    for (const tr of tracker.tracks) {
      if (tr.missed > 0 || tr.age < 2) continue;
      for (const line of o.config.lines) {
        const side = crossing(
          { x: tr.px, y: tr.py },
          { x: tr.cx, y: tr.cy },
          line.a,
          line.b,
        );
        // One count per track and line within two seconds suppresses jitter on the line.
        if (
          side &&
          (tr.crossed[line.id] === undefined ||
            i - tr.crossed[line.id] > 2 * fps)
        ) {
          tr.crossed[line.id] = i;
          emit({
            kind: "line_cross",
            at: at(i),
            line: line.id,
            direction: side === line.inSide ? "in" : "out",
          });
        }
      }
      for (const z of o.config.zones) {
        const isIn = inside({ x: tr.cx, y: tr.cy }, z.polygon);
        if (isIn && tr.zoneSince[z.id] === undefined) tr.zoneSince[z.id] = i;
        if (!isIn && tr.zoneSince[z.id] !== undefined) {
          const seconds = (i - tr.zoneSince[z.id]) / fps;
          if (seconds >= 1)
            emit({
              kind: "dwell",
              at: at(tr.zoneSince[z.id]),
              zone: z.id,
              value: Math.round(seconds * 10) / 10,
              until: at(i),
            });
          delete tr.zoneSince[z.id];
        }
      }
    }
    for (const z of o.config.zones) {
      // A live track counts at its last position while briefly missed (≤ tracker tolerance).
      const visible = tracker.tracks.filter(
        (tr) => tr.age >= 3 && inside({ x: tr.cx, y: tr.cy }, z.polygon),
      ).length;
      zoneCounts[z.id].push(visible);
      if (z.kind === "queue") {
        const min = z.queueMin ?? 3,
          hold = (z.queueSeconds ?? 10) * fps;
        queueRun[z.id] = visible >= min ? (queueRun[z.id] || 0) + 1 : 0;
        if (queueRun[z.id] >= hold && queueOpen[z.id] == null) {
          queueOpen[z.id] = i - hold + 1;
          emit({
            kind: "queue_start",
            at: at(i - hold + 1),
            zone: z.id,
            value: visible,
          });
        }
        if (visible < min && queueOpen[z.id] != null) {
          emit({
            kind: "queue_end",
            at: at(i),
            zone: z.id,
            value: (i - queueOpen[z.id]!) / fps,
          });
          queueOpen[z.id] = null;
        }
      }
      if (z.kind === "shelf" || z.kind === "workstation") {
        const px = zonePixels.get(z.id)!;
        let changed = 0;
        for (const p of px) if (mask[p]) changed++;
        const share = px.length ? changed / px.length : 0;
        if (z.kind === "shelf") {
          // The first seconds are the reference ("as configured"); a lasting change with nobody
          // in front is a signal to check the shelf — never a stock movement.
          if (i < 3 * fps) shelfRef[z.id] = share;
          // People in front move; a changed shelf is a static blob that does not.
          const movers = tracker.tracks.filter(
            (tr) =>
              tr.travel > 0.05 && inside({ x: tr.cx, y: tr.cy }, z.polygon),
          ).length;
          const lasting = share > 0.35 && movers === 0;
          shelfRun[z.id] = lasting ? (shelfRun[z.id] || 0) + 1 : 0;
          if (shelfRun[z.id] >= 5 * fps && !shelfOpen[z.id]) {
            shelfOpen[z.id] = true;
            emit({
              kind: "shelf_change_suspected",
              at: at(i),
              zone: z.id,
              value: Math.round(share * 100) / 100,
            });
          }
          if (!lasting) shelfOpen[z.id] = false;
        } else {
          const occupied = visible > 0 || share > 0.2;
          const s = (work[z.id] ||= { state: false, run: 0 });
          s.run = occupied !== s.state ? s.run + 1 : 0;
          if (s.run >= 3 * fps) {
            s.state = occupied;
            s.run = 0;
            emit({
              kind: "workstation_state",
              at: at(i),
              zone: z.id,
              value: occupied ? 1 : 0,
            });
          }
        }
      }
    }
    if (frames % (aggregate * fps) === 0) {
      for (const z of o.config.zones) {
        const c = zoneCounts[z.id];
        if (c.length)
          emit({
            kind: "zone_count",
            at: at(i - c.length + 1),
            until: at(i + 1),
            zone: z.id,
            value:
              Math.round((c.reduce((a, b) => a + b, 0) / c.length) * 100) / 100,
          });
        zoneCounts[z.id] = [];
      }
      flush();
    }
    busyMs += performance.now() - started;
  };
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...o.input,
    "-an",
    "-vf",
    `scale=${w}:${h},format=gray`,
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
  const abort = () => child.kill("SIGTERM");
  o.signal?.addEventListener("abort", abort);
  const heartbeat = setInterval(() => {
    if (o.onHeartbeat)
      pending = pending.then(() =>
        o.onHeartbeat!({
          frames,
          unusable,
          fps: frames ? (frames * 1000) / Math.max(busyMs, 1) : 0,
          latencyMs: frames ? busyMs / frames : 0,
          sourceTime: at(frames),
        }),
      );
  }, 5000);
  let buffer: Buffer = Buffer.alloc(0);
  const ended = await new Promise<RunSummary["ended"]>((resolve) => {
    child.stdout.on("data", (chunk: Buffer) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (buffer.length >= size) {
        step(new Uint8Array(buffer.subarray(0, size)));
        buffer = buffer.subarray(size);
      }
    });
    child.on("error", () => resolve("decoder_error"));
    child.on("close", (code) =>
      resolve(
        o.signal?.aborted
          ? "aborted"
          : code === 0
            ? o.live
              ? "signal_lost"
              : "end_of_stream"
            : frames
              ? "signal_lost"
              : "decoder_error",
      ),
    );
  });
  clearInterval(heartbeat);
  o.signal?.removeEventListener("abort", abort);
  for (const tr of tracker.tracks) leaveZones(tr, frames);
  for (const z of o.config.zones)
    if (queueOpen[z.id] != null)
      emit({
        kind: "queue_end",
        at: at(frames),
        zone: z.id,
        value: (frames - queueOpen[z.id]!) / fps,
      });
  if (gapStart !== null && frames - gapStart >= fps)
    emit({
      kind: "gap",
      at: at(gapStart),
      until: at(frames),
      reason: "unusable_frames",
    });
  // A lost live stream is an explicit event: the period after it has no data.
  if (ended === "signal_lost" || ended === "decoder_error")
    emit({
      kind: "signal_lost",
      at: at(frames),
      reason: ended,
    });
  flush();
  await pending;
  const cpu = os.cpus()[0]?.model || "unknown";
  return {
    frames,
    unusable,
    fps: frames ? (frames * 1000) / Math.max(busyMs, 1) : 0,
    latencyMs: frames ? busyMs / frames : 0,
    sourceTime: at(frames),
    processor: PROCESSOR_VERSION,
    detectors: DETECTOR_VERSIONS,
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
}
