import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";

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
const nav = (page: Page, name: string) =>
  page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
const form = (page: Page, button: string) =>
  page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: button, exact: true }) });
test("situation → draft purchase → second-person approval → execution; tasks, knowledge, automation, assistant, integrations and invoice line decisions in RU/KK", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const owner = client(page.request);
  await owner.post("auth/register", {
    name: "Собственник",
    email: `exec-${randomUUID()}@example.test`,
    password: "Browser-Synthetic-Exec-661!",
  });
  const org = (
    await owner.post("organizations", {
      name: "Taraz Execution",
      profile: "retail",
    })
  ).id;
  const base = `organizations/${org}`;
  const branch = (await owner.get(base)).branches[0].id;
  const managerEmail = `manager-${randomUUID()}@example.test`;
  const invite = await owner.post(`${base}/invitations`, {
    email: managerEmail,
    role: "manager",
    branchId: branch,
  });
  const warehouse = (
    await owner.post(`${base}/warehouses`, { branchId: branch, name: "Склад" })
  ).id;
  const item = (
    await owner.post(`${base}/catalog`, {
      sku: "TEA-EXEC",
      name_ru: "Чай упаковка",
      name_kk: "Шай қаптама",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "10",
      sale_price: "20",
    })
  ).id;
  const other = (
    await owner.post(`${base}/catalog`, {
      sku: "EXTRA-EXEC",
      name_ru: "Лишний товар",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "1",
      sale_price: "2",
    })
  ).id;
  await owner.post(`${base}/stock-commands`, {
    key: randomUUID(),
    kind: "receipt",
    warehouseId: warehouse,
    itemId: item,
    quantity: "2",
    unit: "pc",
    unitCost: "10",
    note: "Начальный остаток",
  });
  const supplier = (
    await owner.post(`${base}/suppliers`, {
      key: randomUUID(),
      name: "Поставщик Тараз",
      contact: "Тест",
      paymentTerms: "После приёмки",
      quality: 4,
      reliability: 4,
    })
  ).id;
  await owner.post(`${base}/supplier-offers`, {
    key: randomUUID(),
    supplierId: supplier,
    itemId: item,
    supplierSku: "TEA BOX",
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
    dated: "2026-01-01",
    validUntil: "2030-12-31",
    characteristicsConfirmed: true,
    note: "Тестовый прайс",
  });
  await page.goto("/");
  await page.getByRole("button", { name: "РУС", exact: true }).click();
  // T023: reorder point through the form, then explicit detection.
  let f = form(page, "Сохранить порог");
  await f.getByRole("combobox", { name: "Товар", exact: true }).selectOption(item);
  await f.getByLabel("Минимум, базовые единицы", { exact: true }).fill("10");
  await f.getByLabel("Страховой запас", { exact: true }).fill("2");
  await f.getByRole("button", { name: "Сохранить порог", exact: true }).click();
  await page
    .getByRole("button", { name: "Проверить сейчас", exact: true })
    .click();
  await expect(page.getByText(/Риск нехватки товара: TEA-EXEC/)).toBeVisible();
  await expect(page.getByText("Не хватает", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Подготовить закупку", exact: true })
    .click();
  await expect(page.getByText(/Черновик закупки создан/)).toBeVisible();
  await nav(page, "Согласования");
  await page.getByRole("combobox", { name: "Показать", exact: true }).selectOption("draft");
  await page.getByRole("button", { name: /Закупка · 132,00 KZT/ }).click();
  await page
    .getByRole("button", { name: "Отправить на согласование", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: /Предложение закупки · Ждёт согласования/,
    }),
  ).toBeVisible();
  // T024: a second person approves the exact parameter version.
  const managerContext = await browser.newContext({ baseURL: origin });
  const manager = await managerContext.newPage();
  const m = client(manager.request);
  await m.post("auth/register", {
    name: "Управляющий",
    email: managerEmail,
    password: "Browser-Synthetic-Exec-662!",
  });
  await m.post("invitations/accept", { token: invite.token });
  await manager.goto("/");
  await manager.getByRole("button", { name: "РУС", exact: true }).click();
  await nav(manager, "Согласования");
  await manager.getByRole("button", { name: /Закупка · 132,00 KZT/ }).click();
  f = form(manager, "Записать решение");
  await f
    .getByLabel("Основание", { exact: true })
    .fill("Остаток ниже минимума");
  await f
    .getByRole("button", { name: "Записать решение", exact: true })
    .click();
  await expect(
    manager.getByRole("heading", { name: /Предложение закупки · Согласовано/ }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "РУС", exact: true }).click();
  await nav(page, "Согласования");
  await page.getByRole("combobox", { name: "Показать", exact: true }).selectOption("approved");
  await page.getByRole("button", { name: /Закупка · 132,00 KZT/ }).click();
  await page
    .getByRole("button", { name: "Выполнить согласованное", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: /Предложение закупки · Выполнено/ }),
  ).toBeVisible();
  const purchases = (await owner.get(`${base}/purchases`)).items;
  expect(purchases[0]).toMatchObject({
    state: "approved",
    total_minor: "13200",
  });
  // T021: task with verification by another person.
  await nav(page, "Задачи");
  f = form(page, "Создать задачу");
  await f.getByLabel("Задача", { exact: true }).fill("Проверить витрину чая");
  await f
    .getByRole("combobox", { name: "Исполнитель", exact: true })
    .selectOption({ label: "Собственник" });
  await f
    .getByLabel("Чеклист, по пункту в строке", { exact: true })
    .fill("Пересчитать упаковки");
  await f
    .getByRole("checkbox", { name: "Нужна проверка руководителем" })
    .check();
  await f.getByRole("button", { name: "Создать задачу", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Проверить витрину чая/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Начать", exact: true }).click();
  await expect(page.getByText(/^В работе · Общая/)).toBeVisible();
  await page.getByRole("checkbox", { name: /Пересчитать упаковки/ }).click();
  await expect(
    page.getByRole("checkbox", { name: /Пересчитать упаковки/ }),
  ).toBeChecked();
  f = form(page, "Сообщить о выполнении");
  await f.getByLabel("Что сделано", { exact: true }).fill("Упаковки на месте");
  await f
    .getByRole("button", { name: "Сообщить о выполнении", exact: true })
    .click();
  await expect(
    page.getByText("Отчёт об исполнении", { exact: true }),
  ).toBeVisible();
  await nav(manager, "Задачи");
  await manager.getByRole("combobox", { name: "Показать", exact: true }).selectOption("done");
  await manager.getByRole("button", { name: /Проверить витрину чая/ }).click();
  f = form(manager, "Записать результат проверки");
  await f
    .getByLabel("Основание / комментарий", { exact: true })
    .fill("Проверено на месте");
  await f
    .getByRole("button", { name: "Записать результат проверки", exact: true })
    .click();
  await expect(manager.getByText(/Проверена · Общая/)).toBeVisible();
  // T022: draft, publish, search.
  await nav(page, "Знания");
  f = form(page, "Сохранить черновик");
  await f.getByLabel("Название", { exact: true }).fill("Приёмка чая");
  await f.getByLabel("Раздел", { exact: true }).fill("Склад");
  await f
    .getByLabel("Основание изменения", { exact: true })
    .fill("Первая редакция");
  await f
    .getByLabel("Текст", { exact: true })
    .fill("Проверить целостность упаковки и срок годности.");
  await f
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Опубликовать открытую версию", exact: true })
    .click();
  await expect(page.getByText(/· опубликована /)).toBeVisible();
  await page
    .getByRole("search")
    .getByLabel("Что найти", { exact: true })
    .fill("целостность");
  await page
    .getByRole("search")
    .getByRole("button", { name: "Найти", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Приёмка чая · v1", exact: true }),
  ).toBeVisible();
  // T025: rule needs a passing dry run before activation.
  await nav(page, "Автоматизации");
  f = form(page, "Сохранить черновик правила");
  await f.getByLabel("Название", { exact: true }).fill("Нехватка → задача");
  await f
    .getByLabel("Условие: поле события (необязательно)", { exact: true })
    .fill("rule");
  await f.getByLabel("Значение", { exact: true }).fill("low_stock");
  await f
    .getByLabel("Основание", { exact: true })
    .fill("Правило для закупщика");
  await f
    .getByRole("button", { name: "Сохранить черновик правила", exact: true })
    .click();
  await page.getByRole("button", { name: "Включить", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Сначала успешно проверьте" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Проверить на тестовом событии", exact: true })
    .click();
  await expect(
    page.getByText("Проверка пройдена", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Включить", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Нехватка → задача.*Включено/ }),
  ).toBeVisible();
  // T026: honest not_configured state.
  await nav(page, "Помощник");
  await expect(
    page.getByText(/AI-провайдер не подключён на сервере/),
  ).toBeVisible();
  await page
    .getByLabel("Вопрос или поручение", { exact: true })
    .fill("Что требует внимания?");
  await page.getByRole("button", { name: "Отправить", exact: true }).click();
  await expect(
    page.getByText(/Не подключено: AI-провайдер не подключён/),
  ).toBeVisible();
  // T029/T030: passports and status without a live account.
  await nav(page, "Подключения");
  await expect(page.getByText("Не подключено", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/GET \/report\/stock\/bystore\/current/),
  ).toBeVisible();
  // T020: invoice line outside the order is rejected explicitly, not posted.
  const purchase = (
    await owner.post(`${base}/purchases`, {
      key: randomUUID(),
      branchId: branch,
      warehouseId: warehouse,
      supplierId: supplier,
      date: "2026-10-14",
      dueDate: "2026-10-20",
      budget: "200",
      note: "Для сверки",
      lines: [
        {
          offerId: (await owner.get(`${base}/purchases/${purchases[0].id}`))
            .lines[0].offer_id,
          quantity: "12",
        },
      ],
    })
  ).id;
  for (const [kind, version] of [
    ["submit", 1],
    ["approve", 2],
    ["sent", 3],
  ] as const)
    await owner.post(`${base}/purchases/${purchase}/commands`, {
      key: randomUUID(),
      version,
      kind,
      note: "Проверено вручную",
    });
  await owner.post(`${base}/purchase-documents`, {
    key: randomUUID(),
    orderId: purchase,
    filename: "line-decisions.csv",
    content: Buffer.from(`name,qty\nЧай,12\n${randomUUID()}`).toString(
      "base64",
    ),
    externalId: "",
  });
  await nav(page, "Закупки");
  await page
    .getByRole("button", { name: /№\d+ · Поставщик Тараз.*Отправлено вручную/ })
    .first()
    .click();
  await page.getByRole("button", { name: /line-decisions\.csv/ }).click();
  f = form(page, "Сохранить проверку документа");
  await f
    .getByRole("combobox", { name: "Результат проверки", exact: true })
    .selectOption("review");
  await f.getByLabel("Номер документа", { exact: true }).fill("LINE-1");
  await f.getByLabel("Дата документа", { exact: true }).fill("2026-10-14");
  await f.getByLabel("Срок оплаты", { exact: true }).fill("2026-10-20");
  await f.getByLabel("Количество в документе", { exact: true }).fill("12");
  await f
    .getByLabel("Цена за эту единицу, включая налоги, KZT", { exact: true })
    .fill("10");
  await f
    .getByRole("button", { name: "Добавить строку вне заказа", exact: true })
    .click();
  f = form(page, "Сохранить проверку документа");
  const extra = f.getByTestId("extra-line-0");
  await extra
    .getByLabel("Наименование по документу", { exact: true })
    .fill("Неизвестная позиция");
  await extra.getByRole("combobox", { name: "Товар каталога", exact: true }).selectOption(other);
  await extra.getByLabel("Количество", { exact: true }).fill("1");
  await extra
    .getByLabel("Цена за единицу, включая налоги, KZT", { exact: true })
    .fill("5");
  await f.getByLabel("Доставка, KZT", { exact: true }).fill("12");
  await f.getByLabel("Итог по оригиналу, KZT", { exact: true }).fill("137");
  await f
    .getByLabel("Основание / комментарий", { exact: true })
    .fill("Сверено с оригиналом");
  await f.getByRole("checkbox", { name: /Проверены расхождения/ }).check();
  await f
    .getByRole("button", { name: "Сохранить проверку документа", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Есть строки вне заказа" }),
  ).toBeVisible();
  await extra.getByRole("combobox", { name: "Решение", exact: true }).selectOption("reject");
  await f
    .getByRole("button", { name: "Сохранить проверку документа", exact: true })
    .click();
  await expect(
    page.getByText(/Отклонено, не принято и не оплачивается/),
  ).toBeVisible();
  const obligations = (await owner.get(`${base}/finance/obligations`)).items;
  expect(
    obligations.find(
      (o: { purchase_order_id: string }) => o.purchase_order_id === purchase,
    ),
  ).toMatchObject({ amount_minor: "13200" });
  // Accessibility, KK and mobile widths on the new Today screen.
  await nav(page, "Сегодня");
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({
    path: "docs/evidence/today-desktop-ru.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "ҚАЗ", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Назар аударыңыз", exact: true }),
  ).toBeVisible();
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    for (const section of [
      "Бүгін",
      "Тапсырмалар",
      "Келісулер",
      "Көмекші",
      "Қосылымдар",
    ]) {
      const button = page
        .getByRole("navigation")
        .getByRole("button", { name: section, exact: true });
      if (await button.isVisible()) await button.click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `${section} @ ${width}`,
      ).toBe(true);
    }
  }
  await page.screenshot({
    path: "docs/evidence/approvals-mobile-kk.png",
    fullPage: true,
  });
  await managerContext.close();
  expect(errors).toEqual([]);
});
