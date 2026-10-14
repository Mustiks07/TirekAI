import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { digest, verifyPassword } from "../src/server/auth/crypto";
import { can } from "../src/domain/permissions";

let db: Database;
let platform: Platform;
let owner: { token: string; user: { id: string } };
let other: typeof owner;
let org: string;
let otherOrg: string;
const password = "Synthetic-only-Password-934!";
async function account() {
  return platform.register({
    name: "Сынақ қызметкері",
    email: `${randomUUID()}@example.test`,
    password,
  });
}
beforeAll(async () => {
  db = await createMemoryDatabase();
  await migrate(db);
  platform = new Platform(db);
  owner = await account();
  other = await account();
  org = (
    await platform.createOrganization(owner.token, {
      name: "Taraz Test",
      profile: "retail",
    })
  ).id;
  otherOrg = (
    await platform.createOrganization(other.token, {
      name: "Independent Test",
      profile: "retail",
    })
  ).id;
});
afterAll(async () => {
  await db.close();
});

describe("identity, isolation, and membership lifecycle", () => {
  it("migrates repeatably without changing applied history", async () => {
    await migrate(db);
    expect(await db.query("SELECT * FROM schema_migrations")).toHaveLength(1);
  });
  it("persists only hashes of passwords and session tokens", async () => {
    const [row] = await db.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id=$1",
      [owner.user.id],
    );
    expect(row.password_hash).not.toContain(password);
    expect(await verifyPassword(password, row.password_hash)).toBe(true);
    expect(await verifyPassword("wrong-password", row.password_hash)).toBe(
      false,
    );
    expect(
      await db.query("SELECT * FROM sessions WHERE token_hash=$1", [
        owner.token,
      ]),
    ).toHaveLength(0);
    expect(
      await db.query("SELECT * FROM sessions WHERE token_hash=$1", [
        digest(owner.token),
      ]),
    ).toHaveLength(1);
  });
  it("lists only the user's organizations and rejects a guessed organization id", async () => {
    expect(
      (await platform.session(owner.token)).organizations.map((o) => o.id),
    ).toEqual([org]);
    await expect(
      platform.workspace(owner.token, otherOrg),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(platform.workspace("", org)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(
      platform.updateOrganization(owner.token, otherOrg, {
        name: "Unauthorized",
        profile: "food",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      (await platform.workspace(other.token, otherOrg)).organization.name,
    ).toBe("Independent Test");
  });
  it("commits organization and its audit together, rejects invalid timezone", async () => {
    const ws = await platform.workspace(owner.token, org);
    expect(ws.organization.currency).toBe("KZT");
    expect(ws.organization.timezone).toBe("Asia/Qyzylorda");
    expect(ws.organization.data_origin).toBe("synthetic");
    expect(ws.activity[0].action).toBe("organization.created");
    await expect(
      platform.createOrganization(owner.token, {
        name: "Invalid zone",
        profile: "retail",
        timezone: "Bogus/Zone",
      }),
    ).rejects.toBeDefined();
  });
  it("accepts a single-use invitation only for the specified email", async () => {
    const employee = await account();
    const invitation = await platform.invite(owner.token, org, {
      email: employee.user.email,
      role: "employee",
    });
    await expect(
      platform.acceptInvitation(other.token, { token: invitation.token }),
    ).rejects.toMatchObject({ code: "INVALID_INVITATION" });
    const accepted = await platform.acceptInvitation(employee.token, {
      token: invitation.token,
    });
    expect(accepted.id).toBe(org);
    await expect(
      platform.acceptInvitation(employee.token, { token: invitation.token }),
    ).rejects.toMatchObject({ code: "INVALID_INVITATION" });
    const ws = await platform.workspace(employee.token, org);
    expect(ws.members).toHaveLength(1);
    expect(ws.members[0].user_id).toBe(employee.user.id);
    expect(ws.invitations).toEqual([]);
    expect(ws.activity).toEqual([]);
    await expect(
      platform.invite(employee.token, org, {
        email: "unauthorized@example.test",
        role: "manager",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      platform.updateOrganization(employee.token, org, {
        name: "Unauthorized",
        profile: "retail",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("enforces branch scope for staff lists and audit as well as branch lists", async () => {
    const b1 = await platform.createBranch(owner.token, org, {
      name: "Taraz 1",
    });
    const b2 = await platform.createBranch(owner.token, org, {
      name: "Taraz 2",
    });
    const manager = await account();
    const staff = await account();
    for (const [person, role, branchId] of [
      [manager, "manager", b1.id],
      [staff, "employee", b2.id],
    ] as const) {
      const invitation = await platform.invite(owner.token, org, {
        email: person.user.email,
        role,
        branchId,
      });
      await platform.acceptInvitation(person.token, {
        token: invitation.token,
      });
    }
    const ws = await platform.workspace(manager.token, org);
    expect(ws.branches.map((b) => b.id)).toEqual([b1.id]);
    expect(ws.members.map((m) => m.user_id)).toEqual([manager.user.id]);
    expect(ws.activity.every((a) => a.action !== "organization.created")).toBe(
      true,
    );
    expect(
      ws.activity.filter((a) => a.action === "invitation.accepted"),
    ).toHaveLength(1);
  });
  it("rejects cross-organization branch references without persisting an invitation", async () => {
    const branch = (await platform.workspace(other.token, otherOrg))
      .branches[0];
    const before = (await platform.workspace(owner.token, org)).invitations
      .length;
    await expect(
      platform.invite(owner.token, org, {
        email: "foreign@example.test",
        role: "manager",
        branchId: branch.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      (await platform.workspace(owner.token, org)).invitations,
    ).toHaveLength(before);
  });
  it("cannot promote a member to owner through the invitation input", async () => {
    expect(can("employee", "team:write")).toBe(false);
    await expect(
      platform.invite(owner.token, org, {
        email: "attacker@example.test",
        role: "owner",
      }),
    ).rejects.toBeDefined();
  });
  it("expires and revokes invitations, replacing old links when reinvited", async () => {
    const person = await account();
    const first = await platform.invite(owner.token, org, {
      email: person.user.email,
      role: "sales",
    });
    const second = await platform.invite(owner.token, org, {
      email: person.user.email,
      role: "employee",
    });
    await expect(
      platform.acceptInvitation(person.token, { token: first.token }),
    ).rejects.toMatchObject({ code: "INVALID_INVITATION" });
    await platform.revokeInvitation(owner.token, org, second.id);
    await expect(
      platform.acceptInvitation(person.token, { token: second.token }),
    ).rejects.toMatchObject({ code: "INVALID_INVITATION" });
    const third = await platform.invite(owner.token, org, {
      email: person.user.email,
      role: "employee",
    });
    await db.query(
      "UPDATE invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
      [third.id],
    );
    await expect(
      platform.acceptInvitation(person.token, { token: third.token }),
    ).rejects.toMatchObject({ code: "INVALID_INVITATION" });
  });
  it("allows only one successful acceptance under repeated concurrent requests", async () => {
    const person = await account();
    const invitation = await platform.invite(owner.token, org, {
      email: person.user.email,
      role: "observer",
    });
    const results = await Promise.allSettled([
      platform.acceptInvitation(person.token, { token: invitation.token }),
      platform.acceptInvitation(person.token, { token: invitation.token }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await db.query(
        "SELECT * FROM memberships WHERE user_id=$1 AND organization_id=$2",
        [person.user.id, org],
      ),
    ).toHaveLength(1);
  });
  it("revokes every active session when a member is removed; protects owner", async () => {
    const person = await account();
    const login = await platform.login({ email: person.user.email, password });
    const invitation = await platform.invite(owner.token, org, {
      email: person.user.email,
      role: "employee",
    });
    await platform.acceptInvitation(person.token, { token: invitation.token });
    const ws = await platform.workspace(owner.token, org);
    const member = ws.members.find((m) => m.user_id === person.user.id)!;
    await expect(
      platform.removeMember(other.token, otherOrg, member.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await platform.removeMember(owner.token, org, member.id);
    expect((await platform.session(person.token)).user).toBeNull();
    expect((await platform.session(login.token)).user).toBeNull();
    await expect(
      platform.removeMember(
        owner.token,
        org,
        ws.members.find((m) => m.role === "owner")!.id,
      ),
    ).rejects.toMatchObject({ code: "OWNER_PROTECTED" });
  });
  it("blocks a revoked inviter at acceptance time", async () => {
    const person = await account();
    const newOwner = await account();
    const newOrg = (
      await platform.createOrganization(newOwner.token, {
        name: "Revocation Test",
        profile: "services",
      })
    ).id;
    const invitation = await platform.invite(newOwner.token, newOrg, {
      email: person.user.email,
      role: "employee",
    });
    await db.query(
      "UPDATE memberships SET role='observer' WHERE user_id=$1 AND organization_id=$2",
      [newOwner.user.id, newOrg],
    );
    await expect(
      platform.acceptInvitation(person.token, { token: invitation.token }),
    ).rejects.toMatchObject({ code: "INVALID_INVITATION" });
  });
  it("rejects expired sessions and destroys logged-out sessions", async () => {
    const person = await account();
    await db.query(
      "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [digest(person.token)],
    );
    expect((await platform.session(person.token)).user).toBeNull();
    const login = await platform.login({ email: person.user.email, password });
    await platform.logout(login.token);
    expect((await platform.session(login.token)).user).toBeNull();
  });
  it("rate-limits repeated bad passwords and does not store submitted passwords", async () => {
    const email = `${randomUUID()}@example.test`;
    for (let i = 0; i < 8; i++)
      await expect(platform.login({ email, password })).rejects.toMatchObject({
        code: "INVALID_CREDENTIALS",
      });
    await expect(platform.login({ email, password })).rejects.toMatchObject({
      code: "RATE_LIMIT",
    });
  });
  it("rolls back an unsuccessful transaction", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.query(
          "UPDATE organizations SET name='Should roll back' WHERE id=$1",
          [org],
        );
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect((await platform.workspace(owner.token, org)).organization.name).toBe(
      "Taraz Test",
    );
  });
});
