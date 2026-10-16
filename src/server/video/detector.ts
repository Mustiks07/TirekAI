import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Detection } from "./bytetrack";

// T057 person detector adapter. The model runs on the processing device's CPU through
// onnxruntime-node; frames are never sent anywhere and never stored. Only the COCO "person" class
// is read: no faces, identities or attributes. Model: D-FINE (Peterande/D-FINE, Apache-2.0),
// COCO-trained checkpoints converted to ONNX (onnx-community/dfine_*_coco-ONNX). Checkpoints
// pre-trained on Objects365 are deliberately not offered (the D-FINE README warns that their
// commercial use may be restricted by the Objects365 terms).
export const DETECTORS = {
  "dfine-n": {
    repo: "onnx-community/dfine_n_coco-ONNX",
    version: "dfine_n_coco@onnx",
    license: "Apache-2.0 (D-FINE code and COCO checkpoints)",
  },
  "dfine-s": {
    repo: "onnx-community/dfine_s_coco-ONNX",
    version: "dfine_s_coco@onnx",
    license: "Apache-2.0 (D-FINE code and COCO checkpoints)",
  },
} as const;
export type DetectorKind = keyof typeof DETECTORS;
export interface PersonDetector {
  readonly kind: DetectorKind;
  readonly version: string;
  readonly precision: "fp32" | "int8";
  // The processor feeds RGB frames of exactly this size (the model's own input, stretched).
  readonly width: number;
  readonly height: number;
  detect(rgb: Uint8Array): Promise<Detection[]>;
  dispose(): Promise<void>;
}
export function detectorPath(
  kind: DetectorKind,
  precision: "fp32" | "int8",
  dir = process.env.VIDEO_MODEL_DIR || ".data/models",
) {
  return resolve(
    dir,
    DETECTORS[kind].repo,
    "onnx",
    precision === "int8" ? "model_int8.onnx" : "model.onnx",
  );
}
export async function loadDetector(
  kind: DetectorKind,
  o: {
    precision?: "fp32" | "int8";
    threshold?: number;
    threads?: number;
    dir?: string;
  } = {},
): Promise<PersonDetector> {
  const precision = o.precision ?? "fp32",
    file = detectorPath(kind, precision, o.dir);
  // A missing model is an explicit error, never a silent switch to the motion detector.
  if (!existsSync(file)) throw new Error("DETECTOR_MODEL_MISSING");
  const ort = await import("onnxruntime-node");
  const session = await ort.InferenceSession.create(file, {
    intraOpNumThreads: o.threads ?? 0,
    graphOptimizationLevel: "all",
  });
  const W = 640,
    H = 640,
    // Low-score boxes are kept for the tracker's second association step (ByteTrack).
    threshold = o.threshold ?? 0.1,
    input = new Float32Array(3 * W * H);
  return {
    kind,
    version: `${DETECTORS[kind].version}-${precision}`,
    precision,
    width: W,
    height: H,
    async detect(rgb) {
      if (rgb.length !== W * H * 3) throw new Error("DETECTOR_FRAME_SIZE");
      // HWC uint8 → CHW float 0..1 (the model's processor rescales by 1/255, no normalization).
      for (let p = 0, n = W * H; p < n; p++) {
        input[p] = rgb[p * 3] / 255;
        input[n + p] = rgb[p * 3 + 1] / 255;
        input[2 * n + p] = rgb[p * 3 + 2] / 255;
      }
      const out = await session.run({
        pixel_values: new ort.Tensor("float32", input, [1, 3, H, W]),
      });
      const logits = out.logits.data as Float32Array,
        boxes = out.pred_boxes.data as Float32Array,
        classes = out.logits.dims[2],
        queries = out.logits.dims[1];
      const found: Detection[] = [];
      for (let q = 0; q < queries; q++) {
        const score = 1 / (1 + Math.exp(-logits[q * classes])); // class 0 = person
        if (score < threshold) continue;
        const [cx, cy, w, h] = boxes.subarray(q * 4, q * 4 + 4);
        found.push({
          x0: Math.max(0, cx - w / 2),
          y0: Math.max(0, cy - h / 2),
          x1: Math.min(1, cx + w / 2),
          y1: Math.min(1, cy + h / 2),
          score,
        });
      }
      return found;
    },
    async dispose() {
      await session.release();
    },
  };
}
