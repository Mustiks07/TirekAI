import { randomUUID } from "node:crypto";
import type { Sql } from "./db/database";
import { AppError } from "../domain/errors";
import { assertPermission, type Permission } from "../domain/permissions";
import { idSchema, type Role } from "../domain/contracts";
import { digest } from "./auth/crypto";

export async function actorFromSession(tx: Sql, secret: string) {
  if (!/^[a-f0-9]{64}$/.test(secret))
    throw new AppError("UNAUTHENTICATED", 401);
  const [actor] = await tx.query<{ user_id: string }>(
    "SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()",
    [digest(secret)],
  );
  if (!actor) throw new AppError("UNAUTHENTICATED", 401);
  return actor.user_id;
}
export async function actorAccess(
  tx: Sql,
  actorId: string,
  organizationId: string,
  permission: Permission,
  branchId?: string,
) {
  idSchema.parse(organizationId);
  const [membership] = await tx.query<{ role: Role; branch_id: string | null }>(
    "SELECT role,branch_id FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR SHARE",
    [organizationId, actorId],
  );
  if (!membership) throw new AppError("FORBIDDEN", 403);
  assertPermission(membership.role, permission);
  if (branchId) {
    idSchema.parse(branchId);
    if (membership.branch_id && membership.branch_id !== branchId)
      throw new AppError("FORBIDDEN", 403);
    if (
      !(
        await tx.query(
          "SELECT id FROM branches WHERE id=$1 AND organization_id=$2",
          [branchId, organizationId],
        )
      ).length
    )
      throw new AppError("FORBIDDEN", 403);
  }
  return {
    actorId,
    branchId: branchId || membership.branch_id,
    role: membership.role,
  };
}
// Internal principal for approved proposals, automations and AI tools. It exists only in
// server memory (never parsed from HTTP input) and is re-checked against the current
// membership on every call, so revoked rights stop execution.
export class InternalActor {
  constructor(
    readonly actorId: string,
    readonly origin: "approval" | "automation" | "assistant" | "integration",
  ) {
    idSchema.parse(actorId);
  }
}
export type Credential = string | InternalActor;
export async function credentialActor(tx: Sql, credential: Credential) {
  return credential instanceof InternalActor
    ? credential.actorId
    : actorFromSession(tx, credential);
}
export async function sessionAccess(
  tx: Sql,
  secret: Credential,
  organizationId: string,
  permission: Permission,
  branchId?: string,
) {
  return actorAccess(
    tx,
    await credentialActor(tx, secret),
    organizationId,
    permission,
    branchId,
  );
}
export async function audit(
  tx: Sql,
  org: string,
  actor: string,
  action: string,
  branch: string | null,
  details: Record<string, string> = {},
) {
  await tx.query(
    "INSERT INTO audit_events(id,organization_id,actor_id,action,branch_id,details) VALUES($1,$2,$3,$4,$5,$6)",
    [randomUUID(), org, actor, action, branch, JSON.stringify(details)],
  );
}
