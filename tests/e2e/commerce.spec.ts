import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
test("orders, partial fulfillment, payment, return, refund and financial breakdown in RU/KK", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(`/api/v1/${path}`, {
      headers: { origin: "http://127.0.0.1:3100" },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).data;
  };
  const get = async (path: string) => {
    const response = await page.request.get(`/api/v1/${path}`);
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).data;
  };
  await post("auth/register", {
    name: "Заказы тест",
    email: `order-${randomUUID()}@example.test`,
    password: "Browser-Synthetic-Order-661!",
  });
  const org = (
      await post("organizations", { name: "Taraz Orders", profile: "retail" })
    ).id,
    base = `organizations/${org}`,
    workspace = await get(base),
    branch = workspace.branches[0].id;
  const warehouse = (
    await post(`${base}/warehouses`, {
      branchId: branch,
      name: "Склад заказов",
    })
  ).id;
  const item = (
    await post(`${base}/catalog`, {
      sku: "TEA-ORDER",
      name_ru: "Чай для заказа",
      name_kk: "Тапсырыс шайы",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "20",
      sale_price: "100",
    })
  ).id;
  await post(`${base}/stock-commands`, {
    key: randomUUID(),
    kind: "receipt",
    warehouseId: warehouse,
    itemId: item,
    quantity: "10",
    unit: "pc",
    unitCost: "20",
    note: "Тестовая поставка",
  });
  const batch = await post(`${base}/imports`, {
    branchId: branch,
    filename: "orders.csv",
    delimiter: ",",
    content:
      "external_id,name,email,phone\nO1,Айдана Заказы,orders@example.test,\n",
  });
  await post(`${base}/imports/${batch.batch.id}/confirm`, {
    version: batch.batch.version,
  });
  await expect
    .poll(async () => (await get(`${base}/order-customers`)).pagination.total)
    .toBe(1);
  const customer = (await get(`${base}/order-customers`)).items[0].id;
  await page.goto("/");
  await page.getByRole("button", { name: "РУС", exact: true }).click();
  const nav = page.getByRole("navigation");
  await nav.getByRole("button", { name: "Заказы", exact: true }).click();
  await page
    .getByRole("button", { name: "Создать заказ", exact: true })
    .click();
  let form = page.getByRole("region", { name: "Форма операции", exact: true });
  await form
    .getByRole("combobox", { name: "Клиент", exact: true })
    .selectOption(customer);
  await form
    .getByRole("combobox", { name: "Склад заказа", exact: true })
    .selectOption(warehouse);
  await form.getByLabel("Срок оплаты", { exact: true }).fill("2026-10-01");
  await form
    .getByLabel("Основание", { exact: true })
    .fill("Проверка заказа клиента");
  await form
    .getByRole("combobox", { name: "Позиция 1", exact: true })
    .selectOption(item);
  await form.getByLabel("Количество 1", { exact: true }).fill("3");
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  const card = page.getByRole("region", {
    name: "Карточка заказа",
    exact: true,
  });
  await expect(card).toBeVisible();
  await card
    .getByRole("button", { name: "Подтвердить и зарезервировать", exact: true })
    .click();
  form = page.getByRole("region", { name: "Форма операции", exact: true });
  await form
    .getByLabel("Основание", { exact: true })
    .fill("Подтверждён клиентом");
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await card
    .getByRole("button", { name: "Исполнить часть", exact: true })
    .click();
  await form
    .getByLabel("Количество в единицах строки", { exact: true })
    .fill("2");
  await form
    .getByLabel("Основание", { exact: true })
    .fill("Выдали две упаковки");
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(
    card.getByRole("heading", { name: /Частично исполнен/ }),
  ).toBeVisible();
  const id = (await get(`${base}/orders`)).items[0].id;
  expect((await get(`${base}/orders/${id}`)).order).toMatchObject({
    revenue_minor: "20000",
    paid_minor: "0",
    receivable_minor: "20000",
  });
  await expect(
    new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze()
      .then((r) => r.violations),
  ).resolves.toEqual([]);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: "docs/evidence/orders-desktop-ru.png",
    fullPage: true,
  });
  await nav.getByRole("button", { name: "Финансы", exact: true }).click();
  await page
    .getByRole("button", { name: "Добавить счёт", exact: true })
    .click();
  await form
    .getByLabel("Название счёта", { exact: true })
    .fill("Касса заказов");
  await form.getByLabel("Начальный остаток, ₸", { exact: true }).fill("0");
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(
    page.getByText("Касса заказов", { exact: true }).first(),
  ).toBeVisible();
  const account = (await get(`${base}/finance/accounts`)).items[0].id;
  async function money(kind: string, amount: string, note: string) {
    await page
      .getByRole("button", { name: "Денежная операция", exact: true })
      .click();
    await form
      .getByRole("combobox", { name: "Вид операции", exact: true })
      .selectOption(kind);
    await form
      .getByRole("combobox", { name: "Денежный счёт", exact: true })
      .selectOption(account);
    await form
      .getByRole("combobox", { name: "Заказ", exact: true })
      .selectOption(id);
    await form.getByLabel("Сумма, ₸", { exact: true }).fill(amount);
    await form.getByLabel("Основание", { exact: true }).fill(note);
    await form.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect(form).not.toBeVisible();
  }
  await money("payment", "150", "Частичная оплата клиента");
  expect((await get(`${base}/finance/summary`)).receivable_minor).toBe("5000");
  await nav.getByRole("button", { name: "Заказы", exact: true }).click();
  await page.locator(".commerce-order").first().click();
  await card
    .getByRole("button", { name: "Оформить возврат", exact: true })
    .click();
  await form
    .getByLabel("Количество в единицах строки", { exact: true })
    .fill("1");
  await form
    .getByLabel("Основание", { exact: true })
    .fill("Клиент вернул упаковку");
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(
    card.getByText("Возврат товара / услуги", { exact: true }),
  ).toBeVisible();
  await nav.getByRole("button", { name: "Финансы", exact: true }).click();
  await money("refund", "50", "Возврат оплаты за упаковку");
  const report = await get(`${base}/finance/summary`);
  expect(report).toMatchObject({
    revenue_minor: "10000",
    cash_minor: "10000",
    cost_minor: "2000",
    gross_profit_minor: "8000",
    receivable_minor: "0",
  });
  const calendar = page.getByRole("region", {
    name: "Платёжный календарь и сценарий",
    exact: true,
  });
  await expect(
    calendar.getByText("Фактический остаток сейчас", { exact: false }),
  ).toBeVisible();
  await calendar.getByLabel("Горизонт, дней", { exact: true }).fill("2");
  await calendar
    .getByLabel("Задержка поступлений, дней", { exact: true })
    .fill("3");
  await calendar
    .getByRole("button", { name: "Рассчитать сценарий", exact: true })
    .click();
  await expect(calendar.getByRole("status")).toContainText(
    "Прогноз на конец · сценарий: 100,00 ₸",
  );
  await expect(calendar.getByRole("status")).toContainText(
    "Прогноз на конец · база: 200,00 ₸",
  );
  expect((await get(`${base}/finance/summary`)).cash_minor).toBe("10000");
  await expect(
    new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze()
      .then((r) => r.violations),
  ).resolves.toEqual([]);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: "docs/evidence/finance-desktop-ru.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "ҚАЗ", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ақша және міндеттемелер", exact: true }),
  ).toBeVisible();
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: "docs/evidence/finance-mobile-kk.png",
    fullPage: true,
  });
  await expect(
    new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze()
      .then((r) => r.violations),
  ).resolves.toEqual([]);
  expect(errors).toEqual([]);
});
