import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryDatabase, migrate } from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { CrmService } from "../src/server/crm/service";
import { ownerExport } from "../src/server/ops/export";

// T053 / AC 15: an organization export contains only that organization and no secrets.
it("T053: owner export holds own rows only, without hashes, tokens or sealed credentials", async () => {
  const db = await createMemoryDatabase();
  try {
    await migrate(db);
    const p = new Platform(db);
    const user = () =>
      p.register({
        name: "Export",
        email: `${randomUUID()}@example.test`,
        password: "Synthetic-Export-661!",
      });
    const a = await user(),
      b = await user();
    const orgA = (
        await p.createOrganization(a.token, {
          name: "Export A",
          profile: "retail",
        })
      ).id,
      orgB = (
        await p.createOrganization(b.token, {
          name: "Export B",
          profile: "retail",
        })
      ).id;
    const branchA = (await p.workspace(a.token, orgA)).branches[0].id,
      branchB = (await p.workspace(b.token, orgB)).branches[0].id;
    const customer = (
      name: string,
      token: string,
      org: string,
      branchId: string,
    ) =>
      new CrmService(db).createCustomer(token, org, {
        key: randomUUID(),
        branchId,
        name,
        email: "",
        phone: "",
        kind: "person",
        responsibleId: null,
        consents: { email: false, sms: false, messenger: false },
        consentNote: "Синтетика",
      });
    await customer("Клиент А", a.token, orgA, branchA);
    await customer("Клиент Б", b.token, orgB, branchB);
    await p.invite(a.token, orgA, {
      email: `${randomUUID()}@example.test`,
      role: "sales",
      branchId: branchA,
    });
    await expect(ownerExport(db, b.token, orgA)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const data = await ownerExport(db, a.token, orgA);
    const text = JSON.stringify(data);
    expect(text).toContain("Клиент А");
    expect(text).not.toContain("Клиент Б");
    expect(text).not.toContain(orgB);
    expect(text).not.toContain(b.user.email);
    expect(data.counts.customers).toBe(1);
    expect(data.counts.users).toBe(1);
    expect(data.omittedColumns).toEqual(
      expect.arrayContaining(["users.password_hash", "invitations.token_hash"]),
    );
    for (const rows of Object.values(data.tables))
      for (const row of rows)
        for (const column of Object.keys(row))
          expect(column).not.toMatch(/password|token_hash|credentials/);
    const [audit] = await db.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE organization_id=$1 AND action='organization.exported'",
      [orgA],
    );
    expect(audit.action).toBe("organization.exported");
  } finally {
    await db.close();
  }
});
