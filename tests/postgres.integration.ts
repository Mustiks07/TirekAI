import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  createPostgresDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { InventoryService } from "../src/server/inventory/service";
import { ImportService } from "../src/server/imports/service";
import { ImportWorker } from "../src/server/jobs/worker";
import { CommerceService } from "../src/server/commerce/service";
import { PurchasingService } from "../src/server/purchasing/service";
import { documentView } from "../src/domain/purchasing";
import { migrations } from "../src/server/db/schema";
import { IndustryService } from "../src/server/industry/service";
import { CrmService } from "../src/server/crm/service";
import { OutcomeService } from "../src/server/outcomes/service";

it("two independent pools cannot receive the same remaining invoice quantity twice", async () => {
  const s = new PurchasingService(db),
    sku = await item(),
    date = "2026-10-14",
    supplier = (
      await s.createSupplier(owner.token, org, {
        key: randomUUID(),
        name: randomUUID(),
        contact: "Test",
        paymentTerms: "On invoice",
        quality: 4,
        reliability: 4,
      })
    ).id;
  const offer = (
    await s.createOffer(owner.token, org, {
      key: randomUUID(),
      supplierId: supplier,
      itemId: sku,
      supplierSku: "Single",
      packQuantity: "1",
      baseUnit: "pc",
      packPrice: "10",
      minimumPacks: 1,
      delivery: "0",
      leadDays: 1,
      currency: "KZT",
      rate: null,
      rateDate: null,
      rateSource: "",
      tax: "included",
      taxPercent: null,
      dated: date,
      validUntil: date,
      characteristicsConfirmed: true,
      note: "Concurrent receipt test",
    })
  ).id;
  const id = (
    await s.create(owner.token, org, {
      key: randomUUID(),
      branchId: branch,
      warehouseId: warehouse,
      supplierId: supplier,
      date,
      dueDate: date,
      budget: "10",
      note: "Concurrent test",
      lines: [{ offerId: offer, quantity: "1" }],
    })
  ).id;
  let version = 1;
  for (const kind of ["submit", "approve", "sent"])
    await s.transition(owner.token, org, id, {
      key: randomUUID(),
      version: version++,
      kind,
      note: "Approved manually",
    });
  const doc = (
    await s.upload(owner.token, org, {
      key: randomUUID(),
      orderId: id,
      filename: "invoice.csv",
      content: Buffer.from(`name,qty,price\n${sku},1,10`).toString("base64"),
      externalId: randomUUID(),
    })
  ).id;
  await s.review(owner.token, org, doc, {
    key: randomUUID(),
    version: 1,
    number: randomUUID(),
    date,
    dueDate: date,
    delivery: "0",
    total: "10",
    lines: [
      {
        itemId: sku,
        name: "Single unit",
        unit: "pc",
        quantity: "1",
        unitPrice: "10",
      },
    ],
    note: "Compared invoice",
    acknowledgeDiscrepancies: false,
  });
  const d = documentView.parse(
    JSON.parse(JSON.stringify(await s.document(owner.token, org, doc))),
  );
  const input = {
    key: randomUUID(),
    version: 4,
    documentId: doc,
    note: "One unit physically accepted",
    lines: [{ lineId: d.lines[0].id, quantity: "1" }],
  };
  const results = await Promise.all([
    s.receive(owner.token, org, id, input),
    new PurchasingService(other).receive(owner.token, org, id, input),
  ]);
  expect(results.filter((r) => r.reused)).toHaveLength(1);
  expect(
    (
      await db.query(
        "SELECT quantity::text,value_minor::text FROM stock_balances WHERE organization_id=$1 AND item_id=$2",
        [org, sku],
      )
    )[0],
  ).toEqual({ quantity: "1.000000", value_minor: "1000" });
  await expect(
    s.receive(owner.token, org, id, { ...input, key: randomUUID() }),
  ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
});
const url = process.env.SMB_POSTGRES_TEST_URL;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  new URL(url).username !== "smb_test"
)
  throw Error("Use npm run test:postgres to create an isolated cluster");
