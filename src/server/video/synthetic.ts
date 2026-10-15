import { spawn } from "node:child_process";
import type { VideoConfig } from "./processor";

// Synthetic, labelled lab clips for the T037 evaluation protocol. They are rendered video files
// processed exactly like any recording; the ground truth comes from the renderer, not from the
// detector. They do not replace evaluation on permitted real recordings.
export type Truth = {
  crossings: { t: number; line: string; direction: "in" | "out" }[];
  queues: { from: number; to: number; zone: string }[];
};
type Walker = {
  start: number;
  speed: number;
  y: number;
  dir: 1 | -1;
  w: number;
  h: number;
  shade: number;
};
type Stander = {
  from: number;
  to: number;
  x: number;
  y: number;
  shade: number;
};
export type Clip = {
  name: string;
  scenario: "single" | "opposing" | "overlap" | "queue";
  seconds: number;
  walkers: Walker[];
  standers: Stander[];
  drift: boolean;
  // Unusable stretches (camera covered / no light): rendered black.
  dark?: { from: number; to: number }[];
  // A lasting visual change of a shelf area from `at` on (goods taken away), for T038.
  shelfChange?: { at: number; x0: number; y0: number; x1: number; y1: number; shade: number };
};
const W = 320,
  H = 180,
  FPS = 10;
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
export const LAB_CONFIG: VideoConfig = {
  version: 1,
  lines: [
    {
      id: "door",
      name: "Вход",
      a: { x: 0.5, y: 0.05 },
      b: { x: 0.5, y: 0.95 },
      inSide: 1,
    },
  ],
  zones: [
    {
      id: "queue",
      name: "Касса",
      polygon: [
        { x: 0.04, y: 0.1 },
        { x: 0.3, y: 0.1 },
        { x: 0.3, y: 0.9 },
        { x: 0.04, y: 0.9 },
      ],
      kind: "queue",
      queueMin: 3,
      queueSeconds: 10,
    },
  ],
};
// Four clips: single passes, opposing traffic, close pairs/overlaps and a queue zone. Together
// they contain more than 100 line crossings.
export function labClips(seed = 2026): Clip[] {
  const r = rng(seed);
  const walkers = (
    n: number,
    gap: number,
    opts: (i: number) => Partial<Walker>,
  ) =>
    Array.from({ length: n }, (_, i) => ({
      start: 1 + i * gap + r() * 0.5,
      speed: 0.09 + r() * 0.05,
      y: 0.25 + r() * 0.5,
      dir: (r() < 0.5 ? 1 : -1) as 1 | -1,
      w: 0.045 + r() * 0.01,
      h: 0.2 + r() * 0.05,
      shade: r() < 0.5 ? 40 + r() * 30 : 200 + r() * 30,
      ...opts(i),
    }));
  return [
    {
      name: "lab-single",
      scenario: "single",
      seconds: 260,
      walkers: walkers(40, 6.2, () => ({})),
      standers: [],
      drift: false,
    },
    {
      name: "lab-opposing",
      scenario: "opposing",
      seconds: 200,
      walkers: walkers(40, 4.8, (i) => ({
        dir: (i % 2 ? 1 : -1) as 1 | -1,
        y: i % 2 ? 0.3 + r() * 0.1 : 0.62 + r() * 0.1,
        start: 1 + Math.floor(i / 2) * 9.5 + (i % 2) * 0.4,
      })),
      standers: [],
      drift: false,
    },
    {
      name: "lab-overlap",
      scenario: "overlap",
      seconds: 220,
      walkers: walkers(32, 6.5, (i) => ({
        dir: (Math.floor(i / 2) % 2 ? 1 : -1) as 1 | -1,
        y: i % 2 ? 0.36 : 0.62,
        start: 1 + Math.floor(i / 2) * 13 + (i % 2) * 0.9,
      })),
      standers: [],
      drift: true,
    },
    {
      name: "lab-queue",
      scenario: "queue",
      seconds: 180,
      walkers: [],
      standers: [
        { from: 10, to: 60, x: 0.1, y: 0.3, shade: 60 },
        { from: 14, to: 55, x: 0.17, y: 0.5, shade: 210 },
        { from: 18, to: 48, x: 0.24, y: 0.7, shade: 70 },
        { from: 90, to: 140, x: 0.1, y: 0.25, shade: 205 },
        { from: 92, to: 130, x: 0.18, y: 0.5, shade: 55 },
        { from: 95, to: 125, x: 0.25, y: 0.72, shade: 215 },
        { from: 100, to: 112, x: 0.1, y: 0.78, shade: 65 },
        { from: 150, to: 158, x: 0.12, y: 0.4, shade: 60 },
      ],
      drift: false,
    },
  ];
}
// Positions of walkers at time t (normalised); used by both the renderer and the ground truth.
const xAt = (wk: Walker, t: number) =>
  wk.dir === 1
    ? -0.08 + (t - wk.start) * wk.speed
    : 1.08 - (t - wk.start) * wk.speed;
