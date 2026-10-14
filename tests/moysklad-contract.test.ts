import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { InventoryService } from "../src/server/inventory/service";
import { InsightService } from "../src/server/decisions/insights";
import { IntegrationService } from "../src/server/integrations/service";
import { entityIdFromHref } from "../src/server/integrations/moysklad";

// Local contract server built from the documented shapes of MoySklad JSON API 1.2
// (Bearer auth, mandatory gzip, limit/offset paging with meta.size, expand only ≤ 100,
// 429 with X-Lognex-Retry-After, errors[] bodies, short stock report). Not a live account.
const TOKEN = "contract-token-0123456789abcdef";
type P = {
  id: string;
  name: string;
  code: string;
  updated: string;
  archived: boolean;
  uom: string;
};
const state = {
  products: [] as P[],
  stock: [] as {
    assortmentId: string;
    storeId: string | null;
    stock: number;
  }[],
  failOnce: { rate: false, server: false },
  requests: [] as string[],
  webhooks: [] as unknown[],
};
const store = randomUUID();
let server: Server, base: string;
function send(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const data = gzipSync(Buffer.from(JSON.stringify(body)));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Encoding": "gzip",
    ...headers,
  });
  res.end(data);
}
const product = (p: P) => ({
  id: p.id,
  meta: { href: `${base}/entity/product/${p.id}`, type: "product" },
  updated: p.updated,
  name: p.name,
  code: p.code,
  externalCode: `ext-${p.code}`,
  archived: p.archived,
  uom: { name: p.uom === "796" ? "шт" : "?", code: p.uom },
});
let db: Database,
  p: Platform,
  org: string,
  branch: string,
  owner: string,
  manager: string,
  seller: string,
  svc: IntegrationService;
