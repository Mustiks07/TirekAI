import { expect, it } from "vitest";
import {
  assign,
  ByteTracker,
  type Detection,
} from "../src/server/video/bytetrack";

const box = (
  cx: number,
  cy: number,
  score = 0.9,
  w = 0.06,
  h = 0.2,
): Detection => ({
  x0: cx - w / 2,
  y0: cy - h / 2,
  x1: cx + w / 2,
  y1: cy + h / 2,
  score,
});
it("T057: the assignment is the minimum-cost matching, also for rectangular matrices", () => {
  expect(
    assign([
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ]).sort(),
  ).toEqual([
    [0, 1],
    [1, 0],
    [2, 2],
  ]);
  expect(assign([[0.9, 0.1]])).toEqual([[0, 1]]);
  expect(assign([[0.2], [0.1]])).toEqual([[1, 0]]);
  expect(assign([])).toEqual([]);
});
it("T057: two people walking towards each other keep their own tracks", () => {
  const t = new ByteTracker();
  const seen = new Map<number, number[]>();
  for (let f = 0; f < 40; f++) {
    const a = 0.1 + f * 0.02,
      b = 0.9 - f * 0.02;
    t.update([box(a, 0.5), box(b, 0.52)], f);
    for (const tr of t.tracks)
      seen.set(tr.id, [...(seen.get(tr.id) ?? []), tr.cx]);
  }
  // Exactly two identities over the whole walk, each moving monotonically in its direction.
  expect([...seen.keys()]).toHaveLength(2);
  const dirs = [...seen.values()].map((xs) => Math.sign(xs.at(-1)! - xs[0]));
  expect(dirs.sort()).toEqual([-1, 1]);
});
it("T057: a partly hidden person (low-confidence detections) keeps the track; a gap is bridged", () => {
  const t = new ByteTracker();
  const ids = new Set<number>();
  for (let f = 0; f < 30; f++) {
    const x = 0.2 + f * 0.02;
    // frames 10–14: occluded, the detector is unsure; frames 15–17: not detected at all
    const d =
      f >= 15 && f <= 17 ? [] : [box(x, 0.5, f >= 10 && f < 15 ? 0.3 : 0.85)];
    t.update(d, f);
    for (const tr of t.tracks) ids.add(tr.id);
  }
  expect(ids.size).toBe(1);
  // The re-found track moves from its last seen position: a line in the gap would be crossed once.
  const [tr] = t.tracks;
  expect(tr.cx).toBeGreaterThan(0.7);
});
it("T057: a single spurious detection never becomes a person; a lost track ends after the buffer", () => {
  const t = new ByteTracker();
  t.update([box(0.5, 0.5, 0.95)], 0);
  expect(t.tracks).toHaveLength(0);
  t.update([], 1);
  expect(t.tracks).toHaveLength(0);
  const u = new ByteTracker({
    high: 0.5,
    low: 0.1,
    newTrack: 0.6,
    matchIou: 0.2,
    lowMatchIou: 0.5,
    buffer: 3,
  });
  u.update([box(0.3, 0.5)], 0);
  u.update([box(0.31, 0.5)], 1);
  expect(u.tracks).toHaveLength(1);
  let ended: unknown[] = [];
  for (let f = 2; f < 8 && !ended.length; f++) ended = u.update([], f);
  expect(ended).toHaveLength(1);
  expect(u.tracks).toHaveLength(0);
});
