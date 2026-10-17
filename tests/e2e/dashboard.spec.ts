import {
  test,
  expect,
  chromium,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";

// T005/T052 main screen of TirekAI on real records: refresh, branch switch, the decision draft,
// the calculation dialog, event links, a typed and a spoken question to the assistant, Kazakh,
// the mobile menu, no horizontal scroll and no console errors or warnings.
const origin = "http://127.0.0.1:3100";
function client(request: APIRequestContext) {
  const post = async (path: string, data: unknown) => {
    const r = await request.post(`/api/v1/${path}`, {
      headers: { origin },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()).data;
  };
  const get = async (path: string) => {
    const r = await request.get(`/api/v1/${path}`);
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()).data;
  };
  return { post, get };
}
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Qyzylorda" }).format(
    new Date(),
  );
async function seed(page: Page) {
  const api = client(page.request);
  await api.post("auth/register", {
    name: "Айдар",
    email: `dash-${randomUUID()}@example.test`,
    password: "Browser-Synthetic-Dash-661!",
  });
  const org = (
    await api.post("organizations", { name: "Tirek Dash", profile: "retail" })
  ).id;
  const base = `organizations/${org}`;
  const branch = (await api.get(base)).branches[0].id;
  const branch2 = (await api.post(`${base}/branches`, { name: "Астана" })).id;
  const warehouse = (
    await api.post(`${base}/warehouses`, { branchId: branch, name: "Склад 1" })
  ).id;
  const warehouse2 = (
    await api.post(`${base}/warehouses`, { branchId: branch2, name: "Склад 2" })
  ).id;
  const item = (
    await api.post(`${base}/catalog`, {
      sku: "DASH-1",
      name_ru: "Бумага А4",
      name_kk: "А4 қағаз",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "40",
      sale_price: "100",
    })
  ).id;
  for (const [w, quantity] of [
    [warehouse, "10"],
    [warehouse2, "20"],
  ])
    await api.post(`${base}/stock-commands`, {
      key: randomUUID(),
      kind: "receipt",
      warehouseId: w,
      itemId: item,
      quantity,
      unit: "pc",
      unitCost: "40",
      note: "Начальный остаток",
    });
  const supplier = (
    await api.post(`${base}/suppliers`, {
      key: randomUUID(),
      name: "Тараз Снаб",
      contact: "Тест",
      paymentTerms: "После приёмки",
      quality: 4,
      reliability: 4,
    })
  ).id;
  await api.post(`${base}/supplier-offers`, {
    key: randomUUID(),
    supplierId: supplier,
    itemId: item,
    supplierSku: "A4",
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
    note: "Тестовый прайс",
  });
  // Today's sales through the order commands: 8 pc in the first branch, 3 pc in Astana.
  for (const [b, w, quantity, name] of [
    [branch, warehouse, "8", "Кафе Арай"],
    [branch2, warehouse2, "3", "Офис Орда"],
  ]) {
    const customer = (
      await api.post(`${base}/crm/customers`, {
        key: randomUUID(),
        branchId: b,
        name,
        email: "",
        phone: "",
        kind: "company",
        responsibleId: null,
        consents: { email: false, sms: false, messenger: false },
        consentNote: "Тестовые данные",
      })
    ).id;
    const order = (
      await api.post(`${base}/orders`, {
        key: randomUUID(),
        branchId: b,
        customerId: customer,
        warehouseId: w,
        dueDate: today(),
        delivery: "pickup",
        note: "Тестовый заказ",
        taxMode: "excluded",
        lines: [
          { itemId: item, quantity, unit: "pc", price: "100", discount: "0" },
        ],
      })
    ).id;
    await api.post(`${base}/orders/${order}/commands`, {
      key: randomUUID(),
      version: 1,
      kind: "confirm",
      note: "Тест",
    });
    const line = (await api.get(`${base}/orders/${order}`)).lines[0].id;
    await api.post(`${base}/orders/${order}/commands`, {
      key: randomUUID(),
      version: 2,
      kind: "fulfill",
      lineId: line,
      quantity,
      note: "Тест",
    });
  }
  await api.post(`${base}/insights/reorder-points`, {
    warehouseId: warehouse,
    itemId: item,
    minimum: "5",
    safety: "1",
    leadDays: 3,
    version: 0,
  });
  await api.post(`${base}/finance/accounts`, {
    key: randomUUID(),
    branchId: branch,
    name: "Касса",
    opening: "1000",
  });
  await api.post(`${base}/assistant/settings`, {
    version: 0,
    enabled: true,
    voiceEnabled: true,
    monthlyTokenBudget: 100000,
    maxOutputTokens: 2000,
  });
  return { org, branch, branch2 };
}
const noOverflow = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
const nav = (page: Page, name: string) =>
  page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();

