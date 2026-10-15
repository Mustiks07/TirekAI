import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { VideoService } from "../src/server/video/service";
import { crossing, inside, components } from "../src/server/video/cv";
import { processVideo, type VideoEvent } from "../src/server/video/processor";
import { renderClip, type Clip } from "../src/server/video/synthetic";

// T035–T038: real decoding (ffmpeg) and processing of rendered clips, plus the service rules.
const hasFfmpeg =
  spawnSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"]).status === 0;
const config = {
  version: 1,
  lines: [
    {
      id: "door",
      name: "Вход",
      a: { x: 0.5, y: 0.05 },
      b: { x: 0.5, y: 0.95 },
      inSide: 1 as const,
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
      kind: "queue" as const,
      queueMin: 3,
      queueSeconds: 10,
    },
    {
      id: "shelf",
      name: "Полка",
      polygon: [
        { x: 0.75, y: 0.05 },
        { x: 0.97, y: 0.05 },
        { x: 0.97, y: 0.3 },
        { x: 0.75, y: 0.3 },
      ],
      kind: "shelf" as const,
    },
  ],
};
it("T036: line crossing side and polygon membership are geometric, not guessed", () => {
  const a = { x: 0.5, y: 0 },
    b = { x: 0.5, y: 1 };
  expect(crossing({ x: 0.4, y: 0.5 }, { x: 0.6, y: 0.5 }, a, b)).toBe(-1);
  expect(crossing({ x: 0.6, y: 0.5 }, { x: 0.4, y: 0.5 }, a, b)).toBe(1);
  expect(crossing({ x: 0.4, y: 0.5 }, { x: 0.45, y: 0.5 }, a, b)).toBe(0);
  const square = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  expect(inside({ x: 0.5, y: 0.5 }, square)).toBe(true);
  expect(inside({ x: 1.5, y: 0.5 }, square)).toBe(false);
  const mask = new Uint8Array(100);
  for (const i of [11, 12, 21, 22, 77]) mask[i] = 1;
  expect(components(mask, 10, 10, 2)).toHaveLength(1);
});
describe.skipIf(!hasFfmpeg)("T035–T038 with ffmpeg", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taraz-video-"));
  const clip: Clip = {
    name: "test",
    scenario: "single",
    seconds: 90,
    walkers: Array.from({ length: 8 }, (_, i) => ({
      start: 2 + i * 8,
      speed: 0.12,
      y: 0.5,
      dir: (i % 2 ? 1 : -1) as 1 | -1,
      w: 0.05,
      h: 0.22,
      shade: i % 3 ? 45 : 215,
    })),
    standers: [],
    drift: false,
    dark: [{ from: 70, to: 76 }],
    shelfChange: { at: 80, x0: 0.78, y0: 0.08, x1: 0.95, y1: 0.27, shade: 250 },
  };
  const start = new Date("2026-10-15T09:00:00Z");
  const events: VideoEvent[] = [];
  let summary: Awaited<ReturnType<typeof processVideo>>;
  let db: Database,
    p: Platform,
    org: string,
    branch: string,
    owner: string,
    manager: string,
    seller: string,
    svc: VideoService;
  const key = () => randomUUID();
  beforeAll(async () => {
    const file = path.join(dir, "clip.mp4");
    await renderClip(clip, file);
    summary = await processVideo({
      input: ["-i", file],
      config,
      startTime: start,
      live: false,
      onEvents: async (e) => {
        events.push(...e);
      },
    });
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
      await p.createOrganization(owner, { name: "Cam Lab", profile: "retail" })
    ).id;
    branch = (await p.workspace(owner, org)).branches[0].id;
    for (const role of ["manager", "sales"]) {
      const u = await user(),
        inv = await p.invite(owner, org, {
          email: u.user.email,
          role,
          branchId: branch,
        });
      await p.acceptInvitation(u.token, { token: inv.token });
      if (role === "manager") manager = u.token;
      else seller = u.token;
    }
  }, 120_000);
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.close();
  });
  it("T035/T037: the processor decodes the recording, counts crossings by direction and reports unusable time as a gap", () => {
    expect(summary).toMatchObject({ ended: "end_of_stream", frames: 900 });
    expect(summary.unusable).toBeGreaterThanOrEqual(55);
    const crossings = events.filter((e) => e.kind === "line_cross");
    expect(crossings.length).toBe(8);
    expect(crossings.filter((e) => e.direction === "in").length).toBe(4);
    const gap = events.find((e) => e.kind === "gap")!;
    expect((new Date(gap.at).getTime() - start.getTime()) / 1000).toBeCloseTo(
      70,
      0,
    );
    expect(
      (new Date(gap.until!).getTime() - start.getTime()) / 1000,
    ).toBeCloseTo(76, 0);
  });
  it("T038: a lasting change of the shelf area with nobody in front is a signal to check, nothing more", () => {
    const shelf = events.filter((e) => e.kind === "shelf_change_suspected");
    expect(shelf).toHaveLength(1);
    expect(
      (new Date(shelf[0].at).getTime() - start.getTime()) / 1000,
    ).toBeGreaterThan(80);
  });
  it("T035/T036: sources, device token and versioned zones are controlled by rights; a wrong token is refused", async () => {
    await expect(
      svc.createSource(seller, org, {
        key: key(),
        branchId: branch,
        name: "Вход",
        kind: "file",
        mode: "recording",
        passport: {},
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      svc.createSource(owner, org, {
        key: key(),
        branchId: branch,
        name: "Файл",
        kind: "file",
        mode: "live",
        passport: {},
      }),
    ).rejects.toThrow();
    const src = (
      await svc.createSource(manager, org, {
        key: key(),
        branchId: branch,
        name: "Вход — запись",
        kind: "file",
        mode: "recording",
        passport: {
          protocol: "file",
          time: "file",
          auth: "none",
          access: "file",
        },
      })
    ).id;
    await expect(svc.issueDeviceToken(manager, org, src)).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
    const { token } = await svc.issueDeviceToken(owner, org, src);
    await expect(svc.device(src, "f".repeat(64))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const device = await svc.device(src, token);
    await expect(svc.deviceConfig(device)).rejects.toMatchObject({
      code: "VIDEO_NOT_CONFIGURED",
    });
    await svc.saveConfig(manager, org, src, {
      key: key(),
      version: 0,
      lines: config.lines,
      zones: config.zones,
      note: "Первая разметка",
    });
    await expect(
      svc.saveConfig(manager, org, src, {
        key: key(),
        version: 0,
        lines: config.lines,
        zones: [],
        note: "Устаревшая версия",
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(
      svc.saveConfig(manager, org, src, {
        key: key(),
        version: 1,
        lines: [{ ...config.lines[0], a: { x: 1.4, y: 0 } }],
        zones: [],
        note: "Неверная точка",
      }),
    ).rejects.toThrow();
    expect((await svc.deviceConfig(device)).version).toBe(1);
  });
  it("T035/T036/T037: ingest is idempotent, gaps make hours 'no data', versions are not mixed silently, signals become tasks", async () => {
    const [srcRow] = await db.query<{ id: string }>(
      "SELECT id FROM video_sources WHERE organization_id=$1",
      [org],
    );
    const { token } = await svc.issueDeviceToken(owner, org, srcRow.id);
    const device = await svc.device(srcRow.id, token);
    const { runId } = await svc.startRun(device, {
      configVersion: 1,
      sourceStart: start.toISOString(),
      passport: { codec: "mpeg4", width: 320, height: 180, fps: 10 },
    });
    const payload = events.map((e) => ({ ...e }));
    expect(await svc.ingest(device, { runId, events: payload })).toEqual({
      added: payload.length,
      duplicates: 0,
    });
    expect(await svc.ingest(device, { runId, events: payload })).toEqual({
      added: 0,
      duplicates: payload.length,
    });
    await svc.endRun(device, {
      runId,
      ended: "end_of_stream",
      summary: summary as unknown as Record<string, unknown>,
    });
    const [signal] = await db.query<{
      topic: string;
      payload: { kind: string };
    }>(
      "SELECT topic,payload FROM domain_events WHERE organization_id=$1 AND topic='video.signal'",
      [org],
    );
    expect(signal.payload.kind).toBe("shelf_change_suspected");
    const stats = await svc.stats(manager, org, srcRow.id, {
      from: "2026-10-15T08:00:00.000Z",
      to: "2026-10-15T11:00:00.000Z",
    });
    const [before, during, after] = stats.hours;
    // Before and after the recording there is no data: nothing is reported as zero visitors.
    expect(before).toMatchObject({ coverage: 0, lines: {} });
    expect(after).toMatchObject({ coverage: 0, lines: {} });
    expect(during.lines.door).toEqual({ in: 4, out: 4 });
    expect(during.coverage).toBeGreaterThan(0);
    expect(during.coverage).toBeLessThan(90 / 3600);
    expect(stats.mixedVersions).toBe(false);
    await svc.saveConfig(manager, org, srcRow.id, {
      key: key(),
      version: 1,
      lines: config.lines,
      zones: config.zones.slice(0, 1),
      note: "Полка убрана",
    });
    const second = await svc.startRun(device, {
      configVersion: 2,
      sourceStart: "2026-10-15T09:10:00.000Z",
      passport: {},
    });
    await svc.ingest(device, {
      runId: second.runId,
      events: [
        {
          seq: 0,
          kind: "line_cross",
          at: "2026-10-15T09:10:05.000Z",
          line: "door",
          direction: "in",
        },
      ],
    });
    await svc.endRun(device, {
      runId: second.runId,
      ended: "end_of_stream",
      summary: { sourceTime: "2026-10-15T09:11:00.000Z" },
    });
    const mixed = await svc.stats(manager, org, srcRow.id, {
      from: "2026-10-15T09:00:00.000Z",
      to: "2026-10-15T10:00:00.000Z",
    });
    expect(mixed).toMatchObject({ mixedVersions: true, versions: [1, 2] });
    const shelf = (
      (await svc.signals(manager, org, srcRow.id)).items as {
        id: string;
        kind: string;
      }[]
    ).find((x) => x.kind === "shelf_change_suspected")!;
    const k = key();
    const task = await svc.taskFromSignal(manager, org, shelf.id, {
      key: k,
      title: "Проверить полку",
      assigneeId: null,
    });
    expect(
      (
        await svc.taskFromSignal(manager, org, shelf.id, {
          key: key(),
          title: "Повтор",
          assigneeId: null,
        })
      ).id,
    ).toBe(task.id);
    const [t] = await db.query<{
      links: { type: string; id: string }[];
      requires_verification: boolean;
    }>("SELECT links,requires_verification FROM tasks WHERE id=$1", [task.id]);
    expect(t).toMatchObject({
      links: [{ type: "video_event", id: shelf.id }],
      requires_verification: true,
    });
    // The signal never touched stock.
    expect(
      await db.query(
        "SELECT id FROM stock_movements WHERE organization_id=$1",
        [org],
      ),
    ).toHaveLength(0);
  });
  it("T037/T038: an evaluation on a too small annotated set stays experimental; detectors keep separate statuses", async () => {
    const [run] = await db.query<{ id: string }>(
      "SELECT id FROM video_runs WHERE organization_id=$1 AND config_version=1",
      [org],
    );
    for (const e of events.filter((x) => x.kind === "line_cross"))
      await svc.annotate(manager, org, run.id, {
        kind: "line_cross",
        atSeconds: (new Date(e.at).getTime() - start.getTime()) / 1000,
        untilSeconds: null,
        line: "door",
        zone: null,
        direction: e.direction!,
      });
    await svc.evaluate(manager, org, { key: key(), runIds: [run.id] });
    const d = await svc.detectors(manager, org);
    const line = d.items.find((x) => x.detector === "line_crossing")!;
    expect(line).toMatchObject({
      status: "experimental",
      reason: "dataset_too_small",
    });
    expect(d.items.find((x) => x.detector === "shelf_change")).toMatchObject({
      status: "experimental",
      reason: "not_evaluated",
    });
    expect(d.items.find((x) => x.detector === "queue")!.lab).toMatchObject({
      reason: "thresholds_met_on_synthetic_only",
    });
  });
  it("T035: a source that cannot be decoded ends as a lost signal with a reason, not as an empty period", async () => {
    const lost: VideoEvent[] = [];
    const r = await processVideo({
      input: ["-i", path.join(dir, "missing.mp4")],
      config,
      startTime: start,
      live: false,
      onEvents: async (e) => void lost.push(...e),
    });
    expect(r.ended).toBe("decoder_error");
    expect(lost.at(-1)!.kind).toBe("signal_lost");
  });
});