let db: Database,
  other: Database,
  p: Platform,
  owner: Awaited<ReturnType<Platform["register"]>>,
  org: string,
  branch: string,
  warehouse: string;
beforeAll(async () => {
  db = createPostgresDatabase(url!);
  other = createPostgresDatabase(url!);
  await migrate(db);
  p = new Platform(db);
  owner = await p.register({
    name: "Postgres Test",
    email: "pg@example.test",
    password: "Synthetic-Postgres-Password-661!",
  });
  org = (
    await p.createOrganization(owner.token, {
      name: "Concurrent Test",
      profile: "retail",
    })
  ).id;
  branch = (await p.workspace(owner.token, org)).branches[0].id;
  warehouse = (
    await new InventoryService(db).createWarehouse(owner.token, org, {
      name: "Concurrent warehouse",
      branchId: branch,
    })
  ).id;
});
afterAll(async () => {
  await db?.close();
  await other?.close();
});
const item = async () =>
  (
    await new InventoryService(db).saveItem(owner.token, org, {
      sku: randomUUID(),
      name_ru: "Postgres item",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "100",
      sale_price: "200",
    })
  ).id!;
const command = (
  itemId: string,
  kind: string,
  extra: Record<string, unknown> = {},
) => ({
  key: randomUUID(),
  warehouseId: warehouse,
  itemId,
  kind,
  quantity: "1",
  unit: "pc",
  note: "Concurrent PostgreSQL test",
  ...extra,
});
it("runs all migrations on PostgreSQL without modifying applied history", async () => {
  await migrate(other);
  expect(
    await db.query("SELECT version FROM schema_migrations ORDER BY version"),
  ).toEqual(migrations.map(({ version }) => ({ version })));
});
it("T047/T048 independent pools serialize clinic bookings, anonymous invoices and baseline uniqueness", async () => {
  const organization = (
    await p.createOrganization(owner.token, {
      name: "Clinic concurrency",
      profile: "clinic",
    })
  ).id;
  const b = (await p.workspace(owner.token, organization)).branches[0].id;
  const stock = new InventoryService(db),
    svc = new IndustryService(db),
    second = new IndustryService(other),
    commerce = new CommerceService(db);
  const wh = (
    await stock.createWarehouse(owner.token, organization, {
      branchId: b,
      name: "Clinic",
    })
  ).id;
  const service = (
    await stock.saveItem(owner.token, organization, {
      sku: "SERVICE",
      name_ru: "Приём",
      kind: "service",
      base_unit: "pc",
      purchase_price: null,
      sale_price: "10",
    })
  ).id!;
  const resources: string[] = [];
  for (const kind of ["specialist", "room"])
    resources.push(
      (
        await svc.command(owner.token, organization, {
          key: randomUUID(),
          branchId: b,
          kind: "resource",
          title: kind,
          resourceKind: kind,
          capacity: 1,
          bufferMinutes: 0,
          days: [1, 2, 3, 4, 5, 6, 7],
          opens: "00:00",
          closes: "23:59",
        })
      ).id,
    );
  const request = async () =>
    (
      await svc.command(owner.token, organization, {
        key: randomUUID(),
        branchId: b,
        kind: "clinic",
        patientName: "Private test",
        contact: "",
        serviceItemId: service,
        warehouseId: wh,
        price: "10",
        note: "Synthetic",
      })
    ).id;
  const a = await request(),
    c = await request();
  const date = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const slot = (id: string) => ({
    key: randomUUID(),
    id,
    version: 1,
    kind: "clinic_book",
    resources,
    startsAt: date + "T09:00:00Z",
    endsAt: date + "T10:00:00Z",
    note: "Synthetic",
  });
  const results = await Promise.allSettled([
    svc.command(owner.token, organization, slot(a)),
    second.command(owner.token, organization, slot(c)),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "RESOURCE_CONFLICT" },
  });
  const scheduled = results[0].status === "fulfilled" ? a : c;
  await svc.command(owner.token, organization, {
    key: randomUUID(),
    id: scheduled,
    version: 2,
    kind: "clinic_visit",
    outcome: "visited",
    note: "Synthetic",
  });
  const invoice = {
    key: randomUUID(),
    id: scheduled,
    version: 3,
    kind: "clinic_invoice",
    note: "Synthetic",
  };
  const billed = await Promise.all([
    svc.command(owner.token, organization, invoice),
    second.command(owner.token, organization, invoice),
  ]);
  expect(billed.filter((x) => x.reused)).toHaveLength(1);
  expect(
    await db.query("SELECT id FROM sales_orders WHERE organization_id=$1", [
      organization,
    ]),
  ).toHaveLength(1);
  const [customer] = await db.query<{ customer_id: string }>(
    "SELECT customer_id FROM clinic_billing_customers WHERE organization_id=$1",
    [organization],
  );
  const order = (
    await commerce.create(owner.token, organization, {
      key: randomUUID(),
      branchId: b,
      customerId: customer.customer_id,
      warehouseId: wh,
      dueDate: date,
      delivery: "pickup",
      note: "Synthetic",
      taxMode: "excluded",
      lines: [
        {
          itemId: service,
          quantity: "1",
          unit: "pc",
          price: "10",
          discount: "0",
        },
      ],
    })
  ).id;
  const baseline = () => ({
    key: randomUUID(),
    branchId: b,
    sourceType: "order",
    sourceId: order,
    forecast: "10",
    alternativeOfferIds: [],
    limitations: "Synthetic comparison, no causal claim",
  });
  const tracked = await Promise.allSettled([
    new OutcomeService(db).create(owner.token, organization, baseline()),
    new OutcomeService(other).create(owner.token, organization, baseline()),
  ]);
  expect(tracked.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(tracked.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "OUTCOME_ALREADY_TRACKED" },
  });
});
it("allows one reservation of the final unit through independent pools", async () => {
  const id = await item();
  await new InventoryService(db).execute(
    owner.token,
    org,
    command(id, "receipt", { unitCost: "100" }),
  );
  const results = await Promise.allSettled([
    new InventoryService(db).execute(owner.token, org, command(id, "reserve")),
    new InventoryService(other).execute(
      owner.token,
      org,
      command(id, "reserve"),
    ),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "INSUFFICIENT_STOCK" },
  });
  const [b] = await db.query(
    "SELECT quantity::text,reserved::text FROM stock_balances WHERE item_id=$1",
    [id],
  );
  expect(b).toEqual({ quantity: "1.000000", reserved: "1.000000" });
});
it("deduplicates simultaneous receipt delivery across connections", async () => {
  const id = await item(),
    c = command(id, "receipt", { unitCost: "100" });
  const results = await Promise.all([
    new InventoryService(db).execute(owner.token, org, c),
    new InventoryService(other).execute(owner.token, org, c),
  ]);
  expect(results[0].id).toBe(results[1].id);
  expect(results.map((r) => r.reused).sort()).toEqual([false, true]);
  expect(
    await db.query("SELECT id FROM stock_movements WHERE item_id=$1", [id]),
  ).toHaveLength(1);
});
it("prevents stale inventory counts while another connection changes stock", async () => {
  const id = await item(),
    service = new InventoryService(db);
  await service.execute(
    owner.token,
    org,
    command(id, "receipt", { unitCost: "100" }),
  );
  const b = await service.snapshot(owner.token, org, {
    warehouseId: warehouse,
    itemId: id,
  });
  await new InventoryService(other).execute(
    owner.token,
    org,
    command(id, "receipt", { unitCost: "200" }),
  );
  await expect(
    service.execute(
      owner.token,
      org,
      command(id, "count", { version: b.version, quantity: "0" }),
    ),
  ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
});
async function queued(prefix: string) {
  const service = new ImportService(db);
  const batch = await service.upload(owner.token, org, {
    branchId: branch,
    filename: `${prefix}.csv`,
    delimiter: ",",
    content:
      "external_id,name,email,phone\n" +
      Array.from(
        { length: 31 },
        (_, i) => `${prefix}${i},Клиент ${i},${prefix}${i}@example.test,\n`,
      ).join(""),
  });
  await service.confirm(owner.token, org, batch.batch.id, {
    version: batch.batch.version,
  });
  return batch.batch.id;
}
it("dispatches and processes outbox jobs concurrently without duplicate customers", async () => {
  const a = await queued("alpha"),
    b = await queued("beta"),
    w1 = new ImportWorker(db),
    w2 = new ImportWorker(other);
  await Promise.all([w1.dispatch(), w2.dispatch()]);
  expect(
    await db.query("SELECT id FROM jobs WHERE batch_id=ANY($1::uuid[])", [
      [a, b],
    ]),
  ).toHaveLength(2);
  for (let i = 0; i < 4; i++) await Promise.all([w1.runOnce(), w2.runOnce()]);
  const result = await db.query(
    "SELECT source_batch_id,count(*)::int total FROM customers WHERE source_batch_id=ANY($1::uuid[]) GROUP BY source_batch_id",
    [[a, b]],
  );
  expect(result).toHaveLength(2);
  expect(result.every((r) => r.total === 31)).toBe(true);
  expect(
    await db.query(
      "SELECT id FROM outbox_events WHERE topic='import.completed' AND batch_id=ANY($1::uuid[])",
      [[a, b]],
    ),
  ).toHaveLength(2);
});
it("fences a stale lease when another connection reclaims the job", async () => {
  const id = await queued("lease"),
    w1 = new ImportWorker(db),
    w2 = new ImportWorker(other);
  await w1.dispatch();
  const old = await w1.claim();
  await other.query(
    "UPDATE jobs SET lease_until=now()-interval '1 second' WHERE batch_id=$1",
    [id],
  );
  const current = await w2.claim();
  expect(current?.lease_token).not.toBe(old?.lease_token);
  expect(await w1.process(old!)).toBe(false);
  await w2.process(current!);
  await w2.runOnce();
  expect(
    (await new ImportService(db).get(owner.token, org, id)).batch.imported,
  ).toBe(31);
});
it("rolls back an in-flight business write after terminating its database backend", async () => {
  const id = await item();
  const client = new Client({ connectionString: url });
  client.on("error", () => {});
  await client.connect();
  try {
    await client.query("BEGIN");
    const pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await client.query(
      "INSERT INTO stock_balances(organization_id,warehouse_id,item_id,quantity,value_minor) VALUES($1,$2,$3,7,70000)",
      [org, warehouse, id],
    );
    await other.query("SELECT pg_terminate_backend($1)", [pid]);
  } finally {
    await client.end().catch(() => {});
  }
  expect(
    await db.query("SELECT * FROM stock_balances WHERE item_id=$1", [id]),
  ).toHaveLength(0);
  await new InventoryService(db).execute(
    owner.token,
    org,
    command(id, "receipt", { unitCost: "100" }),
  );
  expect(
    await db.query(
      "SELECT quantity::text FROM stock_balances WHERE item_id=$1",
      [id],
    ),
  ).toEqual([{ quantity: "1.000000" }]);
});

async function saleFixture() {
  const batch = await queued(`sale${randomUUID().slice(0, 8)}`),
    worker = new ImportWorker(db);
  await worker.dispatch();
  await worker.runOnce();
  await worker.runOnce();
  const [customer] = await db.query<{ id: string }>(
    "SELECT id FROM customers WHERE source_batch_id=$1 LIMIT 1",
    [batch],
  );
  const itemId = await item();
  await new InventoryService(db).execute(
    owner.token,
    org,
    command(itemId, "receipt", { unitCost: "20" }),
  );
  const make = () =>
    new CommerceService(db).create(owner.token, org, {
      key: randomUUID(),
      branchId: branch,
      customerId: customer.id,
      warehouseId: warehouse,
      dueDate: "2030-01-01",
      delivery: "pickup",
      taxMode: "excluded",
      note: "Concurrent order",
      lines: [{ itemId, quantity: "1", unit: "pc", price: "100" }],
    });
  return { make, itemId };
}
it("confirms only one competing order for the last unit and rolls back the other", async () => {
  const f = await saleFixture(),
    a = await f.make(),
    b = await f.make();
  const confirm = (database: Database, id: string) =>
    new CommerceService(database).transition(owner.token, org, id, {
      key: randomUUID(),
      version: 1,
      kind: "confirm",
      note: "Concurrent confirmation",
    });
  const results = await Promise.allSettled([
    confirm(db, a.id),
    confirm(other, b.id),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "INSUFFICIENT_STOCK" },
  });
  const rows = await db.query<{ state: string }>(
    "SELECT state FROM sales_orders WHERE id=ANY($1::uuid[])",
    [[a.id, b.id]],
  );
  expect(rows.map((r) => r.state).sort()).toEqual(["confirmed", "draft"]);
});
it("prevents concurrent overpayment and deduplicates repeated payment delivery", async () => {
  const f = await saleFixture(),
    a = await f.make(),
    s = new CommerceService(db);
  await s.transition(owner.token, org, a.id, {
    key: randomUUID(),
    version: 1,
    kind: "confirm",
    note: "Confirm order",
  });
  const account = (
    await s.createAccount(owner.token, org, {
      key: randomUUID(),
      branchId: branch,
      name: randomUUID(),
      opening: "0",
    })
  ).id;
  const pay = (database: Database, key: string, amount: string) =>
    new CommerceService(database).money(owner.token, org, {
      key,
      accountId: account,
      orderId: a.id,
      kind: "payment",
      amount,
      note: "Concurrent payment",
    });
  const results = await Promise.allSettled([
    pay(db, randomUUID(), "75"),
    pay(other, randomUUID(), "75"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "PAYMENT_EXCEEDS" },
  });
  const key = randomUUID(),
    repeats = await Promise.all([pay(db, key, "25"), pay(other, key, "25")]);
  expect(repeats[0].id).toBe(repeats[1].id);
  expect(repeats.map((r) => r.reused).sort()).toEqual([false, true]);
  expect((await s.get(owner.token, org, a.id)).order.paid_minor).toBe("10000");
});
it("prevents two independent connections from spending the same last account balance", async () => {
  const s = new CommerceService(db),
    account = (
      await s.createAccount(owner.token, org, {
        key: randomUUID(),
        branchId: branch,
        name: randomUUID(),
        opening: "10",
      })
    ).id;
  const spend = (database: Database) =>
    new CommerceService(database).money(owner.token, org, {
      key: randomUUID(),
      kind: "expense",
      accountId: account,
      amount: "10",
      category: "Operating",
      counterparty: "Synthetic vendor",
      operating: true,
      note: "Concurrent expense",
    });
  const results = await Promise.allSettled([spend(db), spend(other)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "INSUFFICIENT_MONEY" },
  });
  expect(
    (
      await db.query(
        "SELECT balance_minor::text FROM money_accounts WHERE id=$1",
        [account],
      )
    )[0].balance_minor,
  ).toBe("0");
});
async function sentPurchase(quantity: string) {
  const s = new PurchasingService(db),
    sku = await item(),
    date = "2026-10-14",
    supplier = (
      await s.createSupplier(owner.token, org, {
        key: randomUUID(),
        name: randomUUID(),
        contact: "Test",
        paymentTerms: "On invoice",
        quality: 4,
        reliability: 4,
      })
    ).id;
  const offer = (
    await s.createOffer(owner.token, org, {
      key: randomUUID(),
      supplierId: supplier,
      itemId: sku,
      supplierSku: "Single",
      packQuantity: "1",
      baseUnit: "pc",
      packPrice: "10",
      minimumPacks: 1,
      delivery: "0",
      leadDays: 1,
      currency: "KZT",
      rate: null,
      rateDate: null,
      rateSource: "",
      tax: "included",
      taxPercent: null,
      dated: date,
      validUntil: date,
      characteristicsConfirmed: true,
      note: "T020 concurrency",
    })
  ).id;
  const id = (
    await s.create(owner.token, org, {
      key: randomUUID(),
      branchId: branch,
      warehouseId: warehouse,
      supplierId: supplier,
      date,
      dueDate: date,
      budget: "1000",
      note: "T020 concurrency",
      lines: [{ offerId: offer, quantity }],
    })
  ).id;
  let version = 1;
  for (const kind of ["submit", "approve", "sent"])
    await s.transition(owner.token, org, id, {
      key: randomUUID(),
      version: version++,
      kind,
      note: "Approved manually",
    });
  const doc = (
    await s.upload(owner.token, org, {
      key: randomUUID(),
      orderId: id,
      filename: "invoice.csv",
      content: Buffer.from(`name,qty\n${randomUUID()},1`).toString("base64"),
      externalId: randomUUID(),
    })
  ).id;
  const review = {
    version: 1,
    number: randomUUID(),
    date,
    dueDate: date,
    delivery: "0",
    note: "Compared invoice",
    acknowledgeDiscrepancies: true,
    line: {
      itemId: sku,
      name: "Unit",
      unit: "pc",
      quantity,
      unitPrice: "10",
    },
  };
  return { s, sku, id, doc, review };
}
it("T020: a concurrent receipt and payable adjustment serialize and keep payable equal to document lines", async () => {
  const { s, id, doc, review } = await sentPurchase("4");
  const { line, ...rest } = review;
  await s.review(owner.token, org, doc, {
    ...rest,
    key: randomUUID(),
    total: "40",
    lines: [line],
  });
  const d = documentView.parse(
    JSON.parse(JSON.stringify(await s.document(owner.token, org, doc))),
  );
  const results = await Promise.allSettled([
    s.receive(owner.token, org, id, {
      key: randomUUID(),
      version: 4,
      documentId: doc,
      note: "Two physically accepted",
      lines: [{ lineId: d.lines[0].id, quantity: "2" }],
    }),
    new PurchasingService(other).adjust(owner.token, org, doc, {
      key: randomUUID(),
      version: d.document.version,
      reason: "Credit note for one unit",
      lines: [{ lineId: d.lines[0].id, baseQuantity: "3", total: "30" }],
    }),
  ]);
  expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  const [row] = await db.query<{
    amount: string;
    lines: string;
    value: string;
  }>(
    "SELECT o.amount_minor::text amount,(SELECT sum(total_minor) FROM purchase_document_lines WHERE document_id=$1)::text lines,(SELECT coalesce(sum(r.value_minor),0) FROM purchase_receipts r JOIN purchase_document_lines l ON l.id=r.document_line_id WHERE l.document_id=$1)::text value FROM purchase_documents d JOIN supplier_obligations o ON o.id=d.obligation_id WHERE d.id=$1",
    [doc],
  );
  expect(row).toEqual({ amount: "3000", lines: "3000", value: "2000" });
});
it("T020: two connections approving the same document with a separate-purchase decision create one split order", async () => {
  const { s, doc, review } = await sentPurchase("1");
  const extra = await item();
  const { line, ...rest } = review;
  const body = () => ({
    ...rest,
    key: randomUUID(),
    total: "15",
    lines: [
      line,
      {
        itemId: extra,
        name: "Extra",
        unit: "pc",
        quantity: "1",
        unitPrice: "5",
        decision: "separate",
      },
    ],
  });
  const results = await Promise.allSettled([
    s.review(owner.token, org, doc, body()),
    new PurchasingService(other).review(owner.token, org, doc, body()),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: {
      code: expect.stringMatching(/VERSION_CONFLICT|DOCUMENT_APPROVED/),
    },
  });
  expect(
    await db.query(
      "SELECT id FROM document_line_decisions WHERE document_id=$1",
      [doc],
    ),
  ).toHaveLength(1);
  expect(
    await db.query(
      "SELECT id FROM purchase_documents WHERE parent_document_id=$1",
      [doc],
    ),
  ).toHaveLength(1);
});

