// T057 detector speed on THIS device: `npm run video:bench [-- --frames 40 --file clip.mp4]`.
// Frames come from a recording through ffmpeg (default: a rendered synthetic lab clip, which has
// no people — it measures speed only, never accuracy). Writes docs/evidence/video-bench-<date>.json.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import {
  DETECTORS,
  loadDetector,
  type DetectorKind,
} from "../src/server/video/detector";
import { labClips, renderClip } from "../src/server/video/synthetic";

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const N = Number(arg("frames", "40"));
async function frames(file: string, w: number, h: number, n: number) {
  return new Promise<Uint8Array[]>((resolve, reject) => {
    const p = spawn(process.env.FFMPEG_PATH || "ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      file,
      "-frames:v",
      String(n),
      "-vf",
      `scale=${w}:${h},format=rgb24`,
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
    const parts: Buffer[] = [];
    p.stdout.on("data", (d) => parts.push(d));
    p.on("error", reject);
    p.on("close", () => {
      const all = Buffer.concat(parts),
        size = w * h * 3,
        out: Uint8Array[] = [];
      for (let o = 0; o + size <= all.length; o += size)
        out.push(new Uint8Array(all.subarray(o, o + size)));
      resolve(out);
    });
  });
}
async function main() {
  let file = arg("file", "");
  const source = file
    ? "recording given by --file"
    : "synthetic lab clip (speed only)";
  if (!file) {
    file = path.join(
      mkdtempSync(path.join(tmpdir(), "taraz-bench-")),
      "lab.mp4",
    );
    await renderClip({ ...labClips()[0], seconds: 8 }, file);
  }
  const results = [];
  for (const kind of Object.keys(DETECTORS) as DetectorKind[])
    for (const precision of ["fp32", "int8"] as const) {
      let detector;
      try {
        detector = await loadDetector(kind, { precision });
      } catch {
        results.push({ kind, precision, status: "model_missing" });
        continue;
      }
      const f = await frames(file, detector.width, detector.height, N);
      await detector.detect(f[0]); // warm-up
      const t: number[] = [];
      for (const x of f) {
        const s = performance.now();
        await detector.detect(x);
        t.push(performance.now() - s);
      }
      await detector.dispose();
      t.sort((a, b) => a - b);
      const mean = t.reduce((a, b) => a + b, 0) / t.length;
      results.push({
        kind,
        version: detector.version,
        precision,
        frames: t.length,
        meanMs: Math.round(mean),
        p95Ms: Math.round(t[Math.ceil(t.length * 0.95) - 1]),
        maxFps: Math.round((1000 / mean) * 10) / 10,
      });
      console.log(JSON.stringify(results.at(-1)));
    }
  await mkdir("docs/evidence", { recursive: true });
  const out = `docs/evidence/video-bench-${new Date().toISOString().slice(0, 10)}.json`;
  await writeFile(
    out,
    JSON.stringify(
      {
        task: "T057",
        date: new Date().toISOString(),
        source,
        input: "640×640 RGB (model input), CPU only, onnxruntime-node",
        hardware: {
          cpu: os.cpus()[0]?.model,
          cores: os.cpus().length,
          platform: `${os.platform()} ${os.arch()}`,
        },
        results,
      },
      null,
      2,
    ),
  );
  console.log(`Report: ${out}`);
}
main().catch((e) => {
  console.error("VIDEO_BENCH_FAILED", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