export function truthOf(clip: Clip, config = LAB_CONFIG): Truth {
  const crossings: Truth["crossings"] = [];
  for (const wk of clip.walkers) {
    // Both directions travel 0.58 of the width to the line at x = 0.5.
    const t = wk.start + 0.58 / wk.speed;
    // Moving left→right crosses the vertical line from its negative side (see cv.crossing).
    const side = wk.dir === 1 ? -1 : 1;
    if (t < clip.seconds - 0.5)
      crossings.push({
        t,
        line: "door",
        direction: side === config.lines[0].inSide ? "in" : "out",
      });
  }
  // Queue truth: at least queueMin people in the zone for queueSeconds.
  const queues: Truth["queues"] = [];
  const z = config.zones[0];
  let open: number | null = null;
  for (let f = 0; f <= clip.seconds * FPS; f++) {
    const t = f / FPS;
    const n = clip.standers.filter((s) => t >= s.from && t < s.to).length;
    if (n >= (z.queueMin ?? 3) && open === null) open = t;
    if (n < (z.queueMin ?? 3) && open !== null) {
      if (t - open >= (z.queueSeconds ?? 10))
        queues.push({ from: open, to: t, zone: z.id });
      open = null;
    }
  }
  return { crossings: crossings.sort((a, b) => a.t - b.t), queues };
}
function render(clip: Clip, f: number, base: Uint8Array, noise: () => number) {
  const t = f / FPS,
    out = new Uint8Array(W * H);
  if (clip.dark?.some((d) => t >= d.from && t < d.to)) return out;
  const light = clip.drift ? Math.sin(t / 40) * 12 : 0;
  for (let i = 0; i < out.length; i++)
    out[i] = Math.max(0, Math.min(255, base[i] + light + (noise() - 0.5) * 6));
  const blob = (
    cx: number,
    cy: number,
    rw: number,
    rh: number,
    shade: number,
  ) => {
    const x0 = Math.floor((cx - rw) * W),
      x1 = Math.ceil((cx + rw) * W),
      y0 = Math.floor((cy - rh) * H),
      y1 = Math.ceil((cy + rh) * H);
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
        const dx = (x / W - cx) / rw,
          dy = (y / H - cy) / rh;
        if (dx * dx + dy * dy <= 1)
          out[y * W + x] = Math.max(
            0,
            Math.min(255, shade + ((x + y) % 7) * 3),
          );
      }
  };
  const sc = clip.shelfChange;
  if (sc && t >= sc.at)
    for (let y = Math.floor(sc.y0 * H); y < Math.ceil(sc.y1 * H); y++)
      for (let x = Math.floor(sc.x0 * W); x < Math.ceil(sc.x1 * W); x++) out[y * W + x] = sc.shade;
  for (const wk of clip.walkers) {
    const x = xAt(wk, t);
    if (t >= wk.start && x > -0.1 && x < 1.1)
      blob(x, wk.y + Math.sin(t * 6) * 0.004, wk.w, wk.h / 2, wk.shade);
  }
  for (const s of clip.standers)
    if (t >= s.from && t < s.to)
      blob(s.x + Math.sin(t * 2) * 0.003, s.y, 0.04, 0.1, s.shade);
  return out;
}
export async function renderClip(
  clip: Clip,
  file: string,
  ffmpeg = process.env.FFMPEG_PATH || "ffmpeg",
  seed = 7,
) {
  const r = rng(seed),
    base = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      base[y * W + x] =
        110 +
        Math.round(30 * Math.sin(x / 23) * Math.cos(y / 17)) +
        (((x >> 4) + (y >> 4)) % 2) * 8;
  const child = spawn(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-s",
      `${W}x${H}`,
      "-r",
      String(FPS),
      "-i",
      "pipe:0",
      "-c:v",
      "mpeg4",
      "-q:v",
      "3",
      "-pix_fmt",
      "yuv420p",
      file,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const done = new Promise<void>((resolve, reject) =>
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg ${code}: ${err.slice(0, 200)}`)),
    ),
  );
  for (let f = 0; f < clip.seconds * FPS; f++) {
    const ok = child.stdin.write(Buffer.from(render(clip, f, base, r)));
    if (!ok) await new Promise((res) => child.stdin.once("drain", res));
  }
  child.stdin.end();
  await done;
  return truthOf(clip);
}
