import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "../db/database";
import { AppError } from "../../domain/errors";

// Shared idempotency for T021–T030 commands: same key + same payload returns the first
// result; same key + different payload is a conflict. Rights are always re-checked first.
export async function idempotent(
  tx: Sql,
  org: string,
  key: string,
  payload: unknown,
) {
  const hash = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
    id = randomUUID();
  const added = await tx.query(
    "INSERT INTO execution_commands(id,organization_id,request_key,payload_hash,result_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,request_key) DO NOTHING RETURNING id",
    [randomUUID(), org, key, hash, id],
  );
  if (added.length) return { id, reused: false };
  const [old] = await tx.query<{ result_id: string; payload_hash: string }>(
    "SELECT result_id,payload_hash FROM execution_commands WHERE organization_id=$1 AND request_key=$2",
    [org, key],
  );
  if (old.payload_hash !== hash)
    throw new AppError("IDEMPOTENCY_CONFLICT", 409);
  return { id: old.result_id, reused: true };
}
export type Chain = { originChainId: string; depth: number };
// Transactional outbox: the event commits or rolls back with the business change.
export async function emit(
  tx: Sql,
  e: {
    org: string;
    branch: string | null;
    topic: string;
    entityType: string;
    entityId: string;
    payload?: Record<string, unknown>;
    actorId: string | null;
    chain?: Chain;
    dedupeKey?: string;
  },
) {
  const id = randomUUID();
  const rows = await tx.query<{ id: string }>(
    "INSERT INTO domain_events(id,organization_id,branch_id,topic,entity_type,entity_id,payload,actor_id,origin_chain_id,depth,dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(organization_id,dedupe_key) DO NOTHING RETURNING id",
    [
      id,
      e.org,
      e.branch,
      e.topic,
      e.entityType,
      e.entityId,
      JSON.stringify(e.payload || {}),
      e.actorId,
      e.chain?.originChainId || id,
      e.chain?.depth || 0,
      e.dedupeKey || id,
    ],
  );
  return rows[0]?.id || null;
}
export async function notify(
  tx: Sql,
  org: string,
  userId: string | null | undefined,
  kind: string,
  entityType: string,
  entityId: string,
  dedupeKey: string,
) {
  if (!userId) return;
  await tx.query(
    "INSERT INTO notifications(id,organization_id,user_id,kind,entity_type,entity_id,dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
    [randomUUID(), org, userId, kind, entityType, entityId, dedupeKey],
  );
}
export async function organizationClock(tx: Sql, org: string) {
  const [row] = await tx.query<{
    timezone: string;
    today: string;
    local_time: string;
    iso_day: number;
  }>(
    "SELECT timezone,(now() AT TIME ZONE timezone)::date::text today,to_char(now() AT TIME ZONE timezone,'HH24:MI') local_time,extract(isodow FROM now() AT TIME ZONE timezone)::int iso_day FROM organizations WHERE id=$1",
    [org],
  );
  if (!row) throw new AppError("NOT_FOUND", 404);
  return row;
}
export function base64File(
  content: string,
  maxBytes: number,
  allowed: Record<string, (b: Buffer) => boolean>,
  filename: string,
) {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      content,
    )
  )
    throw new AppError("INVALID_INPUT", 422);
  const bytes = Buffer.from(content, "base64");
  if (!bytes.length) throw new AppError("INVALID_INPUT", 422);
  if (bytes.length > maxBytes) throw new AppError("TOO_LARGE", 413);
  const ext = filename.toLowerCase().split(".").pop() || "";
  const mime = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
  }[ext];
  // Extension and file signature must agree; executable or unknown formats are rejected.
  if (!mime || !allowed[mime] || !allowed[mime](bytes))
    throw new AppError("FILE_TYPE_UNSUPPORTED", 415);
  return { bytes, mime };
}
export const signatures = {
  "image/png": (b: Buffer) =>
    b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  "image/jpeg": (b: Buffer) =>
    b.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")),
  "application/pdf": (b: Buffer) =>
    b.subarray(0, 5).toString("latin1") === "%PDF-",
  "text/plain": (b: Buffer) => isUtf8Text(b),
  "text/markdown": (b: Buffer) => isUtf8Text(b),
};
function isUtf8Text(b: Buffer) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(b);
    // Control characters other than tab/newline indicate a binary file.
    // eslint-disable-next-line no-control-regex
    return !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text);
  } catch {
    return false;
  }
}
