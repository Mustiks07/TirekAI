import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import type { Database, Sql } from "../db/database";
import { sessionAccess, audit, type Credential } from "../access";
import { AppError } from "../../domain/errors";
import { idSchema } from "../../domain/contracts";
import { idempotent, emit } from "../execution/core";
import { TaskService } from "../tasks/service";
import {
  annotationInput,
  configInput,
  heartbeatInput,
  ingestInput,
  runEnd,
  runStart,
  sourceInput,
  previewInput,
} from "../../domain/video";
import { previewStore } from "./preview";
import { liveHub } from "./live-analysis";
import { judge, scoreClip, type ClipResult } from "./evaluate";
import { DETECTOR_VERSIONS } from "./versions";
import type { RunSummary, VideoEvent } from "./processor";
import lab from "./lab-evaluation.json";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
// A live badge needs a heartbeat within this window; otherwise the source shows "no signal".
export const LIVE_SECONDS = 30;
type Source = {
  id: string;
  organization_id: string;
  branch_id: string;
  mode: string;
  device_token_hash: string | null;
  created_by: string;
};
// Signals that ask a person to look (never an accusation, never a stock change).
const SIGNALS = new Set([
  "queue_start",
  "shelf_change_suspected",
  "signal_lost",
  "workstation_state",
]);
export class VideoService {
  constructor(private db: Database) {}
  private async source(
    tx: Sql,
    org: string,
    id: string,
    branch: string | null,
    lock = false,
  ) {
    idSchema.parse(id);
    const [s] = await tx.query<Source & { name: string; kind: string }>(
      `SELECT id,organization_id,branch_id,name,kind,mode,device_token_hash,created_by FROM video_sources WHERE organization_id=$1 AND id=$2 AND ($3::uuid IS NULL OR branch_id=$3) ${lock ? "FOR UPDATE" : ""}`,
      [org, id, branch],
    );
    if (!s) throw new AppError("NOT_FOUND", 404);
    return s;
  }
  async sources(secret: Credential, org: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "video:read");
      return {
        items: await tx.query(
          `SELECT v.id,v.branch_id,v.name,v.kind,v.mode,v.passport,v.state,v.raw_storage,v.last_heartbeat_at,v.last_source_time,v.last_metrics,v.version,(v.device_token_hash IS NOT NULL) has_device,
          (v.state='running' AND v.last_heartbeat_at>now()-make_interval(secs=>${LIVE_SECONDS})) signal_ok,
          (SELECT max(version) FROM video_configs c WHERE c.source_id=v.id) config_version
          FROM video_sources v WHERE v.organization_id=$1 AND ($2::uuid IS NULL OR v.branch_id=$2) ORDER BY v.name`,
          [org, s.branchId],
        ),
        canWrite: ["owner", "manager"].includes(s.role),
        canManage: s.role === "owner",
      };
    });
  }
  async createSource(secret: Credential, org: string, input: unknown) {
    const c = sourceInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "video:write", c.branchId);
      const r = await idempotent(tx, org, c.key, {
        operation: "video.source",
        ...c,
      });
      if (r.reused) return r;
      await tx.query(
        "INSERT INTO video_sources(id,organization_id,branch_id,name,kind,mode,passport,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          r.id,
          org,
          c.branchId,
          c.name,
          c.kind,
          c.mode,
          JSON.stringify(c.passport),
          s.actorId,
        ],
      );
      await audit(tx, org, s.actorId, "video.source_created", c.branchId, {
        sourceId: r.id,
      });
      return r;
    });
  }
  // The processing device authenticates with this token; it is shown once and stored hashed.
  // Reissuing replaces the old token at once: a processor still using it is refused from its next
  // request. That must be asked for explicitly (replace: true).
  async issueDeviceToken(
    secret: Credential,
    org: string,
    id: string,
    input: unknown = {},
  ) {
    const c = z
      .object({ replace: z.boolean().default(false) })
      .strict()
      .parse(input ?? {});
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "video:manage");
      const v = await this.source(tx, org, id, s.branchId, true);
      if (v.device_token_hash && !c.replace)
        throw new AppError("VIDEO_TOKEN_REPLACE_CONFIRM", 409);
      const token = randomBytes(32).toString("hex");
      await tx.query(
        "UPDATE video_sources SET device_token_hash=$3,version=version+1 WHERE organization_id=$1 AND id=$2",
        [org, v.id, sha(token)],
      );
      await audit(tx, org, s.actorId, "video.device_token", v.branch_id, {
        sourceId: v.id,
      });
      return { token };
    });
  }
  // Every change of lines or zones is a new version; reports never mix versions silently.
  async saveConfig(
    secret: Credential,
    org: string,
    id: string,
    input: unknown,
  ) {
    const c = configInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "video:write");
      const v = await this.source(tx, org, id, s.branchId, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "video.config",
        id,
        ...c,
      });
      if (r.reused) return r;
      const [cur] = await tx.query<{ v: number }>(
        "SELECT coalesce(max(version),0)::int v FROM video_configs WHERE source_id=$1",
        [v.id],
      );
      if (cur.v !== c.version) throw new AppError("VERSION_CONFLICT", 409);
      await tx.query(
        "INSERT INTO video_configs(id,organization_id,source_id,version,lines,zones,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          r.id,
          org,
          v.id,
          cur.v + 1,
          JSON.stringify(c.lines),
          JSON.stringify(c.zones),
          c.note,
          s.actorId,
        ],
      );
      await audit(tx, org, s.actorId, "video.config_saved", v.branch_id, {
        sourceId: v.id,
        version: String(cur.v + 1),
      });
      return r;
    });
  }
  async configs(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "video:read");
      const v = await this.source(tx, org, id, s.branchId);
      return {
        items: await tx.query(
          "SELECT c.version,c.lines,c.zones,c.note,c.created_at,u.name created_by_name FROM video_configs c JOIN users u ON u.id=c.created_by WHERE c.source_id=$1 ORDER BY c.version DESC LIMIT 20",
          [v.id],
        ),
      };
    });
  }
  // Hourly figures per configuration version. Time without a running processor or inside a gap
  // has no data: such hours show null, not zero visitors.
  async stats(secret: Credential, org: string, id: string, input: unknown) {
    const q = z
      .object({ from: z.iso.datetime(), to: z.iso.datetime() })
      .strict()
      .parse(input);
    if (
      new Date(q.to).getTime() - new Date(q.from).getTime() > 31 * 86_400_000 ||
      q.to <= q.from
    )
      throw new AppError("INVALID_RANGE", 422);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "video:read");
      const v = await this.source(tx, org, id, s.branchId);
      const runs = await tx.query<{
        id: string;
        config_version: number;
        source_start: string;
        source_end: string | null;
      }>(
        "SELECT r.id,r.config_version,r.source_start,coalesce((SELECT max(coalesce(e.until,e.at)) FROM video_events e WHERE e.run_id=r.id),(r.summary->>'sourceTime')::timestamptz) source_end FROM video_runs r WHERE r.organization_id=$1 AND r.source_id=$2 AND r.source_start<$3 ORDER BY r.source_start",
        [org, v.id, q.to],
      );
      const events = await tx.query<{
        kind: string;
        at: string;
        until: string | null;
        line_id: string | null;
        zone_id: string | null;
        direction: string | null;
        value: string | null;
        config_version: number;
      }>(
        "SELECT kind,at,until,line_id,zone_id,direction,value::text,config_version FROM video_events WHERE organization_id=$1 AND source_id=$2 AND at>=$3 AND at<$4 ORDER BY at",
        [org, v.id, q.from, q.to],
      );
      const hours: {
        hour: string;
        coverage: number;
        versions: number[];
        lines: Record<string, { in: number; out: number } | null>;
        zones: Record<string, number | null>;
        queues: number;
      }[] = [];
      const H = 3_600_000;
      for (
        let t = Math.floor(new Date(q.from).getTime() / H) * H;
        t < new Date(q.to).getTime();
        t += H
      ) {
        // Covered = inside a run and not inside a reported gap.
        let covered = 0;
        const versions = new Set<number>();
        for (const r of runs) {
          const a = Math.max(t, new Date(r.source_start).getTime()),
            b = Math.min(
              t + H,
              r.source_end ? new Date(r.source_end).getTime() : a,
            );
          if (b > a) {
            covered += b - a;
            versions.add(r.config_version);
          }
        }
        for (const g of events.filter(
          (e) => e.kind === "gap" || e.kind === "signal_lost",
        )) {
          const a = Math.max(t, new Date(g.at).getTime()),
            b = Math.min(t + H, g.until ? new Date(g.until).getTime() : a);
          if (b > a) covered -= b - a;
        }
        const inHour = events.filter((e) => {
          const x = new Date(e.at).getTime();
          return x >= t && x < t + H;
        });
        const has = covered > 0;
        const lines: Record<string, { in: number; out: number } | null> = {},
          zones: Record<string, number | null> = {};
        for (const e of inHour.filter((e) => e.kind === "line_cross")) {
          const l = (lines[e.line_id!] ||= { in: 0, out: 0 })!;
          l[e.direction as "in" | "out"]++;
        }
        const zc = inHour.filter((e) => e.kind === "zone_count");
        for (const zid of new Set(zc.map((e) => e.zone_id!))) {
          const items = zc.filter((e) => e.zone_id === zid);
          zones[zid] = items.length
            ? Math.round(
                (items.reduce((a, e) => a + Number(e.value), 0) /
                  items.length) *
                  100,
              ) / 100
            : null;
        }
        hours.push({
          hour: new Date(t).toISOString(),
          coverage: Math.max(0, Math.round((covered / H) * 100) / 100),
          versions: [...versions].sort(),
          lines: has ? lines : {},
          zones: has ? zones : {},
          queues: inHour.filter((e) => e.kind === "queue_start").length,
        });
      }
      const versions = new Set(hours.flatMap((h) => h.versions));
      return {
        hours,
        // Different line/zone versions in one period are flagged: their counts are not comparable.
        mixedVersions: versions.size > 1,
        versions: [...versions].sort(),
      };
    });
  }
  async signals(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "video:read");
      const v = await this.source(tx, org, id, s.branchId);
      return {
        items: await tx.query(
          "SELECT id,run_id,config_version,kind,at,until,line_id,zone_id,value::text,reason,task_id FROM video_events WHERE organization_id=$1 AND source_id=$2 AND kind=ANY($3::text[]) ORDER BY at DESC LIMIT 50",
          [org, v.id, [...SIGNALS, "gap"]],
        ),
      };
    });
  }
  // A signal becomes a task for a person to check; the event and the task are linked.
  async taskFromSignal(
    secret: Credential,
    org: string,
    eventId: string,
    input: unknown,
  ) {
    idSchema.parse(eventId);
    const c = z
      .object({
        key: z.uuid(),
        title: z.string().trim().min(3).max(160),
        assigneeId: z.uuid().nullable(),
      })
      .strict()
      .parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "video:read");
      const [e] = await tx.query<{
        id: string;
        kind: string;
        branch_id: string;
        task_id: string | null;
        at: string;
        zone_id: string | null;
      }>(
        "SELECT e.id,e.kind,v.branch_id,e.task_id,e.at,e.zone_id FROM video_events e JOIN video_sources v ON v.organization_id=e.organization_id AND v.id=e.source_id WHERE e.organization_id=$1 AND e.id=$2 AND ($3::uuid IS NULL OR v.branch_id=$3) FOR UPDATE OF e",
        [org, eventId, s.branchId],
      );
      if (!e || !SIGNALS.has(e.kind)) throw new AppError("NOT_FOUND", 404);
      if (e.task_id) return { id: e.task_id, reused: true };
      const task = await new TaskService(this.db).createInTransaction(
        tx,
        secret,
        org,
        {
          key: c.key,
          branchId: e.branch_id,
          title: c.title,
          description: `Сигнал камеры / Камера сигналы: ${e.kind}${e.zone_id ? ` (${e.zone_id})` : ""}, ${e.at}. Проверить на месте / Орнында тексеру.`,
          assigneeId: c.assigneeId,
          requiresVerification: true,
          links: [{ type: "video_event", id: e.id }],
        },
        { source: "situation", sourceId: e.id },
      );
      await tx.query(
        "UPDATE video_events SET task_id=$3 WHERE organization_id=$1 AND id=$2",
        [org, e.id, task.id],
      );
      return task;
    });
  }
  // ---- Processing device API (token auth, no session) ----
  async device(sourceId: string, token: string | null) {
    if (
      !idSchema.safeParse(sourceId).success ||
      !token ||
      !/^[a-f0-9]{64}$/.test(token)
    )
      throw new AppError("NOT_FOUND", 404);
    const [s] = await this.db.query<Source>(
      "SELECT id,organization_id,branch_id,mode,device_token_hash,created_by FROM video_sources WHERE id=$1",
      [sourceId],
    );
    const a = Buffer.from(s?.device_token_hash || "0".repeat(64), "hex"),
      b = Buffer.from(sha(token), "hex");
    if (!s || !s.device_token_hash || !timingSafeEqual(a, b))
      throw new AppError("NOT_FOUND", 404);
    return s;
  }
  async deviceConfig(s: Source) {
    const [c] = await this.db.query<{
      version: number;
      lines: unknown;
      zones: unknown;
    }>(
      "SELECT version,lines,zones FROM video_configs WHERE source_id=$1 ORDER BY version DESC LIMIT 1",
      [s.id],
    );
    if (!c) throw new AppError("VIDEO_NOT_CONFIGURED", 409);
    return { ...c, mode: s.mode };
  }
  async startRun(s: Source, input: unknown) {
    const c = runStart.parse(input);
    return this.db.transaction(async (tx) => {
      const [cfg] = await tx.query(
        "SELECT version FROM video_configs WHERE source_id=$1 AND version=$2",
        [s.id, c.configVersion],
      );
      if (!cfg) throw new AppError("VIDEO_NOT_CONFIGURED", 409);
      const id = randomUUID();
      await tx.query(
        "INSERT INTO video_runs(id,organization_id,source_id,config_version,state,source_start,passport,pipeline) VALUES($1,$2,$3,$4,'running',$5,$6,$7)",
        [
          id,
          s.organization_id,
          s.id,
          c.configVersion,
          c.sourceStart,
          JSON.stringify(c.passport),
          c.pipeline ? JSON.stringify(c.pipeline) : null,
        ],
      );
      await tx.query(
        "UPDATE video_sources SET state='running',last_heartbeat_at=now(),passport=passport||$2::jsonb WHERE id=$1",
        [s.id, JSON.stringify({ detected: c.passport })],
      );
      return { runId: id };
    });
  }
  private async run(tx: Sql, s: Source, runId: string, lock = false) {
    const [r] = await tx.query<{
      id: string;
      config_version: number;
      state: string;
    }>(
      `SELECT id,config_version,state FROM video_runs WHERE organization_id=$1 AND id=$2 AND source_id=$3 ${lock ? "FOR UPDATE" : ""}`,
      [s.organization_id, runId, s.id],
    );
    if (!r) throw new AppError("NOT_FOUND", 404);
    return r;
  }
  async heartbeat(s: Source, input: unknown) {
    const c = heartbeatInput.parse(input);
    await this.db.transaction(async (tx) => {
      const r = await this.run(tx, s, c.runId);
      if (r.state !== "running") throw new AppError("RUN_ENDED", 409);
      await tx.query(
        "UPDATE video_sources SET state='running',last_heartbeat_at=now(),last_source_time=$2,last_metrics=$3 WHERE id=$1",
        [
          s.id,
          c.sourceTime,
          JSON.stringify({
            frames: c.frames,
            unusable: c.unusable,
            fps: c.fps,
            inputFps: c.inputFps ?? null,
            latencyMs: c.latencyMs,
            now: c.now ?? null,
            diagnosis: c.diagnosis ?? null,
          }),
        ],
      );
    });
    // Tells the device whether someone is watching (then it sends analyzed frames).
    return { ok: true, preview: previewStore().wanted(s.id) };
  }
  // T057: an analyzed frame for the live view; accepted only while someone watches the source.
  async preview(s: Source, input: unknown) {
    const c = previewInput.parse(input);
    const [r] = await this.db.query<{ state: string }>(
      "SELECT state FROM video_runs WHERE organization_id=$1 AND id=$2 AND source_id=$3",
      [s.organization_id, c.runId, s.id],
    );
    if (!r) throw new AppError("NOT_FOUND", 404);
    if (r.state !== "running") throw new AppError("RUN_ENDED", 409);
    const kept = previewStore().put(s.id, {
      ...c,
      org: s.organization_id,
      received: Date.now(),
    });
    return { ok: true, preview: kept };
  }
  // Viewing: an authorized user of the source's organization and branch asks for the latest
  // analyzed frame. Asking keeps the device sending for a few seconds; nothing is stored.
  async view(secret: Credential, org: string, id: string) {
    const v = await this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "video:read");
      return this.source(tx, org, id, s.branchId);
    });
    const store = previewStore();
    store.watch(v.id);
    const frame = store.get(v.id, org);
    return {
      frame: frame
        ? {
            at: frame.at,
            age_ms: Date.now() - frame.received,
            image: frame.image,
            width: frame.width,
            height: frame.height,
            visible: frame.visible,
            people: frame.people,
            zones: frame.zones,
            crossings: frame.crossings,
          }
        : null,
    };
  }
  async unview(secret: Credential, org: string, id: string) {
    const v = await this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "video:read");
      return this.source(tx, org, id, s.branchId);
    });
    previewStore().unwatch(v.id);
    return { ok: true };
  }
  // Main screen figures: connection, people counted on the latest analyzed frame (only when the
  // heartbeat is fresh), entries and exits today and how people are counted in the current run.
  async live(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "video:read");
      const v = await this.source(tx, org, id, s.branchId);
      const [row] = await tx.query<{
        state: string;
        mode: string;
        last_heartbeat_at: string | null;
        heartbeat_age: number | null;
        last_metrics: Record<string, unknown> | null;
        has_device: boolean;
        today: string;
      }>(
        "SELECT v.state,v.mode,v.last_heartbeat_at,extract(epoch FROM now()-v.last_heartbeat_at)::float8 heartbeat_age,v.last_metrics,(v.device_token_hash IS NOT NULL) has_device,(now() AT TIME ZONE o.timezone)::date::text today FROM video_sources v JOIN organizations o ON o.id=v.organization_id WHERE v.id=$1",
        [v.id],
      );
      const lines = await tx.query<{ direction: string; n: number }>(
        "SELECT e.direction,count(*)::int n FROM video_events e JOIN organizations o ON o.id=e.organization_id WHERE e.organization_id=$1 AND e.source_id=$2 AND e.kind='line_cross' AND (e.at AT TIME ZONE o.timezone)::date=$3::date GROUP BY e.direction",
        [org, v.id, row.today],
      );
      const [run] = await tx.query<{
        id: string;
        state: string;
        pipeline: Record<string, unknown> | null;
        started_at: string;
      }>(
        "SELECT id,state,pipeline,started_at FROM video_runs WHERE organization_id=$1 AND source_id=$2 ORDER BY started_at DESC LIMIT 1",
        [org, v.id],
      );
      const online =
        row.state === "running" &&
        row.heartbeat_age !== null &&
        row.heartbeat_age < LIVE_SECONDS;
      // A heartbeat comes every 5 s; older figures are not presented as "now".
      const fresh =
        online && row.heartbeat_age !== null && row.heartbeat_age < 15;
      const m = row.last_metrics || {};
      return {
        online,
        state: row.state,
        mode: row.mode,
        hasDevice: row.has_device,
        lastHeartbeatAt: row.last_heartbeat_at,
        now: fresh ? (m.now ?? null) : null,
        metrics: online
          ? {
              inputFps: m.inputFps ?? null,
              processingFps: m.fps ?? null,
              latencyMs: m.latencyMs ?? null,
              frames: m.frames ?? null,
              unusable: m.unusable ?? null,
              diagnosis: m.diagnosis ?? null,
            }
          : null,
        today: {
          date: row.today,
          in: lines.find((l) => l.direction === "in")?.n ?? 0,
          out: lines.find((l) => l.direction === "out")?.n ?? 0,
        },
        run: run
          ? {
              id: run.id,
              state: run.state,
              startedAt: run.started_at,
              pipeline: run.pipeline,
            }
          : null,
      };
    });
  }
  liveStart(secret: Credential, org: string, input: unknown) {
    return liveHub().start(this.db, secret, org, input);
  }
  liveFrame(secret: Credential, org: string, id: string, input: unknown) {
    return liveHub().frame(this.db, secret, org, id, input);
  }
  liveStop(secret: Credential, org: string, id: string) {
    return liveHub().stop(this.db, secret, org, id);
  }
  // Aggregated events only; repeats of the same run sequence number are ignored.
  async ingest(s: Source, input: unknown) {
    const c = ingestInput.parse(input);
    return this.db.transaction(async (tx) => {
      const r = await this.run(tx, s, c.runId);
      let added = 0;
      for (const e of c.events) {
        const id = randomUUID();
        const rows = await tx.query(
          "INSERT INTO video_events(id,organization_id,source_id,run_id,config_version,seq,kind,at,until,line_id,zone_id,direction,value,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(run_id,seq) DO NOTHING RETURNING id",
          [
            id,
            s.organization_id,
            s.id,
            r.id,
            r.config_version,
            e.seq,
            e.kind,
            e.at,
            e.until ?? null,
            e.line ?? null,
            e.zone ?? null,
            e.direction ?? null,
            e.value ?? null,
            e.reason ?? null,
          ],
        );
        if (!rows.length) continue;
        added++;
        if (SIGNALS.has(e.kind))
          await emit(tx, {
            org: s.organization_id,
            branch: s.branch_id,
            topic: "video.signal",
            entityType: "video_event",
            entityId: id,
            payload: {
              kind: e.kind,
              zone: e.zone ?? null,
              sourceId: s.id,
              at: e.at,
              value: e.value ?? null,
            },
            actorId: null,
            dedupeKey: `video.signal:${r.id}:${e.seq}`,
          });
      }
      await tx.query(
        "UPDATE video_sources SET last_heartbeat_at=now() WHERE id=$1",
        [s.id],
      );
      return { added, duplicates: c.events.length - added };
    });
  }
  async endRun(s: Source, input: unknown) {
    const c = runEnd.parse(input);
    return this.db.transaction(async (tx) => {
      const r = await this.run(tx, s, c.runId, true);
      if (r.state !== "running") return { ok: true };
      const state =
        c.ended === "end_of_stream"
          ? "ended"
          : c.ended === "aborted"
            ? "aborted"
            : c.ended === "signal_lost"
              ? "lost"
              : "error";
      await tx.query(
        "UPDATE video_runs SET state=$2,ended_at=now(),summary=$3 WHERE id=$1",
        [r.id, state, JSON.stringify(c.summary)],
      );
      await tx.query(
        "UPDATE video_sources SET state=$2,last_metrics=$3 WHERE id=$1",
        [
          s.id,
          state === "lost" ? "lost" : state === "error" ? "error" : "stopped",
          JSON.stringify(c.summary),
        ],
      );
      return { ok: true };
    });
  }
  // ---- Annotation and evaluation on permitted recordings (T037/T038) ----
  async runs(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "video:read");
      const v = await this.source(tx, org, id, s.branchId);
      return {
        items: await tx.query(
          "SELECT r.id,r.config_version,r.state,r.source_start,r.started_at,r.ended_at,r.summary,r.passport,r.pipeline,(SELECT count(*)::int FROM video_annotations a WHERE a.run_id=r.id) annotations FROM video_runs r WHERE r.organization_id=$1 AND r.source_id=$2 ORDER BY r.started_at DESC LIMIT 20",
          [org, v.id],
        ),
      };
    });
  }
  async annotate(
    secret: Credential,
    org: string,
    runId: string,
    input: unknown,
  ) {
    idSchema.parse(runId);
    const c = annotationInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "video:write");
      const [r] = await tx.query<{ id: string; branch_id: string }>(
        "SELECT r.id,v.branch_id FROM video_runs r JOIN video_sources v ON v.organization_id=r.organization_id AND v.id=r.source_id WHERE r.organization_id=$1 AND r.id=$2 AND ($3::uuid IS NULL OR v.branch_id=$3)",
        [org, runId, s.branchId],
      );
      if (!r) throw new AppError("NOT_FOUND", 404);
      const id = randomUUID();
      await tx.query(
        "INSERT INTO video_annotations(id,organization_id,run_id,kind,at_seconds,until_seconds,line_id,zone_id,direction,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          org,
          r.id,
          c.kind,
          c.atSeconds,
          c.untilSeconds,
          c.line,
          c.zone,
          c.direction,
          s.actorId,
        ],
      );
      return { id };
    });
  }
  // Scores the detector against human annotations of the selected runs and records the result.
  async evaluate(secret: Credential, org: string, input: unknown) {
    const c = z
      .object({ key: z.uuid(), runIds: z.array(z.uuid()).min(1).max(20) })
      .strict()
      .parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "video:write");
      const r = await idempotent(tx, org, c.key, {
        operation: "video.evaluate",
        ...c,
      });
      if (r.reused) return r;
      const results: ClipResult[] = [];
      for (const runId of c.runIds) {
        const [run] = await tx.query<{
          id: string;
          source_start: string;
          summary: RunSummary | null;
          state: string;
        }>(
          "SELECT r.id,r.source_start,r.summary,r.state FROM video_runs r JOIN video_sources v ON v.organization_id=r.organization_id AND v.id=r.source_id WHERE r.organization_id=$1 AND r.id=$2 AND ($3::uuid IS NULL OR v.branch_id=$3)",
          [org, runId, s.branchId],
        );
        if (!run || run.state === "running")
          throw new AppError("RUN_NOT_FINISHED", 409);
        const marks = await tx.query<{
          kind: string;
          at_seconds: string;
          until_seconds: string | null;
          line_id: string | null;
          zone_id: string | null;
          direction: "in" | "out" | null;
        }>(
          "SELECT kind,at_seconds::text,until_seconds::text,line_id,zone_id,direction FROM video_annotations WHERE organization_id=$1 AND run_id=$2",
          [org, run.id],
        );
        if (!marks.length) throw new AppError("ANNOTATIONS_REQUIRED", 422);
        const events = await tx.query<{
          seq: number;
          kind: VideoEvent["kind"];
          at: string;
          until: string | null;
          line_id: string | null;
          zone_id: string | null;
          direction: "in" | "out" | null;
        }>(
          "SELECT seq,kind,at,until,line_id,zone_id,direction FROM video_events WHERE run_id=$1 ORDER BY seq",
          [run.id],
        );
        const truth = {
          crossings: marks
            .filter((m) => m.kind === "line_cross" && m.line_id && m.direction)
            .map((m) => ({
              t: Number(m.at_seconds),
              line: m.line_id!,
              direction: m.direction!,
            })),
          queues: marks
            .filter((m) => m.kind === "queue" && m.zone_id && m.until_seconds)
            .map((m) => ({
              from: Number(m.at_seconds),
              to: Number(m.until_seconds),
              zone: m.zone_id!,
            })),
        };
        results.push(
          scoreClip(
            run.id,
            "recorded",
            truth,
            events.map((e) => ({
              seq: e.seq,
              kind: e.kind,
              at: new Date(e.at).toISOString(),
              ...(e.line_id ? { line: e.line_id } : {}),
              ...(e.zone_id ? { zone: e.zone_id } : {}),
              ...(e.direction ? { direction: e.direction } : {}),
            })),
            (run.summary || {
              frames: 0,
              unusable: 0,
              fps: 0,
              latencyMs: 0,
              ended: "end_of_stream",
            }) as RunSummary,
            new Date(run.source_start),
          ),
        );
      }
      const verdicts = judge(results, { name: `org:${org}`, kind: "recorded" });
      for (const v of verdicts)
        await tx.query(
          "INSERT INTO video_evaluations(id,organization_id,detector,dataset,metrics,clips,passed,status,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            randomUUID(),
            org,
            v.detector,
            JSON.stringify(v.dataset),
            JSON.stringify(v.metrics),
            JSON.stringify(results),
            v.passed,
            v.status,
            v.reason,
            s.actorId,
          ],
        );
      await audit(tx, org, s.actorId, "video.evaluated", null, {
        runs: String(c.runIds.length),
      });
      return r;
    });
  }
  // Each detector carries its own status; there is no overall "ready" badge.
  async detectors(secret: Credential, org: string) {
    return this.db.transaction(async (tx) => {
      await sessionAccess(tx, secret, org, "video:read");
      const own = await tx.query<{
        detector: string;
        status: string;
        reason: string;
        metrics: unknown;
        dataset: unknown;
        created_at: string;
      }>(
        "SELECT DISTINCT ON (detector) detector,status,reason,metrics,dataset,created_at FROM video_evaluations WHERE organization_id=$1 ORDER BY detector,created_at DESC",
        [org],
      );
      const labRows = (
        lab as {
          evaluations: {
            detector: string;
            status: string;
            reason: string;
            metrics: unknown;
            dataset: unknown;
          }[];
        }
      ).evaluations;
      return {
        lab: {
          checked: (lab as { checked: string }).checked,
          hardware: (lab as { hardware: unknown }).hardware,
        },
        items: Object.entries(DETECTOR_VERSIONS).map(([detector, version]) => {
          const o = own.find((x) => x.detector === detector),
            l = labRows.find((x) => x.detector === detector);
          return {
            detector,
            version,
            status: o?.status || "experimental",
            reason: o?.reason || l?.reason || "not_evaluated",
            organization: o || null,
            lab: l || null,
          };
        }),
      };
    });
  }
}
