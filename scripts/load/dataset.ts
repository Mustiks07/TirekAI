import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "../../src/server/db/database";
import { Platform } from "../../src/server/platform";
import { InventoryService } from "../../src/server/inventory/service";
import { CommerceService } from "../../src/server/commerce/service";
import { CrmService } from "../../src/server/crm/service";

// T051 load set (SPECIFICATION §21): 1000 SKU, ≥ 10 000 business operations, 90 days of history,
// two branches, 20 users with different roles. Every business operation goes through the
// application services (stock receipts, orders, confirmations, issues, payments, returns,
// refunds). Only afterwards are the timestamps of this synthetic set shifted back over 90 days
// (fixture backdating — the services always write "now"); no business row is written by SQL.
export type LoadUser = {
  email: string;
  password: string;
  role: string;
  branchId: string | null;
};
export type LoadSet = {
  organizationId: string;
  branches: string[];
  warehouses: string[];
  accounts: string[];
  customers: string[][];
  items: string[];
  users: LoadUser[];
  counts: Record<string, number>;
  seconds: number;
};
const roles: [string, number | null][] = [
  ["manager", null],
  ["manager", 1],
  ...Array.from({ length: 5 }, () => ["sales", 0] as [string, number]),
  ...Array.from({ length: 3 }, () => ["sales", 1] as [string, number]),
  ["purchasing", 0],
  ["purchasing", 0],
  ["purchasing", 1],
  ["purchasing", 1],
  ["finance", null],
  ["finance", 0],
  ["finance", 1],
  ["observer", 0],
  ["observer", 1],
  ["employee", 0],
];
// Deterministic pseudo-random sequence: the set is reproducible for the same parameters.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
async function pool<T>(
  items: T[],
  size: number,
  work: (x: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}
export async function seedLoadSet(
  db: Database,
  options: { skus?: number; orders?: number; concurrency?: number } = {},
): Promise<LoadSet> {
  const started = Date.now();
  const skus = options.skus ?? 1000,
    orderCount = options.orders ?? 2150,
    concurrency = options.concurrency ?? 8;
  const random = rng(51);
  const p = new Platform(db),
    inventory = new InventoryService(db),
    commerce = new CommerceService(db),
    crm = new CrmService(db);
  const counts: Record<string, number> = {};
  const count = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const password = () => randomBytes(18).toString("base64url");
  const ownerPassword = password();
  const owner = await p.register({
    name: "Load owner",
    email: `load-owner-${randomUUID()}@example.test`,
    password: ownerPassword,
  });
  const org = (
    await p.createOrganization(owner.token, {
      name: "Нагрузка T051",
      profile: "retail",
    })
  ).id;
  const branches = [
    (await p.workspace(owner.token, org)).branches[0].id,
    (await p.createBranch(owner.token, org, { name: "Север" })).id,
  ];
  const users: LoadUser[] = [
    {
      email: owner.user.email,
      password: ownerPassword,
      role: "owner",
      branchId: null,
    },
  ];
  for (const [role, b] of roles) {
    const pw = password(),
      u = await p.register({
        name: `Load ${role}`,
        email: `load-${role}-${randomUUID()}@example.test`,
        password: pw,
      });
    const inv = await p.invite(owner.token, org, {
      email: u.user.email,
      role,
      branchId: b === null ? null : branches[b],
    });
    await p.acceptInvitation(u.token, { token: inv.token });
    await p.logout(u.token);
    users.push({
      email: u.user.email,
      password: pw,
      role,
      branchId: b === null ? null : branches[b],
    });
  }
  const warehouses: string[] = [];
  for (const [i, b] of branches.entries())
    warehouses.push(
      (
        await inventory.createWarehouse(owner.token, org, {
          branchId: b,
          name: `Склад ${i + 1}`,
        })
      ).id,
    );
  const accounts: string[] = [];
  for (const b of branches)
    accounts.push(
      (
        await commerce.createAccount(owner.token, org, {
          key: randomUUID(),
          branchId: b,
          name: "Касса",
          opening: "0",
        })
      ).id,
    );
  // Catalog: sale price always known for the ordered goods; ~3 % with unknown purchase price.
  const items: string[] = [];
  const prices: string[] = [];
  const specs = Array.from({ length: skus }, (_, i) => {
    const sale = 100 + Math.floor(random() * 4900);
    // Integer tenge generated for the fixture; the receipt cost is known even when the catalog
    // purchase price is left unknown.
    const cost = String(Math.floor((sale * 6) / 10));
    return {
      i,
      sale: String(sale),
      cost,
      purchase: random() < 0.03 ? null : cost,
    };
  });
  await pool(specs, concurrency, async (s) => {
    const r = await inventory.saveItem(owner.token, org, {
      sku: `LOAD-${String(s.i + 1).padStart(4, "0")}`,
      name_ru: `Товар нагрузки ${s.i + 1}`,
      name_kk: `Жүктеме тауары ${s.i + 1}`,
      category: `Категория ${(s.i % 20) + 1}`,
      kind: "goods",
      base_unit: "pc",
      purchase_price: s.purchase,
      sale_price: s.sale,
    });
    items[s.i] = r.id!;
    prices[s.i] = s.sale;
    count("catalog_items");
  });
  const receipts = specs.flatMap((s) => [
    { i: s.i, w: 0, qty: String(200 + Math.floor(random() * 300)) },
    ...(s.i % 2 === 0
      ? [{ i: s.i, w: 1, qty: String(100 + Math.floor(random() * 200)) }]
      : []),
  ]);
  await pool(receipts, concurrency, async (r) => {
    await inventory.execute(owner.token, org, {
      key: randomUUID(),
      kind: "receipt",
      warehouseId: warehouses[r.w],
      itemId: items[r.i],
      quantity: r.qty,
      unit: "pc",
      unitCost: specs[r.i].cost,
      note: "Нагрузочный набор: приход",
    });
    count("stock_receipts");
  });
  const customers: string[][] = [[], []];
  const customerSpecs = Array.from({ length: 300 }, (_, i) => i);
  await pool(customerSpecs, concurrency, async (i) => {
    const b = i < 200 ? 0 : 1;
    const c = await crm.createCustomer(owner.token, org, {
      key: randomUUID(),
      branchId: branches[b],
      name: `Клиент нагрузки ${i + 1}`,
      email: "",
      phone: `+770000${String(i).padStart(5, "0")}`,
      kind: "person",
      responsibleId: null,
      consents: { email: false, sms: false, messenger: false },
      consentNote: "Синтетический клиент нагрузочного набора",
    });
    customers[b].push(c.id);
    count("customers");
  });
  // Orders: create → confirm (reserve) → issue each line → payment (full or 70 %); every 20th
  // order is returned and refunded. Each step is its own service command.
  const orderSpecs = Array.from({ length: orderCount }, (_, i) => {
    const b = i % 3 === 2 ? 1 : 0,
      lines = 1 + Math.floor(random() * 3),
      chosen = new Set<number>();
    while (chosen.size < lines)
      chosen.add(
        b === 1
          ? 2 * Math.floor(random() * (skus / 2))
          : Math.floor(random() * skus),
      );
    return {
      i,
      b,
      day: (i * 7919) % 90,
      lines: [...chosen].map((x) => ({
        itemId: items[x],
        quantity: String(1 + Math.floor(random() * 3)),
        price: prices[x],
      })),
      partial: random() < 0.2,
      ret: i % 20 === 0,
    };
  });
  const orderDays: { id: string; day: number }[] = [];
  await pool(orderSpecs, concurrency, async (o) => {
    const created = await commerce.create(owner.token, org, {
      key: randomUUID(),
      branchId: branches[o.b],
      customerId: customers[o.b][o.i % customers[o.b].length],
      warehouseId: warehouses[o.b],
      dueDate: "2026-12-31",
      delivery: "pickup",
      note: "Нагрузочный набор",
      taxMode: "excluded",
      lines: o.lines.map((l) => ({ ...l, unit: "pc", discount: "0" })),
    });
    count("orders_created");
    orderDays.push({ id: created.id, day: o.day });
    const version = async () =>
      (await commerce.get(owner.token, org, created.id)).order.version;
    await commerce.transition(owner.token, org, created.id, {
      key: randomUUID(),
      version: await version(),
      kind: "confirm",
      note: "Подтверждение",
    });
    count("orders_confirmed");
    const view = await commerce.get(owner.token, org, created.id);
    let firstEvent = "";
    for (const line of view.lines) {
      const r = await commerce.transition(owner.token, org, created.id, {
        key: randomUUID(),
        version: await version(),
        kind: "fulfill",
        lineId: line.id,
        quantity: line.quantity,
        note: "Выдача",
      });
      firstEvent ||= r.id;
      count("issues");
    }
    const total = BigInt(view.order.total_minor);
    const paid = o.partial ? (total * 7n) / 10n : total;
    if (paid > 0n) {
      await commerce.money(owner.token, org, {
        key: randomUUID(),
        accountId: accounts[o.b],
        orderId: created.id,
        kind: "payment",
        amount: `${paid / 100n}.${String(paid % 100n).padStart(2, "0")}`,
        note: "Оплата",
      });
      count("payments");
    }
    if (o.ret) {
      await commerce.transition(owner.token, org, created.id, {
        key: randomUUID(),
        version: await version(),
        kind: "return",
        eventId: firstEvent,
        quantity: view.lines[0].quantity,
        note: "Возврат",
      });
      count("returns");
      const after = await commerce.get(owner.token, org, created.id);
      const over =
        BigInt(after.order.paid_minor) - BigInt(after.order.revenue_minor);
      if (over > 0n) {
        await commerce.money(owner.token, org, {
          key: randomUUID(),
          accountId: accounts[o.b],
          orderId: created.id,
          kind: "refund",
          amount: `${over / 100n}.${String(over % 100n).padStart(2, "0")}`,
          note: "Возврат денег",
        });
        count("refunds");
      }
    }
  });
  // Fixture backdating over 90 days (see header).
  await db.transaction(async (tx) => {
    await tx.query(
      "CREATE TEMP TABLE load_days(order_id uuid PRIMARY KEY, days int NOT NULL) ON COMMIT DROP",
    );
    for (let i = 0; i < orderDays.length; i += 500) {
      const part = orderDays.slice(i, i + 500);
      await tx.query(
        `INSERT INTO load_days(order_id,days) VALUES ${part.map((_, k) => `($${2 * k + 1}::uuid,$${2 * k + 2}::int)`).join(",")}`,
        part.flatMap((x) => [x.id, x.day]),
      );
    }
    const shift = "make_interval(days=>d.days)";
    await tx.query(
      `UPDATE sales_orders o SET created_at=o.created_at-${shift},due_date=(o.created_at-${shift})::date+7 FROM load_days d WHERE o.organization_id=$1 AND o.id=d.order_id`,
      [org],
    );
    await tx.query(
      `UPDATE sales_events e SET created_at=e.created_at-${shift} FROM load_days d WHERE e.organization_id=$1 AND e.order_id=d.order_id`,
      [org],
    );
    await tx.query(
      `UPDATE money_entries e SET created_at=e.created_at-${shift} FROM load_days d WHERE e.organization_id=$1 AND e.order_id=d.order_id`,
      [org],
    );
    await tx.query(
      `UPDATE stock_movements m SET created_at=m.created_at-${shift} FROM order_stock_links l JOIN load_days d ON d.order_id=l.order_id WHERE m.organization_id=$1 AND l.organization_id=$1 AND l.object_id=m.id`,
      [org],
    );
    await tx.query(
      "UPDATE stock_movements SET created_at=created_at-interval '91 days' WHERE organization_id=$1 AND kind='receipt'",
      [org],
    );
  });
  counts.business_operations =
    (counts.stock_receipts ?? 0) +
    (counts.orders_created ?? 0) +
    (counts.orders_confirmed ?? 0) +
    (counts.issues ?? 0) +
    (counts.payments ?? 0) +
    (counts.returns ?? 0) +
    (counts.refunds ?? 0);
  await p.logout(owner.token);
  return {
    organizationId: org,
    branches,
    warehouses,
    accounts,
    customers,
    items,
    users,
    counts,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}
