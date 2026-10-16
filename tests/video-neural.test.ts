import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { processVideo, type VideoEvent } from "../src/server/video/processor";
import {
  detectorPath,
  loadDetector,
  suppress,
  type PersonDetector,
} from "../src/server/video/detector";
import { components } from "../src/server/video/cv";
import {
  LAB_CONFIG,
  labClips,
  renderClip,
  truthOf,
  type Clip,
} from "../src/server/video/synthetic";

const hasFfmpeg =
  spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]).status === 0;
// Test double for the pipeline wiring only (RGB frames → detections → ByteTrack → lines/zones):
// it finds the rendered walkers by brightness. It is not a model and says nothing about accuracy.
function stubDetector(): PersonDetector {
  const W = 640,
    H = 640;
  return {
    kind: "rfdetr-n",
    version: "stub-for-tests",
    precision: "fp32",
    width: W,
    height: H,
    async detect(rgb) {
      const small = 160,
        mask = new Uint8Array(small * small);
      for (let y = 0; y < small; y++)
        for (let x = 0; x < small; x++) {
          const k = (y * 4 * W + x * 4) * 3;
          mask[y * small + x] = Math.abs(rgb[k] - 112) > 45 ? 1 : 0;
        }
      // components() already returns normalized coordinates.
      return components(mask, small, small, 6).map((b) => ({
        x0: b.x0,
        y0: b.y0,
        x1: b.x1 + 1 / small,
        y1: b.y1 + 1 / small,
        score: 0.9,
      }));
    },
    async dispose() {},
  };
}
it("T057: overlapping duplicate boxes of one person become one; separate people stay separate", () => {
  const box = (x0: number, score: number) => ({
    x0,
    y0: 0.2,
    x1: x0 + 0.2,
    y1: 0.9,
    score,
  });
  const kept = suppress([box(0.1, 0.6), box(0.11, 0.9), box(0.6, 0.7)]);
  expect(kept.map((d) => d.score)).toEqual([0.9, 0.7]);
});
it("T057: a missing detector model is an explicit error, not a silent switch to motion", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taraz-nomodel-"));
  await expect(loadDetector("rfdetr-n", { dir })).rejects.toThrow(
    "DETECTOR_MODEL_MISSING",
  );
});
describe.skipIf(!hasFfmpeg)("T057 neural pipeline with ffmpeg", () => {
  it("RGB frames flow through the detector and ByteTrack into the same line events; the summary names the pipeline", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "taraz-neural-"));
    // Four people pass one at a time in alternating directions (rendered, synthetic).
    const clip: Clip = {
      name: "neural-wiring",
      scenario: "single",
      seconds: 36,
      walkers: Array.from({ length: 4 }, (_, i) => ({
        start: 2 + i * 8,
        speed: 0.12,
        y: 0.5,
        dir: (i % 2 ? 1 : -1) as 1 | -1,
        w: 0.05,
        h: 0.22,
        shade: 215,
      })),
      standers: [],
      drift: false,
      dark: [],
    };
    const file = path.join(dir, "clip.mp4");
    await renderClip(clip, file);
    const events: VideoEvent[] = [];
    const start = new Date("2026-10-16T09:00:00Z");
    const summary = await processVideo({
      input: ["-i", file],
      config: LAB_CONFIG,
      startTime: start,
      live: false,
      fps: 10,
      detector: stubDetector(),
      onEvents: async (e) => void events.push(...e),
    });
    expect(summary).toMatchObject({
      ended: "end_of_stream",
      people: {
        mode: "neural",
        detector: "stub-for-tests",
        tracker: "bytetrack",
      },
    });
    expect(summary.frames).toBeGreaterThanOrEqual(350);
    const truth = truthOf(clip).crossings.length,
      counted = events.filter((e) => e.kind === "line_cross").length;
    expect(truth).toBe(4);
    expect(counted).toBe(truth);
  }, 120_000);
  it("the motion pipeline remains available and is labelled as such", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "taraz-motion-"));
    const file = path.join(dir, "clip.mp4");
    await renderClip({ ...labClips()[0], seconds: 10 }, file);
    const summary = await processVideo({
      input: ["-i", file],
      config: LAB_CONFIG,
      startTime: new Date(),
      live: false,
      onEvents: async () => {},
    });
    expect(summary.people).toEqual({
      mode: "motion",
      detector: null,
      tracker: "nearest",
    });
  }, 60_000);
});
// Real model on real footage, where both were downloaded (npm run video:model; the Intel sample
// videos, CC BY 4.0, see docs/LOCAL_MODELS.md). Skipped otherwise, never mocked.
const clips = ".data/eval/videos";
const clip = (name: string) => path.join(clips, name);
describe.skipIf(
  !hasFfmpeg ||
    !existsSync(detectorPath("rfdetr-n", "fp32")) ||
    !existsSync(clip("one-by-one-person-detection.mp4")) ||
    !existsSync(clip("people-detection.mp4")),
)("T057 real RF-DETR-N model on real people (CC BY 4.0 sample videos)", () => {
  const full = {
    id: "all",
    name: "all",
    kind: "presence" as const,
    polygon: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
  };
  async function run(file: string, from: number, seconds: number) {
    const d = await loadDetector("rfdetr-n");
    const timeline: number[] = [],
      ids = new Set<number>();
    let crossings = { in: 0, out: 0 };
    const summary = await processVideo({
      input: ["-ss", String(from), "-t", String(seconds), "-i", clip(file)],
      config: {
        version: 1,
        // Camera above the room: walking up the picture (away from the camera) is "in".
        lines: [
          {
            id: "door",
            name: "door",
            a: { x: 0, y: 0.75 },
            b: { x: 1, y: 0.75 },
            inSide: -1,
          },
        ],
        zones: [full],
      },
      startTime: new Date(0),
      live: false,
      fps: 5,
      detector: d,
      onEvents: async () => {},
      onFrame: (r) => {
        timeline.push(r.visible);
        for (const p of r.people) if (p.counted) ids.add(p.id);
        crossings = r.crossings.door;
      },
    });
    await d.dispose();
    return { summary, timeline, ids, crossings };
  }
  it("a person standing still is boxed and counted the whole time; an empty room is 0", async () => {
    // 88–124 s: empty for 5 s, then a person walks in, stands ~25 s and leaves.
    const r = await run("one-by-one-person-detection.mp4", 88, 36);
    expect(r.summary.people.detector).toBe("rfdetr_nano_coco@onnx-fp32");
    expect(r.ids.size).toBe(1);
    expect(Math.max(...r.timeline)).toBe(1);
    // Standing (≈ 100–115 s → frames 60–135): counted on every frame.
    expect(r.timeline.slice(60, 135).every((v) => v === 1)).toBe(true);
    // Before anyone enters (88–92 s) and after the person left: nobody is invented.
    expect(r.timeline.slice(0, 20).every((v) => v === 0)).toBe(true);
    expect(r.timeline.slice(-10).every((v) => v === 0)).toBe(true);
  }, 180_000);
  it("several people at once are counted separately and entering is counted in the right direction", async () => {
    // 12–34 s: two people, then three people enter from the camera side.
    const r = await run("people-detection.mp4", 12, 22);
    expect(Math.max(...r.timeline)).toBe(3);
    expect(r.ids.size).toBe(5);
    expect(r.crossings.out).toBe(0);
    expect(r.crossings.in).toBeGreaterThanOrEqual(4);
  }, 180_000);
});
