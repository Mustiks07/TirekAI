import type { RunSummary, VideoEvent } from "./processor";
import type { Truth } from "./synthetic";

// T037 evaluation protocol (SPECIFICATION §13): ≥3 labelled clips, ≥100 crossing events in
// total; per usable clip the absolute count error ≤ 10 %; queue-event F1 ≥ 0.85. Latency, FPS,
// hardware and unusable frames are measured. "validated" additionally requires permitted real
// recordings: a synthetic lab set can at most confirm the pipeline (status stays experimental).
export type ClipResult = {
  clip: string;
  scenario: string;
  truthCrossings: number;
  detectedCrossings: number;
  matched: number;
  countError: number;
  precision: number;
  recall: number;
  truthQueues: number;
  detectedQueues: number;
  queueMatched: number;
  run: Pick<RunSummary, "frames" | "unusable" | "fps" | "latencyMs" | "ended">;
};
export function scoreClip(
  clip: string,
  scenario: string,
  truth: Truth,
  events: VideoEvent[],
  run: RunSummary,
  start: Date,
): ClipResult {
  const t = (iso: string) => (new Date(iso).getTime() - start.getTime()) / 1000;
  const detected = events.filter((e) => e.kind === "line_cross");
  const used = new Set<number>();
  let matched = 0;
  for (const g of truth.crossings) {
    let best = -1,
      bestD = 1.0;
    detected.forEach((d, i) => {
      const dt = Math.abs(t(d.at) - g.t);
      if (
        !used.has(i) &&
        d.line === g.line &&
        d.direction === g.direction &&
        dt <= bestD
      ) {
        best = i;
        bestD = dt;
      }
    });
    if (best >= 0) {
      used.add(best);
      matched++;
    }
  }
  const qs = events.filter((e) => e.kind === "queue_start");
  const qe = events.filter((e) => e.kind === "queue_end");
  const intervals = qs.map((s, i) => ({
    from: t(s.at),
    to: qe[i] ? t(qe[i].at) : Infinity,
    zone: s.zone,
  }));
  const usedQ = new Set<number>();
  let qMatched = 0;
  for (const g of truth.queues) {
    const k = intervals.findIndex(
      (d, i) =>
        !usedQ.has(i) && d.zone === g.zone && d.from < g.to && d.to > g.from,
    );
    if (k >= 0) {
      usedQ.add(k);
      qMatched++;
    }
  }
  const n = truth.crossings.length;
  return {
    clip,
    scenario,
    truthCrossings: n,
    detectedCrossings: detected.length,
    matched,
    countError: n ? Math.abs(detected.length - n) / n : detected.length ? 1 : 0,
    precision: detected.length ? matched / detected.length : n ? 0 : 1,
    recall: n ? matched / n : 1,
    truthQueues: truth.queues.length,
    detectedQueues: intervals.length,
    queueMatched: qMatched,
    run: {
      frames: run.frames,
      unusable: run.unusable,
      fps: run.fps,
      latencyMs: run.latencyMs,
      ended: run.ended,
    },
  };
}
export type Evaluation = {
  detector: string;
  dataset: {
    name: string;
    kind: "synthetic_lab" | "recorded";
    clips: number;
    crossings: number;
  };
  thresholds: {
    maxCountError: number;
    minQueueF1: number;
    minClips: number;
    minCrossings: number;
  };
  metrics: {
    maxCountError: number | null;
    queueF1: number | null;
    meanFps: number;
    meanLatencyMs: number;
  };
  passed: boolean;
  status: "experimental" | "validated";
  reason: string;
};
const f1 = (tp: number, det: number, truth: number) => {
  const p = det ? tp / det : 0,
    r = truth ? tp / truth : 0;
  return p + r ? (2 * p * r) / (p + r) : 0;
};
export function judge(
  results: ClipResult[],
  dataset: { name: string; kind: "synthetic_lab" | "recorded" },
) {
  const thresholds = {
    maxCountError: 0.1,
    minClips: 3,
    minCrossings: 100,
    minQueueF1: 0.85,
  };
  const crossingClips = results.filter((r) => r.truthCrossings > 0),
    crossings = crossingClips.reduce((a, r) => a + r.truthCrossings, 0);
  const maxErr = crossingClips.length
    ? Math.max(...crossingClips.map((r) => r.countError))
    : null;
  const queueClips = results.filter((r) => r.truthQueues > 0);
  const qF1 = queueClips.length
    ? f1(
        queueClips.reduce((a, r) => a + r.queueMatched, 0),
        queueClips.reduce((a, r) => a + r.detectedQueues, 0),
        queueClips.reduce((a, r) => a + r.truthQueues, 0),
      )
    : null;
  const meanFps =
      results.reduce((a, r) => a + r.run.fps, 0) / Math.max(results.length, 1),
    meanLatencyMs =
      results.reduce((a, r) => a + r.run.latencyMs, 0) /
      Math.max(results.length, 1);
  const out: Evaluation[] = [];
  const decide = (
    detector: string,
    passed: boolean,
    enough: boolean,
    metrics: Evaluation["metrics"],
  ) => {
    const real = dataset.kind === "recorded";
    out.push({
      detector,
      dataset: { ...dataset, clips: results.length, crossings },
      thresholds,
      metrics,
      passed: passed && enough,
      status: passed && enough && real ? "validated" : "experimental",
      reason: !enough
        ? "dataset_too_small"
        : !passed
          ? "thresholds_not_met"
          : real
            ? "thresholds_met"
            : "thresholds_met_on_synthetic_only",
    });
  };
  decide(
    "line_crossing",
    maxErr !== null && maxErr <= thresholds.maxCountError,
    crossingClips.length >= thresholds.minClips &&
      crossings >= thresholds.minCrossings,
    {
      maxCountError: maxErr,
      queueF1: null,
      meanFps,
      meanLatencyMs,
    },
  );
  decide(
    "queue",
    qF1 !== null && qF1 >= thresholds.minQueueF1,
    queueClips.length >= 1,
    { maxCountError: null, queueF1: qF1, meanFps, meanLatencyMs },
  );
  return out;
}
