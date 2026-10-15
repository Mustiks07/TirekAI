import type { Sql } from "../db/database";
import { passports } from "../integrations/registry";

// T055 live acceptance evidence, built from what the application itself recorded while an owner
// ran the protocol in the interface (docs/LIVE_ACCEPTANCE.md): connection check, reads, mappings,
// conflicts, inbound events, controlled writes, re-sync and disconnect. No credentials, tokens,
// payloads or personal data are read. A check against a contract stand-in never counts as live.
type Count = Record<string, number>;
const group = async (tx: Sql, sql: string, params: unknown[]) => {
  const out: Count = {};
  for (const r of await tx.query<{ k: string; n: number }>(sql, params))
    out[r.k] = r.n;
  return out;
};
export async function liveIntegrationReport(tx: Sql, org: string) {
  const connections = await tx.query<{
    id: string;
    provider: string;
    status: string;
    contract_version: string;
    verification: { scope?: string; host?: string; checked_at?: string } | null;
    created_at: string;
    disconnected_at: string | null;
    credentials_erased: boolean;
    last_success_at: string | null;
    last_error_code: string | null;
  }>(
    "SELECT id,provider,status,contract_version,verification,created_at::text,disconnected_at::text,credentials IS NULL credentials_erased,last_success_at::text,last_error_code FROM integration_connections WHERE organization_id=$1 ORDER BY created_at",
    [org],
  );
  const items = [];
  for (const c of connections) {
    const p = [org, c.id];
    const runs = await group(
      tx,
      "SELECT kind||':'||state k,count(*)::int n FROM sync_runs WHERE organization_id=$1 AND connection_id=$2 GROUP BY 1",
      p,
    );
    const errors = await group(
      tx,
      "SELECT error_code k,count(*)::int n FROM sync_runs WHERE organization_id=$1 AND connection_id=$2 AND error_code IS NOT NULL GROUP BY 1",
      p,
    );
    const mappings = await group(
      tx,
      "SELECT entity_type||':'||state k,count(*)::int n FROM integration_mappings WHERE organization_id=$1 AND connection_id=$2 GROUP BY 1",
      p,
    );
    const conflicts = await group(
      tx,
      "SELECT reason||':'||state k,count(*)::int n FROM sync_conflicts WHERE organization_id=$1 AND connection_id=$2 GROUP BY 1",
      p,
    );
    const inbox = await group(
      tx,
      "SELECT state k,count(*)::int n FROM integration_inbox WHERE organization_id=$1 AND connection_id=$2 GROUP BY 1",
      p,
    );
    const exports = await group(
      tx,
      "SELECT state k,count(*)::int n FROM integration_exports WHERE organization_id=$1 AND connection_id=$2 GROUP BY 1",
      p,
    );
    const succeededReads = Object.entries(runs)
      .filter(([k]) =>
        /^(initial|incremental|stock):(succeeded|partial)$/.test(k),
      )
      .reduce((a, [, n]) => a + n, 0);
    const official = passports.find((r) => r.provider === c.provider)?.contract;
    const live = c.verification?.scope === "connection_only";
    items.push({
      id: c.id,
      provider: c.provider,
      status: c.status,
      contract: c.contract_version,
      officialContract: official ?? null,
      // connection_only = the adapter reached the provider's official host with these credentials.
      checkedAgainst: live
        ? "official_host"
        : c.verification
          ? "contract_server"
          : "not_checked",
      checkedHost: c.verification?.host ?? null,
      checkedAt: c.verification?.checked_at ?? null,
      lastSuccessAt: c.last_success_at,
      lastErrorCode: c.last_error_code,
      runs,
      errors,
      mappings,
      conflicts,
      inbound: inbox,
      writes: exports,
      protocol: {
        connectionCheck: live,
        read: live && succeededReads > 0,
        mapping: live && Object.keys(mappings).length > 0,
        controlledWrite: live && (exports.sent ?? 0) > 0,
        resync: live && succeededReads >= 2,
        disconnect: live && !!c.disconnected_at && c.credentials_erased,
      },
    });
  }
  return {
    task: "T055",
    organizationId: org,
    generatedAt: new Date().toISOString(),
    connections: items,
    note: "Steps count only for checks against the official host (scope connection_only). Contract stand-ins and unchecked connections are never reported as live.",
  };
}
