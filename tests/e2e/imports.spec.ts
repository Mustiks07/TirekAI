import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
test("customer CSV preview, durable import, replay, editing and mobile KK", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = "http://127.0.0.1:3100";
  expect(
    (
      await page.request.post("/api/v1/auth/register", {
        headers: { origin },
        data: {
          name: "Тест клиентов",
          email: `csv-${randomUUID()}@example.test`,
          password: "Browser-Synthetic-Import-448!",
        },
      })
    ).ok(),
  ).toBe(true);
  const response = await page.request.post("/api/v1/organizations", {
    headers: { origin },
    data: { name: "Taraz Clients", profile: "services" },
  });
  expect(response.ok()).toBe(true);
  const org = (await response.json()).data.id;
  await page.goto("/");
  await page.getByRole("button", { name: "РУС", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Клиенты", exact: true })
    .click();
  await expect(
    page.getByText("Клиентов пока нет", { exact: true }),
  ).toBeVisible();
  const content =
    "external_id,name,email,phone\nC1,Айдана Тест,aidana@example.test,+77010000001\nC2,Данияр Тест,daniyar@example.test,\nC2,Данияр Тест,daniyar@example.test,\nC3,Ошибка,invalid,123\n";
  await page
    .getByLabel("Файл CSV / TSV")
    .setInputFiles({
      name: "clients.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(content),
    });
  await page
    .getByRole("button", { name: "Проверить файл", exact: true })
    .click();
  const preview = page.getByRole("region", {
    name: "Предпросмотр",
    exact: true,
  });
  await expect(
    preview.getByText("Неверная почта", { exact: true }),
  ).toBeVisible();
  await expect(
    preview.getByText("Повтор строки в файле", { exact: true }),
  ).toBeVisible();
  expect(
    (
      await (
        await page.request.get(`/api/v1/organizations/${org}/customers`)
      ).json()
    ).data.pagination.total,
  ).toBe(0);
  await preview
    .getByRole("button", {
      name: "Импортировать корректные строки · 2",
      exact: true,
    })
    .click();
  await expect(
    preview.getByText("Завершено с ошибками", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".customer-card")).toHaveCount(2);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "docs/evidence/import-desktop-ru.png",
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page
    .getByRole("button", { name: "Проверить файл", exact: true })
    .click();
  await expect(
    page.getByText("Этот файл уже загружен.", { exact: false }),
  ).toBeVisible();
  expect(
    (
      await (
        await page.request.get(`/api/v1/organizations/${org}/customers`)
      ).json()
    ).data.pagination.total,
  ).toBe(2);
  await page
    .getByRole("button", { name: "Изменить: Айдана Тест", exact: true })
    .click();
  await page
    .getByLabel("Имя клиента", { exact: true })
    .fill("Айдана Обновлённая");
  await page
    .getByRole("button", { name: "Сохранить клиента", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Айдана Обновлённая", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "ҚАЗ", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Клиенттер.", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "docs/evidence/import-mobile-kk.png",
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
  expect((await page.request.post("/api/internal/worker")).status()).toBe(404);
  expect(
    (
      await page.request.post("/api/internal/worker", {
        headers: { authorization: `Bearer ${"a".repeat(64)}` },
      })
    ).status(),
  ).toBe(404);
  expect(errors).toEqual([]);
});
