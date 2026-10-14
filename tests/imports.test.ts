import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { ImportService } from "../src/server/imports/service";
import { ImportWorker } from "../src/server/jobs/worker";
import {
  batchViewSchema,
  customersViewSchema,
  importApiContract,
} from "../src/domain/import-contracts";
import { parseCustomers } from "../src/server/imports/csv";
import {
  lineAmount,
  minorUnits,
  minorToDecimal,
  quantity,
  marginPercent,
  exactDecimal,
} from "../src/domain/decimal";
const header = "external_id,name,email,phone\n";
const row = (id: string, name = "Тестовый клиент") =>
  `${id},${name},${id}@example.test,+77010000001\n`;
describe("exact decimals", () => {
  it("rounds decimal ties without binary float loss", () => {
    expect(minorUnits("1.005")).toBe(101n);
    expect(minorUnits("-1.005")).toBe(-101n);
    expect(minorToDecimal(101n)).toBe("1.01");
  });
  it("rounds only the final line amount", () => {
    expect(lineAmount("0.335", "3")).toBe(101n);
    expect(lineAmount("199.99", "0.125")).toBe(2500n);
  });
  it("rejects float inputs, exponent forms and excessive precision", () => {
    for (const v of [
      1.1,
      "1e2",
      "1.0000001",
      "NaN",
      "01.2",
      "1000000000000000",
    ]) {
      expect(() => exactDecimal(v as string)).toThrow();
    }
  });
  it("handles zero revenue, losses and signed refunds", () => {
    expect(marginPercent(0n, 10n)).toBeNull();
    expect(marginPercent(300n, 400n)).toBe("-33.33");
    expect(minorUnits("-2.5")).toBe(-250n);
    expect(() => quantity("-1")).toThrow();
    expect(() => lineAmount("-1", "1")).toThrow();
  });
});
describe("CSV boundaries", () => {
  it("accepts BOM, reordered columns, quoted delimiters and lowercase emails", () => {
    const [r] = parseCustomers(
      '\uFEFFphone;email;name;external_id\r\n+77010000001;A@EXAMPLE.TEST;"Тест; клиент";C1',
      ";",
    );
    expect(r.status).toBe("ready");
    expect(r.values.name).toBe("Тест; клиент");
    expect(r.values.email).toBe("a@example.test");
    expect(r.row_number).toBe(2);
  });
  it("reports field/column errors and file duplicates independently", () => {
    const rows = parseCustomers(
      header +
        row("a") +
        row("a") +
        row("a", "Другой клиент") +
        "b,Б,wrong,123,extra\n" +
        "c,Клиент,,\n",
      ",",
    );
    expect(rows.map((r) => r.status)).toEqual([
      "ready",
      "duplicate",
      "conflict",
      "invalid",
      "invalid",
    ]);
    expect(rows[3].errors).toContain("COLUMN_COUNT");
    expect(rows[4].errors).toContain("CONTACT_REQUIRED");
  });
  it("retains physical source line numbers for multiline CSV", () => {
    const rows = parseCustomers(
      header + 'a,"Два\nимени",a@example.test,\nb,Клиент,b@example.test,',
      ",",
    );
    expect(rows[0].row_number).toBe(3);
    expect(rows[0].status).toBe("invalid");
    expect(rows[1].row_number).toBe(4);
  });
  it("rejects malformed, oversized and incorrectly encoded files", () => {
    for (const [csv, code] of [
      ["name,email\na,b", "CSV_HEADERS"],
      [header, "CSV_EMPTY"],
      [header + 'a,"broken', "CSV_SYNTAX"],
      [header + "\uFFFD", "CSV_ENCODING"],
      ["я".repeat(140000), "TOO_LARGE"],
      [
        header + Array.from({ length: 1001 }, (_, i) => row(`x${i}`)).join(""),
        "CSV_TOO_MANY_ROWS",
      ],
    ])
      expect(() => parseCustomers(csv, ",")).toThrow(code);
  });
  it("publishes generated response and request contracts", () => {
    expect(importApiContract().schemas).toHaveProperty("CustomerUpdate");
  });
});
let db: Database,
  platform: Platform,
  service: ImportService,
  worker: ImportWorker;
let owner: Awaited<ReturnType<Platform["register"]>>,
  outsider: typeof owner,
  staff: typeof owner;
