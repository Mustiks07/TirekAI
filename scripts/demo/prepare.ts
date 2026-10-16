// Prepares the 3–5 minute demo on top of the Tirek Market fixture (npm run db:seed:business).
// Every write goes through the same services as the UI; nothing is backdated and no model
// answer, OCR result or economic effect is stored in advance. Afterwards the whole local
// database is saved as the demo baseline (npm run demo:reset restores it).
//   npm run demo:prepare
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { getDatabase } from "../../src/server/db/database";
import { Platform } from "../../src/server/platform";
import { InventoryService } from "../../src/server/inventory/service";
import { PurchasingService } from "../../src/server/purchasing/service";
import { InsightService } from "../../src/server/decisions/insights";
import { CommerceService } from "../../src/server/commerce/service";
import { CrmService } from "../../src/server/crm/service";
import { runTool } from "../../src/server/assistant/tools";
import { saveBaseline, localDatabase } from "./state";

const fixturePath = ".local/tirekai-business.json",
  statePath = ".local/tirekai-demo.json";
type State = {
  approver: { email: string; password: string };
  keys: Record<string, string>;
  steps: Record<string, unknown>;
  completed: boolean;
};
async function main() {
  if (process.env.DATABASE_URL) throw new Error("LOCAL_ONLY");
  process.env.LOCAL_DATABASE = "1";
  process.env.LOCAL_PREVIEW = "1";
  const database = localDatabase();
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
    email: string;
    password: string;
    date: string;
    completed: boolean;
    database: string;
  };
  if (!fixture.completed || fixture.database !== database)
    throw new Error("RUN_DB_SEED_BUSINESS_FIRST");
  let state: State;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    state = {
      approver: {
        email: "tirekai-approver@example.test",
        password: randomBytes(24).toString("base64url"),
      },
      keys: {},
      steps: {},
      completed: false,
    };
    await writeFile(statePath, JSON.stringify(state, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
  }
  if (state.completed) {
    console.log(
      "Demo already prepared. Restore the baseline with npm run demo:reset.",
    );
    return;
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
    pur = new PurchasingService(db),
    sales = new CommerceService(db),
    crm = new CrmService(db),
    insights = new InsightService(db);
  let token = "";
  try {
    token = (
      await p.login({ email: fixture.email, password: fixture.password })
    ).token;
    const org = (await p.session(token)).organizations.find(
      (o) => o.name === "Tirek Market · Тестовые данные",
    )!.id;
    const ws = await p.workspace(token, org);
    const branch = ws.branches.find((b) => b.name === "01")!.id;
    const warehouse = (await inv.warehouses(token, org, {})).items.find(
      (w) => w.branch_id === branch && w.name === "Центральный склад",
    )!.id;
    const ids: Record<string, string> = {};
    for (const sku of ["TM-001", "TM-002", "TM-034"])
      ids[sku] = (await inv.catalog(token, org, { q: sku })).items.find(
        (i: { sku: string }) => i.sku === sku,
      )!.id;
    const item = (sku: string) => ids[sku];
    const suppliers = (await pur.suppliers(token, org, {})).items as {
      id: string;
      data: { name: string };
    }[];
    const supplier = (name: string) =>
      suppliers.find((s) => s.data.name === name)!.id;
    const today = fixture.date;
    const offers = (
      await pur.compare(token, org, {
        itemId: item("TM-001"),
        quantity: "1",
        date: today,
      })
    ).offers;
    const offer = (
      label: string,
      v: {
        supplier: string;
        sku: string;
        packQuantity: string;
        packPrice: string;
        minimumPacks: number;
        delivery: string | null;
        leadDays: number;
        note: string;
      },
    ) =>
      step(label, (key) =>
        pur.createOffer(token, org, {
          key,
          supplierId: supplier(v.supplier),
          itemId: item(v.sku),
          supplierSku: `DEMO-${v.sku}-${v.packQuantity}`,
          packQuantity: v.packQuantity,
          baseUnit: "pc",
          packPrice: v.packPrice,
          minimumPacks: v.minimumPacks,
          delivery: v.delivery,
          leadDays: v.leadDays,
          currency: "KZT",
          rate: "1",
          rateDate: today,
          rateSource: "KZT",
          tax: "excluded",
          taxPercent: "0",
          dated: today,
          validUntil: today.slice(0, 4) + "-12-31",
          characteristicsConfirmed: true,
          note: v.note,
        }),
      );

    // Second person for approvals (the owner cannot approve her own proposal).
    await step("approver", async () => {
      const existing = ws.members.find(
        (m: { email: string }) => m.email === state.approver.email,
      );
      if (existing) return { id: existing.user_id };
      const u = await p.register({
        name: "Данияр · согласующий (демо)",
        email: state.approver.email,
        password: state.approver.password,
      });
      try {
        const invitation = await p.invite(token, org, {
          email: state.approver.email,
          role: "manager",
          branchId: branch,
        });
        await p.acceptInvitation(u.token, { token: invitation.token });
        return { id: u.user.id };
      } finally {
        await p.logout(u.token);
      }
    });

    // Scenario 1: an ordered and sent purchase that the synthetic invoice TS-1042 belongs to.
    const green = await offer("offer:green-tea", {
      supplier: "Тараз Снаб",
      sku: "TM-002",
      packQuantity: "1",
      packPrice: "900",
      minimumPacks: 1,
      delivery: "2500",
      leadDays: 3,
      note: "Демо: зелёный чай у того же поставщика, что и чёрный",
    });
    const black = offers.find((o) => o.supplier_name === "Тараз Снаб");
    if (!black) throw new Error("FIXTURE_OFFER_MISSING");
    const purchase = await step("purchase:tea", (key) =>
      pur.create(token, org, {
        key,
        branchId: branch,
        warehouseId: warehouse,
        supplierId: supplier("Тараз Снаб"),
        date: today,
        dueDate: today,
        budget: "80000",
        note: "Демо: чай к накладной ТС-1042",
        lines: [
          { offerId: black.id, quantity: "40" },
          { offerId: green.id, quantity: "24" },
        ],
      }),
    );
    for (const kind of ["submit", "approve", "sent"] as const)
      await step(`purchase:tea:${kind}`, async (key) => {
        const d = await pur.get(token, org, purchase.id);
        return pur.transition(token, org, purchase.id, {
          key,
          version: d.order.version,
          kind,
          note: "Демо: заказ отправлен поставщику вручную",
        });
      });

    // A customer takes the last 8 packs of A4 paper today: an ordinary order, fulfilment and
    // payment through the sales service, so the warehouse really runs out.
    const customer = (
      (await crm.customers(token, org, { q: "Офис Орда" })).items as {
        id: string;
        branch_id: string;
        name: string;
      }[]
    ).find((c) => c.branch_id === branch && c.name === "Офис Орда")!.id;
    const account = (
      (await sales.accounts(token, org, {})).items as {
        id: string;
        branch_id: string;
        name: string;
      }[]
    ).find((a) => a.branch_id === branch && a.name === "Касса")!.id;
    const sale = await step("sale:paper", (key) =>
      sales.create(token, org, {
        key,
        branchId: branch,
        customerId: customer,
        warehouseId: warehouse,
        dueDate: today,
        delivery: "pickup",
        note: "Демо: клиент забрал последние пачки бумаги",
        taxMode: "excluded",
        lines: [
          {
            itemId: item("TM-034"),
            quantity: "8",
            unit: "pc",
            price: "2100",
            discount: "0",
          },
        ],
      }),
    );
    const saleStep = (label: string, payload: Record<string, unknown>) =>
      step(`sale:paper:${label}`, async (key) => {
        const d = await sales.get(token, org, sale.id);
        return sales.transition(token, org, sale.id, {
          key,
          version: d.order.version,
          note: "Демо: продажа",
          ...payload,
        });
      });
    await saleStep("confirm", { kind: "confirm" });
    const line = (await sales.get(token, org, sale.id)).lines[0];
    await saleStep("fulfill", {
      kind: "fulfill",
      lineId: line.id,
      quantity: line.quantity,
    });
    await step("sale:paper:payment", async (key) => {
      const d = await sales.get(token, org, sale.id),
        amount = BigInt(d.order.total_minor);
      return sales.money(token, org, {
        key,
        kind: "payment",
        accountId: account,
        orderId: sale.id,
        amount: `${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`,
        note: "Демо: оплата в кассу",
      });
    });

    // Scenario 2: A4 paper is out of stock (0 < 20 + 5). Three more offers with
    // different packs, minimums and delivery; one has no stated delivery and stays incomparable.
    await offer("offer:paper:taraz", {
      supplier: "Тараз Снаб",
      sku: "TM-034",
      packQuantity: "5",
      packPrice: "6900",
      minimumPacks: 2,
      delivery: "4000",
      leadDays: 5,
      note: "Демо: коробка 5 пачек, минимум 2 коробки",
    });
    await offer("offer:paper:bereke", {
      supplier: "Береке Опт",
      sku: "TM-034",
      packQuantity: "10",
      packPrice: "13500",
      minimumPacks: 1,
      delivery: "0",
      leadDays: 2,
      note: "Демо: коробка 10 пачек, доставка включена",
    });
    await offer("offer:paper:alatau", {
      supplier: "Alatau Foods",
      sku: "TM-034",
      packQuantity: "1",
      packPrice: "1290",
      minimumPacks: 1,
      delivery: null,
      leadDays: 4,
      note: "Демо: стоимость доставки поставщик не указал",
    });
    await insights.refresh(token, org);

    // Expected numbers for scenario 3, from the same calculation layer the assistant's tools use.
    const ctx = {
      db,
      credential: token,
      org,
      key: (index: string) => (state.keys[`tool:${index}`] ||= randomUUID()),
    };
    const finance = await runTool(ctx, "finance_summary", {});
    const situations = await runTool(ctx, "list_situations", {});
    const report = {
      synthetic: true,
      preparedAt: new Date().toISOString(),
      organizationId: org,
      scenario1: {
        purchaseId: purchase.id,
        invoice: "docs/demo/invoice-ts-1042.jpg",
        ordered: [
          { sku: "TM-001", quantity: "40", price: "1250" },
          { sku: "TM-002", quantity: "24", price: "900" },
        ],
      },
      scenario2: {
        item: "TM-034 · Бумага A4 500 листов",
        warehouse: "Центральный склад",
        compare: await pur.compare(token, org, {
          itemId: item("TM-034"),
          quantity: "25",
          date: today,
        }),
      },
      scenario3: { finance, situations },
    };
    await writeFile(
      ".local/tirekai-demo-report.json",
      JSON.stringify(report, null, 2),
    );
    state.completed = true;
    await save();
  } finally {
    if (token) await p.logout(token).catch(() => {});
    await db.close();
  }
  await saveBaseline();
  console.log(
    "Demo prepared and saved as baseline. Approver credentials: .local/tirekai-demo.json; expected numbers: .local/tirekai-demo-report.json.",
  );
}
main().catch((e) => {
  console.error(
    "DEMO_PREPARE_FAILED",
    e instanceof Error ? e.message.split(" ")[0] : "Error",
    (e as { code?: string }).code || "",
  );
  process.exitCode = 1;
});