test("TirekAI main screen: real data, refresh, branch switch, decision, calculation, events, assistant text and voice, KK, mobile menu", async () => {
  test.setTimeout(240_000);
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 900 },
    permissions: ["microphone"],
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning")
      problems.push(`${m.type()}: ${m.text()}`);
  });
  const asks: { text: string; voice?: unknown }[] = [];
  const dashboards: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/assistant/messages"))
      asks.push(r.postDataJSON());
    if (r.method() === "GET" && /\/dashboard(\?|$)/.test(r.url()))
      dashboards.push(r.url());
  });
  const { branch2 } = await seed(page);
  await page.goto("/");
  await page.getByRole("button", { name: "РУС", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Сегодня требуют внимания",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/^Добр(ое|ый|ой) .*, Айдар$/)).toBeVisible();

  // Refresh runs the situation check and shows the new situation with its numbers.
  await page
    .getByRole("button", { name: "Обновить ситуации", exact: true })
    .click();
  const main = page.locator(".dash-main");
  await expect(main.getByText(/Бумага А4/)).toBeVisible();
  await expect(
    page.getByText(/^\d+ ситуаци(я|и|й) мо(жет|гут) повлиять/),
  ).toBeVisible();
  await expect(page.getByText(/Обновлено только что/)).toBeVisible();
  await expect(main.getByText("8 шт/день", { exact: true })).toBeVisible();
  await expect(main.getByText("3 дня", { exact: true })).toBeVisible();
  await expect(main.getByText(/Заказать .* у «Тараз Снаб»/)).toBeVisible();
  // One day of history is named as a preliminary estimate.
  await expect(main.getByText(/история продаж короче 7 дней/)).toBeVisible();

  // The calculation dialog: period, formula, sources, assumptions; Escape closes it.
  await main
    .getByRole("button", { name: "Показать расчёт", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  for (const heading of ["Период", "Расчёт", "Источники", "Допущения"])
    await expect(
      dialog.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
  await expect(dialog.getByText(/окно до 28 дней/)).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Branch switch reloads the view for that branch only.
  const before = dashboards.length;
  await page
    .locator(".topbar")
    .getByRole("combobox", { name: "Филиал", exact: true })
    .selectOption(branch2);
  await expect.poll(() => dashboards.length).toBeGreaterThan(before);
  expect(dashboards.at(-1)).toContain(`branchId=${branch2}`);
  const branches = page.locator(".dash-branches");
  await expect(branches.getByText("Астана", { exact: true })).toBeVisible();
  await expect(branches.locator("tbody tr")).toHaveCount(1);
  await expect(main.getByText(/Бумага А4/)).toHaveCount(0);
  await page
    .locator(".topbar")
    .getByRole("combobox", { name: "Филиал", exact: true })
    .selectOption("");
  await expect(main.getByText(/Бумага А4/)).toBeVisible();
  await expect(branches.locator("tbody tr")).toHaveCount(2);
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);

  // The minimum cash reserve is set from the money card (versioned, idempotent command).
  const cash = page.locator(".dash-cash");
  await expect(
    cash.getByText("Минимальный резерв не задан", { exact: true }),
  ).toBeVisible();
  await cash
    .getByRole("button", { name: "Задать резерв", exact: true })
    .click();
  await cash.getByLabel("Минимальный резерв, ₸", { exact: true }).fill("500");
  await cash.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(cash.getByText("500 ₸", { exact: true })).toBeVisible();

  // An event opens its record.
  await page
    .locator(".dash-timeline")
    .getByRole("button", { name: /Создан заказ №\d+ · Кафе Арай/ })
    .click();
  await expect(page.locator("main h1")).toHaveText(/Заказы/);
  await expect(
    page.getByRole("region", { name: "Карточка заказа", exact: true }),
  ).toBeVisible();

  // "Prepare a decision" creates a draft that is opened in approvals.
  await nav(page, "Главная");
  await main
    .getByRole("button", { name: "Подготовить решение", exact: true })
    .click();
  await expect(main.getByText(/Черновик решения создан/)).toBeVisible();
  await main
    .getByRole("button", { name: "Открыть согласования", exact: true })
    .click();
  await expect(page.locator("main h1")).toHaveText(/Согласования/);

  // A typed question goes to the assistant once.
  await nav(page, "Главная");
  const ask = page.getByRole("textbox", {
    name: "Вопрос помощнику",
    exact: true,
  });
  await ask.fill("Что лучше сделать при бюджете 300 000 ₸?");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(page.locator("main h1")).toHaveText(/Помощник/);
  await expect(
    page.locator(".assistant-message.user .assistant-text", {
      hasText: "бюджете 300 000",
    }),
  ).toBeVisible({ timeout: 30_000 });
  // No model is configured in tests: the answer is a plain "not configured" message.
  await expect(page.locator(".assistant-message.assistant")).toBeVisible();
  expect(asks).toHaveLength(1);
  expect(asks[0]).not.toHaveProperty("voice");

  // A spoken question is recognized and sent by itself, without pressing "Send".
  await nav(page, "Главная");
  await page
    .getByRole("button", { name: "Записать вопрос", exact: true })
    .click();
  await page.waitForTimeout(1200);
  await page
    .getByRole("button", { name: "Остановить и распознать", exact: true })
    .click();
  await expect(
    page.locator(".assistant-message.user .assistant-text", {
      hasText: "Спиши 25 штук",
    }),
  ).toBeVisible({ timeout: 60_000 });
  expect(asks).toHaveLength(2);
  expect(asks[1]).toMatchObject({ text: "Спиши 25 штук" });

  // Kazakh: the same screen with Kazakh texts.
  await nav(page, "Главная");
  await page.getByRole("button", { name: "ҚАЗ", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Бүгін назар аударуды қажет етеді",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Шешім дайындау", exact: true }),
  ).toBeVisible();
  expect(await noOverflow(page)).toBe(true);

  // Mobile: the main decision first, a drawer menu with a trapped background, no side scroll.
  await page.getByRole("button", { name: "РУС", exact: true }).click();
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1280, 720],
  ]) {
    await page.setViewportSize({ width, height });
    await expect(main).toBeVisible();
    expect(await noOverflow(page), `${width}`).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Меню", exact: true }).click();
  await expect(page.locator(".app-main")).toHaveAttribute("inert", "");
  await expect(
    page.getByRole("navigation").getByRole("button", { name: "Камеры" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".app-main")).not.toHaveAttribute("inert", "");
  expect(problems).toEqual([]);
  await browser.close();
});
