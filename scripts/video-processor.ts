import { spawn } from "node:child_process";
import {
  processVideo,
  type VideoConfig,
  type VideoEvent,
} from "../src/server/video/processor";
import {
  DETECTORS,
  loadDetector,
  type DetectorKind,
} from "../src/server/video/detector";

// T035 processing device. Started and stopped explicitly by an operator; long processing does
// not depend on a browser tab. Raw frames never leave this process and are never stored.
//   VIDEO_DEVICE_TOKEN=… npm run video:processor -- --server https://app --source <id> --file clip.mp4 [--start 2026-10-15T09:00:00+05:00]
//   VIDEO_DEVICE_TOKEN=… VIDEO_RTSP_URL=rtsp://user:pass@camera/stream npm run video:processor -- --server … --source … --rtsp
//   VIDEO_DEVICE_TOKEN=… npm run video:processor -- --server … --source … --webcam /dev/video0   (Windows: --webcam "video=Camera")
// Camera credentials stay in VIDEO_RTSP_URL on this device; they are not sent to the server.
// People: --detector dfine-n (default, neural, model from `npm run video:model`), dfine-s, or
// motion (the classical blob pipeline). A missing model stops the run; it never falls back.
//   [--detector dfine-n|dfine-s|motion] [--precision fp32|int8] [--fps 5]
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const server = arg("server"),
  source = arg("source"),
  token = process.env.VIDEO_DEVICE_TOKEN;
if (!server || !source || !token) {
  console.error(
    "Usage: --server <https://app> --source <id> (--file <path> | --rtsp | --webcam <device>); token in VIDEO_DEVICE_TOKEN",
  );
  process.exit(2);
}
let input: string[], live: boolean, probe: string | null;
if (arg("file")) {
  input = ["-i", arg("file")!];
  live = false;
  probe = arg("file")!;
} else if (args.includes("--rtsp")) {
  const url = process.env.VIDEO_RTSP_URL;
  if (!url) throw new Error("VIDEO_RTSP_URL is not set");
  input = ["-rtsp_transport", "tcp", "-i", url];
  live = true;
  probe = url;
} else if (arg("webcam")) {
  input =
    process.platform === "win32"
      ? ["-f", "dshow", "-i", arg("webcam")!]
      : ["-f", "v4l2", "-i", arg("webcam")!];
  live = true;
  probe = null;
} else throw new Error("No input");
const headers = {
  Authorization: `Device ${token}`,
  "X-Source-Id": source,
  "Content-Type": "application/json",
};
async function call<T>(path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(`${server}/api/video/${path}`, {
        method: body ? "POST" : "GET",
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) return (await r.json()) as T;
      if (r.status < 500)
        throw new Error(
          `server refused ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`,
        );
    } catch (error) {
      if (
        attempt >= 5 ||
        (error instanceof Error && error.message.startsWith("server refused"))
      )
        throw error;
    }
    await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
  }
}
function ffprobe(target: string) {
  return new Promise<Record<string, unknown>>((resolve) => {
    const p = spawn(process.env.FFPROBE_PATH || "ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,avg_frame_rate",
      "-of",
      "json",
      target,
    ]);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => {
      try {
        const s = JSON.parse(out).streams?.[0] || {};
        const [n, d] = String(s.avg_frame_rate || "0/1")
          .split("/")
          .map(Number);
        resolve({
          codec: s.codec_name,
          width: s.width,
          height: s.height,
          ...(d ? { fps: Math.round((n / d) * 100) / 100 } : {}),
        });
      } catch {
        resolve({});
      }
    });
    p.on("error", () => resolve({}));
  });
}
const kind = (arg("detector") ?? "dfine-n") as DetectorKind | "motion";
if (kind !== "motion" && !(kind in DETECTORS)) {
  console.error(
    `Unknown --detector ${kind}: use ${Object.keys(DETECTORS).join(", ")} or motion`,
  );
  process.exit(2);
}
const detector =
  kind === "motion"
    ? undefined
    : await loadDetector(kind, {
        precision: arg("precision") === "int8" ? "int8" : "fp32",
      }).catch((e) => {
        console.error(
          e instanceof Error && e.message === "DETECTOR_MODEL_MISSING"
            ? `Model for ${kind} is not on this device: run npm run video:model, or choose --detector motion explicitly.`
            : "Detector failed to load.",
        );
        process.exit(2);
      });
const fps = Number(arg("fps") ?? (detector ? 5 : 10));
const cfg = await call<VideoConfig & { mode: string }>("config");
const startTime = arg("start") ? new Date(arg("start")!) : new Date();
const passport = probe ? await ffprobe(probe) : {};
const { runId } = await call<{ runId: string }>("runs", {
  configVersion: cfg.version,
  sourceStart: startTime.toISOString(),
  passport,
});
console.log(
  `run ${runId}: config v${cfg.version}, ${live ? "live" : "recording"}, people: ${detector ? `${detector.version} + ByteTrack` : "motion (classical)"}, ${fps} fps`,
);
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());
const summary = await processVideo({
  input,
  config: cfg,
  startTime,
  live,
  detector,
  fps,
  signal: controller.signal,
  onEvents: async (events: VideoEvent[]) => {
    for (let i = 0; i < events.length; i += 500)
      await call("events", { runId, events: events.slice(i, i + 500) });
  },
  onHeartbeat: async (h) => {
    await call("heartbeat", { runId, ...h });
  },
});
await call("end", { runId, ended: summary.ended, summary });
await detector?.dispose();
console.log(JSON.stringify(summary));
