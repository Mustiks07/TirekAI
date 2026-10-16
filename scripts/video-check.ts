// T057 local check of the people pipeline on this device, without the app, a token or any
// upload: frames are analyzed in memory and only counts are printed. Use it to see whether people
// in front of a camera (or in a recording) are found, before connecting the processor.
//   npm run video:check -- --webcam "video=HD User Facing" [--seconds 30]     (Windows, dshow)
//   npm run video:check -- --webcam /dev/video0 [--seconds 30]                (Linux)
//   npm run video:check -- --file shop.mp4 [--line 0,0.75,1,0.75] [--zone 0.2,0.2,0.8,0.9]
//   [--detector rfdetr-n|rfdetr-s|dfine-s] [--fps 5] [--report docs/evidence/x.json]
// Every second: people counted now, the best person score, entries/exits over the line. At the
// end: the first broken link (no frames / unusable frames / model sees nobody / tracker drops /
// outside the zone).
import { writeFile } from "node:fs/promises";
import os from "node:os";
import { processVideo } from "../src/server/video/processor";
import {
  DEFAULT_DETECTOR,
  RETIRED_DETECTORS,
  isDetectorKind,
  loadDetector,
} from "../src/server/video/detector";
import { explain } from "../src/server/video/analyzer";

const args = process.argv.slice(2);
const arg = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const nums = (v: string | undefined, n: number) => {
  const x = (v ?? "").split(",").map(Number);
  return x.length === n && x.every((y) => y >= 0 && y <= 1) ? x : null;
};
async function main() {
  const kind = arg("detector") ?? DEFAULT_DETECTOR;
  if (kind in RETIRED_DETECTORS) throw new Error(RETIRED_DETECTORS[kind]);
  if (!isDetectorKind(kind)) throw new Error(`Unknown --detector ${kind}`);
  const fps = Number(arg("fps") ?? 5);
  const seconds = Number(arg("seconds") ?? 30);
  let input: string[], live: boolean;
  if (arg("file")) {
    input = ["-i", arg("file")!];
    live = false;
  } else if (arg("webcam")) {
    input = [
      ...(process.platform === "win32" ? ["-f", "dshow"] : ["-f", "v4l2"]),
      "-i",
      arg("webcam")!,
      "-t",
      String(seconds),
    ];
    live = true;
  } else throw new Error("Use --file <path> or --webcam <device>");
  const l = nums(arg("line"), 4) ?? [0, 0.75, 1, 0.75];
  const z = nums(arg("zone"), 4) ?? [0, 0, 1, 1];
  const detector = await loadDetector(kind).catch((e) => {
    throw new Error(
      e instanceof Error && e.message === "DETECTOR_MODEL_MISSING"
        ? "Model is not on this device: run npm run video:model"
        : "Detector failed to load",
    );
  });
  console.log(
    `${detector.version} + ByteTrack, ${fps} fps; line (${l.join(", ")}), zone (${z.join(", ")})`,
  );
  const timeline: { t: number; now: number; score: number }[] = [];
  let best = 0;
  const ids = new Set<number>();
  let crossings = { in: 0, out: 0 };
  const summary = await processVideo({
    input,
    live,
    fps,
    detector: {
      ...detector,
      // Same model; the best person score per frame is kept for the printout.
      detect: async (rgb) => {
        const found = await detector.detect(rgb);
        best = Math.max(best, ...found.map((d) => d.score), 0);
        return found;
      },
    },
    startTime: new Date(0),
    config: {
      version: 1,
      lines: [
        {
          id: "line",
          name: "line",
          a: { x: l[0], y: l[1] },
          b: { x: l[2], y: l[3] },
          inSide: -1,
        },
      ],
      zones: [
        {
          id: "zone",
          name: "zone",
          kind: "presence",
          polygon: [
            { x: z[0], y: z[1] },
            { x: z[2], y: z[1] },
            { x: z[2], y: z[3] },
            { x: z[0], y: z[3] },
          ],
        },
      ],
    },
    onEvents: async () => {},
    onFrame: (r) => {
      for (const p of r.people) if (p.counted) ids.add(p.id);
      crossings = r.crossings.line ?? crossings;
      if (r.index % fps === fps - 1) {
        const t = Math.round((r.index + 1) / fps);
        timeline.push({
          t,
          now: r.visible,
          score: Math.round(best * 100) / 100,
        });
        console.log(
          `${String(t).padStart(4)} s  ${r.usable ? `people now ${r.visible}, in zone ${r.zones.zone ?? 0}` : "unusable frame"}  best score ${best.toFixed(2)}  in ${crossings.in} / out ${crossings.out}`,
        );
        best = 0;
      }
    },
  });
  await detector.dispose();
  const d = summary.diagnosis!;
  const verdict = explain(d);
  const text: Record<string, string> = {
    no_frames: "no frames arrived: check the device name / file",
    unusable_frames: "all frames were too dark, too bright or frozen",
    model_sees_nobody:
      "the model found no person above the tracker threshold: check light, distance and that a person is in view",
    tracker_drops:
      "people were detected but not confirmed as tracks (too few consecutive frames)",
    outside_zone: "people were counted, but never inside the zone",
    ok: "people were found, tracked and counted",
  };
  console.log(
    `\n${summary.frames} frames (${summary.unusable} unusable), ${Math.round(summary.latencyMs)} ms/frame, input ${summary.inputFps} fps; ${ids.size} people tracked; in ${crossings.in} / out ${crossings.out}`,
  );
  console.log(`Diagnosis: ${verdict} — ${text[verdict]}`);
  const report = arg("report");
  if (report)
    await writeFile(
      report,
      JSON.stringify(
        {
          task: "T057",
          date: new Date().toISOString(),
          source: arg("file") ? { file: arg("file") } : { webcam: true },
          detector: detector.version,
          fps,
          line: l,
          zone: z,
          hardware: { cpu: os.cpus()[0]?.model, cores: os.cpus().length },
          frames: summary.frames,
          unusable: summary.unusable,
          latencyMs: Math.round(summary.latencyMs),
          peopleTracked: ids.size,
          crossings,
          diagnosis: d,
          verdict,
          timeline,
        },
        null,
        2,
      ),
    );
}
main().catch((e) => {
  console.error("VIDEO_CHECK_FAILED", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
