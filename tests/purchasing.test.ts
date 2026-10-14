import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { PurchasingService } from "../src/server/purchasing/service";
import { InventoryService } from "../src/server/inventory/service";
import { CommerceService } from "../src/server/commerce/service";
import { ImportService } from "../src/server/imports/service";
import { ImportWorker } from "../src/server/jobs/worker";
import {
  comparison,
  purchaseDetail,
  documentView,
  needView,
  budgetView,
  priceOffer,
} from "../src/domain/purchasing";
let db: Database,
  p: Platform,
  s: PurchasingService,
  inventory: InventoryService,
  org: string,
  branch: string,
  warehouse: string,
  sku: string,
  supplier: string,
  owner: string,
  seller: string,
  purchaser: string,
  outsider: string;
const date = "2026-10-14",
  key = () => randomUUID();
beforeAll(async () => {
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  s = new PurchasingService(db);
  inventory = new InventoryService(db);
  const user = async () =>
    p.register({
      name: "Purchase Test",
      email: `${key()}@example.test`,
      password: "Synthetic-Purchase-661!",
    });
  const u = await user();
  owner = u.token;
  org = (
    await p.createOrganization(owner, {
      name: "Purchase Lab",
      profile: "retail",
    })
  ).id;
  branch = (await p.workspace(owner, org)).branches[0].id;
  warehouse = (
    await inventory.createWarehouse(owner, org, {
      branchId: branch,
      name: "Main",
    })
  ).id;
  for (const role of ["sales", "purchasing"] as const) {
    const u = await user(),
      i = await p.invite(owner, org, {
        email: u.user.email,
        role,
        branchId: branch,
      });
    await p.acceptInvitation(u.token, { token: i.token });
    if (role === "sales") seller = u.token;
    else purchaser = u.token;
  }
  outsider = (await user()).token;
  sku = (
    await inventory.saveItem(owner, org, {
      sku: "SKU",
      name_ru: "Тестовый товар",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "0",
      sale_price: "100",
      conversions: [{ unit: "box", factor: "6" }],
    })
  ).id!;
  supplier = (
    await s.createSupplier(owner, org, {
      key: key(),
      name: "Supplier One",
      contact: "test",
      paymentTerms: "After invoice",
      quality: 4,
      reliability: 4,
    })
  ).id;
});
afterAll(async () => {
  await db?.close();
});
it("keeps corrections and preview separate from approval, stock and payables", async () => {
  const id = await purchase();
  await advance(id);
  const doc = await upload(id),
    c = review({
      total: "144",
      lines: [
        {
          itemId: sku,
          name: "Тестовый товар",
          unit: "pc",
          quantity: "12",
          unitPrice: "11",
        },
      ],
    });
  const before = await db.query(
    "SELECT count(*)::int n FROM procurement_commands",
  );
  const preview = await s.review(owner, org, doc, c, "preview");
  expect(preview).toMatchObject({
    total_minor: "14400",
    discrepancies: [`price:${sku}`, "total"],
  });
  expect(
    await db.query("SELECT count(*)::int n FROM procurement_commands"),
  ).toEqual(before);
  await s.review(owner, org, doc, c, "draft");
  let d = documentView.parse(
    JSON.parse(JSON.stringify(await s.document(owner, org, doc))),
  );
  expect(d.document.state).toBe("review");
  expect(d.document.obligation_id).toBeNull();
  expect(d.lines).toHaveLength(0);
  expect(d.document.version).toBe(2);
  await s.review(owner, org, doc, { ...c, key: key(), version: 2 });
  d = documentView.parse(
    JSON.parse(JSON.stringify(await s.document(owner, org, doc))),
  );
  expect(d.revisions).toHaveLength(2);
  expect(d.document.state).toBe("approved");
});
const offer = (overrides: Record<string, unknown> = {}) => ({
  key: key(),
  supplierId: supplier,
  itemId: sku,
  supplierSku: "BOX-6",
  packQuantity: "6",
  baseUnit: "pc",
  packPrice: "60",
  minimumPacks: 1,
  delivery: "12",
  leadDays: 3,
  currency: "KZT",
  rate: null,
  rateDate: null,
  rateSource: "",
  tax: "included",
  taxPercent: null,
  dated: date,
  validUntil: "2026-12-31",
  characteristicsConfirmed: true,
  note: "Synthetic offer",
  ...overrides,
});
async function purchase(qty = "12") {
  const f = await s.createOffer(owner, org, offer());
  const o = await s.create(owner, org, {
    key: key(),
    branchId: branch,
    warehouseId: warehouse,
    supplierId: supplier,
    date,
    dueDate: date,
    budget: "2000",
    note: "Synthetic order",
    lines: [{ offerId: f.id, quantity: qty }],
  });
  return o.id;
}
async function advance(id: string) {
  for (const kind of ["submit", "approve", "sent"]) {
    const o = await s.get(owner, org, id);
    await s.transition(owner, org, id, {
      key: key(),
      version: o.order.version,
      kind,
      note: "Reviewed order",
    });
  }
}
async function upload(id: string) {
  return (
    await s.upload(owner, org, {
      key: key(),
      orderId: id,
      filename: "invoice.csv",
      content: Buffer.from(
        `name,quantity,unit,price\nТестовый товар,2,box,60\n#${key()}`,
      ).toString("base64"),
      externalId: "",
    })
  ).id;
}
const review = (overrides: Record<string, unknown> = {}) => ({
  key: key(),
  version: 1,
  number: key(),
  date,
  dueDate: date,
  delivery: "12",
  total: "132",
  lines: [
    {
      itemId: sku,
      name: "Тестовый товар",
      unit: "box",
      quantity: "2",
      unitPrice: "60",
    },
  ],
  note: "Checked against original",
  acknowledgeDiscrepancies: true,
  ...overrides,
});
it("compares whole packs, minimums, delivery and dated currencies without converting unknowns to zero", async () => {
  await s.createOffer(owner, org, offer());
  await s.createOffer(
    owner,
    org,
    offer({
      packQuantity: "10",
      packPrice: "95",
      delivery: "0",
      supplierSku: "BOX-10",
    }),
  );
  await s.createOffer(owner, org, offer({ delivery: null }));
  const c = await s.compare(owner, org, { itemId: sku, quantity: "12", date });
  expect(comparison.safeParse(JSON.parse(JSON.stringify(c))).success).toBe(
    true,
  );
  expect(c.offers[0].total_minor).toBe("13200");
  expect(c.offers.find((o) => o.data.packQuantity === "10")?.quantity).toBe(
    "20",
  );
  expect(c.offers.at(-1)?.total_minor).toBeNull();
  const foreign = offer({
    currency: "USD",
    rate: "500",
    rateDate: date,
    rateSource: "Manual confirmed rate",
    tax: "excluded",
    taxPercent: "10",
  });
  expect(
    priceOffer(foreign as Parameters<typeof priceOffer>[0], "6", date)
      .total_minor,
  ).toBe("3900000");
});
it("requires approval permission and rejects budget overruns", async () => {
  const id = await purchase();
  await s.transition(purchaser, org, id, {
    key: key(),
    version: 1,
    kind: "submit",
    note: "Please approve",
  });
  await expect(
    s.transition(purchaser, org, id, {
      key: key(),
      version: 2,
      kind: "approve",
      note: "Self approve",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    s.create(owner, org, {
      key: key(),
      branchId: branch,
      warehouseId: warehouse,
      supplierId: supplier,
      date,
      dueDate: date,
      budget: "1",
      note: "Too small",
      lines: [
        {
          offerId: (await s.createOffer(owner, org, offer())).id,
          quantity: "12",
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
});
it("upload never posts stock; approval creates a linked payable; partial receipt and retries preserve cost exactly", async () => {
  const id = await purchase();
  await advance(id);
  const doc = await upload(id);
  const before = await db.query(
    "SELECT * FROM stock_balances WHERE organization_id=$1",
    [org],
  );
  await expect(
    s.receive(owner, org, id, {
      key: key(),
      documentId: doc,
      version: 4,
      note: "Physical count",
      lines: [{ lineId: key(), quantity: "6" }],
    }),
  ).rejects.toMatchObject({ code: "DOCUMENT_NOT_APPROVED" });
  expect(
    await db.query("SELECT * FROM stock_balances WHERE organization_id=$1", [
      org,
    ]),
  ).toEqual(before);
  const approval = review();
  await s.review(owner, org, doc, approval);
  expect((await s.review(owner, org, doc, approval)).reused).toBe(true);
  const detail = documentView.parse(
    JSON.parse(JSON.stringify(await s.document(owner, org, doc))),
  );
  expect(detail.document.obligation_id).toBeTruthy();
  expect(detail.document.discrepancies).toEqual([]);
  const cmd = {
    key: key(),
    documentId: doc,
    version: 4,
    note: "Six units accepted",
    lines: [{ lineId: detail.lines[0].id, quantity: "6" }],
  };
  await s.receive(owner, org, id, cmd);
  expect((await s.receive(owner, org, id, cmd)).reused).toBe(true);
  let o = await s.get(owner, org, id);
  expect(o.order.state).toBe("partial");
  expect(purchaseDetail.safeParse(JSON.parse(JSON.stringify(o))).success).toBe(
    true,
  );
  await s.receive(owner, org, id, { ...cmd, key: key(), version: 5 });
  o = await s.get(owner, org, id);
  expect(o.order.state).toBe("completed");
  const [sum] = await db.query<{ value: string; qty: string }>(
    "SELECT sum(r.value_minor)::text value,sum(r.quantity)::text qty FROM purchase_receipts r JOIN purchase_document_lines l ON l.organization_id=r.organization_id AND l.id=r.document_line_id WHERE l.document_id=$1",
    [doc],
  );
  expect(sum.value).toBe("13200");
  expect(Number(sum.qty)).toBe(12);
  const finance = await new CommerceService(db).obligations(owner, org, {});
  expect(
    finance.items.some(
      (x: Record<string, unknown>) => x.id === detail.document.obligation_id,
    ),
  ).toBe(true);
});
it("detects same file, external ID and invoice identity before posting", async () => {
  const id = await purchase();
  await advance(id);
  const input = {
    key: key(),
    orderId: id,
    filename: "same.csv",
    content: Buffer.from(`sku,qty\n${key()},1`).toString("base64"),
    externalId: key(),
  };
  const doc = (await s.upload(owner, org, input)).id;
  expect((await s.upload(owner, org, input)).reused).toBe(true);
  await expect(
    s.upload(owner, org, { ...input, key: key(), filename: "renamed.csv" }),
  ).rejects.toMatchObject({ code: "DUPLICATE_DOCUMENT" });
  await expect(
    s.upload(owner, org, {
      ...input,
      key: key(),
      content: Buffer.from("different,1").toString("base64"),
    }),
  ).rejects.toMatchObject({ code: "DUPLICATE_DOCUMENT" });
  const c = review();
  await s.review(owner, org, doc, c);
  const other = await upload(id);
  await expect(
    s.review(owner, org, other, { ...c, key: key() }),
  ).rejects.toMatchObject({ code: "DUPLICATE_DOCUMENT" });
});
it("requires explicit discrepancy acknowledgment and rolls back invalid actual quantities", async () => {
  const id = await purchase();
  await advance(id);
  const doc = await upload(id);
  await expect(
    s.review(
      owner,
      org,
      doc,
      review({
        acknowledgeDiscrepancies: false,
        total: "134",
        lines: [
          {
            itemId: sku,
            name: "Тестовый товар",
            unit: "box",
            quantity: "2",
            unitPrice: "61",
          },
        ],
      }),
    ),
  ).rejects.toMatchObject({ code: "DISCREPANCY_REVIEW_REQUIRED" });
  await s.review(owner, org, doc, review());
  const d = documentView.parse(
    JSON.parse(JSON.stringify(await s.document(owner, org, doc))),
  );
  await expect(
    s.receive(owner, org, id, {
      key: key(),
      documentId: doc,
      version: 4,
      note: "Too many units",
      lines: [{ lineId: d.lines[0].id, quantity: "13" }],
    }),
  ).rejects.toMatchObject({ code: "QUANTITY_EXCEEDS" });
  expect((await s.get(owner, org, id)).order.version).toBe(4);
});
it("enforces organization, branch and role for originals and procurement", async () => {
  const id = await purchase(),
    doc = await upload(id);
  for (const token of [outsider, seller]) {
    await expect(s.get(token, org, id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(s.document(token, org, doc, true)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  }
  const branch2 = (await p.createBranch(owner, org, { name: "Other" })).id,
    wh = (
      await inventory.createWarehouse(owner, org, {
        branchId: branch2,
        name: "Other",
      })
    ).id;
  await expect(
    s.need(purchaser, org, {
      warehouseId: wh,
      itemId: sku,
      minimum: "1",
      safety: "1",
      leadDays: 3,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
it("uses explicit minimum fallback for short history and returns read-only budget alternatives", async () => {
  const result = await s.need(owner, org, {
    warehouseId: warehouse,
    itemId: sku,
    minimum: "20",
    safety: "2",
    leadDays: 3,
  });
  expect(needView.safeParse(result).success).toBe(true);
  expect(result.method).toBe("minimum_rule");
  expect(result.warnings).toContain("zero_sales_not_zero_demand");
  const budget = await s.budget(owner, org, {
    budget: "1",
    date,
    lines: [{ itemId: sku, quantity: "12", priority: 1 }],
  });
  expect(budgetView.safeParse(budget).success).toBe(true);
  expect(budget.lines[0].selected_offer_id).toBeNull();
  expect(budget.remaining_minor).toBe("100");
});
it("keeps purchased cost through sale, partial payment, return and refund", async () => {
  const imp = new ImportService(db),
    batch = await imp.upload(owner, org, {
      branchId: branch,
      filename: "purchase-customer.csv",
      delimiter: ",",
      content:
        "external_id,name,email,phone\nprocurement,Customer Purchase,customer@example.test,\n",
    });
  await imp.confirm(owner, org, batch.batch.id, {
    version: batch.batch.version,
  });
  const worker = new ImportWorker(db);
  await worker.dispatch();
  await worker.runOnce();
  const commerce = new CommerceService(db),
    customer = (await commerce.customers(owner, org, {})).items[0].id;
  const order = (
    await commerce.create(owner, org, {
      key: key(),
      branchId: branch,
      warehouseId: warehouse,
      customerId: customer,
      dueDate: date,
      delivery: "pickup",
      taxMode: "excluded",
      note: "Purchased goods sale",
      lines: [
        { itemId: sku, quantity: "3", unit: "pc", price: "20", discount: "0" },
      ],
    })
  ).id;
  await commerce.transition(owner, org, order, {
    key: key(),
    version: 1,
    kind: "confirm",
    note: "Confirmed sale",
  });
  let d = await commerce.get(owner, org, order);
  await commerce.transition(owner, org, order, {
    key: key(),
    version: d.order.version,
    kind: "fulfill",
    lineId: d.lines[0].id,
    quantity: "2",
    note: "Two units sold",
  });
  const account = (
    await commerce.createAccount(owner, org, {
      key: key(),
      branchId: branch,
      name: "Purchase Sale Cash",
      opening: "0",
    })
  ).id;
  await commerce.money(owner, org, {
    key: key(),
    kind: "payment",
    accountId: account,
    orderId: order,
    amount: "30",
    note: "Partial payment",
  });
  d = await commerce.get(owner, org, order);
  const sold = d.events.find(
    (e: Record<string, unknown>) => e.kind === "fulfill",
  )!;
  expect(sold.cost_minor).toBe("2200");
  await commerce.transition(owner, org, order, {
    key: key(),
    version: d.order.version,
    kind: "return",
    eventId: sold.id,
    quantity: "1",
    note: "One unit returned",
  });
  await commerce.money(owner, org, {
    key: key(),
    kind: "refund",
    accountId: account,
    orderId: order,
    amount: "10",
    note: "Refund for return",
  });
  d = await commerce.get(owner, org, order);
  expect(d.order).toMatchObject({
    revenue_minor: "2000",
    paid_minor: "2000",
    receivable_minor: "0",
  });
  expect((await commerce.summary(owner, org, {})).gross_profit_minor).toBe(
    "900",
  );
});
