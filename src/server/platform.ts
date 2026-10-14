import { randomUUID } from "node:crypto";
import type { Database, Sql } from "./db/database";
import { digest, hashPassword, token, verifyPassword } from "./auth/crypto";
import { AppError } from "../domain/errors";
import { assertPermission, can, type Permission } from "../domain/permissions";
import {
  registerSchema,
  loginSchema,
  organizationSchema,
  invitationSchema,
  branchSchema,
  tokenSchema,
  idSchema,
  type User,
  type Organization,
  type Branch,
  type Member,
  type Invitation,
  type AuditEvent,
  type Workspace,
} from "../domain/contracts";

const SESSION_HOURS = 12;
export class Platform {
  constructor(private db: Database) {}

  private async audit(
    tx: Sql,
    organizationId: string,
    actorId: string,
    action: string,
    details: Record<string, string> = {},
    branchId: string | null = null,
  ) {
    await tx.query(
      "INSERT INTO audit_events(id,organization_id,actor_id,action,details,branch_id) VALUES($1,$2,$3,$4,$5,$6)",
      [
        randomUUID(),
        organizationId,
        actorId,
        action,
        JSON.stringify(details),
        branchId,
      ],
    );
  }
  private async issueSession(tx: Sql, userId: string) {
    const secret = token();
    await tx.query(
      "DELETE FROM sessions WHERE user_id=$1 AND expires_at <= now()",
      [userId],
    );
    await tx.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
      [digest(secret), userId, new Date(Date.now() + SESSION_HOURS * 3600000)],
    );
    return secret;
  }
  private async rateLimit(key: string) {
    const [limit] = await this.db.query<{ attempts: number }>(
      `INSERT INTO auth_limits(key_hash,attempts,reset_at) VALUES($1,1,now()+interval '15 minutes')
      ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN auth_limits.reset_at<=now() THEN 1 ELSE auth_limits.attempts+1 END,
      reset_at=CASE WHEN auth_limits.reset_at<=now() THEN now()+interval '15 minutes' ELSE auth_limits.reset_at END RETURNING attempts`,
      [digest(key)],
    );
    if (limit.attempts > 8) throw new AppError("RATE_LIMIT", 429);
  }
  async register(input: unknown) {
    const data = registerSchema.parse(input);
    await this.rateLimit(`register:${data.email}`);
    const passwordHash = await hashPassword(data.password);
    return this.db.transaction(async (tx) => {
      const user: User = {
        id: randomUUID(),
        name: data.name,
        email: data.email,
      };
      const inserted = await tx.query(
        "INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING RETURNING id",
        [user.id, user.name, user.email, passwordHash],
      );
      if (!inserted.length) throw new AppError("ACCOUNT_EXISTS", 409);
      return { user, token: await this.issueSession(tx, user.id) };
    });
  }
  async login(input: unknown) {
    const data = loginSchema.parse(input);
    await this.rateLimit(`login:${data.email}`);
    const [user] = await this.db.query<User & { password_hash: string }>(
      "SELECT id,name,email,password_hash FROM users WHERE email=$1",
      [data.email],
    );
    // Keep the expensive operation for unknown users as well.
    const ok = user
      ? await verifyPassword(data.password, user.password_hash)
      : (await hashPassword(data.password), false);
    if (!ok || !user) throw new AppError("INVALID_CREDENTIALS", 401);
    return this.db.transaction(async (tx) => {
      await tx.query("DELETE FROM auth_limits WHERE key_hash=$1", [
        digest(`login:${data.email}`),
      ]);
      return {
        user: { id: user.id, name: user.name, email: user.email },
        token: await this.issueSession(tx, user.id),
      };
    });
  }
  async logout(secret: string) {
    await this.db.query("DELETE FROM sessions WHERE token_hash=$1", [
      digest(secret),
    ]);
  }
  private async user(tx: Sql, secret: string): Promise<User> {
    if (!/^[a-f0-9]{64}$/.test(secret))
      throw new AppError("UNAUTHENTICATED", 401);
    const [user] = await tx.query<User>(
      "SELECT u.id,u.name,u.email FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()",
      [digest(secret)],
    );
    if (!user) throw new AppError("UNAUTHENTICATED", 401);
    return user;
  }
  private async access(
    tx: Sql,
    secret: string,
    organizationId: string,
    permission: Permission = "organization:read",
  ) {
    idSchema.parse(organizationId);
    const user = await this.user(tx, secret);
    const [organization] = await tx.query<Organization>(
      `SELECT o.*,m.role,m.branch_id FROM organizations o JOIN memberships m ON m.organization_id=o.id
      WHERE o.id=$1 AND m.user_id=$2 FOR SHARE OF m`,
      [organizationId, user.id],
    );
    if (!organization) throw new AppError("FORBIDDEN", 403);
    assertPermission(organization.role, permission);
    return { user, organization };
  }
  async session(secret: string) {
    if (!secret) return { user: null, organizations: [] };
    let user: User;
    try {
      user = await this.user(this.db, secret);
    } catch (err) {
      if (err instanceof AppError && err.status === 401)
        return { user: null, organizations: [] };
      throw err;
    }
    const organizations = await this.db.query<Organization>(
      `SELECT o.*,m.role,m.branch_id FROM organizations o JOIN memberships m ON m.organization_id=o.id
      WHERE m.user_id=$1 ORDER BY o.created_at`,
      [user.id],
    );
    return { user, organizations };
  }
  async createOrganization(secret: string, input: unknown) {
    const data = organizationSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const user = await this.user(tx, secret);
      const id = randomUUID();
      await tx.query(
        "INSERT INTO organizations(id,name,profile,timezone) VALUES($1,$2,$3,$4)",
        [id, data.name, data.profile, data.timezone],
      );
      await tx.query(
        "INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",
        [randomUUID(), id, user.id],
      );
      await tx.query(
        "INSERT INTO branches(id,organization_id,name) VALUES($1,$2,$3)",
        [randomUUID(), id, "01"],
      );
      await this.audit(tx, id, user.id, "organization.created");
      return { id };
    });
  }
  async workspace(secret: string, organizationId: string): Promise<Workspace> {
    return this.db.transaction(async (tx) => {
      const { user, organization } = await this.access(
        tx,
        secret,
        organizationId,
      );
      const scope = organization.branch_id;
      const branches = await tx.query<Branch>(
        "SELECT id,name FROM branches WHERE organization_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY name",
        [organizationId, scope],
      );
      const teamRead = can(organization.role, "team:read");
      const members = await tx.query<Member>(
        `SELECT m.id,m.user_id,u.name,u.email,m.role,m.branch_id,b.name AS branch_name FROM memberships m
        JOIN users u ON u.id=m.user_id LEFT JOIN branches b ON b.id=m.branch_id AND b.organization_id=m.organization_id
        WHERE m.organization_id=$1 AND ($2::uuid IS NULL OR m.branch_id=$2) AND ($3::boolean OR m.user_id=$4) ORDER BY m.created_at`,
        [organizationId, scope, teamRead, user.id],
      );
      const canManageTeam = can(organization.role, "team:write");
      const invitations = canManageTeam
        ? await tx.query<Invitation>(
            `SELECT id,email,role,branch_id,expires_at,
        CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN accepted_at IS NOT NULL THEN 'accepted' WHEN expires_at<=now() THEN 'expired' ELSE 'pending' END AS status
        FROM invitations WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 50`,
            [organizationId],
          )
        : [];
      const canReadAudit = can(organization.role, "audit:read");
      const activity = canReadAudit
        ? await tx.query<AuditEvent>(
            `SELECT a.id,a.action,a.created_at,a.details,u.name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id
        WHERE a.organization_id=$1 AND ($2::uuid IS NULL OR a.branch_id=$2) ORDER BY a.created_at DESC,a.id DESC LIMIT 30`,
            [organizationId, scope],
          )
        : [];
      return {
        organization,
        branches,
        members,
        invitations,
        activity,
        canManageTeam,
        canReadAudit,
        canManageOrganization: can(organization.role, "organization:write"),
      };
    });
  }
  async updateOrganization(
    secret: string,
    organizationId: string,
    input: unknown,
  ) {
    const data = organizationSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const { user } = await this.access(
        tx,
        secret,
        organizationId,
        "organization:write",
      );
      await tx.query(
        "UPDATE organizations SET name=$1,profile=$2,timezone=$3 WHERE id=$4",
        [data.name, data.profile, data.timezone, organizationId],
      );
      await this.audit(tx, organizationId, user.id, "organization.updated");
    });
  }
  async createBranch(secret: string, organizationId: string, input: unknown) {
    const data = branchSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const { user } = await this.access(
        tx,
        secret,
        organizationId,
        "organization:write",
      );
      const id = randomUUID();
      const inserted = await tx.query(
        "INSERT INTO branches(id,organization_id,name) VALUES($1,$2,$3) ON CONFLICT(organization_id,name) DO NOTHING RETURNING id",
        [id, organizationId, data.name],
      );
      if (!inserted.length) throw new AppError("BRANCH_EXISTS", 409);
      await this.audit(tx, organizationId, user.id, "branch.created", {}, id);
      return { id };
    });
  }
  async invite(secret: string, organizationId: string, input: unknown) {
    const data = invitationSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const { user } = await this.access(
        tx,
        secret,
        organizationId,
        "team:write",
      );
      if (data.branchId) {
        const branches = await tx.query(
          "SELECT id FROM branches WHERE id=$1 AND organization_id=$2",
          [data.branchId, organizationId],
        );
        if (!branches.length) throw new AppError("FORBIDDEN", 403);
      }
      const members = await tx.query(
        "SELECT m.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND u.email=$2",
        [organizationId, data.email],
      );
      if (members.length) throw new AppError("ALREADY_MEMBER", 409);
      // Serialize issuance for this organization so repeated invites invalidate older links.
      await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
        organizationId,
      ]);
      await tx.query(
        "UPDATE invitations SET revoked_at=now() WHERE organization_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL",
        [organizationId, data.email],
      );
      const raw = token();
      const id = randomUUID();
      await tx.query(
        "INSERT INTO invitations(id,organization_id,email,role,branch_id,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '48 hours')",
        [
          id,
          organizationId,
          data.email,
          data.role,
          data.branchId,
          digest(raw),
          user.id,
        ],
      );
      await this.audit(
        tx,
        organizationId,
        user.id,
        "invitation.created",
        { role: data.role },
        data.branchId,
      );
      return { id, token: raw };
    });
  }
  async acceptInvitation(secret: string, input: unknown) {
    const data = tokenSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const user = await this.user(tx, secret);
      const [invitation] = await tx.query<{
        id: string;
        organization_id: string;
        role: string;
        branch_id: string | null;
        created_by: string;
      }>(
        `SELECT id,organization_id,role,branch_id,created_by FROM invitations
        WHERE token_hash=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`,
        [digest(data.token), user.email],
      );
      if (!invitation) throw new AppError("INVALID_INVITATION", 400);
      // The inviter must still have authority at execution time.
      const [creator] = await tx.query<{ role: string }>(
        "SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR SHARE",
        [invitation.organization_id, invitation.created_by],
      );
      if (creator?.role !== "owner")
        throw new AppError("INVALID_INVITATION", 400);
      const inserted = await tx.query(
        "INSERT INTO memberships(id,organization_id,user_id,role,branch_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,user_id) DO NOTHING RETURNING id",
        [
          randomUUID(),
          invitation.organization_id,
          user.id,
          invitation.role,
          invitation.branch_id,
        ],
      );
      if (!inserted.length) throw new AppError("ALREADY_MEMBER", 409);
      await tx.query("UPDATE invitations SET accepted_at=now() WHERE id=$1", [
        invitation.id,
      ]);
      await this.audit(
        tx,
        invitation.organization_id,
        user.id,
        "invitation.accepted",
        { role: invitation.role },
        invitation.branch_id,
      );
      return { id: invitation.organization_id };
    });
  }
  async revokeInvitation(
    secret: string,
    organizationId: string,
    invitationId: string,
  ) {
    idSchema.parse(invitationId);
    return this.db.transaction(async (tx) => {
      const { user } = await this.access(
        tx,
        secret,
        organizationId,
        "team:write",
      );
      const rows = await tx.query<{ branch_id: string | null }>(
        "UPDATE invitations SET revoked_at=now() WHERE id=$1 AND organization_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING branch_id",
        [invitationId, organizationId],
      );
      if (!rows.length) throw new AppError("NOT_FOUND", 404);
      await this.audit(
        tx,
        organizationId,
        user.id,
        "invitation.revoked",
        {},
        rows[0].branch_id,
      );
    });
  }
  async removeMember(secret: string, organizationId: string, memberId: string) {
    idSchema.parse(memberId);
    return this.db.transaction(async (tx) => {
      const { user } = await this.access(
        tx,
        secret,
        organizationId,
        "team:write",
      );
      const [member] = await tx.query<{
        user_id: string;
        role: string;
        branch_id: string | null;
      }>(
        "SELECT user_id,role,branch_id FROM memberships WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [memberId, organizationId],
      );
      if (!member) throw new AppError("NOT_FOUND", 404);
      if (member.role === "owner") throw new AppError("OWNER_PROTECTED", 409);
      await tx.query(
        "DELETE FROM memberships WHERE id=$1 AND organization_id=$2",
        [memberId, organizationId],
      );
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [member.user_id]);
      await tx.query(
        "UPDATE invitations SET revoked_at=now() WHERE organization_id=$1 AND created_by=$2 AND accepted_at IS NULL",
        [organizationId, member.user_id],
      );
      await this.audit(
        tx,
        organizationId,
        user.id,
        "member.removed",
        { role: member.role },
        member.branch_id,
      );
    });
  }
}
