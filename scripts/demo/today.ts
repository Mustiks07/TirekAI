// Sales of the current day for the main screen demo (Tirek Market fixture). Run with the local
// server stopped, on the day of the demo: `npm run demo:today`. Every record goes through the
// business services (order → confirm → fulfill → payment), with real timestamps; nothing is
// back-dated. Repeating it on the same day changes nothing (stored keys); on another day it adds
// that day's sales. Synthetic data only; no external calls.
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getDatabase } from "../../src/server/db/database";
import { Platform } from "../../src/server/platform";
import { InventoryService } from "../../src/server/inventory/service";
import { CommerceService } from "../../src/server/commerce/service";
import { localDatabase } from "./state";
import { D } from "../../src/domain/purchasing";

const fixturePath = ".local/tirekai-business.json",
  statePath = ".local/tirekai-today.json";
type State = {
  date: string;
  keys: Record<string, string>;
  steps: Record<string, unknown>;
};
// Orders per branch (index in branch order) and their size: different volumes so that the
// branch comparison and the average check show real differences.
const PLAN = [
  { orders: 4, quantity: 3 },
  { orders: 2, quantity: 2 },
  { orders: 3, quantity: 5 },
];
async function main() {
  process.env.LOCAL_DATABASE = "1";
  process.env.LOCAL_PREVIEW = "1";
  const database = localDatabase();
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
    email: string;
    password: string;
    completed: boolean;
    database: string;
  };
  if (!fixture.completed || fixture.database !== database)
    throw new Error("RUN_DB_SEED_BUSINESS_FIRST");
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Qyzylorda",
  }).format(new Date());
  let state: State;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.date !== today) state = { date: today, keys: {}, steps: {} };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    state = { date: today, keys: {}, steps: {} };
  }
  const save = async () => {
    await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2), {
      mode: 0o600,
    });
    await rename(`${statePath}.tmp`, statePath);
  };
  const step = async <T>(
    label: string,
    action: (key: string) => Promise<T>,
  ) => {
    if (label in state.steps) return state.steps[label] as T;
    const key = (state.keys[label] ||= randomUUID());
    await save();
    const result = await action(key);
    state.steps[label] = result ?? true;
    await save();
    return result;
  };
  const db = await getDatabase();
  const p = new Platform(db),
    inv = new InventoryService(db),
    sales = new CommerceService(db);
  let token = "";
  try {
    token = (
      await p.login({ email: fixture.email, password: fixture.password })
    ).token;
    const org = (await p.session(token)).organizations.find((o) =>
      o.name.startsWith("Tirek Market"),
    )!.id;
    const branches = (await p.workspace(token, org)).branches;
    const warehouses = (await inv.warehouses(token, org, {})).items as {
      id: string;
      branch_id: string;
    }[];
    const catalog = (await inv.catalog(token, org, { limit: 100 })).items as {
      id: string;
      sale_price: string | null;
      base_unit: string;
    }[];
    let created = 0;
    for (const [b, branch] of branches.entries()) {
      const plan = PLAN[b % PLAN.length];
      const warehouse = warehouses.find((w) => w.branch_id === branch.id);
      if (!warehouse) continue;
      const customers = (
        await sales.customers(token, org, { branchId: branch.id, limit: 5 })
      ).items as { id: string }[];
      const account = (
        (await sales.accounts(token, org, { branchId: branch.id })).items as {
          id: string;
        }[]
      )[0];
      const stock = (
        await inv.view(token, org, "balances", {
          warehouseId: warehouse.id,
          limit: 100,
        })
      ).items as { item_id: string; available: string }[];
      // Items with a known sale price and enough stock for the planned quantity.
      const sellable = stock
        .filter((s) =>
          new D(s.available).gte((plan.quantity + 1) * plan.orders),
        )
        .map((s) => catalog.find((c) => c.id === s.item_id))
        .filter((c): c is (typeof catalog)[number] => !!c?.sale_price);
      if (!customers.length || sellable.length < 2) continue;
      for (let i = 0; i < plan.orders; i++) {
        const order = await step(`${b}:${i}:order`, (key) =>
          sales.create(token, org, {
            key,
            branchId: branch.id,
            customerId: customers[i % customers.length].id,
            warehouseId: warehouse.id,
            dueDate: today,
            delivery: "pickup",
            note: "Демо: продажа сегодня (синтетические данные)",
            taxMode: "excluded",
            lines: [0, 1].map((n) => {
              const item = sellable[(i + n) % sellable.length];
              return {
                itemId: item.id,
                quantity: String(plan.quantity + (n ? 1 : 0)),
                unit: item.base_unit,
                price: item.sale_price!,
                discount: "0",
              };
            }),
          }),
        );
        const transition = (label: string, payload: Record<string, unknown>) =>
          step(`${b}:${i}:${label}`, async (key) => {
            const d = await sales.get(token, org, order.id);
            return sales.transition(token, org, order.id, {
              key,
              version: d.order.version,
              note: "Демо-операция",
              ...payload,
            });
          });
        await transition("confirm", { kind: "confirm" });
        const detail = await sales.get(token, org, order.id);
        for (const [n, line] of detail.lines.entries())
          await transition(`fulfill:${n}`, {
            kind: "fulfill",
            lineId: line.id,
            quantity: line.quantity,
          });
        if (account && i % 2 === 0)
          await step(`${b}:${i}:payment`, async (key) => {
            const d = await sales.get(token, org, order.id),
              amount = BigInt(d.order.total_minor);
            return sales.money(token, org, {
              key,
              kind: "payment",
              accountId: account.id,
              orderId: order.id,
              amount: `${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`,
              note: "Демо: оплата клиента",
            });
          });
        created++;
      }
    }
    console.log(
      `Demo day ${today}: ${created} orders of the day are in place (created now or on an earlier run today) through the business services. No external calls.`,
    );
  } finally {
    if (token) await p.logout(token).catch(() => {});
    await db.close();
  }
}
main().catch((e) => {
  console.error("DEMO_TODAY_FAILED", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
