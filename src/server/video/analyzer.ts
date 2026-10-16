import {
  Background,
  Tracker,
  components,
  dilate,
  crossing,
  frameQuality,
  inside,
  open3,
  type Track,
} from "./cv";
import { ByteTracker, type Detection } from "./bytetrack";
import type { VideoConfig, VideoEvent } from "./processor";

// T035–T038/T057 per-frame analysis shared by the processing device (scripts/video-processor.ts
// via processVideo) and the in-app demo analysis (src/server/video/live-analysis.ts), so a person
// is counted by the same code in both. Input: a small grayscale frame (quality, gaps, shelves,
// workstations) and, in neural mode, person boxes for the same frame. Output: aggregated events and
// a report of the frame (boxes, tracks, zone counts) that never contains image data.
export type FramePerson = {
  id: number;
  // Normalized box of the last detection (neural mode) or blob (motion mode).
  box: [number, number, number, number] | null;
  x: number;
  y: number;
  // false while the tracker keeps a briefly missed person at the last position.
  seen: boolean;
  // Counted in zone figures (a new track needs three frames to count).
  counted: boolean;
  zones: string[];
};
export type FrameReport = {
  index: number;
  at: string;
  usable: boolean;
  // Person boxes at or above the tracker's confident threshold (null in motion mode).
  detections: number | null;
  people: FramePerson[];
  // People counted now: whole frame and per zone.
  visible: number;
  zones: Record<string, number>;
  crossings: Record<string, { in: number; out: number }>;
};
// Running diagnosis of the pipeline: tells "the model does not see people" apart from "the tracker
// drops them", "they are outside the zone" and "no usable frames".
export type Diagnosis = {
  frames: number;
  usable: number;
  withDetections: number;
  withPeople: number;
  inZone: Record<string, number>;
  maxScore: number | null;
};
export const TRACKER_SETTINGS = {
  high: 0.5,
  low: 0.1,
  newTrack: 0.6,
  matchIou: 0.2,
  lowMatchIou: 0.5,
};
export function grayFromRgb(
  rgb: Uint8Array,
  rw: number,
  rh: number,
  w: number,
  h: number,
) {
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(((y + 0.5) * rh) / h);
    for (let x = 0; x < w; x++) {
      const k = (sy * rw + Math.floor(((x + 0.5) * rw) / w)) * 3;
      gray[y * w + x] = (rgb[k] * 77 + rgb[k + 1] * 150 + rgb[k + 2] * 29) >> 8;
    }
  }
  return gray;
}
export class FrameAnalyzer {
  readonly w: number;
  readonly h: number;
  readonly fps: number;
  frames = 0;
  unusable = 0;
  readonly diagnosis: Diagnosis;
  readonly crossings: Record<string, { in: number; out: number }> = {};
  private events: VideoEvent[] = [];
  private seq = 0;
  private bg: Background;
  private tracker: ByteTracker | Tracker;
  private prev: Uint8Array | null = null;
  private hold: Uint8Array | undefined;
  private gapStart: number | null = null;
  private zoneCounts: Record<string, number[]> = {};
  private queueOpen: Record<string, number | null> = {};
  private queueRun: Record<string, number> = {};
  private shelfRef: Record<string, number> = {};
  private shelfRun: Record<string, number> = {};
  private shelfOpen: Record<string, boolean> = {};
  private work: Record<string, { state: boolean; run: number }> = {};
  private zonePixels = new Map<string, number[]>();
  private minArea: number;
  private aggregate: number;
  constructor(
    private o: {
      config: VideoConfig;
      startTime: Date;
      live: boolean;
      neural: boolean;
      width?: number;
      height?: number;
      fps?: number;
      minArea?: number;
      aggregateSeconds?: number;
    },
  ) {
    this.w = o.width ?? 320;
    this.h = o.height ?? 180;
    this.fps = o.fps ?? 10;
    this.minArea = o.minArea ?? Math.round((this.w * this.h) / 900);
    this.aggregate = o.aggregateSeconds ?? 10;
    this.bg = new Background(this.w, this.h);
    this.tracker = o.neural
      ? new ByteTracker({ ...TRACKER_SETTINGS, buffer: 3 * this.fps })
      : new Tracker();
    this.diagnosis = {
      frames: 0,
      usable: 0,
      withDetections: 0,
      withPeople: 0,
      inZone: {},
      maxScore: o.neural ? 0 : null,
    };
    for (const z of o.config.zones) {
      const idx: number[] = [];
      for (let y = 0; y < this.h; y++)
        for (let x = 0; x < this.w; x++)
          if (
            inside({ x: (x + 0.5) / this.w, y: (y + 0.5) / this.h }, z.polygon)
          )
            idx.push(y * this.w + x);
      this.zonePixels.set(z.id, idx);
      this.zoneCounts[z.id] = [];
      this.diagnosis.inZone[z.id] = 0;
    }
    for (const l of o.config.lines) this.crossings[l.id] = { in: 0, out: 0 };
  }
  at(frame: number) {
    return new Date(
      this.o.startTime.getTime() + (frame * 1000) / this.fps,
    ).toISOString();
  }
  // Events produced since the last call.
  take() {
    return this.events.splice(0, this.events.length);
  }
  get tracks(): Track[] {
    return this.tracker.tracks;
  }
  private emit(e: Omit<VideoEvent, "seq">) {
    this.events.push({ ...e, seq: this.seq++ } as VideoEvent);
  }
  private leaveZones(tr: Track, frame: number) {
    for (const [zone, since] of Object.entries(tr.zoneSince)) {
      const seconds = (frame - since) / this.fps;
      if (seconds >= 1)
        this.emit({
          kind: "dwell",
          at: this.at(since),
          zone,
          value: Math.round(seconds * 10) / 10,
          until: this.at(frame),
        });
      delete tr.zoneSince[zone];
    }
  }
  private counted(tr: Track) {
    return tr.age >= 3 && tr.missed <= this.fps;
  }
  step(frame: Uint8Array, people: Detection[] | null = null): FrameReport {
    const { fps, w, h } = this,
      config = this.o.config,
      i = this.frames++;
    this.diagnosis.frames++;
    const q = frameQuality(frame, this.prev);
    this.prev = frame;
    if (q.unusable || (q.frozen && this.o.live)) {
      this.unusable++;
      if (this.gapStart === null) this.gapStart = i;
      return {
        index: i,
        at: this.at(i),
        usable: false,
        detections: null,
        people: [],
        visible: 0,
        zones: {},
        crossings: this.crossings,
      };
    }
    this.diagnosis.usable++;
    if (this.gapStart !== null) {
      // A gap of unusable frames is reported as missing data, never as zero visitors.
      if (i - this.gapStart >= fps)
        this.emit({
          kind: "gap",
          at: this.at(this.gapStart),
          until: this.at(i),
          reason: "unusable_frames",
        });
      this.gapStart = null;
    }
    const mask = open3(this.bg.apply(frame, 28, this.hold), w, h);
    this.hold = dilate(mask, w, h, 2);
    let confident: number | null = null;
    if (people) {
      confident = people.filter((d) => d.score >= TRACKER_SETTINGS.high).length;
      if (confident) this.diagnosis.withDetections++;
      for (const d of people)
        this.diagnosis.maxScore = Math.max(
          this.diagnosis.maxScore ?? 0,
          d.score,
        );
    }
    const tracker = this.tracker;
    const ended =
      people && tracker instanceof ByteTracker
        ? tracker.update(people, i)
        : (tracker as Tracker).update(components(mask, w, h, this.minArea), i);
    for (const tr of ended) this.leaveZones(tr, i);
    for (const tr of tracker.tracks) {
      if (tr.missed > 0 || tr.age < 2) continue;
      for (const line of config.lines) {
        const side = crossing(
          { x: tr.px, y: tr.py },
          { x: tr.cx, y: tr.cy },
          line.a,
          line.b,
        );
        // One count per track and line within two seconds suppresses jitter on the line.
        if (
          side &&
          (tr.crossed[line.id] === undefined ||
            i - tr.crossed[line.id] > 2 * fps)
        ) {
          tr.crossed[line.id] = i;
          const direction = side === line.inSide ? "in" : "out";
          this.crossings[line.id][direction]++;
          this.emit({
            kind: "line_cross",
            at: this.at(i),
            line: line.id,
            direction,
          });
        }
      }
      for (const z of config.zones) {
        const isIn = inside({ x: tr.cx, y: tr.cy }, z.polygon);
        if (isIn && tr.zoneSince[z.id] === undefined) tr.zoneSince[z.id] = i;
        if (!isIn && tr.zoneSince[z.id] !== undefined) {
          const seconds = (i - tr.zoneSince[z.id]) / fps;
          if (seconds >= 1)
            this.emit({
              kind: "dwell",
              at: this.at(tr.zoneSince[z.id]),
              zone: z.id,
              value: Math.round(seconds * 10) / 10,
              until: this.at(i),
            });
          delete tr.zoneSince[z.id];
        }
      }
    }
    const report: FrameReport = {
      index: i,
      at: this.at(i),
      usable: true,
      detections: confident,
      people: tracker.tracks
        .filter((tr) => tr.missed <= fps)
        .map((tr) => ({
          id: tr.id,
          box: tr.box ?? null,
          x: tr.cx,
          y: tr.cy,
          seen: tr.missed === 0,
          counted: this.counted(tr),
          zones: config.zones
            .filter((z) => inside({ x: tr.cx, y: tr.cy }, z.polygon))
            .map((z) => z.id),
        })),
      visible: 0,
      zones: {},
      crossings: this.crossings,
    };
    report.visible = report.people.filter((p) => p.counted).length;
    if (report.visible) this.diagnosis.withPeople++;
    for (const z of config.zones) {
      // A live track counts at its last position while briefly missed (≤ tracker tolerance).
      const visible = report.people.filter(
        (p) => p.counted && p.zones.includes(z.id),
      ).length;
      report.zones[z.id] = visible;
      if (visible) this.diagnosis.inZone[z.id]++;
      this.zoneCounts[z.id].push(visible);
      if (z.kind === "queue") {
        const min = z.queueMin ?? 3,
          hold = (z.queueSeconds ?? 10) * fps;
        this.queueRun[z.id] =
          visible >= min ? (this.queueRun[z.id] || 0) + 1 : 0;
        if (this.queueRun[z.id] >= hold && this.queueOpen[z.id] == null) {
          this.queueOpen[z.id] = i - hold + 1;
          this.emit({
            kind: "queue_start",
            at: this.at(i - hold + 1),
            zone: z.id,
            value: visible,
          });
        }
        if (visible < min && this.queueOpen[z.id] != null) {
          this.emit({
            kind: "queue_end",
            at: this.at(i),
            zone: z.id,
            value: (i - this.queueOpen[z.id]!) / fps,
          });
          this.queueOpen[z.id] = null;
        }
      }
      if (z.kind === "shelf" || z.kind === "workstation") {
        const px = this.zonePixels.get(z.id)!;
        let changed = 0;
        for (const p of px) if (mask[p]) changed++;
        const share = px.length ? changed / px.length : 0;
        if (z.kind === "shelf") {
          // The first seconds are the reference ("as configured"); a lasting change with nobody
          // in front is a signal to check the shelf — never a stock movement.
          if (i < 3 * fps) this.shelfRef[z.id] = share;
          // People in front move; a changed shelf is a static blob that does not.
          const movers = tracker.tracks.filter(
            (tr) =>
              tr.travel > 0.05 && inside({ x: tr.cx, y: tr.cy }, z.polygon),
          ).length;
          const lasting = share > 0.35 && movers === 0;
          this.shelfRun[z.id] = lasting ? (this.shelfRun[z.id] || 0) + 1 : 0;
          if (this.shelfRun[z.id] >= 5 * fps && !this.shelfOpen[z.id]) {
            this.shelfOpen[z.id] = true;
            this.emit({
              kind: "shelf_change_suspected",
              at: this.at(i),
              zone: z.id,
              value: Math.round(share * 100) / 100,
            });
          }
          if (!lasting) this.shelfOpen[z.id] = false;
        } else {
          const occupied = visible > 0 || share > 0.2;
          const s = (this.work[z.id] ||= { state: false, run: 0 });
          s.run = occupied !== s.state ? s.run + 1 : 0;
          if (s.run >= 3 * fps) {
            s.state = occupied;
            s.run = 0;
            this.emit({
              kind: "workstation_state",
              at: this.at(i),
              zone: z.id,
              value: occupied ? 1 : 0,
            });
          }
        }
      }
    }
    if (this.frames % (this.aggregate * fps) === 0) this.aggregateZones(i);
    return report;
  }
  // Zone averages since the last aggregate (history and hourly figures; never the live count).
  private aggregateZones(i: number) {
    for (const z of this.o.config.zones) {
      const c = this.zoneCounts[z.id];
      if (c.length)
        this.emit({
          kind: "zone_count",
          at: this.at(i - c.length + 1),
          until: this.at(i + 1),
          zone: z.id,
          value:
            Math.round((c.reduce((a, b) => a + b, 0) / c.length) * 100) / 100,
        });
      this.zoneCounts[z.id] = [];
    }
  }
  get aggregateDue() {
    return this.frames > 0 && this.frames % (this.aggregate * this.fps) === 0;
  }
  // End of input: open dwell, queues and gaps are closed at the last frame.
  finish(ended: "end_of_stream" | "aborted" | "signal_lost" | "decoder_error") {
    const frames = this.frames;
    for (const tr of this.tracker.tracks) this.leaveZones(tr, frames);
    for (const z of this.o.config.zones)
      if (this.queueOpen[z.id] != null)
        this.emit({
          kind: "queue_end",
          at: this.at(frames),
          zone: z.id,
          value: (frames - this.queueOpen[z.id]!) / this.fps,
        });
    if (this.gapStart !== null && frames - this.gapStart >= this.fps)
      this.emit({
        kind: "gap",
        at: this.at(this.gapStart),
        until: this.at(frames),
        reason: "unusable_frames",
      });
    // A lost live stream is an explicit event: the period after it has no data.
    if (ended === "signal_lost" || ended === "decoder_error")
      this.emit({ kind: "signal_lost", at: this.at(frames), reason: ended });
  }
}
// The first broken link of the chain frame → model → tracker → zone, for the operator.
export type DiagnosisCode =
  | "no_frames"
  | "unusable_frames"
  | "model_sees_nobody"
  | "tracker_drops"
  | "outside_zone"
  | "ok";
export function explain(d: Diagnosis): DiagnosisCode {
  if (!d.frames) return "no_frames";
  if (!d.usable) return "unusable_frames";
  if (d.maxScore !== null && !d.withDetections) return "model_sees_nobody";
  if (!d.withPeople) return "tracker_drops";
  const zones = Object.values(d.inZone);
  if (zones.length && zones.every((n) => n === 0)) return "outside_zone";
  return "ok";
}
