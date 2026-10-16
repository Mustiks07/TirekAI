import { test, expect } from "@playwright/test";
import { randomUUID as key } from "node:crypto";
test("T051: live refresh keeps the draft version and refuses a stale estimate", async ({
  page,
}) => {
  const post = async (path: string, data: unknown) => {
    const r = await page.request.post(`/api/v1/${path}`, {
      headers: { origin: "http://127.0.0.1:3100" },
      data,
    });
    expect(r.ok()).toBe(true);
    return (await r.json()).data;
  };
  const get = async (path: string) =>
    (await (await page.request.get(`/api/v1/${path}`)).json()).data;
  await post("auth/register", {
    name: "Review synthetic",
    email: `review-${key()}@example.test`,
    password: "Review-Browser-661!",
  });
  const org = (
    await post("organizations", {
      name: "Review construction",
      profile: "construction",
    })
  ).id;
  const base = `organizations/${org}`,
    branch = (await get(base)).branches[0].id;
  const warehouse = (
    await post(`${base}/warehouses`, {
      branchId: branch,
      name: "Review warehouse",
    })
  ).id;
  const item = async (kind: string) =>
    (
      await post(`${base}/catalog`, {
        sku: key(),
        name_ru: "Review " + kind,
        kind,
        base_unit: "pc",
        purchase_price: "10",
        sale_price: "100",
      })
    ).id;
  const material = await item("goods"),
    service = await item("service");
  const customer = (
    await post(`${base}/crm/customers`, {
      key: key(),
      branchId: branch,
      name: "Synthetic customer",
      email: "",
      phone: "",
      kind: "person",
      responsibleId: null,
      consents: { email: false, sms: false, messenger: false },
      consentNote: "Synthetic",
    })
  ).id;
  const id = (
    await post(`${base}/industry/commands`, {
      key: key(),
      kind: "construction",
      branchId: branch,
      title: "Review object",
      customerId: customer,
      warehouseId: warehouse,
      billingItemId: service,
      budget: "1000",
      lines: [{ itemId: material, quantity: "1", unit: "pc", price: "100" }],
      stages: ["Stage one"],
      note: "Synthetic",
    })
  ).id;
  await page.goto("/");
  await page.getByRole("button", { name: "РУС", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Работа по профилю", exact: true })
    .click();
  await page
    .locator(".industry-card")
    .filter({ hasText: "Review object" })
    .click();
  const action = "Изменить смету / допобъём";
  await page.getByRole("button", { name: action, exact: true }).click();
  const form = page.getByRole("form", { name: action, exact: true });
  await form.locator('[name="estimate-price-0"]').fill("110");
  await form
    .getByLabel("Основание / подтверждение", { exact: true })
    .fill("Local draft from version one");
  const detail = await get(`${base}/industry/${id}`);
  const refreshed = page.waitForResponse(
    async (r) =>
      r.url().endsWith(`/industry/${id}`) &&
      r.ok() &&
      (await r.json()).data?.document?.version === 2,
  );
  await post(`${base}/industry/commands`, {
    key: key(),
    kind: "construction_revise",
    id,
    version: detail.document.version,
    budget: "2000",
    lines: [{ itemId: material, quantity: "1", unit: "pc", price: "200" }],
    stages: ["Stage one"],
    note: "Concurrent change",
  });
  await refreshed;
  await expect(form.locator('[name="estimate-price-0"]')).toHaveValue("110");
  const rejected = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && r.url().endsWith("/industry/commands"),
  );
  const sent = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/industry/commands"),
  );
  await form.getByRole("button", { name: action, exact: true }).click();
  const request = await sent;
  expect(request.postDataJSON().version).toBe(1);
  expect((await rejected).status()).toBe(409);
  await expect(form).toBeVisible();
  const after = await get(`${base}/industry/${id}`);
  expect(after.document.version).toBe(2);
  expect(after.document.data.lines[0].price).toBe("200");
  await expect(form.locator('[name="estimate-price-0"]')).toHaveValue("110");
  const latest = page.waitForResponse(
    (r) => r.url().endsWith(`/industry/${id}`) && r.ok(),
  );
  await form.getByRole("button", { name: "Закрыть", exact: true }).click();
  await latest;
  await page.getByRole("button", { name: action, exact: true }).click();
  await expect(form.locator('[name="estimate-price-0"]')).toHaveValue("200");
});
