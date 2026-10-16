import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { VideoService } from "../src/server/video/service";
import { FrameAnalyzer, explain } from "../src/server/video/analyzer";
import { processVideo } from "../src/server/video/processor";
import { JpegEncoder, jpegEnd } from "../src/server/video/jpeg";
import type { PersonDetector } from "../src/server/video/detector";

// T057: the people pipeline from frame to count, the live view and the in-app video check —
// rights, scope, memory-only frames, and that the camera (ffmpeg) is always released.
const hasFfmpeg =
  spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]).status === 0;
const full = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
const person = (x0: number, score = 0.9) => ({
  x0,
  y0: 0.2,
  x1: x0 + 0.15,
  y1: 0.9,
  score,
});
// A textured grey frame (quality checks refuse a flat or frozen picture in live mode).
const frame = (seed: number) =>
  Uint8Array.from({ length: 320 * 180 }, (_, i) => 90 + ((i * 7 + seed) % 50));
describe("T057 frame analysis (shared by the processor and the in-app check)", () => {
  const analyzer = () =>
    new FrameAnalyzer({
      config: {
        version: 1,
        lines: [
          {
            id: "door",
            name: "door",
            a: { x: 0.5, y: 0 },
            b: { x: 0.5, y: 1 },
            inSide: 1,
          },
        ],
        zones: [
          {
            id: "left",
            name: "left",
            kind: "presence",
            polygon: [
              { x: 0, y: 0 },
              { x: 0.5, y: 0 },
              { x: 0.5, y: 1 },
              { x: 0, y: 1 },
            ],
          },
        ],
      },
      startTime: new Date(0),
      live: true,
      neural: true,
      fps: 5,
    });
  it("a person standing still is boxed and counted from the third frame on, for as long as they stand", () => {
    const a = analyzer();
    const counts = Array.from(
      { length: 40 },
      (_, i) => a.step(frame(i), [person(0.2)]).visible,
    );
    expect(counts.slice(0, 2)).toEqual([0, 0]);
    expect(counts.slice(2).every((c) => c === 1)).toBe(true);
    const last = a.step(frame(41), [person(0.2)]);
    expect(last.people[0]).toMatchObject({ counted: true, seen: true });
    expect(last.people[0].box).toEqual([0.2, 0.2, 0.35, 0.9]);
    expect(last.zones.left).toBe(1);
    expect(explain(a.diagnosis)).toBe("ok");
  });
  it("an empty frame creates nobody; weak boxes alone do not start a person", () => {
    const a = analyzer();
    for (let i = 0; i < 30; i++) {
      const r = a.step(frame(i), i % 2 ? [] : [person(0.3, 0.3)]);
      expect(r.visible).toBe(0);
      expect(r.people).toEqual([]);
    }
    expect(explain(a.diagnosis)).toBe("model_sees_nobody");
  });
  it("crossing the line is counted once, in the direction of the arrow", () => {
    const a = analyzer();
    // Walk left → right across x = 0.5, then back.
    let r;
    for (let i = 0; i <= 20; i++)
      r = a.step(frame(i), [person(0.1 + i * 0.03)]);
    expect(r!.crossings.door).toEqual({ in: 0, out: 1 });
    for (let i = 0; i <= 20; i++)
      r = a.step(frame(30 + i), [person(0.7 - i * 0.03)]);
    expect(r!.crossings.door).toEqual({ in: 1, out: 1 });
  });
  it("diagnosis separates no frames, unusable frames, people outside the zone", () => {
    const a = analyzer();
    expect(explain(a.diagnosis)).toBe("no_frames");
    a.step(new Uint8Array(320 * 180), [person(0.6)]);
    expect(explain(a.diagnosis)).toBe("unusable_frames");
    for (let i = 0; i < 10; i++) a.step(frame(i), [person(0.7)]);
    expect(explain(a.diagnosis)).toBe("outside_zone");
  });
});
describe.skipIf(!hasFfmpeg || process.platform === "win32")(
  "T057 the processor always releases ffmpeg (and with it the camera)",
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "taraz-release-"));
    const pidFile = path.join(dir, "pid");
    const wrapper = path.join(dir, "ffmpeg.sh");
    writeFileSync(
      wrapper,
      `#!/bin/sh\necho $$ > "${pidFile}"\nexec ${process.env.FFMPEG_PATH || "ffmpeg"} "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // An endless live-like source: only the processor can end it.
    const source = [
      "-re",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=10",
    ];
    const wait = async (pid: number) => {
      for (let i = 0; i < 40 && alive(pid); i++)
        await new Promise((ok) => setTimeout(ok, 50));
      return alive(pid);
    };
    it("a detector failure ends the run with that error and stops ffmpeg", async () => {
      let calls = 0;
      const failing: PersonDetector = {
        kind: "rfdetr-n",
        version: "failing-test-double",
        precision: "fp32",
        width: 32,
        height: 32,
        async detect() {
          if (++calls === 3) throw new Error("MODEL_CRASHED");
          return [];
        },
        async dispose() {},
      };
      await expect(
        processVideo({
          input: source,
          config: { version: 1, lines: [], zones: [] },
          startTime: new Date(),
          live: true,
          fps: 5,
          detector: failing,
          ffmpeg: wrapper,
          onEvents: async () => {},
          onHeartbeat: async () => {},
        }),
      ).rejects.toThrow("MODEL_CRASHED");
      expect(await wait(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    }, 30_000);
    it("a refused heartbeat (e.g. the device token was reissued) ends the run with the refusal and stops ffmpeg", async () => {
      await expect(
        processVideo({
          input: source,
          config: { version: 1, lines: [], zones: [] },
          startTime: new Date(),
          live: true,
          fps: 5,
          ffmpeg: wrapper,
          onEvents: async () => {},
          onHeartbeat: async () => {
            throw new Error("server refused heartbeat: 404 NOT_FOUND");
          },
        }),
      ).rejects.toThrow("404");
      expect(await wait(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    }, 30_000);
    it("an operator stop ends the run as aborted and stops ffmpeg; the heartbeat reports input and processing rates separately", async () => {
      const controller = new AbortController();
      const beats: { inputFps: number; fps: number }[] = [];
      const run = processVideo({
        input: source,
        config: { version: 1, lines: [], zones: [] },
        startTime: new Date(),
        live: true,
        fps: 5,
        ffmpeg: wrapper,
        signal: controller.signal,
        onEvents: async () => {},
        onHeartbeat: async (h) => void beats.push(h),
      });
      await new Promise((ok) => setTimeout(ok, 5600));
      controller.abort();
      const summary = await run;
      expect(summary.ended).toBe("aborted");
      expect(await wait(Number(readFileSync(pidFile, "utf8")))).toBe(false);
      expect(beats.length).toBeGreaterThan(0);
      // Frames arrive at about the requested 5 per second; processing could go much faster.
      expect(beats[0].inputFps).toBeGreaterThan(3);
      expect(beats[0].inputFps).toBeLessThan(7);
      expect(beats[0].fps).toBeGreaterThan(beats[0].inputFps);
    }, 30_000);
    it("live-view frames are encoded to JPEG in memory", async () => {
      const enc = new JpegEncoder(64, 36, "gray");
      const jpeg = await enc.encode(frame(1).subarray(0, 64 * 36));
      enc.close();
      expect(jpeg).not.toBeNull();
      expect(jpeg![0]).toBe(0xff);
      expect(jpeg![1]).toBe(0xd8);
      expect(jpegEnd(jpeg!)).toBe(jpeg!.length);
      // An incomplete image is not taken for a whole one.
      expect(jpegEnd(jpeg!.subarray(0, jpeg!.length - 1))).toBe(-1);
    });
  },
);
describe("T057 live view and in-app check: rights, scope, memory only", () => {
  let db: Database,
    p: Platform,
    svc: VideoService,
    org: string,
    branch: string,
    other: string,
    owner: string,
    manager: string,
    otherManager: string,
    seller: string,
    source: string,
    token: string;
  const key = () => randomUUID();
  beforeAll(async () => {
    process.env.VIDEO_LIVE_DETECTOR = "test-double";
    db = await createMemoryDatabase();
    await migrate(db);
    p = new Platform(db);
    svc = new VideoService(db);
    const user = () =>
      p.register({
        name: "Cam",
        email: `${key()}@example.test`,
        password: "Synthetic-Video-661!",
      });
    owner = (await user()).token;
    org = (
      await p.createOrganization(owner, { name: "Live", profile: "retail" })
    ).id;
    branch = (await p.workspace(owner, org)).branches[0].id;
    other = (await p.createBranch(owner, org, { name: "Второй" })).id;
    for (const [role, b] of [
      ["manager", branch],
      ["manager", other],
      ["sales", branch],
    ] as const) {
      const u = await user(),
        inv = await p.invite(owner, org, {
          email: u.user.email,
          role,
          branchId: b,
        });
      await p.acceptInvitation(u.token, { token: inv.token });
      if (role === "sales") seller = u.token;
      else if (b === branch) manager = u.token;
      else otherManager = u.token;
    }
    source = (
      await svc.createSource(owner, org, {
        key: key(),
        branchId: branch,
        name: "Вход",
        kind: "webcam",
        mode: "live",
        passport: {},
      })
    ).id;
    await svc.saveConfig(owner, org, source, {
      key: key(),
      version: 0,
      lines: [
        {
          id: "door",
          name: "Вход",
          a: { x: 0.5, y: 0 },
          b: { x: 0.5, y: 1 },
          inSide: 1,
        },
      ],
      zones: [],
      note: "вход",
    });
    token = (await svc.issueDeviceToken(owner, org, source)).token;
  }, 60_000);
  afterAll(async () => {
    delete process.env.VIDEO_LIVE_DETECTOR;
    await db?.close();
  });
  it("reissuing a token must be confirmed; the old token is then refused at once", async () => {
    await expect(
      svc.issueDeviceToken(owner, org, source),
    ).rejects.toMatchObject({ code: "VIDEO_TOKEN_REPLACE_CONFIRM" });
    const fresh = (
      await svc.issueDeviceToken(owner, org, source, { replace: true })
    ).token;
    await expect(svc.device(source, token)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    token = fresh;
  });
  it("the run records how people are counted at its start; an interrupted run keeps that", async () => {
    const device = await svc.device(source, token);
    const { runId } = await svc.startRun(device, {
      configVersion: 1,
      sourceStart: new Date().toISOString(),
      pipeline: {
        mode: "neural",
        detector: "rfdetr_nano_coco@onnx-fp32",
        tracker: "bytetrack",
        fps: 5,
      },
    });
    const runs = (await svc.runs(owner, org, source)).items as {
      id: string;
      pipeline: unknown;
      summary: unknown;
    }[];
    expect(runs.find((r) => r.id === runId)).toMatchObject({
      pipeline: { mode: "neural", detector: "rfdetr_nano_coco@onnx-fp32" },
      summary: null,
    });
    // Nobody watches: the heartbeat says so, and an analyzed frame is not kept.
    const beat = await svc.heartbeat(device, {
      runId,
      frames: 25,
      unusable: 0,
      fps: 14.2,
      inputFps: 4.9,
      latencyMs: 70,
      sourceTime: new Date().toISOString(),
      now: {
        at: new Date().toISOString(),
        visible: 2,
        zones: {},
        crossings: { door: { in: 1, out: 0 } },
      },
    });
    expect(beat).toEqual({ ok: true, preview: false });
    const preview = {
      runId,
      at: new Date().toISOString(),
      image: Buffer.from("not really a jpeg").toString("base64"),
      width: 384,
      height: 384,
      visible: 2,
      people: [{ id: 1, box: [0.1, 0.1, 0.3, 0.9], counted: true, seen: true }],
      zones: {},
      crossings: { door: { in: 1, out: 0 } },
    };
    expect(await svc.preview(device, preview)).toEqual({
      ok: true,
      preview: false,
    });
    // The main screen shows people counted now (fresh heartbeat), separately from today.
    const live = await svc.live(manager, org, source);
    expect(live).toMatchObject({
      online: true,
      now: { visible: 2 },
      metrics: { inputFps: 4.9, processingFps: 14.2 },
      run: { pipeline: { detector: "rfdetr_nano_coco@onnx-fp32" } },
      today: { in: 0, out: 0 },
    });
    // Viewing: an authorized user of the branch asks; then the device's frame is kept and shown.
    expect((await svc.view(manager, org, source)).frame).toBeNull();
    expect(await svc.preview(device, preview)).toEqual({
      ok: true,
      preview: true,
    });
    const seen = await svc.view(owner, org, source);
    expect(seen.frame).toMatchObject({ visible: 2, width: 384 });
    // Another branch's manager and a seller without video rights see nothing.
    await expect(svc.view(otherManager, org, source)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(svc.view(seller, org, source)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // Stopping the view drops the frame; the device is told on its next request.
    await svc.unview(manager, org, source);
    expect(await svc.preview(device, preview)).toEqual({
      ok: true,
      preview: false,
    });
    await svc.endRun(device, {
      runId,
      ended: "aborted",
      summary: { frames: 25 },
    });
    await expect(svc.preview(device, preview)).rejects.toMatchObject({
      code: "RUN_ENDED",
    });
  });
  it("the in-app check returns boxes and counts only to the user who started it", async () => {
    const lines = [
      {
        id: "door",
        name: "Вход",
        a: { x: 0.5, y: 0 },
        b: { x: 0.5, y: 1 },
        inSide: 1 as const,
      },
    ];
    await expect(
      svc.liveStart(seller, org, {
        key: key(),
        kind: "camera",
        fps: 5,
        lines,
        zones: [],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const s = await svc.liveStart(manager, org, {
      key: key(),
      kind: "camera",
      fps: 5,
      lines,
      zones: [{ id: "all", name: "all", kind: "presence", polygon: full }],
    });
    expect(s).toMatchObject({
      detector: { version: "test-double", width: 96, height: 96 },
      status: "experimental",
    });
    const rgb = Buffer.alloc(96 * 96 * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = 60 + ((i * 13) % 120);
    let last;
    for (let i = 0; i < 6; i++)
      last = await svc.liveFrame(manager, org, s.id, {
        seq: i,
        rgb: rgb.toString("base64"),
      });
    expect(last).toMatchObject({
      visible: 1,
      zones: { all: 1 },
      totals: { unique: 1, peak: 1 },
    });
    expect(last!.people[0].box).toEqual([0.35, 0.2, 0.65, 0.95]);
    // Wrong frame size is refused; another user (even the owner) cannot use the session.
    await expect(
      svc.liveFrame(manager, org, s.id, {
        seq: 9,
        rgb: Buffer.alloc(30).toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "VIDEO_FRAME_SIZE" });
    await expect(
      svc.liveFrame(owner, org, s.id, { seq: 9, rgb: rgb.toString("base64") }),
    ).rejects.toMatchObject({ code: "VIDEO_LIVE_ENDED" });
    expect(await svc.liveStop(manager, org, s.id)).toEqual({ ok: true });
    expect(await svc.liveStop(manager, org, s.id)).toEqual({ ok: true });
    await expect(
      svc.liveFrame(manager, org, s.id, {
        seq: 10,
        rgb: rgb.toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "VIDEO_LIVE_ENDED" });
  });
});
