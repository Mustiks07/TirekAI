import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";

const password = "Browser-Synthetic-Password-447!";
async function register(page: Page, email: string, name: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "РУС", exact: true }).click();
  await page.getByLabel("Ваше имя").fill(name);
  await page.getByLabel("Электронная почта", { exact: true }).fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Расскажите о вашем бизнесе" }),
  ).toBeVisible();
}
async function createOrg(page: Page, name: string) {
  await page.getByLabel("Название организации", { exact: true }).fill(name);
  await page
    .getByRole("button", { name: "Создать организацию", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Сегодня.", exact: true }),
  ).toBeVisible();
}
test("owner onboarding, branch-scoped invitation, isolation, revocation, mobile and KK/RU", async ({
  page,
  browser,
}) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  const ownerEmail = `owner-${randomUUID()}@example.test`;
  const employeeEmail = `staff-${randomUUID()}@example.test`;
  await register(page, ownerEmail, "Мустафа");
  await createOrg(page, "Taraz Market");
  await expect(
    page.getByText("Пространство создано.", { exact: false }),
  ).toBeVisible();
  const session = (await (await page.request.get("/api/v1/session")).json())
    .data;
  const orgId = session.organizations[0].id;
  const cookie = (await page.context().cookies()).find(
    (c) => c.name === "smb_session",
  );
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
  await page.screenshot({
    path: "docs/evidence/desktop-ru.png",
    fullPage: true,
  });
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Организация", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Добавить филиал", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Название филиала")
    .fill("Точка на Абая");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Добавить филиал", exact: true })
    .click();
  await expect(page.getByText("Точка на Абая", { exact: true })).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Команда", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Пригласить сотрудника", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Пригласить сотрудника", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Электронная почта", { exact: true })
    .fill(employeeEmail);
  await dialog.getByLabel("Роль", { exact: true }).selectOption("employee");
  await dialog
    .getByLabel("Область доступа", { exact: true })
    .selectOption({ label: "Точка на Абая" });
  await dialog
    .getByRole("button", { name: "Создать ссылку", exact: true })
    .click();
  const inviteLink = await dialog.getByLabel("Ссылка-приглашение").inputValue();
  await expect(
    dialog.getByText("Письмо не отправлялось.", { exact: false }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  const employeeContext = await browser.newContext({
    baseURL: "http://127.0.0.1:3100",
  });
  const employee = await employeeContext.newPage();
  await register(employee, employeeEmail, "Айдана");
  // An account without organizations can accept a link without creating its own business.
  await employee.goto(inviteLink);
  await employee
    .getByRole("button", { name: "Принять приглашение", exact: true })
    .click();
  await expect(
    employee.getByRole("heading", { name: "Сегодня.", exact: true }),
  ).toBeVisible();
  await employee
    .getByRole("navigation")
    .getByRole("button", { name: "Команда", exact: true })
    .click();
  await expect(
    employee.getByText(employeeEmail, { exact: true }),
  ).toBeVisible();
  await expect(employee.getByText(ownerEmail, { exact: true })).toHaveCount(0);
  await expect(
    employee.getByRole("button", {
      name: "Пригласить сотрудника",
      exact: true,
    }),
  ).toHaveCount(0);
  const forged = await employee.request.patch(
    `/api/v1/organizations/${orgId}`,
    {
      headers: { Origin: "http://127.0.0.1:3100" },
      data: { name: "Unauthorized", profile: "retail" },
    },
  );
  expect(forged.status()).toBe(403);
  const hostile = await page.request.post("/api/v1/organizations", {
    headers: { Origin: "https://untrusted.example" },
    data: { name: "Hostile", profile: "retail" },
  });
  expect(hostile.status()).toBe(403);
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(
    page.getByText(employeeEmail, { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Исключить", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Отозвать доступ", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const revoked = (await (await employee.request.get("/api/v1/session")).json())
    .data;
  expect(revoked.user).toBeNull();
  // Independent owner and organization cannot read this owner's workspace.
  await employeeContext.clearCookies();
  await register(
    employee,
    `outsider-${randomUUID()}@example.test`,
    "Другой собственник",
  );
  await createOrg(employee, "Alatau Store");
  expect(
    (await employee.request.get(`/api/v1/organizations/${orgId}`)).status(),
  ).toBe(403);
  await employeeContext.close();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Сегодня", exact: true })
    .click();
  const violations = (
    await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze()
  ).violations;
  expect(violations).toEqual([]);
  await page.getByRole("button", { name: "ҚАЗ", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "kk");
  await expect(
    page.getByRole("heading", { name: "Бүгін.", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/evidence/desktop-kk.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".mobile-test")).toHaveText("Сынақ деректері");
  await expect(page.locator(".date-chip")).not.toContainText(/M\d/);
  await page.screenshot({
    path: "docs/evidence/mobile-kk.png",
    fullPage: true,
  });
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Бүгін.", exact: true }),
  ).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("entry keyboard controls, validation and accessible registration", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Танысудан бастайық" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "РУС", exact: true }).click();
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.getByLabel("Электронная почта", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Пароль", { exact: true })).toBeFocused();
  await page
    .getByLabel("Электронная почта", { exact: true })
    .fill("absent@example.test");
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.locator(".error-notice")).toContainText(
    "Неверная почта или пароль",
  );
  const violations = (
    await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze()
  ).violations;
  expect(violations).toEqual([]);
  await page.setViewportSize({ width: 360, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
