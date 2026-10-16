// Populated, synthetic local workspace. All business writes go through the same services as UI.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { getDatabase } from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { InventoryService } from "../src/server/inventory/service";
import { CommerceService } from "../src/server/commerce/service";
import { CrmService } from "../src/server/crm/service";
import { PurchasingService } from "../src/server/purchasing/service";
import { TaskService } from "../src/server/tasks/service";
import { KnowledgeService } from "../src/server/knowledge/service";
import { InsightService } from "../src/server/decisions/insights";
import { TodayService } from "../src/server/decisions/today";

// BUSINESS_FIXTURE_STATE lets a check build a separate throwaway copy (tests); default unchanged.
const statePath =
    process.env.BUSINESS_FIXTURE_STATE || ".local/tirekai-business.json",
  reportPath = statePath.replace(/\.json$/, "") + "-report.json";
type State = {
  email: string;
  password: string;
  date: string;
  database: string;
  completed: boolean;
  steps: Record<string, unknown>;
  keys: Record<string, string>;
};
async function main() {
  if (process.env.DATABASE_URL) throw new Error("LOCAL_ONLY");
  process.env.LOCAL_DATABASE = "1";
  process.env.LOCAL_PREVIEW = "1";
  const database = resolve(process.env.PGLITE_DATA_DIR || ".data/local");
  const localRoot =
    resolve(".data") + (process.platform === "win32" ? "\\" : "/");
  if (!database.startsWith(localRoot))
    throw new Error("LOCAL_DATA_DIRECTORY_REQUIRED");
  await mkdir(".local", { recursive: true });
  let state: State;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    state = {
      email: "tirekai-owner@example.test",
      password: randomBytes(24).toString("base64url"),
      date: new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Qyzylorda",
      }).format(new Date()),
      database,
      completed: false,
      steps: {},
      keys: {},
    };
    await writeFile(statePath, JSON.stringify(state, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
  }
  if (state.database !== database) throw new Error("FIXTURE_DATABASE_MISMATCH");
  if (state.completed) {
    console.log(
      `Business fixture already exists; credentials remain in ${statePath}.`,
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
  ): Promise<T> => {
    if (label in state.steps) return state.steps[label] as T;
    const key = (state.keys[label] ||= randomUUID());
    await save();
    const result = await action(key);
    state.steps[label] = result ?? true;
    await save();
    return result;
  };
  const date = (offset = 0) => {
    const d = new Date(`${state.date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const db = await getDatabase();
  const p = new Platform(db),
    inv = new InventoryService(db),
    crm = new CrmService(db),
    sales = new CommerceService(db),
    pur = new PurchasingService(db),
    tasks = new TaskService(db),
    knowledge = new KnowledgeService(db),
    insights = new InsightService(db);
  let token = "";
  try {
    // Login first also recovers a registration that committed just before interruption.
    try {
      token = (await p.login({ email: state.email, password: state.password }))
        .token;
    } catch (e) {
      if ((e as { code?: string }).code !== "INVALID_CREDENTIALS") throw e;
      token = (
        await p.register({
          name: "Айдана · владелец",
          email: state.email,
          password: state.password,
        })
      ).token;
    }
    const org = await step("organization", async () => {
      const existing = (await p.session(token)).organizations.find(
        (o) => o.name === "Tirek Market · Тестовые данные",
      );
      return existing
        ? { id: existing.id }
        : p.createOrganization(token, {
            name: "Tirek Market · Тестовые данные",
            profile: "retail",
            timezone: "Asia/Qyzylorda",
          });
    });
    const orgId = org.id,
      workspace = await p.workspace(token, orgId);
    const ownerId = (await p.session(token)).user!.id;
    const branches = [workspace.branches.find((b) => b.name === "01")!.id];
    for (const name of ["Магазин · Астана", "Оптовый отдел · Тараз"]) {
      const branch = await step(`branch:${name}`, async () => {
        const found = (await p.workspace(token, orgId)).branches.find(
          (b) => b.name === name,
        );
        return found
          ? { id: found.id }
          : p.createBranch(token, orgId, { name });
      });
      branches.push(branch.id);
    }
    const warehouses: string[] = [],
      accounts: string[] = [];
    for (let b = 0; b < branches.length; b++) {
      warehouses.push(
        (
          await step(`warehouse:${b}`, async () => {
            const name = [
              "Центральный склад",
              "Склад магазина",
              "Оптовый склад",
            ][b];
            const found = (await inv.warehouses(token, orgId, {})).items.find(
              (w) => w.branch_id === branches[b] && w.name === name,
            );
            return found
              ? { id: found.id }
              : inv.createWarehouse(token, orgId, {
                  branchId: branches[b],
                  name,
                });
          })
        ).id,
      );
      for (const kind of ["Расчётный счёт", "Касса"]) {
        const a = await step(`account:${b}:${kind}`, (key) =>
          sales.createAccount(token, orgId, {
            key,
            branchId: branches[b],
            name: kind,
            opening: kind === "Касса" ? "185000" : "1850000",
          }),
        );
        if (kind === "Расчётный счёт") accounts.push(a.id);
      }
    }
    const staff: string[] = [];
    for (const [i, name] of [
      "Данияр · менеджер",
      "Әсел · продажи",
      "Марат · склад",
      "Алия · закупки",
      "Ерлан · бухгалтер",
    ].entries()) {
      const member = await step(`staff:${i}`, async () => {
        const email = `tirekai-staff-${i}@example.test`;
        const existing = (await p.workspace(token, orgId)).members.find(
          (m) => m.email === email,
        );
        if (existing) return { id: existing.user_id };
        const u = await p.register({
          name,
          email,
          password: randomBytes(24).toString("base64url"),
        });
        try {
          const invitation = await p.invite(token, orgId, {
            email,
            role: ["manager", "sales", "employee", "purchasing", "finance"][i],
            branchId: branches[0],
          });
          await p.acceptInvitation(u.token, { token: invitation.token });
          return { id: u.user.id };
        } finally {
          await p.logout(u.token);
        }
      });
      staff.push(member.id);
    }
    const products = [
      ["Чай чёрный 250 г", "Қара шай 250 г", "1800", "1250"],
      ["Чай зелёный 100 г", "Көк шай 100 г", "1400", "900"],
      ["Кофе зерновой 1 кг", "Дәнді кофе 1 кг", "8900", "6100"],
      ["Кофе молотый 250 г", "Ұнтақ кофе 250 г", "2800", "1900"],
      ["Сахар 1 кг", "Қант 1 кг", "550", "390"],
      ["Мука 2 кг", "Ұн 2 кг", "950", "680"],
      ["Рис 1 кг", "Күріш 1 кг", "780", "520"],
      ["Гречка 800 г", "Қарақұмық 800 г", "690", "460"],
      ["Макароны 500 г", "Макарон 500 г", "480", "310"],
      ["Масло подсолнечное 1 л", "Күнбағыс майы 1 л", "920", "640"],
      ["Молоко 1 л", "Сүт 1 л", "620", "430"],
      ["Сливки 500 мл", "Кілегей 500 мл", "1350", "950"],
      ["Вода 1,5 л", "Су 1,5 л", "240", "150"],
      ["Сок яблочный 1 л", "Алма шырыны 1 л", "790", "530"],
      ["Сок апельсиновый 1 л", "Апельсин шырыны 1 л", "850", "570"],
      ["Лимонад 1 л", "Лимонад 1 л", "490", "310"],
      ["Печенье 300 г", "Печенье 300 г", "750", "490"],
      ["Шоколад 100 г", "Шоколад 100 г", "680", "440"],
      ["Мёд 500 г", "Бал 500 г", "2400", "1650"],
      ["Джем 300 г", "Тосап 300 г", "1100", "730"],
      ["Салфетки 100 шт", "Майлық 100 дана", "390", "240"],
      ["Бумажные полотенца", "Қағаз сүлгі", "890", "590"],
      ["Стаканы 50 шт", "Стақан 50 дана", "1200", "790"],
      ["Контейнеры 25 шт", "Контейнер 25 дана", "1600", "1050"],
      ["Пакеты 100 шт", "Пакет 100 дана", "850", "540"],
      ["Перчатки 100 шт", "Қолғап 100 дана", "2300", "1540"],
      ["Средство для посуды 1 л", "Ыдыс жуғыш 1 л", "1100", "720"],
      ["Мыло жидкое 500 мл", "Сұйық сабын 500 мл", "790", "490"],
      ["Чистящее средство 500 г", "Тазартқыш 500 г", "950", "610"],
      ["Губки 5 шт", "Ысқыш 5 дана", "450", "270"],
      ["Блокнот A5", "A5 дәптері", "650", "400"],
      ["Ручки 10 шт", "Қалам 10 дана", "990", "620"],
      ["Скотч упаковочный", "Қаптама таспасы", "480", "290"],
      ["Бумага A4 500 листов", "A4 қағазы 500 парақ", "2100", "1450"],
      ["Папка для документов", "Құжат папкасы", "590", "350"],
      ["Этикетки 100 шт", "Жапсырма 100 дана", "750", "430"],
    ];
    const items: string[] = [];
    for (const [i, product] of products.entries()) {
      const item = await step(`item:${i}`, () =>
        inv.saveItem(token, orgId, {
          sku: `TM-${String(i + 1).padStart(3, "0")}`,
          name_ru: product[0],
          name_kk: product[1],
          kind: "goods",
          base_unit: "pc",
          category:
            i < 20
              ? "Продукты и напитки"
              : i < 30
                ? "Хозяйственные товары"
                : "Канцелярия",
          sale_price: product[2],
          purchase_price: product[3],
        }),
      );
      items.push(item.id);
      for (let b = 0; b < 3; b++)
        await step(`stock:${b}:${i}`, (key) =>
          inv.execute(token, orgId, {
            key,
            kind: "receipt",
            warehouseId: warehouses[b],
            itemId: item.id,
            quantity: i >= 32 ? "8" : "600",
            unit: "pc",
            unitCost: product[3],
            note: "Тестовые данные: подтверждённый начальный остаток",
          }),
        );
    }
    console.log("Business fixture: branches, team and 36 products ready.");
    const customers: string[][] = [[], [], []];
    const names = [
      "Кофейня Самал",
      "Пекарня Арна",
      "Магазин Береке",
      "Офис Орда",
      "Кафе Арай",
      "Гостевой дом Дала",
      "Студия Жарық",
      "Маркет Алма",
      "Кафе Керуен",
      "Магазин Шаңырақ",
      "Офис Болашақ",
      "Пекарня Таң",
    ];
    for (let b = 0; b < 3; b++)
      for (const [i, name] of names.entries()) {
        customers[b].push(
          (
            await step(`customer:${b}:${i}`, (key) =>
              crm.createCustomer(token, orgId, {
                key,
                branchId: branches[b],
                name,
                email: `client-${b}-${i}@example.test`,
                phone: "",
                kind: "company",
                responsibleId: null,
                consents: { email: false, sms: false, messenger: false },
                consentNote:
                  "Синтетический клиент; внешние сообщения не разрешены",
              }),
            )
          ).id,
        );
      }
    const orderIds: string[] = [];
    for (let i = 0; i < 72; i++) {
      const b = i % 3,
        kind = i % 8,
        idx = i % 30;
      const order = await step(`order:${i}`, (key) =>
        sales.create(token, orgId, {
          key,
          branchId: branches[b],
          customerId: customers[b][i % 12],
          warehouseId: warehouses[b],
          dueDate: date(kind === 2 ? -5 : kind === 3 ? -2 : 3 + (i % 10)),
          delivery: i % 2 ? "delivery" : "pickup",
          note: `Тестовые данные: поставка для ${names[i % 12]}`,
          taxMode: "excluded",
          lines: [0, 1].map((n) => ({
            itemId: items[(idx + n) % 30],
            quantity: String(4 + (i % 9)),
            unit: "pc",
            price: products[(idx + n) % 30][2],
            discount: i % 4 === 0 ? "5" : "0",
          })),
        }),
      );
      orderIds.push(order.id);
      const transition = (label: string, payload: Record<string, unknown>) =>
        step(`order:${i}:${label}`, async (key) => {
          const d = await sales.get(token, orgId, order.id);
          return sales.transition(token, orgId, order.id, {
            key,
            version: d.order.version,
            note: "Тестовая операция",
            ...payload,
          });
        });
      if (kind === 0) continue;
      if (kind === 7) {
        await transition("cancel", { kind: "cancel" });
        continue;
      }
      await transition("confirm", { kind: "confirm" });
      if (kind !== 1) {
        const detail = await sales.get(token, orgId, order.id);
        for (const [n, line] of detail.lines.entries()) {
          if (kind === 4 && n === 1) continue;
          await transition(`fulfill:${n}`, {
            kind: "fulfill",
            lineId: line.id,
            quantity: line.quantity,
          });
        }
      }
      if (kind >= 3)
        await step(`order:${i}:payment`, async (key) => {
          const d = await sales.get(token, orgId, order.id),
            amount =
              BigInt(d.order.total_minor) /
              (kind === 3 || kind === 4 ? 2n : 1n);
          return sales.money(token, orgId, {
            key,
            kind: "payment",
            accountId: accounts[b],
            orderId: order.id,
            amount: `${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`,
            note: "Тестовые данные: оплата клиента",
          });
        });
      if (kind === 6) {
        const d = await sales.get(token, orgId, order.id),
          event = d.events.find((e) => e.kind === "fulfill")!;
        await transition("return", {
          kind: "return",
          eventId: event.id,
          quantity: "1",
        });
        await step(`order:${i}:refund`, async (key) => {
          const after = await sales.get(token, orgId, order.id),
            amount = BigInt(after.order.credit_minor);
          return sales.money(token, orgId, {
            key,
            kind: "refund",
            accountId: accounts[b],
            orderId: order.id,
            amount: `${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`,
            note: "Тестовые данные: возврат оплаты",
          });
        });
      }
    }
    console.log(
      "Business fixture: 36 customers and 72 orders with fulfillment, payments and returns ready.",
    );
    const suppliers: string[] = [];
    const offers: string[] = [];
    for (let i = 0; i < 6; i++)
      suppliers.push(
        (
          await step(`supplier:${i}`, (key) =>
            pur.createSupplier(token, orgId, {
              key,
              name: [
                "Тараз Снаб",
                "Alatau Foods",
                "Береке Опт",
                "Office Supply",
                "Dala Pack",
                "Сервис Трейд",
              ][i],
              contact: `supplier-${i}@example.test`,
              paymentTerms: "Оплата через 14 дней после приёмки",
              quality: 4,
              reliability: 4,
            }),
          )
        ).id,
      );
    for (let i = 0; i < 36; i++)
      offers.push(
        (
          await step(`offer:${i}`, (key) =>
            pur.createOffer(token, orgId, {
              key,
              supplierId: suppliers[i % 6],
              itemId: items[i],
              supplierSku: `SUP-${i + 1}`,
              packQuantity: "1",
              baseUnit: "pc",
              packPrice: products[i][3],
              minimumPacks: 1,
              delivery: "2500",
              leadDays: 3,
              currency: "KZT",
              rate: "1",
              rateDate: date(),
              rateSource: "KZT",
              tax: "excluded",
              taxPercent: "0",
              dated: date(-2),
              validUntil: date(30),
              characteristicsConfirmed: true,
              note: "Синтетическое предложение поставщика",
            }),
          )
        ).id,
      );
    for (let i = 0; i < 12; i++) {
      const b = i % 3;
      const purchase = await step(`purchase:${i}`, (key) =>
        pur.create(token, orgId, {
          key,
          branchId: branches[b],
          warehouseId: warehouses[b],
          supplierId: suppliers[i % 6],
          date: date(),
          dueDate: date(3),
          budget: "350000",
          note: "Тестовые данные: пополнение ассортимента",
          lines: [{ offerId: offers[i % 36], quantity: "30" }],
        }),
      );
      if (i % 3 !== 0)
        await step(`purchase:${i}:submit`, async (key) => {
          const d = await pur.get(token, orgId, purchase.id);
          return pur.transition(token, orgId, purchase.id, {
            key,
            version: d.order.version,
            kind: "submit",
            note: "На согласование владельцу",
          });
        });
    }
    for (let i = 0; i < 9; i++)
      await step(`obligation:${i}`, (key) =>
        sales.createObligation(token, orgId, {
          key,
          branchId: branches[i % 3],
          supplier: ["Тараз Снаб", "Береке Опт", "Dala Pack"][i % 3],
          amount: String(45000 + i * 12500),
          dueDate: date(i < 3 ? -3 : i + 2),
          note: "Тестовые данные: обязательство по поставке",
        }),
      );
    for (let i = 0; i < 12; i++)
      await step(`expense:${i}`, (key) =>
        sales.money(token, orgId, {
          key,
          kind: "expense",
          operating: true,
          accountId: accounts[i % 3],
          amount: String(15000 + i * 2500),
          category: ["Аренда", "Доставка", "Связь", "Упаковка"][i % 4],
          counterparty: "Тестовый подрядчик",
          note: "Синтетический расход",
        }),
      );
    const taskNames = [
      "Проверить остатки упаковки",
      "Подготовить заказ к выдаче",
      "Сверить оплату клиента",
      "Проверить сроки поставки",
      "Обновить прайс поставщика",
      "Проверить кассу после смены",
      "Подтвердить документы поставки",
      "Провести инвентаризацию",
      "Согласовать закупку чая",
      "Проверить возврат клиента",
      "Подготовить доставку",
      "Проверить ценники",
    ];
    for (let i = 0; i < 24; i++) {
      const ownerTask = i < 12;
      const task = await step(`task:${i}`, (key) =>
        tasks.create(token, orgId, {
          key,
          branchId: branches[ownerTask ? i % 3 : 0],
          title: taskNames[i % 12],
          description:
            "Тестовая рабочая задача. Проверьте связанные документы и оставьте результат.",
          priority: i % 4 === 0 ? "high" : "normal",
          assigneeId: ownerTask ? ownerId : staff[i % staff.length],
          due: { date: date((i % 5) - 2), time: "18:00" },
          evidence: "comment",
          requiresVerification: false,
          checklist: [],
          links: ownerTask ? [{ type: "sales_order", id: orderIds[i] }] : [],
        }),
      );
      if (ownerTask && i % 3 !== 0)
        await step(`task:${i}:start`, async (key) => {
          const d = await tasks.get(token, orgId, task.id);
          return tasks.command(token, orgId, task.id, {
            key,
            kind: "start",
            version: d.task.version,
          });
        });
    }
    for (const [i, title] of [
      "Открытие и закрытие смены",
      "Приёмка товара на склад",
      "Работа с возвратами",
      "Проверка оплаты заказа",
      "Согласование закупки",
      "Защита данных клиентов",
    ].entries()) {
      const doc = await step(`knowledge:${i}`, (key) =>
        knowledge.create(token, orgId, {
          key,
          branchId: null,
          title,
          category: i % 2 ? "Склад и закупки" : "Рабочие инструкции",
          audience: [],
          body: `${title}\n\n1. Откройте исходный документ и проверьте филиал.\n2. Сверьте фактические данные с документом.\n3. Подтвердите операцию только после проверки.\n4. Зафиксируйте результат и передайте расхождения ответственному.\n\nТестовые данные. Внешние действия не выполняются.`,
          reviewDue: date(30),
          changeNote: "Начальная синтетическая инструкция",
        }),
      );
      await step(`knowledge:${i}:publish`, () =>
        knowledge.publish(token, orgId, doc.id, {
          key: state.keys[`knowledge:${i}:publish`],
          version: 1,
          number: 1,
          action: "publish",
        }),
      );
    }
    for (let i = 32; i < 36; i++)
      await step(`threshold:${i}`, () =>
        insights.setReorderPoint(token, orgId, {
          warehouseId: warehouses[0],
          itemId: items[i],
          minimum: "20",
          safety: "5",
          leadDays: 3,
          version: 0,
        }),
      );
    await insights.refresh(token, orgId);
    const today = await new TodayService(db).today(token, orgId);
    const report = {
      organizationId: orgId,
      synthetic: true,
      createdAt: new Date().toISOString(),
      branches: 3,
      team: 6,
      products: 36,
      warehouses: 3,
      customers: 36,
      orders: 72,
      accounts: 6,
      suppliers: 6,
      offers: 36,
      purchases: 12,
      obligations: 9,
      tasks: 24,
      knowledge: 6,
      situations: today.situations_total,
      summary: await sales.summary(token, orgId, { branchId: branches[0] }),
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    state.completed = true;
    await save();
    console.log(
      `Business fixture complete. Credentials: ${statePath}; report: ${reportPath}. No external services called.`,
    );
  } finally {
    if (token) await p.logout(token).catch(() => {});
    await db.close();
  }
}
main().catch((e) => {
  console.error(
    "BUSINESS_SEED_FAILED",
    e instanceof Error ? e.name : "Error",
    (e as { code?: string }).code || "CHECK_LOCAL_CONFIGURATION",
  );
  process.exitCode = 1;
});
