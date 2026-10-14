import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { InventoryService } from "../src/server/inventory/service";
import { CommerceService } from "../src/server/commerce/service";
import { ImportService } from "../src/server/imports/service";
import { ImportWorker } from "../src/server/jobs/worker";
import { InsightService } from "../src/server/decisions/insights";
import {
  discountedTotal,
  commerceContract,
  orderView,
  financeSummary,
  calendarView,
} from "../src/domain/commerce";
let db: Database,
  p: Platform,
  s: CommerceService,
  inventory: InventoryService,
  owner: Awaited<ReturnType<Platform["register"]>>,
  seller: typeof owner,
  outsider: typeof owner,
  branchStaff: typeof owner;
let org: string,
  branch: string,
  branch2: string,
  warehouse: string,
  warehouse2: string,
  customer: string,
  account: string;
beforeAll(async () => {
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  s = new CommerceService(db);
  inventory = new InventoryService(db);
  const user = () =>
    p.register({
      name: "Commerce Test",
      email: `${randomUUID()}@example.test`,
      password: "Synthetic-Commerce-661!",
    });
  owner = await user();
  seller = await user();
  outsider = await user();
  branchStaff = await user();
  org = (
    await p.createOrganization(owner.token, {
      name: "Orders Test",
      profile: "retail",
    })
  ).id;
  branch = (await p.workspace(owner.token, org)).branches[0].id;
  branch2 = (await p.createBranch(owner.token, org, { name: "Second" })).id;
  warehouse = (
    await inventory.createWarehouse(owner.token, org, {
      branchId: branch,
      name: "Main",
    })
  ).id;
  warehouse2 = (
    await inventory.createWarehouse(owner.token, org, {
      branchId: branch2,
      name: "Other",
    })
  ).id;
  for (const [person, role, branchId] of [
    [seller, "sales", null],
    [branchStaff, "manager", branch2],
  ] as const) {
    const invite = await p.invite(owner.token, org, {
      email: person.user.email,
      role,
      branchId,
    });
    await p.acceptInvitation(person.token, { token: invite.token });
  }
  const imp = new ImportService(db),
    b = await imp.upload(owner.token, org, {
      branchId: branch,
      filename: "clients.csv",
      delimiter: ",",
      content:
        "external_id,name,email,phone\nclient,Клиент тест,client@example.test,\n",
    });
  await imp.confirm(owner.token, org, b.batch.id, { version: b.batch.version });
  const worker = new ImportWorker(db);
  await worker.dispatch();
  await worker.runOnce();
  customer = (await s.customers(owner.token, org, {})).items[0].id as string;
  account = (
    await s.createAccount(owner.token, org, {
      key: randomUUID(),
      branchId: branch,
      name: "Cash",
      opening: "1000",
    })
  ).id;
});
afterAll(async () => {
  await db?.close();
});
async function item(kind = "goods", stock = "10") {
  const id = (
    await inventory.saveItem(owner.token, org, {
      sku: randomUUID(),
      name_ru: "Товар",
      kind,
      base_unit: kind === "goods" ? "pc" : "hour",
      purchase_price: "20",
      sale_price: "100",
    })
  ).id!;
  if (kind === "goods")
    await inventory.execute(owner.token, org, {
      key: randomUUID(),
      kind: "receipt",
      warehouseId: warehouse,
      itemId: id,
      quantity: stock,
      unit: "pc",
      unitCost: "20",
      note: "Synthetic receipt",
    });
  return id;
}
async function order(
  itemId?: string,
  quantity = "3",
  price = "100",
  discount = "0",
) {
  itemId ??= await item();
  const r = await s.create(owner.token, org, {
    key: randomUUID(),
    branchId: branch,
    customerId: customer,
    warehouseId: warehouse,
    dueDate: "2020-01-01",
    delivery: "pickup",
    note: "Synthetic order",
    taxMode: "excluded",
    lines: [{ itemId, quantity, unit: "pc", price, discount }],
  });
  return r.id;
}
async function act(
  id: string,
  kind: string,
  extra: Record<string, unknown> = {},
) {
  const o = await s.get(owner.token, org, id);
  return s.transition(owner.token, org, id, {
    key: randomUUID(),
    version: o.order.version,
    kind,
    note: "Synthetic action",
    ...extra,
  });
}
const pay = (
  id: string,
  kind: string,
  amount: string,
  extra: Record<string, unknown> = {},
) =>
  s.money(owner.token, org, {
    key: randomUUID(),
    accountId: account,
    orderId: id,
    kind,
    amount,
    note: "Synthetic payment",
    ...extra,
  });
