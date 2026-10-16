import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { processVideo, type VideoEvent } from "../src/server/video/processor";
import {
  detectorPath,
  loadDetector,
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
    kind: "dfine-n",
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
it("T057: a missing detector model is an explicit error, not a silent switch to motion", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taraz-nomodel-"));
  await expect(loadDetector("dfine-n", { dir })).rejects.toThrow(
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
describe.skipIf(!hasFfmpeg || !existsSync(detectorPath("dfine-n", "fp32")))(
  "T057 real D-FINE-N model (downloaded with npm run video:model)",
  () => {
    it("loads on CPU and runs on 640×640 frames; rendered blobs are not taken for people", async () => {
      const d = await loadDetector("dfine-n");
      const dir = mkdtempSync(path.join(tmpdir(), "taraz-dfine-"));
      const file = path.join(dir, "clip.mp4");
      await renderClip({ ...labClips()[0], seconds: 6 }, file);
      const events: VideoEvent[] = [];
      const summary = await processVideo({
        input: ["-i", file],
        config: LAB_CONFIG,
        startTime: new Date(),
        live: false,
        fps: 2,
        detector: d,
        onEvents: async (e) => void events.push(...e),
      });
      await d.dispose();
      expect(summary.people).toMatchObject({
        mode: "neural",
        detector: "dfine_n_coco@onnx-fp32",
      });
      expect(summary.frames).toBeGreaterThanOrEqual(10);
      // Synthetic rectangles are not people: no crossings may be invented from them.
      expect(events.filter((e) => e.kind === "line_cross")).toHaveLength(0);
    }, 120_000);
  },
);
