// T035–T037 vision core: classical, explainable and dependency-free. Frames are 8-bit grayscale
// at a small working size. No faces, identities or attributes are computed — only moving blobs,
// their tracks and their relation to configured lines and zones.
export type Point = { x: number; y: number };
export type Blob = {
  cx: number;
  cy: number;
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};
export type Track = {
  id: number;
  cx: number;
  cy: number;
  px: number;
  py: number;
  age: number;
  missed: number;
  area: number;
  // Total distance travelled: a static scene change has ~0, a person has more.
  travel: number;
  firstSeen: number;
  zoneSince: Record<string, number>;
  crossed: Record<string, number>;
};
// Running-average background with a frozen update under moving objects.
export class Background {
  private model: Float32Array | null = null;
  constructor(
    private width: number,
    private height: number,
    private rate = 0.02,
  ) {}
  get ready() {
    return this.model !== null;
  }
  // Returns the foreground mask (1 = moving) and updates the model where nothing moves. Pixels
  // under recent foreground (`hold`) are not learned, so a standing person does not fade away.
  apply(frame: Uint8Array, threshold = 28, hold?: Uint8Array) {
    const n = this.width * this.height;
    const mask = new Uint8Array(n);
    if (!this.model) {
      this.model = Float32Array.from(frame);
      return mask;
    }
    const m = this.model;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(frame[i] - m[i]);
      if (d > threshold) mask[i] = 1;
      // Foreground and its margin learn 50× slower: a person standing for a minute stays
      // visible, while a lasting scene change is absorbed over several minutes.
      const slow = d > threshold || (hold !== undefined && hold[i] === 1);
      m[i] += (slow ? this.rate / 50 : this.rate) * (frame[i] - m[i]);
    }
    return mask;
  }
}
// 3×3 binary opening (erode then dilate) removes speckle noise without moving blob centres.
export function open3(mask: Uint8Array, w: number, h: number) {
  const er = new Uint8Array(mask.length),
    out = new Uint8Array(mask.length);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (!mask[(y + dy) * w + x + dx]) {
            all = 0;
            break;
          }
      er[y * w + x] = all;
    }
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      let any = 0;
      for (let dy = -1; dy <= 1 && !any; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (er[(y + dy) * w + x + dx]) {
            any = 1;
            break;
          }
      out[y * w + x] = any;
    }
  return out;
}
// Square dilation by r pixels: a protective margin around foreground.
export function dilate(mask: Uint8Array, w: number, h: number, r: number) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++)
        out.fill(
          1,
          yy * w + Math.max(0, x - r),
          yy * w + Math.min(w - 1, x + r) + 1,
        );
    }
  return out;
}
// Two-pass connected components (4-connectivity) with union-find; small blobs are dropped.
export function components(
  mask: Uint8Array,
  w: number,
  h: number,
  minArea: number,
) {
  const labels = new Int32Array(mask.length);
  const parent: number[] = [0];
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const up = y > 0 ? labels[i - w] : 0,
        left = x > 0 ? labels[i - 1] : 0;
      if (!up && !left) {
        parent.push(parent.length);
        labels[i] = parent.length - 1;
      } else if (up && left) {
        const a = find(up),
          b = find(left);
        labels[i] = Math.min(a, b);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      } else labels[i] = up || left;
    }
  const acc = new Map<
    number,
    {
      sx: number;
      sy: number;
      n: number;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    }
  >();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x];
      if (!l) continue;
      const r = find(l);
      const a = acc.get(r) || {
        sx: 0,
        sy: 0,
        n: 0,
        x0: x,
        y0: y,
        x1: x,
        y1: y,
      };
      a.sx += x;
      a.sy += y;
      a.n++;
      a.x0 = Math.min(a.x0, x);
      a.y0 = Math.min(a.y0, y);
      a.x1 = Math.max(a.x1, x);
      a.y1 = Math.max(a.y1, y);
      acc.set(r, a);
    }
  const out: Blob[] = [];
  for (const a of acc.values())
    if (a.n >= minArea)
      out.push({
        cx: a.sx / a.n / w,
        cy: a.sy / a.n / h,
        area: a.n,
        x0: a.x0 / w,
        y0: a.y0 / h,
        x1: a.x1 / w,
        y1: a.y1 / h,
      });
  return out;
}
// Greedy nearest-neighbour association in normalised coordinates. A track that is not seen for
// `maxMissed` frames ends; a re-appearing person gets a new track (not a "unique visitor").
export class Tracker {
  private next = 1;
  tracks: Track[] = [];
  constructor(
    private maxDistance = 0.12,
    private maxMissed = 6,
  ) {}
  update(blobs: Blob[], t: number) {
    const pairs: { d: number; ti: number; bi: number }[] = [];
    this.tracks.forEach((tr, ti) =>
      blobs.forEach((b, bi) => {
        const d = Math.hypot(tr.cx - b.cx, tr.cy - b.cy);
        if (d <= this.maxDistance) pairs.push({ d, ti, bi });
      }),
    );
    pairs.sort((a, b) => a.d - b.d);
    const usedT = new Set<number>(),
      usedB = new Set<number>();
    for (const p of pairs) {
      if (usedT.has(p.ti) || usedB.has(p.bi)) continue;
      usedT.add(p.ti);
      usedB.add(p.bi);
      const tr = this.tracks[p.ti],
        b = blobs[p.bi];
      tr.px = tr.cx;
      tr.py = tr.cy;
      tr.travel += Math.hypot(b.cx - tr.cx, b.cy - tr.cy);
      tr.cx = b.cx;
      tr.cy = b.cy;
      tr.area = b.area;
      tr.age++;
      tr.missed = 0;
    }
    this.tracks.forEach((tr, ti) => {
      if (!usedT.has(ti)) {
        tr.missed++;
        tr.px = tr.cx;
        tr.py = tr.cy;
      }
    });
    const ended = this.tracks.filter((tr) => tr.missed > this.maxMissed);
    this.tracks = this.tracks.filter((tr) => tr.missed <= this.maxMissed);
    blobs.forEach((b, bi) => {
      if (usedB.has(bi)) return;
      this.tracks.push({
        id: this.next++,
        cx: b.cx,
        cy: b.cy,
        px: b.cx,
        py: b.cy,
        age: 1,
        missed: 0,
        area: b.area,
        travel: 0,
        firstSeen: t,
        zoneSince: {},
        crossed: {},
      });
    });
    return ended;
  }
}
const cross = (o: Point, a: Point, b: Point) =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
// Segment p→q crosses line a–b; the sign says from which side (+1 / −1), 0 = no crossing.
// A point exactly on the line belongs to the non-negative side, so a track that stops on the
// line for one frame is counted once (on the step that actually changes side), never zero times.
export function crossing(p: Point, q: Point, a: Point, b: Point) {
  const d1 = cross(a, b, p),
    d2 = cross(a, b, q),
    d3 = cross(p, q, a),
    d4 = cross(p, q, b);
  if (d1 < 0 !== d2 < 0 && d3 * d4 <= 0) return d1 < 0 ? 1 : -1;
  return 0;
}
export function inside(p: Point, polygon: Point[]) {
  let c = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      c = !c;
  }
  return c;
}
// Frame quality: too dark, washed out or frozen frames are unusable and become gaps, not zeros.
export function frameQuality(frame: Uint8Array, previous: Uint8Array | null) {
  let sum = 0,
    diff = 0;
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i];
    if (previous) diff += Math.abs(frame[i] - previous[i]);
  }
  const mean = sum / frame.length;
  return {
    mean,
    unusable: mean < 12 || mean > 243,
    frozen: previous !== null && diff === 0,
  };
}
