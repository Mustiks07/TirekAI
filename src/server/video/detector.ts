import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Detection } from "./bytetrack";

// T057 person detector adapter. The model runs on the processing device's CPU through
// onnxruntime-node; frames are never sent anywhere and never stored. Only the COCO "person" class
// is read: no faces, identities or attributes.
//
// Default: RF-DETR Nano (roboflow/rf-detr, Apache-2.0 for N/S/M/L — the larger variants use a
// different licence and are not offered), COCO weights converted to ONNX by onnx-community.
// D-FINE-S (Peterande/D-FINE, Apache-2.0) stays available. D-FINE-N was removed on 16.10.2026:
// the onnx-community export of it missed clearly visible people on real frames (a worker in a
// hi-vis vest scored as "backpack 0.33", COCO 139 person not found) while D-FINE-S and RF-DETR
// found the same people at 0.74–0.99 — see docs/LOCAL_MODELS.md. Checkpoints pre-trained on
// Objects365 are deliberately not offered (their commercial use may be restricted).
export const DETECTORS = {
  "rfdetr-n": {
    repo: "onnx-community/rfdetr_nano-ONNX",
    version: "rfdetr_nano_coco@onnx",
    license: "Apache-2.0 (RF-DETR code and N/S/M/L COCO checkpoints)",
    size: 384,
    // RF-DETR keeps the original COCO category ids: 1 = person.
    person: 1,
  },
  "rfdetr-s": {
    repo: "onnx-community/rfdetr_small-ONNX",
    version: "rfdetr_small_coco@onnx",
    license: "Apache-2.0 (RF-DETR code and N/S/M/L COCO checkpoints)",
    size: 512,
    person: 1,
  },
  "dfine-s": {
    repo: "onnx-community/dfine_s_coco-ONNX",
    version: "dfine_s_coco@onnx",
    license: "Apache-2.0 (D-FINE code and COCO checkpoints)",
    size: 640,
    // D-FINE uses contiguous labels: 0 = person.
    person: 0,
  },
} as const;
export type DetectorKind = keyof typeof DETECTORS;
export const DEFAULT_DETECTOR: DetectorKind = "rfdetr-n";
// Kinds that existed earlier and must not silently map to another model.
export const RETIRED_DETECTORS: Record<string, string> = {
  "dfine-n":
    "dfine-n missed clearly visible people in verification (16.10.2026); use rfdetr-n",
};
export function isDetectorKind(kind: string): kind is DetectorKind {
  return Object.prototype.hasOwnProperty.call(DETECTORS, kind);
}
export interface PersonDetector {
  readonly kind: DetectorKind;
  readonly version: string;
  readonly precision: "fp32" | "int8";
  // The caller feeds RGB frames of exactly this size (the model's own input, stretched).
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
const iou = (a: Detection, b: Detection) => {
  const w = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)),
    h = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)),
    inter = w * h,
    union =
      (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return union > 0 ? inter / union : 0;
};
// DETR-style models are trained to give one box per object, but small ones still return
// near-duplicates at lower scores; each would become a separate track. Greedy suppression keeps
// the strongest box of each overlapping group.
export function suppress(found: Detection[], maxIou = 0.7) {
  const sorted = [...found].sort((a, b) => b.score - a.score),
    kept: Detection[] = [];
  for (const d of sorted)
    if (kept.every((k) => iou(k, d) <= maxIou)) kept.push(d);
  return kept;
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
  if (!isDetectorKind(kind)) throw new Error("DETECTOR_UNKNOWN");
  const spec = DETECTORS[kind],
    precision = o.precision ?? "fp32",
    file = detectorPath(kind, precision, o.dir);
  // A missing model is an explicit error, never a silent switch to the motion detector.
  if (!existsSync(file)) throw new Error("DETECTOR_MODEL_MISSING");
  const ort = await import("onnxruntime-node");
  const session = await ort.InferenceSession.create(file, {
    intraOpNumThreads: o.threads ?? 0,
    graphOptimizationLevel: "all",
  });
  const W = spec.size,
    H = spec.size,
    // Low-score boxes are kept for the tracker's second association step (ByteTrack).
    threshold = o.threshold ?? 0.1,
    input = new Float32Array(3 * W * H);
  let queue: Promise<unknown> = Promise.resolve();
  const run = async (rgb: Uint8Array) => {
    // HWC uint8 → CHW float 0..1 (the models' processors rescale by 1/255, no normalization).
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
      const score = 1 / (1 + Math.exp(-logits[q * classes + spec.person]));
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
    return suppress(found);
  };
  return {
    kind,
    version: `${spec.version}-${precision}`,
    precision,
    width: W,
    height: H,
    detect(rgb) {
      if (rgb.length !== W * H * 3)
        return Promise.reject(new Error("DETECTOR_FRAME_SIZE"));
      // One shared input buffer: concurrent callers (several viewers) are run one at a time.
      const next = queue.then(() => run(rgb));
      queue = next.catch(() => {});
      return next;
    },
    async dispose() {
      await queue;
      await session.release();
    },
  };
}
