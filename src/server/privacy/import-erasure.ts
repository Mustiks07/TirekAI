import { createHash } from "node:crypto";
import type { Sql } from "../db/database";

export const erasedImportValues = {
  external_id: "",
  name: "",
  email: "",
  phone: "",
};
// Suppression fingerprint, scoped to a branch; never an identity or a recoverable CSV field.
export const importFingerprint = (
  org: string,
  branch: string,
  externalId: string,
) =>
  createHash("sha256")
    .update(JSON.stringify([org, branch, externalId]))
    .digest("hex");
// Acquire before batch/customer locks in upload, worker and erasure. This also covers previews
// created concurrently with erasure, without holding a transaction while parsing CSV.
export async function lockImportPrivacy(tx: Sql, org: string) {
  await tx.query("SELECT pg_advisory_xact_lock(53025,hashtext($1))", [org]);
}
