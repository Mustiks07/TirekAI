import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { CrmService } from "../src/server/crm/service";
import { changes } from "../src/server/live";

// T051: the change cursor moves after a committed change in the caller's scope only.
let db: Database,
  p: Platform,
  org: string,
  other: string,
  branchA: string,
  branchB: string,
  owner: string,
  outsider: string,
  sellerB: string;
const key = () => randomUUID();
const user = () =>
  p.register({
    name: "Live",
    email: `${key()}@example.test`,
    password: "Synthetic-Live-661!",
  });
const customer = (branchId: string) =>
  new CrmService(db).createCustomer(owner, org, {
    key: key(),
    branchId,
    name: "Клиент",
    email: "",
    phone: "",
    kind: "person",
    responsibleId: null,
    consents: { email: false, sms: false, messenger: false },
    consentNote: "Synthetic consent note",
  });
beforeAll(async () => {
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  owner = (await user()).token;
  org = (await p.createOrganization(owner, { name: "Live", profile: "retail" }))
    .id;
  branchA = (await p.workspace(owner, org)).branches[0].id;
  branchB = (await p.createBranch(owner, org, { name: "Branch B" })).id;
  const out = await user();
  outsider = out.token;
  other = (
    await p.createOrganization(outsider, { name: "Other", profile: "retail" })
  ).id;
  const s = await user(),
    inv = await p.invite(owner, org, {
      email: s.user.email,
      role: "sales",
      branchId: branchB,
    });
  await p.acceptInvitation(s.token, { token: inv.token });
  sellerB = s.token;
});
afterAll(async () => {
  await db?.close();
});
it("T051: the cursor changes after a commit in scope, not for another branch or organization", async () => {
  const before = (await changes(db, owner, org)).cursor,
    beforeB = (await changes(db, sellerB, org)).cursor,
    beforeOther = (await changes(db, outsider, other)).cursor;
  expect(before).toMatch(/^[a-f0-9]{32}$/);
  expect((await changes(db, owner, org)).cursor).toBe(before);
  await customer(branchA);
  expect((await changes(db, owner, org)).cursor).not.toBe(before);
  // Branch-scoped employee of branch B does not see activity of branch A.
  expect((await changes(db, sellerB, org)).cursor).toBe(beforeB);
  await customer(branchB);
  expect((await changes(db, sellerB, org)).cursor).not.toBe(beforeB);
  expect((await changes(db, outsider, other)).cursor).toBe(beforeOther);
  await expect(changes(db, outsider, org)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(changes(db, "", org)).rejects.toMatchObject({
    code: "UNAUTHENTICATED",
  });
});
