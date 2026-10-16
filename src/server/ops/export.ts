import type { Database, Sql } from "../db/database";
import { sessionAccess, audit, type Credential } from "../access";
import { AppError } from "../../domain/errors";

// T053 / SPECIFICATION §20 "экспорт": all rows of one organization, table by table. Secret and
// technical columns (password/token/code hashes, sealed credentials, request hashes) are never
// exported; binary originals only on request. Rows of other organizations cannot appear: every
// table is read with its organization_id, users only through this organization's memberships.
const SECRET =
  /(^|_)(password|token|secret)(_|$)|_hash$|^credentials$|^payload_hash$/;
// Conversations remain private to their author even for the organization owner.
// An organization export is not a database backup and must preserve this boundary.
const PRIVATE_TABLES = new Set([
  "assistant_conversations",
  "assistant_messages",
]);
export type OrganizationExport = {
  organizationId: string;
  exportedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
  counts: Record<string, number>;
  omittedColumns: string[];
};
export async function exportOrganization(
  tx: Sql,
  org: string,
  options: { binaries?: boolean; maxRows?: number } = {},
): Promise<OrganizationExport> {
  const columns = await tx.query<{ t: string; c: string; type: string }>(
    "SELECT c.table_name t,c.column_name c,c.data_type type FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name WHERE c.table_schema='public' AND t.table_type='BASE TABLE' ORDER BY c.table_name,c.ordinal_position",
  );
  const byTable = new Map<string, { c: string; type: string }[]>();
  for (const r of columns) byTable.set(r.t, [...(byTable.get(r.t) ?? []), r]);
  const omitted = new Set<string>();
  const tables: OrganizationExport["tables"] = {},
    counts: Record<string, number> = {};
  let total = 0;
  const pick = (t: string) =>
    byTable.get(t)!.filter((col) => {
      const drop =
        SECRET.test(col.c) || (!options.binaries && col.type === "bytea");
      if (drop) omitted.add(`${t}.${col.c}`);
      return !drop;
    });
  const read = async (t: string, where: string, params: unknown[]) => {
    const cols = pick(t)
      .map((c) => `"${c.c}"`)
      .join(",");
    const rows = await tx.query<Record<string, unknown>>(
      `SELECT ${cols} FROM "${t}" WHERE ${where}`,
      params,
    );
    total += rows.length;
    if (options.maxRows && total > options.maxRows)
      throw new AppError("EXPORT_TOO_LARGE", 413);
    tables[t] = rows;
    counts[t] = rows.length;
  };
  await read("organizations", "id=$1", [org]);
  await read(
    "users",
    "id IN (SELECT user_id FROM memberships WHERE organization_id=$1)",
    [org],
  );
  for (const [t, cols] of byTable) {
    if (
      t === "organizations" ||
      t === "users" ||
      PRIVATE_TABLES.has(t) ||
      !cols.some((c) => c.c === "organization_id")
    )
      continue;
    await read(t, "organization_id=$1", [org]);
  }
  return {
    organizationId: org,
    exportedAt: new Date().toISOString(),
    tables,
    counts,
    omittedColumns: [...omitted].sort(),
  };
}
// Owner self-service export (no binaries, bounded size); larger organizations use the operator CLI.
export async function ownerExport(
  db: Database,
  secret: Credential,
  org: string,
) {
  return db.transaction(async (tx) => {
    const s = await sessionAccess(tx, secret, org, "organization:write");
    const result = await exportOrganization(tx, org, { maxRows: 50_000 });
    await audit(tx, org, s.actorId, "organization.exported", null, {
      rows: String(Object.values(result.counts).reduce((a, n) => a + n, 0)),
    });
    return result;
  });
}