it("calculates discounts once in minor units and generates contracts", () => {
  expect(discountedTotal("0.335", "3", "10")).toBe(90n);
  expect(discountedTotal("999999999999999", "999999999999999", "0")).toBe(
    99999999999999800000000000000100n,
  );
  expect(commerceContract().schemas.Order).toBeDefined();
});
it("executes partial order, partial payment, return and refund with linked stock and exact totals", async () => {
  const id = await order(),
    before = await s.summary(owner.token, org, {});
  await act(id, "confirm");
  let o = await s.get(owner.token, org, id);
  const line = o.lines[0];
  expect(o.order.state).toBe("confirmed");
  expect(o.order.revenue_minor).toBe("0");
  const shipment = await act(id, "fulfill", { lineId: line.id, quantity: "2" });
  o = await s.get(owner.token, org, id);
  expect(o.order).toMatchObject({
    state: "partial",
    revenue_minor: "20000",
    paid_minor: "0",
    receivable_minor: "20000",
  });
  expect(
    (
      await inventory.snapshot(owner.token, org, {
        warehouseId: warehouse,
        itemId: line.item_id,
      })
    ).quantity,
  ).toBe("8.000000");
  const [balance] = await db.query(
    "SELECT reserved::text FROM stock_balances WHERE item_id=$1",
    [line.item_id],
  );
  expect(balance.reserved).toBe("1.000000");
  await pay(id, "payment", "150");
  await act(id, "return", { eventId: shipment.id, quantity: "1" });
  await pay(id, "refund", "50");
  o = await s.get(owner.token, org, id);
  expect(o.order).toMatchObject({
    revenue_minor: "10000",
    paid_minor: "10000",
    receivable_minor: "0",
    expected_minor: "10000",
  });
  await act(id, "fulfill", { lineId: line.id, quantity: "1" });
  o = await s.get(owner.token, org, id);
  expect(o.order.state).toBe("fulfilled");
  expect(o.order.revenue_minor).toBe("20000");
  const report = await s.summary(owner.token, org, {});
  expect(BigInt(report.revenue_minor) - BigInt(before.revenue_minor)).toBe(
    20000n,
  );
  expect(BigInt(report.cost_minor) - BigInt(before.cost_minor)).toBe(4000n);
  expect(report.expenses_complete).toBe(false);
  orderView.parse(JSON.parse(JSON.stringify(o)));
  financeSummary.parse(report);
});
it("blocks manual stock mutations of order reservations and issue returns", async () => {
  const id = await order();
  await act(id, "confirm");
  let o = await s.get(owner.token, org, id);
  const l = o.lines[0];
  await expect(
    inventory.execute(owner.token, org, {
      key: randomUUID(),
      kind: "release",
      warehouseId: warehouse,
      itemId: l.item_id,
      reservationId: l.reservation_id,
      note: "Bypass attempt",
    }),
  ).rejects.toMatchObject({ code: "ORDER_OPERATION_REQUIRED" });
  const event = await act(id, "fulfill", { lineId: l.id, quantity: "1" });
  o = await s.get(owner.token, org, id);
  const movement = o.events.find((v) => v.id === event.id)!.movement_id;
  await expect(
    inventory.execute(owner.token, org, {
      key: randomUUID(),
      kind: "return",
      warehouseId: warehouse,
      itemId: l.item_id,
      movementId: movement,
      quantity: "1",
      unit: "pc",
      note: "Bypass attempt",
    }),
  ).rejects.toMatchObject({ code: "ORDER_OPERATION_REQUIRED" });
});
it("rolls back confirmation entirely if any line cannot be reserved", async () => {
  const a = await item(),
    b = await item("goods", "1"),
    r = await s.create(owner.token, org, {
      key: randomUUID(),
      branchId: branch,
      customerId: customer,
      warehouseId: warehouse,
      dueDate: "2030-01-01",
      delivery: "delivery",
      taxMode: "excluded",
      note: "Atomic confirm",
      lines: [a, b].map((itemId) => ({
        itemId,
        quantity: "2",
        unit: "pc",
        price: "100",
      })),
    });
  await expect(act(r.id, "confirm")).rejects.toMatchObject({
    code: "INSUFFICIENT_STOCK",
  });
  expect((await s.get(owner.token, org, r.id)).order.state).toBe("draft");
  const balances = await db.query<{ reserved: string }>(
    "SELECT reserved::text FROM stock_balances WHERE item_id=ANY($1::uuid[])",
    [[a, b]],
  );
  expect(balances.every((v) => v.reserved === "0.000000")).toBe(true);
});
it("deduplicates order commands and payments, rejects changed payload and stale versions", async () => {
  const id = await order(),
    o = await s.get(owner.token, org, id),
    c = {
      key: randomUUID(),
      version: o.order.version,
      kind: "confirm",
      note: "Repeat confirmation",
    };
  expect((await s.transition(owner.token, org, id, c)).reused).toBe(false);
  expect((await s.transition(owner.token, org, id, c)).reused).toBe(true);
  await expect(
    s.transition(owner.token, org, id, { ...c, note: "Changed payload" }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(
    s.transition(owner.token, org, id, {
      ...c,
      key: randomUUID(),
      kind: "cancel",
    }),
  ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  const key = randomUUID();
  await pay(id, "payment", "10", { key });
  expect((await pay(id, "payment", "10", { key })).reused).toBe(true);
  expect((await s.get(owner.token, org, id)).order.paid_minor).toBe("1000");
});
it("keeps rounding remainders across fractional fulfillment and returns", async () => {
  const id = await order(undefined, "3", "0.003333");
  await act(id, "confirm");
  const l = (await s.get(owner.token, org, id)).lines[0];
  for (let i = 0; i < 3; i++)
    await act(id, "fulfill", { lineId: l.id, quantity: "1" });
  let o = await s.get(owner.token, org, id);
  expect(o.order.revenue_minor).toBe("1");
  for (const e of o.events.filter((e) => e.kind === "fulfill"))
    await act(id, "return", { eventId: e.id, quantity: "1" });
  o = await s.get(owner.token, org, id);
  expect(o.order.revenue_minor).toBe("0");
  expect(o.lines[0].returned).toBe("3.000000");
});
it("cancels only the remainder, preserves executed revenue and makes overpayment refundable", async () => {
  const id = await order();
  await act(id, "confirm");
  const l = (await s.get(owner.token, org, id)).lines[0];
  await pay(id, "payment", "300");
  await act(id, "fulfill", { lineId: l.id, quantity: "1" });
  await act(id, "cancel");
  expect((await s.get(owner.token, org, id)).order).toMatchObject({
    state: "cancelled",
    revenue_minor: "10000",
    paid_minor: "30000",
    credit_minor: "20000",
  });
  await pay(id, "refund", "200");
  expect(
    (
      await db.query(
        "SELECT reserved::text FROM stock_balances WHERE item_id=$1",
        [l.item_id],
      )
    )[0].reserved,
  ).toBe("0.000000");
  await expect(
    act(id, "fulfill", { lineId: l.id, quantity: "1" }),
  ).rejects.toMatchObject({ code: "ORDER_STATE" });
});
it("rejects excessive quantities, payments, refunds and empty-account spending", async () => {
  const id = await order();
  await act(id, "confirm");
  const l = (await s.get(owner.token, org, id)).lines[0];
  await expect(
    act(id, "fulfill", { lineId: l.id, quantity: "4" }),
  ).rejects.toMatchObject({ code: "QUANTITY_EXCEEDS" });
  await expect(pay(id, "payment", "301")).rejects.toMatchObject({
    code: "PAYMENT_EXCEEDS",
  });
  await expect(pay(id, "refund", "1")).rejects.toMatchObject({
    code: "REFUND_EXCEEDS",
  });
  const a = (
    await s.createAccount(owner.token, org, {
      key: randomUUID(),
      branchId: branch,
      name: randomUUID(),
      opening: "0",
    })
  ).id;
  await expect(
    s.money(owner.token, org, {
      key: randomUUID(),
      kind: "expense",
      accountId: a,
      amount: "1",
      category: "Rent",
      counterparty: "Supplier",
      operating: true,
      note: "No money",
    }),
  ).rejects.toMatchObject({ code: "INSUFFICIENT_MONEY" });
});
it("separates transfers, operating expenses and supplier payments from revenue", async () => {
  const a = (
      await s.createAccount(owner.token, org, {
        key: randomUUID(),
        branchId: branch,
        name: randomUUID(),
        opening: "0",
      })
    ).id,
    before = await s.summary(owner.token, org, {});
  await s.money(owner.token, org, {
    key: randomUUID(),
    kind: "transfer",
    accountId: account,
    destinationId: a,
    amount: "100",
    note: "Between accounts",
  });
  expect((await s.summary(owner.token, org, {})).cash_minor).toBe(
    before.cash_minor,
  );
  const ob = (
    await s.createObligation(owner.token, org, {
      key: randomUUID(),
      branchId: branch,
      supplier: "Supplier test",
      amount: "100",
      dueDate: "2030-01-01",
      note: "Supplier invoice",
    })
  ).id;
  await s.money(owner.token, org, {
    key: randomUUID(),
    kind: "supplier_payment",
    accountId: a,
    obligationId: ob,
    amount: "40",
    note: "Partial supplier payment",
  });
  await s.money(owner.token, org, {
    key: randomUUID(),
    kind: "expense",
    accountId: a,
    amount: "10",
    category: "Rent",
    counterparty: "Landlord",
    operating: true,
    note: "Operating expense",
  });
  const after = await s.summary(owner.token, org, {});
  expect(after.revenue_minor).toBe(before.revenue_minor);
  expect(
    BigInt(after.operating_expenses_minor) -
      BigInt(before.operating_expenses_minor),
  ).toBe(1000n);
  expect(BigInt(after.payable_minor) - BigInt(before.payable_minor)).toBe(
    6000n,
  );
  const [sum] = await db.query(
    "SELECT sum(amount_minor)::text total FROM money_entries WHERE account_id=$1",
    [a],
  );
  expect(sum.total).toBe("5000");
});
it("enforces tenant/branch/role scope and redacts cost from sales", async () => {
  const id = await order();
  await act(id, "confirm");
  const l = (await s.get(owner.token, org, id)).lines[0];
  await act(id, "fulfill", { lineId: l.id, quantity: "1" });
  const sales = await s.get(seller.token, org, id);
  expect(JSON.stringify(sales)).not.toContain("cost_minor");
  await expect(s.summary(seller.token, org, {})).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(s.get(outsider.token, org, id)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(s.get(branchStaff.token, org, id)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect((await s.list(branchStaff.token, org, {})).items).toEqual([]);
  await expect(
    s.create(owner.token, org, {
      key: randomUUID(),
      branchId: branch2,
      customerId: customer,
      warehouseId: warehouse2,
      dueDate: "2030-01-01",
      delivery: "pickup",
      taxMode: "excluded",
      note: "Wrong branch",
      lines: [{ itemId: l.item_id, quantity: "1", unit: "pc", price: "10" }],
    }),
  ).rejects.toMatchObject({ code: "CUSTOMER_SCOPE" });
});
it("does not invent zero cost for services and blocks unit changes after an order", async () => {
  const service = await item("service"),
    id = (
      await s.create(owner.token, org, {
        key: randomUUID(),
        branchId: branch,
        customerId: customer,
        warehouseId: warehouse,
        dueDate: "2030-01-01",
        delivery: "pickup",
        taxMode: "excluded",
        note: "Service order",
        lines: [{ itemId: service, quantity: "1", unit: "hour", price: "100" }],
      })
    ).id;
  await act(id, "confirm");
  const l = (await s.get(owner.token, org, id)).lines[0];
  await act(id, "fulfill", { lineId: l.id, quantity: "1" });
  const report = await s.summary(owner.token, org, {});
  expect(report.unknown_cost_events).toBeGreaterThan(0);
  expect(report.gross_profit_minor).toBe(null);
  await expect(
    inventory.saveItem(
      owner.token,
      org,
      {
        sku: randomUUID(),
        name_ru: "Service",
        kind: "service",
        base_unit: "pc",
        purchase_price: "0",
        sale_price: "100",
        version: 1,
      },
      service,
    ),
  ).rejects.toMatchObject({ code: "UNIT_LOCKED" });
});

it("forecasts delayed receipts and changed planned payouts without changing business records", async () => {
  const id = await order();
  await act(id, "confirm");
  await s.createObligation(owner.token, org, {
    key: randomUUID(),
    branchId: branch,
    supplier: "Calendar supplier",
    amount: "100",
    dueDate: "2020-01-01",
    note: "Overdue invoice",
  });
  const before = await s.summary(owner.token, org, {}),
    [count] = await db.query("SELECT count(*)::int n FROM money_entries");
  const forecast = await s.calendar(owner.token, org, {
    days: 2,
    delayDays: 3,
    expensePercent: "150",
  });
  calendarView.parse(forecast);
  expect(forecast.documents.find((d) => d.id === id)?.overdue).toBe(true);
  expect(BigInt(forecast.baseline_minor)).toBe(
    BigInt(forecast.opening_minor) +
      BigInt(forecast.planned_in_minor) -
      BigInt(forecast.planned_out_minor),
  );
  expect(BigInt(forecast.scenario_minor)).toBe(
    BigInt(forecast.opening_minor) -
      (BigInt(forecast.planned_out_minor) * 3n) / 2n,
  );
  expect(await s.summary(owner.token, org, {})).toEqual(before);
  expect(
    (await db.query("SELECT count(*)::int n FROM money_entries"))[0],
  ).toEqual(count);
  await expect(s.calendar(seller.token, org, {})).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect((await s.calendar(branchStaff.token, org, {})).documents).toEqual([]);
});

it("paginates order history and rejects excess returns without altering stock or revenue", async () => {
  const id = await order();
  await act(id, "confirm");
  const line = (await s.get(owner.token, org, id)).lines[0],
    event = await act(id, "fulfill", { lineId: line.id, quantity: "2" });
  const page1 = await s.get(owner.token, org, id, { page: 1, limit: 1 }),
    page2 = await s.get(owner.token, org, id, { page: 2, limit: 1 });
  expect(page1.events).toHaveLength(1);
  expect(page1.events[0].id).not.toBe(page2.events[0].id);
  expect(page1.eventPagination.total).toBe(3);
  await act(id, "return", { eventId: event.id, quantity: "1" });
  const before = await s.get(owner.token, org, id),
    balance = await inventory.snapshot(owner.token, org, {
      warehouseId: warehouse,
      itemId: line.item_id,
    });
  await expect(
    act(id, "return", { eventId: event.id, quantity: "2" }),
  ).rejects.toMatchObject({ code: "RETURN_EXCEEDS" });
  expect(await s.get(owner.token, org, id)).toEqual(before);
  expect(
    await inventory.snapshot(owner.token, org, {
      warehouseId: warehouse,
      itemId: line.item_id,
    }),
  ).toEqual(balance);
});
it("denies financial writes from sales and cross-branch payment allocation", async () => {
  const id = await order();
  await act(id, "confirm");
  const c = {
    key: randomUUID(),
    kind: "payment",
    orderId: id,
    accountId: account,
    amount: "1",
    note: "Permission test",
  };
  await expect(s.money(seller.token, org, c)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(s.money(outsider.token, org, c)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(s.money(branchStaff.token, org, c)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  const a = (
    await s.createAccount(owner.token, org, {
      key: randomUUID(),
      branchId: branch2,
      name: randomUUID(),
      opening: "0",
    })
  ).id;
  await expect(
    s.money(owner.token, org, { ...c, accountId: a }),
  ).rejects.toMatchObject({ code: "ACCOUNT_SCOPE" });
});
it("shows zero revenue and no percentages for an organization that only received other cash", async () => {
  const organization = (
      await p.createOrganization(owner.token, {
        name: "No sales test",
        profile: "services",
      })
    ).id,
    b = (await p.workspace(owner.token, organization)).branches[0].id;
  const a = (
    await s.createAccount(owner.token, organization, {
      key: randomUUID(),
      branchId: b,
      name: "Cash",
      opening: "0",
    })
  ).id;
  await s.money(owner.token, organization, {
    key: randomUUID(),
    kind: "income",
    accountId: a,
    amount: "100",
    category: "Capital",
    counterparty: "Owner",
    note: "Capital contribution",
  });
  expect(await s.summary(owner.token, organization, {})).toMatchObject({
    revenue_minor: "0",
    cash_minor: "10000",
    margin_percent: null,
    markup_percent: null,
    gross_profit_minor: "0",
  });
});
it("T023: detects below-cost sales, unknown cost and stocked goods without a sale price, visible only with cost rights", async () => {
  const cheap = await item();
  const id = await order(cheap, "3", "10");
  await act(id, "confirm");
  const line = (await s.get(owner.token, org, id)).lines[0];
  await act(id, "fulfill", { lineId: line.id, quantity: "3" });
  const unpriced = (
    await inventory.saveItem(owner.token, org, {
      sku: randomUUID(),
      name_ru: "Без цены",
      kind: "goods",
      base_unit: "pc",
      purchase_price: null,
      sale_price: null,
    })
  ).id!;
  await inventory.execute(owner.token, org, {
    key: randomUUID(),
    kind: "receipt",
    warehouseId: warehouse,
    itemId: unpriced,
    quantity: "2",
    unit: "pc",
    unitCost: "5",
    note: "Synthetic receipt",
  });
  const ins = new InsightService(db);
  await ins.detect(org);
  const list = async (token: string, rule: string) =>
    (
      (await ins.list(token, org, { rule })) as unknown as {
        items: {
          entity_id: string;
          severity: number;
          evidence: { facts: Record<string, unknown> };
        }[];
      }
    ).items;
  const below = (await list(owner.token, "below_cost_sale")).find(
    (x) => x.entity_id === line.id,
  );
  expect(below).toMatchObject({
    severity: 3,
    evidence: {
      facts: { revenue_kzt: "30.00", cost_kzt: "60.00", loss_kzt: "30.00" },
    },
  });
  // The service fulfilled earlier has no cost: reported as a data gap, not as a profit.
  const unknown = await list(owner.token, "unknown_cost");
  expect(unknown.length).toBeGreaterThan(0);
  expect(unknown[0].evidence.facts).not.toHaveProperty("cost_kzt");
  const missing = await list(owner.token, "missing_sale_price");
  expect(missing[0]).toMatchObject({ entity_id: branch });
  expect(Number(missing[0].evidence.facts.items_without_price)).toBe(1);
  // A seller without cost rights does not see cost-based situations.
  expect(await list(seller.token, "below_cost_sale")).toEqual([]);
  // Once the item gets a price, the situation clears on the next detection.
  await inventory.saveItem(
    owner.token,
    org,
    {
      sku: (await inventory.catalog(owner.token, org, { q: "Без цены" }))
        .items[0].sku,
      name_ru: "Без цены",
      kind: "goods",
      base_unit: "pc",
      purchase_price: null,
      sale_price: "15",
      version: 1,
    },
    unpriced,
  );
  await ins.detect(org);
  expect(await list(owner.token, "missing_sale_price")).toEqual([]);
});
