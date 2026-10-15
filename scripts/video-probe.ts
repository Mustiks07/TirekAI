import { mkdir, writeFile } from "node:fs/promises";
import {
  probeSource,
  redactSource,
  streamTrial,
} from "../src/server/video/probe";

// T057 step 1 on the processing device, before any zones are drawn:
//   npm run video:probe -- --permission "<who allowed what, where>" --rtsp [--seconds 60]
//   npm run video:probe -- --permission "…" --file recording.mp4
//   npm run video:probe -- --permission "…" --webcam /dev/video0
// The RTSP URL (with credentials) is read only from VIDEO_RTSP_URL on this device. The report has
// the redacted address, stream passport, decode/processing speed, first-frame and stop times.
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const permission = arg("permission")?.trim();
if (!permission) {
  console.error(
    'Record the processing permission: --permission "<owner/site, purpose, notice to people>"',
  );
  process.exit(1);
}
let input: string[], live: boolean, label: string, kind: string;
if (arg("file")) {
  input = ["-i", arg("file")!];
  live = false;
  label = "[recording file]";
  kind = "file";
} else if (args.includes("--rtsp")) {
  const url = process.env.VIDEO_RTSP_URL;
  if (!url) throw new Error("VIDEO_RTSP_URL is not set on this device");
  input = ["-rtsp_transport", "tcp", "-i", url];
  live = true;
  label = redactSource(url);
  kind = "rtsp";
} else if (arg("webcam")) {
  input =
    process.platform === "win32"
      ? ["-f", "dshow", "-i", arg("webcam")!]
      : ["-f", "v4l2", "-i", arg("webcam")!];
  live = true;
  label = "[local camera]";
  kind = "webcam";
} else {
  console.error("Choose a source: --rtsp | --file <path> | --webcam <device>");
  process.exit(1);
}
const seconds = Number(arg("seconds") ?? 60);
const probe = kind === "webcam" ? null : await probeSource(input);
const trial =
  probe && !probe.ok ? null : await streamTrial({ input, seconds, live });
await mkdir("docs/evidence", { recursive: true });
const out = `docs/evidence/video-probe-${new Date().toISOString().slice(0, 10)}-${kind}.json`;
await writeFile(
  out,
  JSON.stringify(
    {
      task: "T057",
      date: new Date().toISOString(),
      permission,
      source: { kind, address: label },
      probe,
      trial,
      note: "Glass-to-event latency is measured separately on site (see docs/LIVE_ACCEPTANCE.md T057).",
    },
    null,
    2,
  ),
);
console.log(
  probe && !probe.ok
    ? `Source not reachable: ${probe.error}. Report: ${out}`
    : `Delivered ${trial!.deliveredFps}/${trial!.targetFps} fps, processing ${trial!.processingMsPerFrame} ms/frame, first frame ${trial!.firstFrameWithinMs} ms, stop ${trial!.stopMs} ms, ended ${trial!.ended}. Report: ${out}`,
);
process.exit(probe && !probe.ok ? 2 : 0);
