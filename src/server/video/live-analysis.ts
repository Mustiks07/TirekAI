import { randomUUID } from "node:crypto";
import type { Database } from "../db/database";
import { sessionAccess, audit, type Credential } from "../access";
import { AppError } from "../../domain/errors";
import { idSchema } from "../../domain/contracts";
import { liveFrameInput, liveStartInput } from "../../domain/video";
import { FrameAnalyzer, grayFromRgb, type Diagnosis } from "./analyzer";
import {
  DEFAULT_DETECTOR,
  isDetectorKind,
  loadDetector,
  type PersonDetector,
} from "./detector";
import type { Detection } from "./bytetrack";

// T057 analysis inside the app ("check on video"): the user's browser sends frames of its own
// camera or of a file the user chose, at the detector's input size; the server runs the same
// detector, tracker and line/zone code as the processing device and returns boxes and counts to
// that same user. Frames are never stored or logged and are dropped after analysis; sessions
// live in memory and end after a minute without frames. This is a demonstration and check tool,
// not the measurement record: its counts are not written to the camera history.
const IDLE_MS = 60_000,
  MAX_SESSIONS = 4;
type Session = {
  id: string;
  key: string;
  org: string;
  user: string;
  kind: "camera" | "file";
  fps: number;
  analyzer: FrameAnalyzer;
  last: number;
  busy: boolean;
  firstSeen: Map<number, number>;
  lastSeen: Map<number, number>;
  counted: Set<number>;
  dwell: number[];
  peak: number;
  ms: number[];
};
export type LiveFrame = {
  index: number;
  ms: number;
  visible: number;
  zones: Record<string, number>;
  crossings: Record<string, { in: number; out: number }>;
  people: {
    id: number;
    box: [number, number, number, number] | null;
    counted: boolean;
    seen: boolean;
    seconds: number;
  }[];
  totals: {
    unique: number;
    peak: number;
    averageSeconds: number | null;
    averageMs: number;
  };
  diagnosis: Diagnosis;
};
// Browser tests only (like SPEECH_WORKER_SCRIPT): a stand-in that reports one person in the
// middle of every frame, to check the screen without the model. Not a detector.
function testDouble(): PersonDetector {
  const size = 96;
  return {
    kind: DEFAULT_DETECTOR,
    version: "test-double",
    precision: "fp32",
    width: size,
    height: size,
    async detect(rgb) {
      if (rgb.length !== size * size * 3)
        throw new Error("DETECTOR_FRAME_SIZE");
      const d: Detection = {
        x0: 0.35,
        y0: 0.2,
        x1: 0.65,
        y1: 0.95,
        score: 0.9,
      };
      return [d];
    },
    async dispose() {},
  };
}
class LiveHub {
  private sessions = new Map<string, Session>();
  private detector: Promise<PersonDetector> | null = null;
  private model() {
    const kind = process.env.VIDEO_LIVE_DETECTOR || DEFAULT_DETECTOR;
    this.detector ??= (
      kind === "test-double"
        ? Promise.resolve(testDouble())
        : isDetectorKind(kind)
          ? loadDetector(kind)
          : Promise.reject(new Error("DETECTOR_UNKNOWN"))
    ).catch((e) => {
      // A missing model is reported, and the next attempt looks for it again.
      this.detector = null;
      throw new AppError(
        e instanceof Error && e.message === "DETECTOR_MODEL_MISSING"
          ? "VIDEO_MODEL_MISSING"
          : "VIDEO_MODEL_UNAVAILABLE",
        503,
      );
    });
    return this.detector;
  }
  private sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions)
      if (now - s.last > IDLE_MS) this.sessions.delete(id);
  }
  private own(id: string, org: string, user: string) {
    idSchema.parse(id);
    const s = this.sessions.get(id);
    // Another user's (or organization's) session looks exactly like a missing one.
    if (!s || s.org !== org || s.user !== user)
      throw new AppError("VIDEO_LIVE_ENDED", 404);
    return s;
  }
  async start(db: Database, secret: Credential, org: string, input: unknown) {
    const c = liveStartInput.parse(input);
    const actor = await db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "video:read");
      await audit(
        tx,
        org,
        s.actorId,
        "video.live_analysis_started",
        s.branchId,
        {
          kind: c.kind,
        },
      );
      return s.actorId;
    });
    this.sweep();
    const detector = await this.model();
    // A repeated start (same key) returns the same session.
    for (const s of this.sessions.values())
      if (s.key === c.key && s.user === actor && s.org === org)
        return this.describe(s, detector);
    // One session per user: a new start replaces the previous one.
    for (const [id, s] of this.sessions)
      if (s.user === actor && s.org === org) this.sessions.delete(id);
    if (this.sessions.size >= MAX_SESSIONS)
      throw new AppError("VIDEO_LIVE_BUSY", 429);
    const s: Session = {
      id: randomUUID(),
      key: c.key,
      org,
      user: actor,
      kind: c.kind,
      fps: c.fps,
      analyzer: new FrameAnalyzer({
        config: { version: 0, lines: c.lines, zones: c.zones },
        startTime: new Date(),
        // Repeated identical frames of a paused file are not a lost signal here.
        live: false,
        neural: true,
        fps: c.fps,
      }),
      last: Date.now(),
      busy: false,
      firstSeen: new Map(),
      lastSeen: new Map(),
      counted: new Set(),
      dwell: [],
      peak: 0,
      ms: [],
    };
    this.sessions.set(s.id, s);
    return this.describe(s, detector);
  }
  private describe(s: Session, d: PersonDetector) {
    return {
      id: s.id,
      fps: s.fps,
      detector: { version: d.version, width: d.width, height: d.height },
      status: "experimental" as const,
    };
  }
  async frame(
    db: Database,
    secret: Credential,
    org: string,
    id: string,
    input: unknown,
  ): Promise<LiveFrame> {
    const actor = await db.transaction(
      async (tx) =>
        (await sessionAccess(tx, secret, org, "video:read")).actorId,
    );
    const s = this.own(id, org, actor);
    const c = liveFrameInput.parse(input);
    const detector = await this.model();
    const rgb = new Uint8Array(Buffer.from(c.rgb, "base64"));
    if (rgb.length !== detector.width * detector.height * 3)
      throw new AppError("VIDEO_FRAME_SIZE", 422);
    // One frame at a time per session: the browser waits for the answer before the next frame.
    if (s.busy) throw new AppError("VIDEO_LIVE_BUSY", 429);
    s.busy = true;
    s.last = Date.now();
    try {
      const started = performance.now();
      const people = await detector.detect(rgb);
      const a = s.analyzer;
      const report = a.step(
        grayFromRgb(rgb, detector.width, detector.height, a.w, a.h),
        people,
      );
      a.take();
      const ms = performance.now() - started;
      s.ms.push(ms);
      if (s.ms.length > 50) s.ms.shift();
      const i = report.index;
      const live = new Set<number>();
      for (const p of report.people) {
        live.add(p.id);
        if (!s.firstSeen.has(p.id)) s.firstSeen.set(p.id, i);
        if (p.seen) s.lastSeen.set(p.id, i);
        if (p.counted) s.counted.add(p.id);
      }
      // A person who left: their time in the frame is final.
      for (const [pid, first] of s.firstSeen)
        if (!live.has(pid)) {
          if (s.counted.has(pid))
            s.dwell.push(((s.lastSeen.get(pid) ?? first) - first + 1) / s.fps);
          s.firstSeen.delete(pid);
          s.lastSeen.delete(pid);
        }
      s.peak = Math.max(s.peak, report.visible);
      s.last = Date.now();
      return {
        index: i,
        ms: Math.round(ms),
        visible: report.visible,
        zones: report.zones,
        crossings: report.crossings,
        people: report.people.map((p) => ({
          id: p.id,
          box: p.box,
          counted: p.counted,
          seen: p.seen,
          seconds:
            Math.round(((i - (s.firstSeen.get(p.id) ?? i) + 1) / s.fps) * 10) /
            10,
        })),
        totals: {
          unique: s.counted.size,
          peak: s.peak,
          averageSeconds: s.dwell.length
            ? Math.round(
                (s.dwell.reduce((x, y) => x + y, 0) / s.dwell.length) * 10,
              ) / 10
            : null,
          averageMs: Math.round(
            s.ms.reduce((x, y) => x + y, 0) / Math.max(s.ms.length, 1),
          ),
        },
        diagnosis: a.diagnosis,
      };
    } finally {
      s.busy = false;
    }
  }
  async stop(db: Database, secret: Credential, org: string, id: string) {
    const actor = await db.transaction(
      async (tx) =>
        (await sessionAccess(tx, secret, org, "video:read")).actorId,
    );
    try {
      this.own(id, org, actor);
      this.sessions.delete(id);
    } catch {
      // Already ended: stopping is idempotent.
    }
    return { ok: true };
  }
}
const g = globalThis as unknown as { videoLiveHub?: LiveHub };
export function liveHub() {
  g.videoLiveHub ??= new LiveHub();
  return g.videoLiveHub;
}
