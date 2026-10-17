import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
test("catalogue, converted receipt, reservation, issue, return, transfer and mobile", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = "http://127.0.0.1:3100";
  await page.request.post("/api/v1/auth/register", {
    headers: { origin },
    data: {
      name: "Склад тест",
      email: `stock-${randomUUID()}@example.test`,
      password: "Browser-Synthetic-Stock-491!",
    },
  });
  const org = (
    await (
      await page.request.post("/api/v1/organizations", {
        headers: { origin },
        data: { name: "Taraz Stock", profile: "retail" },
      })
    ).json()
  ).data.id;
  await page.goto("/");
  await page.getByRole("button", { name: "РУС", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Склад", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Добавить склад", exact: true })
    .click();
  await page
    .getByLabel("Название склада", { exact: true })
    .fill("Склад на Абая");
  await page
    .getByRole("button", { name: "Создать склад", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Добавить позицию", exact: true })
    .click();
  const editor = page.locator(".catalog-editor");
  await editor.getByLabel("Артикул (SKU)", { exact: true }).fill("TEA-001");
  await editor
    .getByLabel("Название на русском", { exact: true })
    .fill("Чай листовой");
  await editor
    .getByLabel("Название на казахском", { exact: true })
    .fill("Жапырақты шай");
  await editor.getByLabel("Категория", { exact: true }).fill("Напитки");
  await editor
    .getByLabel("Базовая единица", { exact: true })
    .selectOption("kg");
  await editor.getByLabel("Закупочная цена, ₸", { exact: true }).fill("500");
  await editor.getByLabel("Цена продажи, ₸", { exact: true }).fill("850");
  await editor
    .getByLabel("Другие единицы", { exact: false })
    .fill("bag=2\ng=0.001");
  await editor
    .getByRole("button", { name: "Сохранить позицию", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Чай листовой", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Операция: Чай листовой", exact: true })
    .click();
  let form = page.getByRole("region", { name: "Операция", exact: true });
  await form.getByLabel("Количество", { exact: true }).fill("2");
  await form.getByLabel("Единица", { exact: true }).selectOption("bag");
  await form
    .getByLabel("Стоимость выбранной единицы, ₸", { exact: true })
    .fill("1000");
  await form
    .getByLabel("Основание операции", { exact: true })
    .fill("Приёмка по тестовой накладной");
  await form
    .getByRole("button", { name: "Провести операцию", exact: true })
    .click();
  await expect(
    page.getByText("Операция проведена", { exact: true }),
  ).toBeVisible();
  const wh = (
    await (
      await page.request.get(`/api/v1/organizations/${org}/warehouses`)
    ).json()
  ).data.items[0].id;
  const balances = () =>
    page.request
      .get(`/api/v1/organizations/${org}/inventory/balances?warehouseId=${wh}`)
      .then((r) => r.json())
      .then((r) => r.data.items[0]);
  await expect.poll(async () => (await balances()).quantity).toBe("4.000000");
  expect((await balances()).value_minor).toBe("200000");
  await page
    .getByRole("button", { name: "Операция: Чай листовой", exact: true })
    .click();
  form = page.getByRole("region", { name: "Операция", exact: true });
  await form.getByLabel("Операция", { exact: true }).selectOption("reserve");
  await form.getByLabel("Количество", { exact: true }).fill("1");
  await form
    .getByLabel("Основание операции", { exact: true })
    .fill("Резерв для тестового заказа");
  await form
    .getByRole("button", { name: "Провести операцию", exact: true })
    .click();
  await expect.poll(async () => (await balances()).available).toBe("3.000000");
  await page.getByRole("button", { name: "Резервы", exact: true }).click();
  await page
    .getByRole("button", { name: "Выдать резерв", exact: true })
    .click();
  form = page.getByRole("region", { name: "Операция", exact: true });
  await form
    .getByLabel("Основание операции", { exact: true })
    .fill("Выдача тестового заказа");
  await form
    .getByRole("button", { name: "Провести операцию", exact: true })
    .click();
  await expect.poll(async () => (await balances()).quantity).toBe("3.000000");
  await page.getByRole("button", { name: "Журнал", exact: true }).click();
  await page
    .getByRole("button", { name: "Возврат по выдаче", exact: true })
    .click();
  form = page.getByRole("region", { name: "Операция", exact: true });
  await form
    .getByLabel("Основание операции", { exact: true })
    .fill("Возврат тестового заказа");
  await form
    .getByRole("button", { name: "Провести операцию", exact: true })
    .click();
  await expect.poll(async () => (await balances()).quantity).toBe("4.000000");
  await page
    .getByRole("button", { name: "Добавить склад", exact: true })
    .click();
  await page
    .getByLabel("Название склада", { exact: true })
    .fill("Склад выдачи");
  await page
    .getByRole("button", { name: "Создать склад", exact: true })
    .click();
  const warehouses = (
    await (
      await page.request.get(`/api/v1/organizations/${org}/warehouses`)
    ).json()
  ).data.items;
  const destination = warehouses.find((w: { id: string }) => w.id !== wh).id;
  await page
    .getByRole("combobox", { name: "Склад", exact: true })
    .selectOption(wh);
  await page
    .getByRole("button", { name: "Операция: Чай листовой", exact: true })
    .click();
  form = page.getByRole("region", { name: "Операция", exact: true });
  await form.getByLabel("Операция", { exact: true }).selectOption("dispatch");
  await form.getByLabel("Количество", { exact: true }).fill("1");
  await form
    .getByLabel("Склад назначения", { exact: true })
    .selectOption(destination);
  await form
    .getByLabel("Основание операции", { exact: true })
    .fill("Перевозка на склад выдачи");
  await form
    .getByRole("button", { name: "Провести операцию", exact: true })
    .click();
  await expect.poll(async () => (await balances()).quantity).toBe("3.000000");
  await page
    .getByRole("combobox", { name: "Склад", exact: true })
    .selectOption(destination);
  await page.getByRole("button", { name: "Перемещения", exact: true }).click();
  await page
    .getByRole("button", { name: "Принять перемещение", exact: true })
    .click();
  form = page.getByRole("region", { name: "Операция", exact: true });
  await form
    .getByLabel("Основание операции", { exact: true })
    .fill("Перевозка получена полностью");
  await form
    .getByRole("button", { name: "Провести операцию", exact: true })
    .click();
  await expect(page.getByText("Принято", { exact: true })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Склад", exact: true })
    .selectOption(wh);
  await page.getByRole("button", { name: "Остатки", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "docs/evidence/inventory-desktop-ru.png",
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "ҚАЗ", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "docs/evidence/inventory-mobile-kk.png",
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  expect(errors).toEqual([]);
});
