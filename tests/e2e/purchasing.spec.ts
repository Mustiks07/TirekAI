import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
test("supplier comparison, purchase approval, document corrections and partial physical receipt in RU/KK", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const post = async (path: string, data: unknown) => {
    const r = await page.request.post(`/api/v1/${path}`, {
      headers: { origin: "http://127.0.0.1:3100" },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()).data;
  };
  const get = async (path: string) => {
    const r = await page.request.get(`/api/v1/${path}`);
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()).data;
  };
  await post("auth/register", {
    name: "Закупки тест",
    email: `purchase-${randomUUID()}@example.test`,
    password: "Browser-Synthetic-Purchase-661!",
  });
  const org = (
      await post("organizations", { name: "Taraz Purchase", profile: "retail" })
    ).id,
    base = `organizations/${org}`,
    branch = (await get(base)).branches[0].id;
  const warehouse = (
      await post(`${base}/warehouses`, {
        branchId: branch,
        name: "Склад закупок",
      })
    ).id,
    item = (
      await post(`${base}/catalog`, {
        sku: "TEA-PURCHASE",
        name_ru: "Чай упаковка",
        name_kk: "Шай қаптама",
        kind: "goods",
        base_unit: "pc",
        purchase_price: "10",
        sale_price: "20",
      })
    ).id;
  const supplier = (
    await post(`${base}/suppliers`, {
      key: randomUUID(),
      name: "Поставщик Тараз",
      contact: "Тестовый контакт",
      paymentTerms: "После приёмки",
      quality: 4,
      reliability: 4,
    })
  ).id;
  await post(`${base}/supplier-offers`, {
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
    validUntil: "2027-12-31",
    characteristicsConfirmed: true,
    note: "Тестовый прайс",
  });
  await page.goto("/");
  await page.getByRole("button", { name: "РУС", exact: true }).click();
  const nav = page.getByRole("navigation");
  await nav.getByRole("button", { name: "Закупки", exact: true }).click();
  await page
    .getByRole("button", { name: "Поставщики и прайсы", exact: true })
    .click();
  let form = page.locator("form").filter({
    has: page.getByRole("button", {
      name: "Рассчитать полную стоимость",
      exact: true,
    }),
  });
  await form
    .getByRole("combobox", { name: "Товар", exact: true })
    .selectOption(item);
  await form.getByLabel("Нужно базовых единиц", { exact: true }).fill("12");
  await form
    .getByRole("button", { name: "Рассчитать полную стоимость", exact: true })
    .click();
  await expect(page.getByText(/132,00 KZT · 11.000000/)).toBeVisible();
  await page
    .getByRole("button", { name: "В проект закупки", exact: true })
    .click();
  form = page.locator("form").filter({
    has: page.getByRole("button", {
      name: "Создать закупочный заказ",
      exact: true,
    }),
  });
  await form
    .getByRole("combobox", { name: "Склад", exact: true })
    .selectOption(warehouse);
  await form.getByLabel("Бюджет KZT", { exact: true }).fill("150");
  await form
    .getByLabel("Основание / комментарий", { exact: true })
    .fill("Для тестового магазина");
  await form
    .getByRole("button", { name: "Создать закупочный заказ", exact: true })
    .click();
  for (const kind of ["submit", "approve", "sent"]) {
    form = page.locator("form").filter({
      has: page.getByRole("button", {
        name: "Изменить состояние",
        exact: true,
      }),
    });
    await form
      .getByRole("combobox", { name: "Действие", exact: true })
      .selectOption(kind);
    await form
      .getByLabel("Основание / комментарий", { exact: true })
      .fill("Проверено вручную");
    await form
      .getByRole("button", { name: "Изменить состояние", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: new RegExp(
          kind === "submit"
            ? "На согласовании"
            : kind === "approve"
              ? "Одобрено"
              : "Отправлено вручную",
        ),
      }),
    ).toBeVisible();
  }
  const order = (await get(`${base}/purchases`)).items[0];
  form = page.locator("form").filter({
    has: page.getByRole("button", {
      name: "Загрузить и распознать",
      exact: true,
    }),
  });
  await form.locator('input[type="file"]').setInputFiles({
    name: "invoice.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "name,qty,unit,price,total\nЧай упаковка,12,pc,11,132\nДоставка,1,service,12,12",
    ),
  });
  await form
    .getByRole("button", { name: "Загрузить и распознать", exact: true })
    .click();
  await expect(
    page.getByText("Распознанный текст", { exact: true }),
  ).toBeVisible();
  expect(
    (await get(`${base}/inventory/balances?warehouseId=${warehouse}`)).items,
  ).toHaveLength(0);
  form = page.locator("form").filter({
    has: page.getByRole("button", {
      name: "Сохранить проверку документа",
      exact: true,
    }),
  });
  await form.getByLabel("Номер документа", { exact: true }).fill("TEST-144");
  await form.getByLabel("Дата документа", { exact: true }).fill("2026-10-14");
  await form.getByLabel("Срок оплаты", { exact: true }).fill("2026-10-20");
  await form.getByLabel("Количество в документе", { exact: true }).fill("12");
  await form
    .getByLabel("Цена за эту единицу, включая налоги, KZT", { exact: true })
    .fill("11");
  await form.getByLabel("Доставка, KZT", { exact: true }).fill("12");
  await form.getByLabel("Итог по оригиналу, KZT", { exact: true }).fill("144");
  await form
    .getByLabel("Основание / комментарий", { exact: true })
    .fill("Цена уточнена по оригиналу");
  await form
    .getByRole("button", { name: "Сохранить проверку документа", exact: true })
    .click();
  await expect(
    page.getByText("Расхождения с заказом", { exact: true }),
  ).toBeVisible();
  expect((await get(`${base}/finance/obligations`)).items).toHaveLength(0);
  await form
    .getByRole("combobox", { name: "Результат проверки", exact: true })
    .selectOption("review");
  await form
    .getByLabel("Основание / комментарий", { exact: true })
    .fill("Расхождения согласованы");
  await form.getByRole("checkbox", { name: /Проверены расхождения/ }).check();
  await form
    .getByRole("button", { name: "Сохранить проверку документа", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Подтвердить фактическую приёмку",
      exact: true,
    }),
  ).toBeVisible();
  form = page.locator("form").filter({
    has: page.getByRole("button", {
      name: "Подтвердить фактическую приёмку",
      exact: true,
    }),
  });
  await form.getByLabel(/Принято сейчас/).fill("6");
  await form
    .getByLabel("Основание / комментарий", { exact: true })
    .fill("Приняты шесть единиц");
  await form
    .getByRole("button", {
      name: "Подтвердить фактическую приёмку",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: /Закупка.*Частично принято/ }),
  ).toBeVisible();
  expect((await get(`${base}/purchases/${order.id}`)).lines[0].received).toBe(
    "6.000000",
  );
  expect((await get(`${base}/finance/obligations`)).items[0]).toMatchObject({
    amount_minor: "14400",
    purchase_order_id: order.id,
  });
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({
    path: "docs/evidence/purchasing-desktop-ru.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "ҚАЗ", exact: true }).click();
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.screenshot({
    path: "docs/evidence/purchasing-mobile-kk.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
