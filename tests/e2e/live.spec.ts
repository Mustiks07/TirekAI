import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { randomUUID } from "node:crypto";

// T051: after an internal operation completes, another person's open screen shows it within the
// 3-second target (SPECIFICATION §21) without pressing "refresh". Measured in the browser.
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
test("open orders and stock screens of another user update within 3 s after a committed change", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  const owner = client(page.request);
  await owner.post("auth/register", {
    name: "Собственник",
    email: `live-${randomUUID()}@example.test`,
    password: "Browser-Synthetic-Live-661!",
  });
  const org = (
    await owner.post("organizations", { name: "Live Taraz", profile: "retail" })
  ).id;
  const base = `organizations/${org}`;
  const branch = (await owner.get(base)).branches[0].id;
  const warehouse = (
    await owner.post(`${base}/warehouses`, { branchId: branch, name: "Склад" })
  ).id;
  const item = (
    await owner.post(`${base}/catalog`, {
      sku: "LIVE-1",
      name_ru: "Живой товар",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "10",
      sale_price: "20",
    })
  ).id;
  await owner.post(`${base}/stock-commands`, {
    key: randomUUID(),
    kind: "receipt",
    warehouseId: warehouse,
    itemId: item,
    quantity: "5",
    unit: "pc",
    unitCost: "10",
    note: "Начальный остаток",
  });
  const customer = (
    await owner.post(`${base}/crm/customers`, {
      key: randomUUID(),
      branchId: branch,
      name: "Клиент Обновление",
      email: "",
      phone: "",
      kind: "person",
      responsibleId: null,
      consents: { email: false, sms: false, messenger: false },
      consentNote: "Тестовые данные",
    })
  ).id;
  const email = `live-manager-${randomUUID()}@example.test`;
  const invite = await owner.post(`${base}/invitations`, {
    email,
    role: "manager",
    branchId: branch,
  });
  const context = await browser.newContext({ baseURL: origin });
  const screen = await context.newPage();
  screen.on("pageerror", (e) => errors.push(e.message));
  const m = client(screen.request);
  await m.post("auth/register", {
    name: "Управляющий",
    email,
    password: "Browser-Synthetic-Live-662!",
  });
  await m.post("invitations/accept", { token: invite.token });
  await screen.goto("/");
  await screen.getByRole("button", { name: "РУС", exact: true }).click();
  await nav(screen, "Заказы");
  await expect(screen.getByText(/Клиент Обновление/)).toHaveCount(0);
  // Another person creates an order; the open screen is not touched.
  const t0 = Date.now();
  const order = await owner.post(`${base}/orders`, {
    key: randomUUID(),
    branchId: branch,
    customerId: customer,
    warehouseId: warehouse,
    dueDate: "2026-12-31",
    delivery: "pickup",
    note: "Проверка обновления",
    taxMode: "excluded",
    lines: [
      { itemId: item, quantity: "2", unit: "pc", price: "20", discount: "0" },
    ],
  });
  await expect(screen.getByText(/Клиент Обновление/).first()).toBeVisible({
    timeout: 3000,
  });
  const orderMs = Date.now() - t0;
  // Stock screen: a reservation by someone else changes the available quantity.
  await nav(screen, "Склад");
  const card = screen
    .getByRole("article")
    .filter({ hasText: "LIVE-1" })
    .filter({ hasText: "В резерве" });
  await expect(card).toContainText(/В резерве\s*0/);
  const t1 = Date.now();
  await owner.post(`${base}/orders/${order.id}/commands`, {
    key: randomUUID(),
    version: 1,
    kind: "confirm",
    note: "Резерв",
  });
  await expect(card).toContainText(/В резерве\s*2/, { timeout: 3000 });
  const stockMs = Date.now() - t1;
  test.info().annotations.push({
    type: "T051 update latency",
    description: `orders ${orderMs} ms, stock ${stockMs} ms (target ≤ 3000 ms)`,
  });
  console.log(`T051 update latency: orders ${orderMs} ms, stock ${stockMs} ms`);
  expect(orderMs).toBeLessThanOrEqual(3000);
  expect(stockMs).toBeLessThanOrEqual(3000);
  expect(errors).toEqual([]);
  await context.close();
});
test("T053: health check reports database, schema and worker state without any organization data", async ({
  request,
}) => {
  const r = await request.get("/api/health");
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body).toMatchObject({
    database: "ok",
    schema: "ok",
    pendingMigrations: 0,
  });
  expect(Object.keys(body).sort()).toEqual(
    [
      "database",
      "migration",
      "pendingMigrations",
      "schema",
      "status",
      "worker",
      "workerHeartbeatAgeSeconds",
    ].sort(),
  );
  expect(r.headers()["cache-control"]).toBe("no-store");
});