let org: string, branch: string, branch2: string, foreignOrg: string;
beforeAll(async () => {
  db = await createMemoryDatabase();
  await migrate(db);
  platform = new Platform(db);
  service = new ImportService(db);
  worker = new ImportWorker(db);
  const account = () =>
    platform.register({
      name: "Тест импорта",
      email: `${randomUUID()}@example.test`,
      password: "Synthetic-Import-Password-446!",
    });
  owner = await account();
  outsider = await account();
  staff = await account();
  org = (
    await platform.createOrganization(owner.token, {
      name: "Import Test",
      profile: "retail",
    })
  ).id;
  foreignOrg = (
    await platform.createOrganization(outsider.token, {
      name: "Other Test",
      profile: "retail",
    })
  ).id;
  branch = (await platform.workspace(owner.token, org)).branches[0].id;
  branch2 = (
    await platform.createBranch(owner.token, org, { name: "Second Branch" })
  ).id;
  const invite = await platform.invite(owner.token, org, {
    email: staff.user.email,
    role: "sales",
    branchId: branch,
  });
  await platform.acceptInvitation(staff.token, { token: invite.token });
});
afterAll(async () => {
  await db?.close();
});
const upload = (content: string, token = owner.token, branchId = branch) =>
  service.upload(token, org, {
    branchId,
    filename: "customers.csv",
    content,
    delimiter: ",",
  });
