import { beforeAll, afterAll, it, expect } from "vitest";
import Decimal from "decimal.js";
import { randomUUID, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { InventoryService } from "../src/server/inventory/service";
import { CommerceService } from "../src/server/commerce/service";
import { KaspiService } from "../src/server/integrations/kaspi-service";
import { KaspiTradeService } from "../src/server/integrations/kaspi-trade";
import { KASPI_TOKEN, kaspiServer, type KOrder } from "./helpers/kaspi-server";

// T040 on a local Kaspi stand-in: order → reserve → acceptance → issue → payout with commission →
// return with refund and commission correction. Synthetic data only.
const NOW = Date.UTC(2026, 9, 15, 6, 0, 0);
const state = {
  orders: [] as KOrder[],
  requests: [] as string[],
  failOnce: { rate: false },
  posts: [] as unknown[],
};
let server: Server,
  base: string,
  db: Database,
  p: Platform,
  org: string,
  branch: string,
  warehouse: string,
  item: string,
  account: string,
  owner: string,
  manager: string,
  seller: string,
  finance: string,
  connection: string,
  trade: KaspiTradeService,
  inventory: InventoryService,
  commerce: CommerceService;
const key = () => randomUUID();
const order = (
  id: string,
  code: string,
  status: string,
  product: string,
  quantity = 2,
): KOrder => ({
  id,
  code,
  state: "NEW",
  status,
  totalPrice: 15000 * quantity,
  deliveryCost: 0,
  creationDate: NOW - 3600_000,
  entries: [
    {
      id: `e-${id}`,
      product,
      name: "Чайник электрический",
      quantity,
      basePrice: 15000,
    },
  ],
});
type Row = {
  id: string;
  code: string;
  status: string;
  version: number;
  sales_order_id: string | null;
  accept_state: string | null;
  order_state: string | null;
  revenue_minor: string | null;
  paid_minor: string | null;
  commission_minor: string;
  net_minor: string;
};
const rows = async () =>
  (await trade.trade(owner, org, connection)).items as Row[];
const row = async (code: string) =>
  (await rows()).find((r) => r.code === code)!;
const n = (v: string) => new Decimal(v).toFixed();
const stock = async () => {
  const [b] = await db.query<{ quantity: string; reserved: string }>(
    "SELECT quantity::text,reserved::text FROM stock_balances WHERE warehouse_id=$1 AND item_id=$2",
    [warehouse, item],
  );
  return { quantity: n(b.quantity), reserved: n(b.reserved) };
};
const balance = async () =>
  (
    await db.query<{ balance_minor: string }>(
      "SELECT balance_minor::text FROM money_accounts WHERE id=$1",
      [account],
    )
  )[0].balance_minor;
beforeAll(async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  state.orders.push(
    order("k-1", "800001", "APPROVED_BY_BANK", "P-100"),
    order("k-2", "800002", "APPROVED_BY_BANK", "P-200", 1),
    order("k-3", "800003", "CANCELLED", "P-100", 1),
    order("k-4", "800004", "APPROVED_BY_BANK", "P-100", 1),
  );
  server = kaspiServer(state);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/shop/api`;
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  inventory = new InventoryService(db);
  commerce = new CommerceService(db);
  const user = () =>
    p.register({
      name: "Trade",
      email: `${key()}@example.test`,
      password: "Synthetic-Trade-661!",
    });
  owner = (await user()).token;
  org = (
    await p.createOrganization(owner, { name: "Trade Lab", profile: "retail" })
  ).id;
  branch = (await p.workspace(owner, org)).branches[0].id;
  for (const role of ["manager", "sales", "finance"]) {
    const u = await user(),
      inv = await p.invite(owner, org, {
        email: u.user.email,
        role,
        branchId: branch,
      });
    await p.acceptInvitation(u.token, { token: inv.token });
    if (role === "manager") manager = u.token;
    else if (role === "sales") seller = u.token;
    else finance = u.token;
  }
  warehouse = (
    await inventory.createWarehouse(owner, org, {
      branchId: branch,
      name: "Main",
    })
  ).id;
  item = (
    await inventory.saveItem(owner, org, {
      sku: "KETTLE",
      name_ru: "Чайник электрический",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "9000",
      sale_price: "15000",
    })
  ).id!;
  await inventory.execute(owner, org, {
    key: key(),
    kind: "receipt",
    warehouseId: warehouse,
    itemId: item,
    quantity: "5",
    unit: "pc",
    unitCost: "9000",
    note: "Synthetic receipt",
  });
  account = (
    await commerce.createAccount(owner, org, {
      key: key(),
      branchId: branch,
      name: "Kaspi Business",
      opening: "0",
    })
  ).id;
  const kaspi = KaspiService.forContractServer(db, base, fetch, () => NOW);
  connection = (
    await kaspi.configure(owner, org, {
      key: key(),
      token: KASPI_TOKEN,
      branchId: branch,
      warehouseId: warehouse,
    })
  ).id;
  await kaspi.syncNow(owner, org, connection);
  trade = new KaspiTradeService(db, kaspi);
});
afterAll(async () => {
  await db?.close();
  await new Promise((r) => server.close(r));
});
it("T040: a Kaspi order becomes an internal order only with linked products and exact totals; confirmation reserves stock", async () => {
  expect((await rows()).map((r) => r.code).sort()).toEqual([
    "800001",
    "800002",
    "800003",
    "800004",
  ]);
  let k1 = await row("800001");
  await expect(
    trade.importOrder(seller, org, k1.id, { key: key(), version: k1.version }),
  ).rejects.toMatchObject({ code: "PRODUCT_NOT_LINKED" });
  const products = (await trade.products(seller, org, connection)).items as {
    product_code: string;
    item_id: string | null;
    orders: number;
  }[];
  expect(products).toEqual([
    expect.objectContaining({
      product_code: "P-100",
      item_id: null,
      orders: 3,
    }),
    expect.objectContaining({
      product_code: "P-200",
      item_id: null,
      orders: 1,
    }),
  ]);
  await trade.linkProduct(seller, org, connection, {
    key: key(),
    productCode: "P-100",
    itemId: item,
  });
  await expect(
    trade.linkProduct(seller, org, connection, {
      key: key(),
      productCode: "P-200",
      itemId: item,
    }),
  ).rejects.toMatchObject({ code: "ITEM_ALREADY_LINKED" });
  const k = key();
  const imported = await trade.importOrder(seller, org, k1.id, {
    key: k,
    version: k1.version,
  });
  expect(
    (
      await trade.importOrder(seller, org, k1.id, {
        key: k,
        version: k1.version,
      })
    ).reused,
  ).toBe(true);
  k1 = await row("800001");
  await expect(
    trade.importOrder(seller, org, k1.id, { key: key(), version: k1.version }),
  ).rejects.toMatchObject({ code: "ALREADY_IMPORTED" });
  expect(k1).toMatchObject({
    sales_order_id: imported.id,
    order_state: "confirmed",
    revenue_minor: "0",
  });
  const view = await commerce.get(owner, org, imported.id);
  expect(view.order.total_minor).toBe("3000000");
  expect([n(view.lines[0].quantity), n(view.lines[0].price)]).toEqual([
    "2",
    "15000",
  ]);
  expect(await stock()).toEqual({ quantity: "5", reserved: "2" });
  const k3 = await row("800003");
  await expect(
    trade.importOrder(seller, org, k3.id, { key: key(), version: k3.version }),
  ).rejects.toMatchObject({ code: "CHANNEL_ORDER_CLOSED" });
  const k2 = await row("800002");
  await expect(
    trade.importOrder(seller, org, k2.id, { key: key(), version: k2.version }),
  ).rejects.toMatchObject({ code: "PRODUCT_NOT_LINKED" });
});
it("T040: acceptance in Kaspi needs the owner's switch and a reserved order; it is sent once and a timeout stays unknown", async () => {
  let k1 = await row("800001");
  await expect(
    trade.accept(seller, org, k1.id, { key: key(), version: k1.version }),
  ).rejects.toMatchObject({ code: "CHANNEL_WRITES_OFF" });
  const { version } = await trade.trade(owner, org, connection);
  await expect(
    trade.setWrites(manager, org, connection, {
      key: key(),
      version,
      enabled: true,
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await trade.setWrites(owner, org, connection, {
    key: key(),
    version,
    enabled: true,
  });
  const k4 = await row("800004");
  await expect(
    trade.accept(seller, org, k4.id, { key: key(), version: k4.version }),
  ).rejects.toMatchObject({ code: "NOT_IMPORTED" });
  expect(state.posts).toHaveLength(0);
  expect(
    await trade.accept(seller, org, k1.id, { key: key(), version: k1.version }),
  ).toEqual({ state: "sent", error: null });
  expect(state.posts).toEqual([
    {
      data: {
        type: "orders",
        id: "k-1",
        attributes: { code: "800001", status: "ACCEPTED_BY_MERCHANT" },
      },
    },
  ]);
  k1 = await row("800001");
  expect(k1).toMatchObject({
    status: "ACCEPTED_BY_MERCHANT",
    accept_state: "sent",
  });
  await expect(
    trade.accept(seller, org, k1.id, { key: key(), version: k1.version }),
  ).rejects.toMatchObject({ code: "CHANNEL_ORDER_STATE" });
  // A lost connection while sending: recorded as unknown, never resent automatically.
  const down = new KaspiTradeService(
    db,
    KaspiService.forContractServer(
      db,
      base,
      async (input, init) => {
        if (init?.method === "POST") throw new TypeError("socket hang up");
        return fetch(input, init);
      },
      () => NOW,
    ),
  );
  const k4v = (await row("800004")).version;
  await down.importOrder(seller, org, k4.id, { key: key(), version: k4v });
  const k4i = await row("800004");
  expect(
    await down.accept(seller, org, k4.id, { key: key(), version: k4i.version }),
  ).toEqual({ state: "unknown", error: "KASPI_TIMEOUT" });
  const after = await row("800004");
  await expect(
    trade.accept(seller, org, k4.id, { key: key(), version: after.version }),
  ).rejects.toMatchObject({ code: "ACCEPT_ALREADY_SENT" });
  expect(state.posts).toHaveLength(1);
});
it("T040: issue, payout with commission from the report, then return with refund and commission correction keep stock and money exact", async () => {
  const k1 = await row("800001");
  await trade.issue(seller, org, k1.id, { key: key(), note: "Выдано курьеру" });
  expect(await stock()).toEqual({ quantity: "3", reserved: "1" });
  expect(await row("800001")).toMatchObject({
    order_state: "fulfilled",
    revenue_minor: "3000000",
  });
  await expect(
    trade.issue(seller, org, k1.id, { key: key(), note: "Повторная выдача" }),
  ).rejects.toMatchObject({ code: "NOTHING_TO_ISSUE" });
  const payout = {
    kind: "payout",
    accountId: account,
    document: "KSR-2026-10-15",
    reportDate: "2026-10-15",
    gross: "30000",
    commission: "3600",
    net: "26400",
  };
  await expect(
    trade.settle(seller, org, k1.id, { key: key(), ...payout }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    trade.settle(finance, org, k1.id, { key: key(), ...payout, net: "26000" }),
  ).rejects.toMatchObject({ code: "SETTLEMENT_ARITHMETIC" });
  const k = key();
  await trade.settle(finance, org, k1.id, { key: k, ...payout });
  expect(
    (await trade.settle(finance, org, k1.id, { key: k, ...payout })).reused,
  ).toBe(true);
  await expect(
    trade.settle(finance, org, k1.id, { key: key(), ...payout }),
  ).rejects.toMatchObject({ code: "SETTLEMENT_DUPLICATE" });
  expect(await balance()).toBe("2640000");
  expect(await row("800001")).toMatchObject({
    paid_minor: "3000000",
    commission_minor: "360000",
    net_minor: "2640000",
  });
  const entries = await db.query<{
    kind: string;
    amount_minor: string;
    operating: boolean;
    order_id: string | null;
  }>(
    "SELECT kind,amount_minor::text,operating,order_id FROM money_entries WHERE account_id=$1 ORDER BY created_at,kind",
    [account],
  );
  expect(entries.map((e) => [e.kind, e.amount_minor, e.operating])).toEqual(
    expect.arrayContaining([
      ["payment", "3000000", false],
      ["expense", "-360000", true],
    ]),
  );
  let summary = await commerce.summary(owner, org, {});
  expect(summary).toMatchObject({
    revenue_minor: "3000000",
    cost_minor: "1800000",
    operating_expenses_minor: "360000",
  });
  const refund = {
    ...payout,
    kind: "return",
    document: "KSR-2026-10-20",
    reportDate: "2026-10-20",
  };
  await expect(
    trade.settle(finance, org, k1.id, { key: key(), ...refund }),
  ).rejects.toMatchObject({ code: "RETURN_GOODS_FIRST" });
  await trade.returnGoods(seller, org, k1.id, {
    key: key(),
    note: "Возврат покупателя Kaspi",
  });
  expect(await stock()).toEqual({ quantity: "5", reserved: "1" });
  await trade.settle(finance, org, k1.id, { key: key(), ...refund });
  expect(await balance()).toBe("0");
  expect(await row("800001")).toMatchObject({
    revenue_minor: "0",
    paid_minor: "0",
    commission_minor: "0",
    net_minor: "0",
  });
  summary = await commerce.summary(owner, org, {});
  expect(summary).toMatchObject({
    revenue_minor: "0",
    cost_minor: "0",
    operating_expenses_minor: "0",
  });
});
