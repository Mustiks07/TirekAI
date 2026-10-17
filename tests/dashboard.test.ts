import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { InventoryService } from "../src/server/inventory/service";
import { PurchasingService } from "../src/server/purchasing/service";
import { CommerceService } from "../src/server/commerce/service";
import { CrmService } from "../src/server/crm/service";
import { InsightService } from "../src/server/decisions/insights";
import { DashboardService } from "../src/server/decisions/dashboard";
import { dashboardView, notificationsView } from "../src/domain/dashboard";

// T005/T052 main screen: the view is computed from real records, names what is missing instead
// of showing zero, follows role and branch scope; the reserve is a versioned, idempotent command.
let db: Database,
  p: Platform,
  inv: InventoryService,
  pur: PurchasingService,
  sales: CommerceService,
  crm: CrmService,
  ins: InsightService,
  dash: DashboardService,
  owner: string,
  manager2: string,
  employee: string,
  org: string,
  branch: string,
  branch2: string,
  warehouse: string,
  warehouse2: string,
  item: string;
const key = () => randomUUID();
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const view = async (token: string, input: Record<string, unknown> = {}) =>
  dashboardView.parse(json(await dash.view(token, org, input)));
beforeAll(async () => {
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  inv = new InventoryService(db);
  pur = new PurchasingService(db);
  sales = new CommerceService(db);
  crm = new CrmService(db);
  ins = new InsightService(db);
  dash = new DashboardService(db);
  const user = () =>
    p.register({
      name: `User ${key().slice(0, 4)}`,
      email: `${key()}@example.test`,
      password: "Synthetic-Dashboard-661!",
    });
  owner = (await user()).token;
  org = (
    await p.createOrganization(owner, { name: "Dash Lab", profile: "retail" })
  ).id;
  branch = (await p.workspace(owner, org)).branches[0].id;
  branch2 = (await p.createBranch(owner, org, { name: "Второй" })).id;
  const join = async (role: string, branchId: string) => {
    const u = await user(),
      i = await p.invite(owner, org, {
        email: u.user.email,
        role,
        branchId,
      });
    await p.acceptInvitation(u.token, { token: i.token });
    return u.token;
  };
  manager2 = await join("manager", branch2);
  employee = await join("employee", branch);
  warehouse = (
    await inv.createWarehouse(owner, org, { branchId: branch, name: "Main" })
  ).id;
  warehouse2 = (
    await inv.createWarehouse(owner, org, { branchId: branch2, name: "Other" })
  ).id;
});
afterAll(async () => {
  await db?.close();
});

it("names what is missing on an empty organization instead of showing zeros", async () => {
  const v = await view(owner);
  expect(v.situations).toMatchObject({ state: "no_data", main: null });
  expect(v.cash).toMatchObject({
    state: "insufficient",
    opening_minor: null,
    reserve_minor: null,
  });
  expect(v.payment.amount_minor).toBeNull();
  expect(v.branches.rows.every((r) => r.change_percent === null)).toBe(true);
  expect(v.events.state).toBe("no_data");
  expect(notificationsView.parse(await dash.notifications(owner, org))).toEqual(
    { approvals: 0, overdue_tasks: 0, situations: 0 },
  );
});

