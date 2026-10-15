import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDatabase, type Database } from "../../src/server/db/database";
import { Platform } from "../../src/server/platform";
import { CommerceService } from "../../src/server/commerce/service";
import { InventoryService } from "../../src/server/inventory/service";
import { CrmService } from "../../src/server/crm/service";
const db = await getDatabase(),
  phase = process.argv[2],
  path = join(process.env.PGLITE_DATA_DIR!, "recovery-fixture.json");
type State = {
  token: string;
  org: string;
  order: string;
  warehouse: string;
  item: string;
  command: Record<string, unknown>;
  payment: Record<string, unknown>;
};
if (phase === "prepare") {
  const p = new Platform(db),
    stock = new InventoryService(db),
    commerce = new CommerceService(db),
    key = randomUUID;
  const token = (
    await p.register({
      name: "Crash fixture",
      email: key() + "@example.test",
      password: "Synthetic-Crash-661!",
    })
  ).token;
  const org = (
    await p.createOrganization(token, {
      name: "Crash fixture",
      profile: "retail",
    })
  ).id;
  const branch = (await p.workspace(token, org)).branches[0].id;
  const warehouse = (
    await stock.createWarehouse(token, org, {
      branchId: branch,
      name: "Warehouse",
    })
  ).id;
  const item = (
    await stock.saveItem(token, org, {
      sku: "CRASH",
      name_ru: "Товар",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "2",
      sale_price: "10",
    })
  ).id!;
  await stock.execute(token, org, {
    key: key(),
    kind: "receipt",
    warehouseId: warehouse,
    itemId: item,
    quantity: "10",
    unit: "pc",
    unitCost: "2",
    note: "Synthetic receipt",
  });
  const customer = (
    await new CrmService(db).createCustomer(token, org, {
      key: key(),
      branchId: branch,
      name: "Synthetic",
      email: "",
      phone: "",
      kind: "person",
      responsibleId: null,
      consents: { email: false, sms: false, messenger: false },
      consentNote: "Synthetic",
    })
  ).id;
  const order = (
    await commerce.create(token, org, {
      key: key(),
      branchId: branch,
      customerId: customer,
      warehouseId: warehouse,
      dueDate: "2099-01-01",
      delivery: "pickup",
      note: "Synthetic",
      taxMode: "excluded",
      lines: [
        { itemId: item, quantity: "1", unit: "pc", price: "10", discount: "0" },
      ],
    })
  ).id;
  await commerce.transition(token, org, order, {
    key: key(),
    version: 1,
    kind: "confirm",
    note: "Synthetic",
  });
  const line = (await commerce.get(token, org, order)).lines[0].id;
  const account = (
    await commerce.createAccount(token, org, {
      key: key(),
      branchId: branch,
      name: "Cash",
      opening: "0",
    })
  ).id;
  const state: State = {
    token,
    org,
    warehouse,
    item,
    order,
    command: {
      key: key(),
      version: 2,
      kind: "fulfill",
      lineId: line,
      quantity: "1",
      note: "Synthetic fulfillment",
    },
    payment: {
      key: key(),
      kind: "payment",
      orderId: order,
      accountId: account,
      amount: "10",
      note: "Synthetic payment",
    },
  };
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  await db.close();
  process.stdout.write("prepared\n");
} else {
  const s = JSON.parse(await readFile(path, "utf8")) as State;
  if (phase === "crash") {
    const wrapped: Database = {
      query: db.query.bind(db),
      close: () => db.close(),
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            query: async <T>(sql: string, params?: unknown[]) => {
              const result = await tx.query<T>(sql, params);
              if (
                sql.startsWith("INSERT INTO sales_events") &&
                params?.includes("fulfill")
              ) {
                process.stdout.write("transaction-open\n");
                await new Promise(() => {});
              }
              return result;
            },
          }),
        ),
    };
    await new CommerceService(wrapped).transition(
      s.token,
      s.org,
      s.order,
      s.command,
    );
    throw new Error("FAULT_POINT_NOT_REACHED");
  }
  const commerce = new CommerceService(db);
  if (phase === "recover" || phase === "replay")
    await commerce.transition(s.token, s.org, s.order, s.command);
  if (phase === "payment-lost") {
    await commerce.money(s.token, s.org, s.payment);
    process.exit(17);
  }
  if (phase === "replay") await commerce.money(s.token, s.org, s.payment);
  const [result] = await db.query(
    "SELECT o.state,o.revenue_minor::text revenue,o.paid_minor::text paid,(SELECT quantity::text FROM stock_balances WHERE organization_id=$1 AND warehouse_id=$3 AND item_id=$4) quantity,(SELECT count(*)::int FROM sales_events WHERE organization_id=$1 AND order_id=$2 AND kind='fulfill') fulfillments,(SELECT count(*)::int FROM money_entries WHERE organization_id=$1 AND order_id=$2) payments FROM sales_orders o WHERE o.organization_id=$1 AND o.id=$2",
    [s.org, s.order, s.warehouse, s.item],
  );
  await db.close();
  process.stdout.write(JSON.stringify(result) + "\n");
}
