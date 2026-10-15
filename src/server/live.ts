import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "./db/database";
import { sessionAccess, type Credential } from "./access";

// T051: change cursor for open screens. Every business change writes an audit row in its own
// transaction, so the number of visible audit rows grows on every commit, regardless of commit
// order (a timestamp alone can go backwards for a transaction that started earlier). Only rows of
// the caller's organization and branch scope count; the value is hashed so it does not disclose
// activity volume.
export const changeCursor = z
  .object({ cursor: z.string().length(32) })
  .strict();
export async function changes(db: Database, secret: Credential, org: string) {
  return db.transaction(async (tx) => {
    const s = await sessionAccess(tx, secret, org, "organization:read");
    const [r] = await tx.query<{ n: string; last: string | null }>(
      "SELECT count(*)::text n,max(created_at)::text last FROM audit_events WHERE organization_id=$1 AND ($2::uuid IS NULL OR branch_id IS NULL OR branch_id=$2)",
      [org, s.branchId],
    );
    return {
      cursor: createHash("sha256")
        .update(`${org}:${s.branchId ?? "*"}:${r.n}:${r.last ?? ""}`)
        .digest("hex")
        .slice(0, 32),
    };
  });
}
