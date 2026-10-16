import type { Track } from "./cv";

// T057 multi-object tracker in the style of ByteTrack (Zhang et al., 2022: "ByteTrack: Multi-Object
// Tracking by Associating Every Detection Box"); own implementation of the published algorithm.
// High-confidence detections are matched first, then low-confidence ones are used to keep existing
// tracks alive through partial occlusion, which a person detector produces often. Positions are
// normalized frame coordinates (0..1), the same as the motion tracker, so lines, zones, dwell and
// queues are computed by unchanged code. No appearance features, faces or identities are used.
export type Detection = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number;
};
type Box = [number, number, number, number]; // cx, cy, w, h
// Constant-velocity Kalman filter per coordinate (position + velocity).
class Axis {
  v = 0;
  p = [
    [1, 0],
    [0, 1],
  ];
  constructor(
    public x: number,
    private q: number,
    private r: number,
  ) {}
  predict() {
    this.x += this.v;
    const [[a, b], [c, d]] = this.p;
    this.p = [
      [a + b + c + d + this.q, b + d],
      [c + d, d + this.q],
    ];
  }
  correct(z: number) {
    const [[a, b], [c, d]] = this.p,
      s = a + this.r,
      k0 = a / s,
      k1 = c / s,
      e = z - this.x;
    this.x += k0 * e;
    this.v += k1 * e;
    this.p = [
      [(1 - k0) * a, (1 - k0) * b],
      [c - k1 * a, d - k1 * b],
    ];
  }
}
type State = Track & {
  kf: Axis[];
  hits: number;
  confirmed: boolean;
  lost: number; // frames since last match
};
const toBox = (d: Detection): Box => [
  (d.x0 + d.x1) / 2,
  (d.y0 + d.y1) / 2,
  d.x1 - d.x0,
  d.y1 - d.y0,
];
function iou(a: Box, b: Box) {
  const ax0 = a[0] - a[2] / 2,
    ax1 = a[0] + a[2] / 2,
    ay0 = a[1] - a[3] / 2,
    ay1 = a[1] + a[3] / 2,
    bx0 = b[0] - b[2] / 2,
    bx1 = b[0] + b[2] / 2,
    by0 = b[1] - b[3] / 2,
    by1 = b[1] + b[3] / 2;
  const w = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0)),
    h = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0)),
    inter = w * h,
    union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}
// Minimum-cost assignment (Hungarian method) on a rectangular cost matrix.
export function assign(cost: number[][]): [number, number][] {
  const n = cost.length,
    m = n ? cost[0].length : 0;
  if (!n || !m) return [];
  const size = Math.max(n, m),
    big = 1e9;
  const c = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => (i < n && j < m ? cost[i][j] : big)),
  );
  const u = new Array(size + 1).fill(0),
    v = new Array(size + 1).fill(0),
    p = new Array(size + 1).fill(0),
    way = new Array(size + 1).fill(0);
  for (let i = 1; i <= size; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(size + 1).fill(Infinity),
      used = new Array(size + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity,
        j1 = 0;
      for (let j = 1; j <= size; j++)
        if (!used[j]) {
          const cur = c[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
      for (let j = 0; j <= size; j++)
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const out: [number, number][] = [];
  for (let j = 1; j <= size; j++)
    if (p[j] && p[j] <= n && j <= m && c[p[j] - 1][j - 1] < big)
      out.push([p[j] - 1, j - 1]);
  return out;
}
export class ByteTracker {
  private next = 1;
  private states: State[] = [];
  constructor(
    private o = {
      high: 0.5,
      low: 0.1,
      newTrack: 0.6,
      matchIou: 0.2,
      lowMatchIou: 0.5,
      // Frames a lost track is kept for re-association (≈3 s at 10 fps).
      buffer: 30,
    },
  ) {}
  // Confirmed tracks only: a single unconfirmed detection is not a person yet.
  get tracks(): Track[] {
    return this.states.filter((s) => s.confirmed);
  }
  private box(s: State): Box {
    return [
      s.kf[0].x,
      s.kf[1].x,
      Math.max(1e-4, s.kf[2].x),
      Math.max(1e-4, s.kf[3].x),
    ];
  }
  private hit(s: State, d: Detection) {
    const b = toBox(d);
    s.kf.forEach((k, i) => k.correct(b[i]));
    s.px = s.cx;
    s.py = s.cy;
    s.travel += Math.hypot(b[0] - s.cx, b[1] - s.cy);
    s.cx = b[0];
    s.cy = b[1];
    s.area = b[2] * b[3];
    s.box = [d.x0, d.y0, d.x1, d.y1];
    s.age++;
    s.hits++;
    s.missed = 0;
    s.lost = 0;
    if (s.hits >= 2) s.confirmed = true;
  }
  private match(states: State[], dets: Detection[], minIou: number) {
    const cost = states.map((s) =>
      dets.map((d) => 1 - iou(this.box(s), toBox(d))),
    );
    const pairs = assign(cost).filter(([i, j]) => 1 - cost[i][j] >= minIou);
    for (const [i, j] of pairs) this.hit(states[i], dets[j]);
    return {
      states: states.filter((_, i) => !pairs.some(([k]) => k === i)),
      dets: dets.filter((_, j) => !pairs.some(([, k]) => k === j)),
    };
  }
  update(detections: Detection[], t: number) {
    for (const s of this.states) s.kf.forEach((k) => k.predict());
    const high = detections.filter((d) => d.score >= this.o.high),
      low = detections.filter(
        (d) => d.score >= this.o.low && d.score < this.o.high,
      );
    const confirmed = this.states.filter((s) => s.confirmed),
      tentative = this.states.filter((s) => !s.confirmed);
    // 1) confirmed (active and lost) ↔ high; 2) still unmatched active ↔ low; 3) tentative ↔ rest.
    const first = this.match(confirmed, high, this.o.matchIou);
    const active = first.states.filter((s) => s.lost === 0);
    const second = this.match(active, low, this.o.lowMatchIou);
    const third = this.match(tentative, first.dets, 0.3);
    const unmatched = new Set([
      ...first.states.filter((s) => s.lost > 0),
      ...second.states,
      ...third.states,
    ]);
    for (const s of unmatched) {
      s.lost++;
      s.missed++;
      // No movement while unseen: a crossing is counted when the track is found again.
      s.px = s.cx;
      s.py = s.cy;
    }
    const ended = this.states.filter(
      (s) =>
        (!s.confirmed && unmatched.has(s)) ||
        (s.confirmed && s.lost > this.o.buffer),
    );
    this.states = this.states.filter((s) => !ended.includes(s));
    for (const d of third.dets) {
      if (d.score < this.o.newTrack) continue;
      const b = toBox(d);
      this.states.push({
        id: this.next++,
        cx: b[0],
        cy: b[1],
        px: b[0],
        py: b[1],
        age: 1,
        missed: 0,
        area: b[2] * b[3],
        box: [d.x0, d.y0, d.x1, d.y1],
        travel: 0,
        firstSeen: t,
        zoneSince: {},
        crossed: {},
        kf: b.map(
          (x, i) => new Axis(x, i < 2 ? 1e-4 : 1e-5, i < 2 ? 1e-4 : 4e-4),
        ),
        hits: 1,
        confirmed: false,
        lost: 0,
      });
    }
    return ended.filter((s) => s.confirmed) as Track[];
  }
}