async function queued(content: string, token = owner.token, branchId = branch) {
  const b = await upload(content, token, branchId);
  await service.confirm(token, org, b.batch.id, { version: b.batch.version });
  return b.batch.id;
}
async function drain() {
  for (let i = 0; i < 50; i++) {
    if (!(await worker.runOnce()).worked) return;
  }
  throw Error("Queue did not drain");
}
describe("durable customer import", () => {
  it("previews without business writes, imports only valid rows and deduplicates confirmation", async () => {
    const b = await upload(
      header + row("first") + row("first") + "bad,Б,not-an-email,\n",
    );
    expect(b.batch.ready).toBe(1);
    expect(b.batch.duplicate).toBe(1);
    expect(b.batch.invalid).toBe(1);
    expect((await service.customers(owner.token, org)).items).toHaveLength(0);
    batchViewSchema.parse(JSON.parse(JSON.stringify(b)));
    await service.confirm(owner.token, org, b.batch.id, { version: 1 });
    await service.confirm(owner.token, org, b.batch.id, { version: 1 });
    expect(
      await db.query(
        "SELECT id FROM outbox_events WHERE topic='import.requested'",
      ),
    ).toHaveLength(1);
    await worker.dispatch();
    await worker.dispatch();
    expect(await db.query("SELECT id FROM jobs")).toHaveLength(1);
    await drain();
    const completed = await service.get(owner.token, org, b.batch.id);
    expect(completed.batch.state).toBe("partial");
    expect(completed.batch.imported).toBe(1);
    const customers = await service.customers(owner.token, org);
    customersViewSchema.parse(JSON.parse(JSON.stringify(customers)));
    expect(customers.items[0].source_row).toBe(2);
  });
  it("reuses a renamed identical file and skips existing rows in a corrected file", async () => {
    const content = header + row("first") + row("fixed");
    const b = await upload(content);
    expect(b.batch.duplicate).toBe(1);
    expect(b.batch.ready).toBe(1);
    const same = await service.upload(owner.token, org, {
      branchId: branch,
      filename: "renamed.csv",
      content,
      delimiter: ",",
    });
    expect(same.reused).toBe(true);
    expect(same.batch.id).toBe(b.batch.id);
    await service.confirm(owner.token, org, b.batch.id, { version: 1 });
    await drain();
    expect((await service.customers(owner.token, org)).pagination.total).toBe(
      2,
    );
  });
  it("does not overwrite conflicts, including changes after preview", async () => {
    const conflict = await upload(header + row("first", "Иное имя"));
    expect(conflict.batch.conflict).toBe(1);
    await expect(
      service.confirm(owner.token, org, conflict.batch.id, { version: 1 }),
    ).rejects.toMatchObject({ code: "IMPORT_NO_ROWS" });
    const a = await queued(header + row("race", "Первое имя"));
    const b = await queued(header + row("race", "Второе имя"));
    await drain();
    const states = await Promise.all([
      service.get(owner.token, org, a),
      service.get(owner.token, org, b),
    ]);
    expect(states.reduce((n, v) => n + v.batch.imported, 0)).toBe(1);
    expect(states.reduce((n, v) => n + v.batch.conflict, 0)).toBe(1);
  });
  it("isolates organizations, branches, list totals and guessed batch IDs", async () => {
    const batch = await queued(
      header + row("branch-only"),
      owner.token,
      branch2,
    );
    await drain();
    await expect(service.get(outsider.token, org, batch)).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
    await expect(service.get(staff.token, org, batch)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      upload(header + row("escape"), staff.token, branch2),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      service.customers(staff.token, org, { branchId: branch2 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      (await service.customers(outsider.token, foreignOrg)).pagination.total,
    ).toBe(0);
    expect(
      (await service.customers(staff.token, org)).items.every(
        (c) => c.branch_id === branch,
      ),
    ).toBe(true);
    const c = (await service.customers(owner.token, org, { branchId: branch2 }))
      .items[0];
    await expect(
      service.updateCustomer(staff.token, org, c.id, {
        name: c.name,
        email: c.email,
        phone: c.phone,
        version: c.version,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("pages responses and rejects stale customer edits", async () => {
    const first = await service.customers(owner.token, org, {
        limit: 1,
        page: 1,
      }),
      second = await service.customers(owner.token, org, { limit: 1, page: 2 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0].id).not.toBe(second.items[0].id);
    expect(first.pagination.total).toBe(second.pagination.total);
    const c = first.items[0],
      edit = {
        name: "Новое имя",
        email: c.email,
        phone: c.phone,
        version: c.version,
      };
    await service.updateCustomer(owner.token, org, c.id, edit);
    await expect(
      service.updateCustomer(owner.token, org, c.id, edit),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(
      service.customers(owner.token, org, { limit: 1001 }),
    ).rejects.toBeDefined();
  });
  it("resumes in bounded chunks with a new worker instance", async () => {
    const id = await queued(
      header + Array.from({ length: 31 }, (_, i) => row(`chunk${i}`)).join(""),
    );
    await worker.runOnce();
    let b = await service.get(owner.token, org, id);
    expect(b.batch.imported).toBe(25);
    expect(b.batch.ready).toBe(6);
    expect(b.batch.state).toBe("running");
    await new ImportWorker(db).runOnce();
    b = await service.get(owner.token, org, id);
    expect(b.batch.imported).toBe(31);
    expect(b.batch.state).toBe("completed");
    expect(
      (await service.get(owner.token, org, id, { page: 2 })).rows,
    ).toHaveLength(6);
  });
  it("rejects an expired lease after another worker takes ownership", async () => {
    const id = await queued(header + row("leased"));
    await worker.dispatch();
    const old = await worker.claim();
    expect(old).toBeDefined();
    await db.query(
      "UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
      [old!.id],
    );
    const fresh = await new ImportWorker(db).claim();
    expect(fresh!.lease_token).not.toBe(old!.lease_token);
    expect(await worker.process(old!)).toBe(false);
    expect(await worker.process(fresh!)).toBe(true);
    expect((await service.get(owner.token, org, id)).batch.imported).toBe(1);
  });
  it("rolls back customer and row status together on a mid-chunk crash, then retries", async () => {
    const id = await queued(header + row("rollback"));
    await worker.dispatch();
    const job = await worker.claim();
    await worker.process(job!, () => {
      throw Error("simulated crash");
    });
    expect(
      await db.query("SELECT id FROM customers WHERE external_id='rollback'"),
    ).toHaveLength(0);
    expect((await service.get(owner.token, org, id)).batch.ready).toBe(1);
    await db.query("UPDATE jobs SET available_at=now() WHERE batch_id=$1", [
      id,
    ]);
    await drain();
    expect((await service.get(owner.token, org, id)).batch.imported).toBe(1);
  });
  it("bounds retry attempts and supports explicit recovery", async () => {
    const id = await queued(header + row("retry"));
    await worker.dispatch();
    for (let i = 0; i < 3; i++) {
      const c = await worker.claim();
      await worker.process(c!, () => {
        throw Error("fault");
      });
      await db.query("UPDATE jobs SET available_at=now() WHERE batch_id=$1", [
        id,
      ]);
    }
    const b = await service.get(owner.token, org, id);
    expect(b.batch.state).toBe("failed");
    expect(await worker.claim()).toBeUndefined();
    await service.retry(owner.token, org, id, { version: b.batch.version });
    await drain();
    expect((await service.get(owner.token, org, id)).batch.imported).toBe(1);
  });
  it("rechecks revoked permissions before execution and lets the owner explicitly retry", async () => {
    const id = await queued(header + row("revoked"), staff.token);
    const member = (await platform.workspace(owner.token, org)).members.find(
      (m) => m.user_id === staff.user.id,
    )!;
    await platform.removeMember(owner.token, org, member.id);
    await drain();
    const b = await service.get(owner.token, org, id);
    expect(b.batch.state).toBe("cancelled");
    expect(b.batch.imported).toBe(0);
    await service.retry(owner.token, org, id, { version: b.batch.version });
    await drain();
    expect((await service.get(owner.token, org, id)).batch.imported).toBe(1);
  });
});