it("T042: independent connections cannot double-book shared resources", async () => {
  const organization = (
    await p.createOrganization(owner.token, {
      name: "Услуги параллельно",
      profile: "services",
    })
  ).id;
  const b = (await p.workspace(owner.token, organization)).branches[0].id,
    inventory = new InventoryService(db),
    svc = new IndustryService(db);
  const wh = (
    await inventory.createWarehouse(owner.token, organization, {
      branchId: b,
      name: "Склад",
    })
  ).id;
  const service = (
    await inventory.saveItem(owner.token, organization, {
      sku: randomUUID(),
      name_ru: "Услуга",
      kind: "service",
      base_unit: "pc",
      purchase_price: null,
      sale_price: "10",
    })
  ).id;
  const customer = (
    await new CrmService(db).createCustomer(owner.token, organization, {
      key: randomUUID(),
      branchId: b,
      name: "Тестовый клиент",
      email: "",
      phone: "",
      kind: "person",
      responsibleId: null,
      consents: { email: false, sms: false, messenger: false },
      consentNote: "Синтетические данные",
    })
  ).id;
  const resources: string[] = [];
  for (const kind of ["specialist", "workplace"])
    resources.push(
      (
        await svc.command(owner.token, organization, {
          key: randomUUID(),
          branchId: b,
          kind: "resource",
          title: kind,
          resourceKind: kind,
          capacity: 1,
          bufferMinutes: 5,
          days: [1, 2, 3, 4, 5, 6, 7],
          opens: "00:00",
          closes: "23:59",
        })
      ).id,
    );
  const input = () => ({
    key: randomUUID(),
    branchId: b,
    kind: "appointment",
    customerId: customer,
    serviceItemId: service,
    price: "10",
    warehouseId: wh,
    materials: [],
    resources,
    startsAt: "2026-10-15T09:00:00Z",
    endsAt: "2026-10-15T10:00:00Z",
    note: "Параллельная запись",
  });
  const results = await Promise.allSettled([
    svc.command(owner.token, organization, input()),
    new IndustryService(other).command(owner.token, organization, input()),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(results.find((x) => x.status === "rejected")).toMatchObject({
    reason: { code: "RESOURCE_CONFLICT" },
  });
  expect(
    await db.query(
      "SELECT id FROM industry_documents WHERE organization_id=$1 AND kind='appointment'",
      [organization],
    ),
  ).toHaveLength(1);
  expect(
    await db.query(
      "SELECT document_id FROM industry_slots WHERE organization_id=$1",
      [organization],
    ),
  ).toHaveLength(2);
});
it("T053: two processes migrating a fresh database apply each version exactly once", async () => {
  const name = `migrate_${randomUUID().replace(/-/g, "")}`;
  const admin = new Client({ connectionString: url! });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const target = new URL(url!);
    target.pathname = `/${name}`;
    const a = createPostgresDatabase(target.toString()),
      b = createPostgresDatabase(target.toString());
    try {
      await Promise.all([migrate(a), migrate(b)]);
      const rows = await a.query<{ n: number; v: number }>(
        "SELECT count(*)::int n,max(version)::int v FROM schema_migrations",
      );
      expect(rows[0]).toEqual({
        n: migrations.length,
        v: migrations.at(-1)!.version,
      });
    } finally {
      await a.close();
      await b.close();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
});
