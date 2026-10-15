import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Database, Sql } from "../db/database";
import { audit } from "../access";
import { AppError } from "../../domain/errors";
import { idSchema } from "../../domain/contracts";
import { idempotent } from "../execution/core";
import { open, seal } from "./service";

// Shared plumbing for the T031–T034 adapters on top of the T029 registry tables: connection rows,
// encrypted credentials, sync runs with honest failure codes, inbound events and conflicts.
export type Provider = "bitrix24" | "onec" | "telegram" | "kaspi";
export type ConnectionRow = {
  id: string;
  organization_id: string;
  provider: Provider;
  status: string;
  credentials: Uint8Array | null;
  webhook_token_hash: string | null;
  settings: Record<string, unknown>;
  created_by: string;
  last_success_at: string | null;
  disconnected_at: string | null;
  version: number;
};
export const sha = (v: string) => createHash("sha256").update(v).digest("hex");
export function sameHash(stored: string | null, value: string) {
  const a = Buffer.from(stored || "0".repeat(64), "hex"),
    b = Buffer.from(sha(value), "hex");
  return Boolean(stored) && a.length === b.length && timingSafeEqual(a, b);
}
export async function connectionFor(
  tx: Sql,
  org: string,
  id: string,
  provider: Provider,
  lock = false,
) {
  idSchema.parse(id);
  const [c] = await tx.query<ConnectionRow>(
    `SELECT * FROM integration_connections WHERE organization_id=$1 AND id=$2 AND provider=$3 ${lock ? "FOR UPDATE" : ""}`,
    [org, id, provider],
  );
  if (!c) throw new AppError("NOT_FOUND", 404);
  return c;
}
export function credentialsOf<T>(conn: ConnectionRow): T {
  if (!conn.credentials || conn.disconnected_at)
    throw new AppError("INTEGRATION_NOT_CONFIGURED", 409);
  return JSON.parse(open(conn.credentials)) as T;
}
// One active connection per provider; replacing credentials keeps mappings and cursors.
export async function saveConnection(
  tx: Sql,
  input: {
    org: string;
    actorId: string;
    key: string;
    provider: Provider;
    credentials: Record<string, unknown>;
    requestCredentials?: Record<string, unknown>;
    hint: string;
    settings: Record<string, unknown>;
    ownership: Record<string, string>;
    contract: string;
    inbound: boolean;
  },
) {
  const r = await idempotent(tx, input.org, input.key, {
    operation: "integration.configure",
    provider: input.provider,
    credentials: sha(
      JSON.stringify(input.requestCredentials ?? input.credentials),
    ),
    settings: input.settings,
  });
  if (r.reused) return { id: r.id, reused: true, webhookToken: null };
  const sealed = seal(JSON.stringify(input.credentials)),
    webhookToken = input.inbound ? randomBytes(32).toString("hex") : null;
  // Serialize first configuration too: no connection row exists to lock yet.
  await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
    input.org,
  ]);
  const [existing] = await tx.query<{ id: string }>(
    "SELECT id FROM integration_connections WHERE organization_id=$1 AND provider=$2 AND disconnected_at IS NULL FOR UPDATE",
    [input.org, input.provider],
  );
  const id = existing?.id || r.id;
  if (existing)
    await tx.query(
      "UPDATE integration_connections SET credentials=$3,credentials_hint=$4,webhook_token_hash=$5,settings=$6,status='configured',verification=NULL,last_error_code=NULL,version=version+1 WHERE organization_id=$1 AND id=$2",
      [
        input.org,
        id,
        sealed,
        input.hint,
        webhookToken && sha(webhookToken),
        JSON.stringify(input.settings),
      ],
    );
  else
    await tx.query(
      "INSERT INTO integration_connections(id,organization_id,provider,status,credentials,credentials_hint,webhook_token_hash,ownership,contract_version,created_by,settings) VALUES($1,$2,$3,'configured',$4,$5,$6,$7,$8,$9,$10)",
      [
        id,
        input.org,
        input.provider,
        sealed,
        input.hint,
        webhookToken && sha(webhookToken),
        JSON.stringify(input.ownership),
        input.contract,
        input.actorId,
        JSON.stringify(input.settings),
      ],
    );
  await tx.query(
    "UPDATE execution_commands SET result_id=$3 WHERE organization_id=$1 AND request_key=$2",
    [input.org, input.key, id],
  );
  await audit(tx, input.org, input.actorId, "integration.configured", null, {
    connectionId: id,
    provider: input.provider,
  });
  // A secret inbound URL token is shown once and stored only as a hash.
  return { id, reused: false, webhookToken };
}
export async function disconnectConnection(
  tx: Sql,
  org: string,
  actorId: string,
  conn: ConnectionRow,
) {
  // Credentials are erased, not hidden; mappings stay for audit and a later reconnect.
  await tx.query(
    "UPDATE integration_connections SET status='disconnected',credentials=NULL,credentials_hint=NULL,webhook_token_hash=NULL,disconnected_at=now(),version=version+1 WHERE organization_id=$1 AND id=$2",
    [org, conn.id],
  );
  await audit(tx, org, actorId, "integration.disconnected", null, {
    connectionId: conn.id,
    provider: conn.provider,
  });
}
const degrading = /_(AUTH_FAILED|FORBIDDEN|SCOPE|PLAN)$/;
// Every exchange is recorded; a failure keeps its code and is never shown as success.
export async function trackRun<T>(
  db: Database,
  conn: ConnectionRow,
  kind: "check" | "initial" | "incremental" | "webhook" | "export",
  work: (stats: Record<string, number>) => Promise<T>,
) {
  if (!conn.credentials || conn.disconnected_at)
    throw new AppError("INTEGRATION_NOT_CONFIGURED", 409);
  const runId = randomUUID(),
    stats: Record<string, number> = {};
  await db.query(
    "INSERT INTO sync_runs(id,organization_id,connection_id,kind,state) VALUES($1,$2,$3,$4,'running')",
    [runId, conn.organization_id, conn.id, kind],
  );
  try {
    const result = await work(stats);
    const partial = (stats.conflicts || 0) + (stats.skipped || 0) > 0;
    await db.query(
      "UPDATE sync_runs SET state=$2,stats=$3,finished_at=now() WHERE id=$1",
      [runId, partial ? "partial" : "succeeded", JSON.stringify(stats)],
    );
    await db.query(
      "UPDATE integration_connections SET last_success_at=now(),last_error_code=NULL WHERE id=$1",
      [conn.id],
    );
    return { runId, stats, result };
  } catch (error) {
    const code = error instanceof AppError ? error.code : "INTEGRATION_FAILED";
    await db.query(
      "UPDATE sync_runs SET state='failed',stats=$2,error_code=$3,finished_at=now() WHERE id=$1",
      [runId, JSON.stringify(stats), code],
    );
    await db.query(
      "UPDATE integration_connections SET last_error_code=$2,last_error_at=now(),status=CASE WHEN $3::boolean THEN 'degraded' ELSE status END WHERE id=$1",
      [conn.id, code, degrading.test(code)],
    );
    throw error;
  }
}
// Marks a connection checked; only the official host may set live_verified.
export async function markChecked(
  db: Database,
  conn: ConnectionRow,
  runId: string,
  live: boolean,
  host: string,
) {
  await db.query(
    "UPDATE integration_connections SET status=$2,verification=$3,version=version+1 WHERE id=$1",
    [
      conn.id,
      live ? "live_verified" : "configured",
      JSON.stringify({
        operation: "check",
        checked_at: new Date().toISOString(),
        host,
        run_id: runId,
        scope: live ? "connection_only" : "contract_server",
      }),
    ],
  );
}
// Inbound events: secret path token + provider check, dedupe by event id, processed by worker.
export async function receiveInbound(
  db: Database,
  provider: Provider,
  connectionId: string,
  token: string,
  eventId: string,
  payload: unknown,
  // Provider-specific authenticity check (e.g. a token inside the body), before anything is stored.
  verify: (conn: ConnectionRow) => boolean = () => true,
) {
  if (
    !idSchema.safeParse(connectionId).success ||
    !/^[a-f0-9]{64}$/.test(token)
  )
    throw new AppError("NOT_FOUND", 404);
  const [conn] = await db.query<ConnectionRow>(
    "SELECT * FROM integration_connections WHERE id=$1 AND provider=$2 AND disconnected_at IS NULL",
    [connectionId, provider],
  );
  if (!conn || !sameHash(conn.webhook_token_hash, token) || !verify(conn))
    throw new AppError("NOT_FOUND", 404);
  const added = await db.query(
    "INSERT INTO integration_inbox(id,organization_id,connection_id,external_event_id,payload,state) VALUES($1,$2,$3,$4,$5,'received') ON CONFLICT(connection_id,external_event_id) DO NOTHING RETURNING id",
    [
      randomUUID(),
      conn.organization_id,
      conn.id,
      eventId,
      JSON.stringify(payload),
    ],
  );
  return { conn, accepted: true, duplicate: !added.length };
}
export async function pendingInbox<T>(db: Database, provider: Provider) {
  return db.query<{
    id: string;
    connection_id: string;
    payload: T;
    attempts: number;
  }>(
    "SELECT i.id,i.connection_id,i.payload,i.attempts FROM integration_inbox i JOIN integration_connections c ON c.id=i.connection_id AND c.provider=$1 WHERE i.state IN ('received','failed') AND i.attempts<5 ORDER BY i.received_at LIMIT 20",
    [provider],
  );
}
export async function settleInbox(
  db: Database,
  id: string,
  error: unknown | null,
) {
  if (error === null)
    await db.query(
      "UPDATE integration_inbox SET state='processed',processed_at=now(),attempts=attempts+1 WHERE id=$1",
      [id],
    );
  else
    await db.query(
      "UPDATE integration_inbox SET state='failed',attempts=attempts+1,error_code=$2 WHERE id=$1",
      [id, error instanceof AppError ? error.code : "INTEGRATION_FAILED"],
    );
}
export async function recordConflict(
  tx: Sql,
  conn: ConnectionRow,
  entity: string,
  externalId: string,
  internalId: string | null,
  reason: string,
  local: unknown,
  remote: unknown,
) {
  await tx.query(
    "INSERT INTO sync_conflicts(id,organization_id,connection_id,entity_type,external_id,internal_id,reason,local,remote,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'open') ON CONFLICT DO NOTHING",
    [
      randomUUID(),
      conn.organization_id,
      conn.id,
      entity,
      externalId,
      internalId,
      reason,
      local === null ? null : JSON.stringify(local),
      JSON.stringify(remote),
    ],
  );
  return "conflicts";
}
// Due connections for periodic sync (not more often than the interval).
export async function dueConnections(
  db: Database,
  provider: Provider,
  minutes: number,
) {
  return db.query<ConnectionRow>(
    "SELECT c.* FROM integration_connections c WHERE c.provider=$1 AND c.disconnected_at IS NULL AND c.credentials IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sync_runs r WHERE r.connection_id=c.id AND r.kind IN ('initial','incremental') AND r.started_at>now()-make_interval(mins=>$2)) LIMIT 5",
    [provider, minutes],
  );
}
// Bounded body reader for public inbound routes.
export async function readLimited(request: Request, limit = 65_536) {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new AppError("TOO_LARGE", 413);
      }
      chunks.push(value);
    }
  return Buffer.concat(chunks).toString("utf8");
}