const key = () => randomUUID();
beforeAll(async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://x");
    state.requests.push(`${req.method} ${url.pathname}${url.search}`);
    if (req.headers["accept-encoding"] !== "gzip")
      return void res.writeHead(415).end();
    if (req.headers.authorization !== `Bearer ${TOKEN}`)
      return send(res, 401, {
        errors: [{ error: "Ошибка аутентификации", code: 1056 }],
      });
    if (state.failOnce.rate) {
      state.failOnce.rate = false;
      return send(
        res,
        429,
        {
          errors: [
            {
              error: "Превышено ограничение на количество запросов",
              code: 1049,
            },
          ],
        },
        { "X-Lognex-Retry-After": "5" },
      );
    }
    if (state.failOnce.server) {
      state.failOnce.server = false;
      return send(res, 503, {
        errors: [{ error: "Сервис временно отключен" }],
      });
    }
    const path = url.pathname.replace("/api/remap/1.2", "");
    if (path === "/context/employee")
      return send(res, 200, {
        id: randomUUID(),
        name: "Контрактный сотрудник",
      });
    if (path === "/entity/store")
      return send(res, 200, {
        meta: { size: 1, limit: 1000, offset: 0 },
        rows: [
          {
            id: store,
            name: "Основной склад",
            archived: false,
            updated: "2026-10-01 10:00:00",
          },
        ],
      });
    if (path === "/entity/product") {
      const limit = Number(url.searchParams.get("limit")),
        offset = Number(url.searchParams.get("offset"));
      if (url.searchParams.get("expand") && limit > 100)
        return send(res, 412, {
          errors: [{ error: "expand with limit > 100" }],
        });
      const from = (url.searchParams.get("filter") || "").replace(
        "updated>=",
        "",
      );
      const rows = state.products
        .filter((x) => !from || x.updated >= from)
        .sort((a, b) => a.updated.localeCompare(b.updated));
      return send(res, 200, {
        meta: { size: rows.length, limit, offset },
        rows: rows.slice(offset, offset + limit).map(product),
      });
    }
    const one = /^\/entity\/product\/([0-9a-f-]{36})$/.exec(path);
    if (one) {
      const x = state.products.find((y) => y.id === one[1]);
      return x
        ? send(res, 200, product(x))
        : send(res, 404, { errors: [{ error: "Объект не найден" }] });
    }
    if (path === "/report/stock/bystore/current")
      return send(res, 200, state.stock);
    if (path === "/entity/webhook" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        state.webhooks.push(JSON.parse(raw));
        send(res, 200, { id: randomUUID() });
      });
      return;
    }
    send(res, 404, { errors: [{ error: "not found" }] });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/remap/1.2`;
  for (let i = 0; i < 150; i++)
    state.products.push({
      id: randomUUID(),
      name: `Товар ${i}`,
      code: `MS-${i}`,
      updated: `2026-10-01 10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
      archived: false,
      uom: i === 7 ? "999" : "796",
    });
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  const user = () =>
    p.register({
      name: "MS",
      email: `${key()}@example.test`,
      password: "Synthetic-MoySklad-661!",
    });
  owner = (await user()).token;
  org = (
    await p.createOrganization(owner, { name: "MS Lab", profile: "retail" })
  ).id;
  branch = (await p.workspace(owner, org)).branches[0].id;
  for (const role of ["manager", "sales"]) {
    const u = await user(),
      inv = await p.invite(owner, org, {
        email: u.user.email,
        role,
        branchId: branch,
      });
    await p.acceptInvitation(u.token, { token: inv.token });
    if (role === "manager") manager = u.token;
    else seller = u.token;
  }
  // A local SKU equal to an external code must not be merged silently.
  await new InventoryService(db).saveItem(owner, org, {
    sku: "MS-3",
    name_ru: "Локальный",
    kind: "goods",
    base_unit: "pc",
    purchase_price: "1",
    sale_price: "2",
  });
  svc = IntegrationService.forContractServer(db, base, fetch, async () => {});
});
afterAll(async () => {
  await db?.close();
  await new Promise((r) => server.close(r));
});
let connection: string, webhookToken: string;
it("T029: credentials are encrypted at rest, only the owner configures, and a contract server never marks a live account as verified", async () => {
  await expect(
    svc.configure(manager, org, {
      key: key(),
      provider: "moysklad",
      token: TOKEN,
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(svc.overview(seller, org)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  const saved = await svc.configure(owner, org, {
    key: key(),
    provider: "moysklad",
    token: TOKEN,
  });
  connection = saved.id;
  webhookToken = saved.webhookToken!;
  const [row] = await db.query<{
    credentials: Uint8Array;
    credentials_hint: string;
    webhook_token_hash: string;
  }>(
    "SELECT credentials,credentials_hint,webhook_token_hash FROM integration_connections WHERE id=$1",
    [connection],
  );
  expect(Buffer.from(row.credentials).toString("utf8")).not.toContain(TOKEN);
  expect(row.credentials_hint).toBe("…cdef");
  expect(row.webhook_token_hash).not.toBe(webhookToken);
  await svc.check(owner, org, connection);
  const o = await svc.overview(manager, org);
  expect(o.connections[0]).toMatchObject({
    status: "configured",
    verification: { scope: "contract_server" },
  });
  expect(
    o.passports[0].operations.find((x) => x.id === "supply_create"),
  ).toMatchObject({ implementation: "planned" });
  expect(
    state.requests.every((r) => r.startsWith("GET") || r.startsWith("POST")),
  ).toBe(true);
});
it("T030: initial import pages, retries 429/5xx, maps units, records conflicts and is idempotent on rerun", async () => {
  state.failOnce.rate = true;
  state.failOnce.server = true;
  const r = await svc.syncNow(owner, org, connection);
  expect(r.products).toMatchObject({ created: 148, conflicts: 2 });
  const pages = state.requests.filter((x) => x.includes("/entity/product?"));
  expect(pages.some((x) => x.includes("offset=100"))).toBe(true);
  const conflicts = await db.query<{ reason: string }>(
    "SELECT reason FROM sync_conflicts WHERE connection_id=$1 ORDER BY reason",
    [connection],
  );
  expect(conflicts.map((c) => c.reason)).toEqual([
    "sku_exists",
    "unit_unmapped",
  ]);
  const again = await svc.syncNow(owner, org, connection);
  expect(again.products.created || 0).toBe(0);
  expect(
    await db.query(
      "SELECT id FROM catalog_items WHERE organization_id=$1 AND category='МойСклад'",
      [org],
    ),
  ).toHaveLength(148);
  expect(
    (
      await db.query(
        "SELECT id FROM sync_conflicts WHERE connection_id=$1 AND state='open'",
        [connection],
      )
    ).length,
  ).toBe(2);
});
it("T030: a local edit is not overwritten by a later remote change until a person resolves the conflict", async () => {
  const [m] = await db.query<{ internal_id: string; external_id: string }>(
    "SELECT internal_id,external_id FROM integration_mappings WHERE connection_id=$1 AND entity_type='product' LIMIT 1",
    [connection],
  );
  const inv = new InventoryService(db);
  const [item] = await db.query<{ version: number }>(
    "SELECT version FROM catalog_items WHERE id=$1",
    [m.internal_id],
  );
  await db.transaction((tx) =>
    inv.updateItemFields(tx, owner, org, m.internal_id, item.version, {
      name_ru: "Локальное имя",
    }),
  );
  const remote = state.products.find((x) => x.id === m.external_id)!;
  remote.name = "Новое имя МойСклад";
  remote.updated = "2026-10-02 09:00:00";
  await svc.syncNow(owner, org, connection);
  const [kept] = await db.query<{ name_ru: string }>(
    "SELECT name_ru FROM catalog_items WHERE id=$1",
    [m.internal_id],
  );
  expect(kept.name_ru).toBe("Локальное имя");
  const [c] = await db.query<{ id: string }>(
    "SELECT id FROM sync_conflicts WHERE connection_id=$1 AND reason='local_modified' AND state='open'",
    [connection],
  );
  await svc.resolve(owner, org, c.id, { key: key(), decision: "took_remote" });
  const [taken] = await db.query<{ name_ru: string }>(
    "SELECT name_ru FROM catalog_items WHERE id=$1",
    [m.internal_id],
  );
  expect(taken.name_ru).toBe("Новое имя МойСклад");
});
it("T030: a linked warehouse mirrors external stock, rejects local ledger commands and feeds situations", async () => {
  const inv = new InventoryService(db);
  const used = (
    await inv.createWarehouse(owner, org, {
      branchId: branch,
      name: "С журналом",
    })
  ).id;
  const [local] = await db.query<{ id: string }>(
    "SELECT id FROM catalog_items WHERE organization_id=$1 AND sku='MS-3'",
    [org],
  );
  await inv.execute(owner, org, {
    key: key(),
    kind: "receipt",
    warehouseId: used,
    itemId: local.id,
    quantity: "1",
    unit: "pc",
    unitCost: "1",
    note: "Локальный приход",
  });
  await expect(
    svc.link(owner, org, connection, { warehouseId: used, storeId: store }),
  ).rejects.toMatchObject({ code: "WAREHOUSE_HAS_LEDGER" });
  const mirror = (
    await inv.createWarehouse(owner, org, {
      branchId: branch,
      name: "Зеркало МойСклад",
    })
  ).id;
  await svc.link(owner, org, connection, {
    warehouseId: mirror,
    storeId: store,
  });
  const [m] = await db.query<{ internal_id: string; external_id: string }>(
    "SELECT internal_id,external_id FROM integration_mappings WHERE connection_id=$1 ORDER BY external_id LIMIT 1",
    [connection],
  );
  state.stock = [
    { assortmentId: m.external_id, storeId: store, stock: 2 },
    { assortmentId: randomUUID(), storeId: store, stock: 5 },
    { assortmentId: m.external_id, storeId: null, stock: -1 },
  ];
  await db.query("DELETE FROM sync_runs WHERE connection_id=$1", [connection]);
  const r = await svc.syncNow(owner, org, connection);
  expect(r.stock).toMatchObject({ mirrored: 1, unmapped: 1, other_stores: 1 });
  await expect(
    inv.execute(owner, org, {
      key: key(),
      kind: "receipt",
      warehouseId: mirror,
      itemId: m.internal_id,
      quantity: "1",
      unit: "pc",
      unitCost: "1",
      note: "Двойной приход",
    }),
  ).rejects.toMatchObject({ code: "EXTERNAL_SOURCE_OF_TRUTH" });
  const ins = new InsightService(db);
  await ins.setReorderPoint(owner, org, {
    warehouseId: mirror,
    itemId: m.internal_id,
    minimum: "5",
    safety: "0",
    leadDays: 1,
    version: 0,
  });
  await ins.detect(org);
  const list = await ins.list(owner, org, { rule: "low_stock" });
  const insight = (
    list.items as {
      evidence: { facts: Record<string, unknown>; sources: { type: string }[] };
    }[]
  )[0];
  expect(insight.evidence.facts).toMatchObject({
    on_hand: "2",
    stock_source: "moysklad",
    stock_stale: "no",
  });
  expect(insight.evidence.sources[0].type).toBe("external_stock");
});
it("T030: webhooks need the secret URL token, deduplicate requestId and re-read the entity by id only", async () => {
  const target = state.products[20];
  const event = {
    events: [
      {
        meta: {
          type: "product",
          href: `https://evil.example/api/remap/1.2/entity/product/${target.id}`,
        },
        action: "UPDATE",
        accountId: randomUUID(),
      },
    ],
  };
  await expect(
    svc.receiveWebhook(connection, "0".repeat(64), "req-00000001", event),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(
    await svc.receiveWebhook(connection, webhookToken, "req-00000001", event),
  ).toEqual({ accepted: true, duplicate: false });
  expect(
    await svc.receiveWebhook(connection, webhookToken, "req-00000001", event),
  ).toEqual({ accepted: true, duplicate: true });
  target.name = "Обновлено вебхуком";
  target.updated = "2026-10-03 12:00:00";
  const before = state.requests.length;
  expect(await svc.processInbox()).toBe(1);
  expect(
    state.requests
      .slice(before)
      .filter((r) => r.includes(`/entity/product/${target.id}`)),
  ).toHaveLength(1);
  const [item] = await db.query<{ name_ru: string }>(
    "SELECT c.name_ru FROM catalog_items c JOIN integration_mappings m ON m.internal_id=c.id WHERE m.external_id=$1",
    [target.id],
  );
  expect(item.name_ru).toBe("Обновлено вебхуком");
  expect(await svc.processInbox()).toBe(0);
  await svc.receiveWebhook(connection, webhookToken, "req-00000002", {
    events: [{ ...event.events[0], action: "DELETE" }],
  });
  await svc.processInbox();
  const [archived] = await db.query<{ active: boolean }>(
    "SELECT c.active FROM catalog_items c JOIN integration_mappings m ON m.internal_id=c.id WHERE m.external_id=$1",
    [target.id],
  );
  expect(archived.active).toBe(false);
  expect(
    entityIdFromHref(
      "https://x/api/remap/1.2/entity/store/" + target.id,
      "product",
    ),
  ).toBeNull();
});
it("T029: auth failures degrade the connection visibly; disconnect erases credentials", async () => {
  const bad = await svc.configure(owner, org, {
    key: key(),
    provider: "moysklad",
    token: "wrong-token-000000000",
  });
  await expect(svc.check(owner, org, bad.id)).rejects.toMatchObject({
    code: "MOYSKLAD_AUTH_FAILED",
  });
  let o = await svc.overview(owner, org);
  expect(o.connections[0]).toMatchObject({
    status: "degraded",
    last_error_code: "MOYSKLAD_AUTH_FAILED",
  });
  expect(o.runs[0]).toMatchObject({
    state: "failed",
    error_code: "MOYSKLAD_AUTH_FAILED",
  });
  await svc.disconnect(owner, org, bad.id);
  const [row] = await db.query<{ credentials: unknown; status: string }>(
    "SELECT credentials,status FROM integration_connections WHERE id=$1",
    [bad.id],
  );
  expect(row).toEqual({ credentials: null, status: "disconnected" });
  await expect(svc.syncNow(owner, org, bad.id)).rejects.toMatchObject({
    code: "INTEGRATION_NOT_CONFIGURED",
  });
  o = await svc.overview(owner, org);
  expect(
    o.connections.find((c) => c.id === bad.id),
  ).toMatchObject({ status: "disconnected" });
});