it("builds the main situation from stock, sales history, lead time and the supplier offer", async () => {
  item = (
    await inv.saveItem(owner, org, {
      sku: "TEA-DASH",
      name_ru: "Чай",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "40",
      sale_price: "100",
    })
  ).id!;
  for (const [w, q] of [
    [warehouse, "10"],
    [warehouse2, "20"],
  ] as const)
    await inv.execute(owner, org, {
      key: key(),
      kind: "receipt",
      warehouseId: w,
      itemId: item,
      quantity: q,
      unit: "pc",
      unitCost: "40",
      note: "Opening stock",
    });
  const supplier = (
    await pur.createSupplier(owner, org, {
      key: key(),
      name: "Supplier Dash",
      contact: "test",
      paymentTerms: "On invoice",
      quality: 4,
      reliability: 4,
    })
  ).id;
  await pur.createOffer(owner, org, {
    key: key(),
    supplierId: supplier,
    itemId: item,
    supplierSku: "BOX-1",
    packQuantity: "1",
    baseUnit: "pc",
    packPrice: "50",
    minimumPacks: 1,
    delivery: "0",
    leadDays: 3,
    currency: "KZT",
    rate: null,
    rateDate: null,
    rateSource: "",
    tax: "included",
    taxPercent: null,
    dated: "2026-01-01",
    validUntil: "2030-12-31",
    characteristicsConfirmed: true,
    note: "Synthetic offer",
  });
  // Sales through the order service: 8 pc in the main branch, 3 pc in the second one.
  for (const [b, w, quantity] of [
    [branch, warehouse, "8"],
    [branch2, warehouse2, "3"],
  ] as const) {
    const customer = (
      await crm.createCustomer(owner, org, {
        key: key(),
        branchId: b,
        name: `Клиент ${quantity}`,
        email: "",
        phone: "",
        kind: "company",
        responsibleId: null,
        consents: { email: false, sms: false, messenger: false },
        consentNote: "Synthetic test client",
      })
    ).id;
    const id = (
      await sales.create(owner, org, {
        key: key(),
        branchId: b,
        customerId: customer,
        warehouseId: w,
        // Due today: an overdue receivable would be a more urgent situation.
        dueDate: new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Qyzylorda",
        }).format(new Date()),
        delivery: "pickup",
        note: "Synthetic order",
        taxMode: "excluded",
        lines: [
          { itemId: item, quantity, unit: "pc", price: "100", discount: "0" },
        ],
      })
    ).id;
    const step = async (kind: string, extra: Record<string, unknown> = {}) => {
      const o = await sales.get(owner, org, id);
      return sales.transition(owner, org, id, {
        key: key(),
        version: o.order.version,
        kind,
        note: "Synthetic action",
        ...extra,
      });
    };
    await step("confirm");
    const line = (await sales.get(owner, org, id)).lines[0];
    await step("fulfill", { lineId: line.id, quantity });
  }
  for (const [w, minimum] of [
    [warehouse, "5"],
    [warehouse2, "4"],
  ] as const)
    await ins.setReorderPoint(owner, org, {
      warehouseId: w,
      itemId: item,
      minimum,
      safety: "1",
      leadDays: 3,
      version: 0,
    });
  await ins.detect(org);

  const v = await view(owner);
  expect(v.situations.state).toBe("ok");
  const m = v.situations.main!;
  expect(m.rule).toBe("low_stock");
  expect(m.stock).toMatchObject({
    available: "2",
    sold: "8",
    history_days: 1,
    daily_sales: "8",
    lead_days: 3,
    average_price_minor: "10000",
    // 8 pc/day × 3 days − 2 pc on hand = 22 pc that cannot be sold before delivery, × 100 ₸.
    lost_units: "22",
    revenue_at_risk_minor: "220000",
    // The second warehouse holds 17 pc against its own 4 + 1: 12 spare, capped by the shortage.
    transfer: { warehouse: "Other", available: "17" },
  });
  expect(m.stock!.order).toMatchObject({ supplier: "Supplier Dash" });
  // One day of history is reported as a preliminary estimate, not hidden.
  expect(m.missing).toContain("short_sales_history");
  expect(m.can_prepare).toBe(true);
  expect(m.sources.length).toBeGreaterThan(0);
  // Today's revenue per branch with no comparable yesterday: no percent is invented.
  const rows = Object.fromEntries(v.branches.rows.map((r) => [r.branch_id, r]));
  expect(rows[branch]).toMatchObject({
    today_minor: "80000",
    yesterday_minor: "0",
    change_percent: null,
  });
  expect(rows[branch2].today_minor).toBe("30000");
  expect(v.events.items.some((e) => e.kind === "order_created")).toBe(true);
});

it("follows role and branch scope", async () => {
  // A branch-bound manager sees only their branch: the main-branch situation is not shown.
  const own = await view(manager2);
  expect(own.branch_id).toBe(branch2);
  expect(own.branches.rows.map((r) => r.branch_id)).toEqual([branch2]);
  expect(own.situations.main?.stock?.warehouse ?? "Other").toBe("Other");
  await expect(
    dash.view(manager2, org, { branchId: branch }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  // An employee has no situations, money or branch revenue on this screen.
  const e = await view(employee);
  expect(e.situations.state).toBe("no_access");
  expect(e.cash.state).toBe("no_access");
  expect(e.payment.state).toBe("no_access");
  // The owner can narrow the view to one branch.
  const narrow = await view(owner, { branchId: branch2 });
  expect(narrow.branches.rows.map((r) => r.branch_id)).toEqual([branch2]);
});

it("sets the minimum reserve as an idempotent, versioned, audited command", async () => {
  await sales.createAccount(owner, org, {
    key: key(),
    branchId: branch,
    name: "Cash",
    opening: "1000",
  });
  const k = key();
  const first = await dash.setReserve(owner, org, {
    key: k,
    branchId: null,
    version: 0,
    minimum: "500.50",
  });
  expect(first.reused).toBe(false);
  expect(
    (
      await dash.setReserve(owner, org, {
        key: k,
        branchId: null,
        version: 0,
        minimum: "500.50",
      })
    ).reused,
  ).toBe(true);
  const v = await view(owner);
  expect(v.cash).toMatchObject({
    state: "ok",
    reserve_minor: "50050",
    reserve_version: 1,
    opening_minor: "100000",
  });
  // A stale version is rejected; the stored value stays.
  await expect(
    dash.setReserve(owner, org, {
      key: key(),
      branchId: null,
      version: 0,
      minimum: "1",
    }),
  ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  // A branch-bound manager cannot change the organization-wide reserve; an employee cannot set any.
  await expect(
    dash.setReserve(manager2, org, {
      key: key(),
      branchId: null,
      version: 1,
      minimum: "1",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    dash.setReserve(employee, org, {
      key: key(),
      branchId: branch,
      version: 0,
      minimum: "1",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  // Malformed amounts never reach the database.
  await expect(
    dash.setReserve(owner, org, {
      key: key(),
      branchId: null,
      version: 1,
      minimum: "1e5",
    }),
  ).rejects.toThrow();
  const [log] = await db.query<{ n: number }>(
    "SELECT count(*)::int n FROM audit_events WHERE organization_id=$1 AND action='finance.reserve_set'",
    [org],
  );
  expect(log.n).toBe(1);
});
