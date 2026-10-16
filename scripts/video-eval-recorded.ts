// T057 accuracy on permitted recordings with human-made truth, motion vs neural pipeline on the
// same clips: `npm run video:eval-recorded -- --manifest <file.json> [--detector dfine-n] [--fps 5]`.
// Manifest: { name, permission, clips: [{ file, source, license, line: {a,b,inSide},
//   truth: [{ t: seconds, direction: "in"|"out" }] }] }. Truth comes from a person watching the
// clip; it is never produced by either pipeline. Offline report only: detector statuses in the
// application change solely through «Разметка и оценка» on the organization's own runs.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import os from "node:os";
import { processVideo, type VideoEvent } from "../src/server/video/processor";
import {
  scoreClip,
  judge,
  type ClipResult,
} from "../src/server/video/evaluate";
import { loadDetector, type DetectorKind } from "../src/server/video/detector";
import type { Point } from "../src/server/video/cv";

type Manifest = {
  name: string;
  permission: string;
  clips: {
    file: string;
    source: string;
    license: string;
    line: { a: Point; b: Point; inSide: 1 | -1 };
    truth: { t: number; direction: "in" | "out" }[];
  }[];
};
const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
async function main() {
  const path = arg("manifest");
  if (!path) throw new Error("MANIFEST_REQUIRED");
  const m = JSON.parse(await readFile(path, "utf8")) as Manifest;
  if (!m.permission?.trim()) throw new Error("PERMISSION_NOTE_REQUIRED");
  const kind = (arg("detector") ?? "dfine-n") as DetectorKind;
  const fps = Number(arg("fps") ?? "5");
  const precision = arg("precision") === "int8" ? "int8" : "fp32";
  const out: Record<string, unknown> = {};
  for (const mode of ["motion", "neural"] as const) {
    const results: ClipResult[] = [];
    for (const c of m.clips) {
      const detector =
        mode === "neural" ? await loadDetector(kind, { precision }) : undefined;
      const start = new Date("2026-01-01T00:00:00Z");
      const events: VideoEvent[] = [];
      const config = {
        version: 1,
        lines: [{ id: "line", name: "line", ...c.line }],
        zones: [],
      };
      const summary = await processVideo({
        input: ["-i", resolve(dirname(path), c.file)],
        config,
        startTime: start,
        live: false,
        fps,
        detector,
        onEvents: async (e) => void events.push(...e),
      });
      await detector?.dispose();
      results.push(
        scoreClip(
          c.file,
          mode,
          {
            crossings: c.truth.map((x) => ({ ...x, line: "line" })),
            queues: [],
          },
          events,
          summary,
          start,
        ),
      );
    }
    out[mode] = {
      clips: results,
      verdict: judge(results, { name: m.name, kind: "recorded" }).find(
        (v) => v.detector === "line_crossing",
      ),
    };
  }
  await mkdir("docs/evidence", { recursive: true });
  const file = `docs/evidence/video-eval-recorded-${new Date().toISOString().slice(0, 10)}.json`;
  await writeFile(
    file,
    JSON.stringify(
      {
        task: "T057",
        date: new Date().toISOString(),
        dataset: {
          name: m.name,
          permission: m.permission,
          clips: m.clips.map((c) => ({
            file: c.file,
            source: c.source,
            license: c.license,
            truthCrossings: c.truth.length,
          })),
        },
        neural: { detector: kind, precision, fps },
        hardware: {
          cpu: os.cpus()[0]?.model,
          cores: os.cpus().length,
        },
        note: "Offline comparison on public footage; not the enterprise camera. The application's detector status is not changed by this report.",
        ...out,
      },
      null,
      2,
    ),
  );
  for (const mode of ["motion", "neural"])
    for (const r of (out[mode] as { clips: ClipResult[] }).clips)
      console.log(
        `${mode} ${r.clip}: truth ${r.truthCrossings}, counted ${r.detectedCrossings}, matched ${r.matched}, count error ${(r.countError * 100).toFixed(1)}%, ${Math.round(r.run.fps)} fps`,
      );
  console.log(`Report: ${file}`);
}
main().catch((e) => {
  console.error("VIDEO_EVAL_FAILED", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
