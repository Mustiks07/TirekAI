import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { InventoryService } from "../src/server/inventory/service";
import { KaspiService } from "../src/server/integrations/kaspi-service";

// Local server with the shapes from the Kaspi partner guide (JSON:API, X-Auth-Token, page[number]
// from 0, page[size] ≤ 100, filter[orders][state]/[creationDate][$ge|$le] in ms, entries and
// masterproducts). Not a live merchant cabinet; no status is changed in Kaspi.
export const KASPI_TOKEN = "kaspi-synthetic-token-AAAAAAAAAAAAAAAA";
export type KOrder = {
  id: string;
  code: string;
  state: string;
  status: string;
  totalPrice: number;
  deliveryCost: number;
  creationDate: number;
  entries: {
    id: string;
    product: string;
    name: string;
    quantity: number;
    basePrice: number;
  }[];
};
export function kaspiServer(state: {
  orders: KOrder[];
  requests: string[];
  failOnce: { rate: boolean };
  posts: unknown[];
}) {
  return createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url || "/", "http://x");
      state.requests.push(
        `${req.method} ${decodeURIComponent(url.pathname + url.search)}`,
      );
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/vnd.api+json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers["x-auth-token"] !== KASPI_TOKEN)
        return send(401, { errors: [{ title: "Unauthorized" }] });
      if (req.headers["content-type"] !== "application/vnd.api+json")
        return send(415, {});
      if (state.failOnce.rate) {
        state.failOnce.rate = false;
        res.writeHead(429, { "Retry-After": "1" });
        return res.end();
      }
      const path = url.pathname.replace("/shop/api", "");
      if (path === "/v2/orders" && req.method === "GET") {
        const size = Number(url.searchParams.get("page[size]")),
          page = Number(url.searchParams.get("page[number]")),
          st = url.searchParams.get("filter[orders][state]"),
          ge = Number(
            url.searchParams.get("filter[orders][creationDate][$ge]"),
          ),
          le = Number(
            url.searchParams.get("filter[orders][creationDate][$le]"),
          );
        if (!(size >= 1 && size <= 100))
          return send(400, { errors: [{ title: "page size" }] });
        const rows = state.orders.filter(
          (o) => o.state === st && o.creationDate >= ge && o.creationDate <= le,
        );
        return send(200, {
          data: rows.slice(page * size, page * size + size).map((o) => ({
            type: "orders",
            id: o.id,
            attributes: {
              code: o.code,
              totalPrice: o.totalPrice,
              deliveryMode: "DELIVERY_PICKUP",
              paymentMode: "PAY_WITH_CREDIT",
              state: o.state,
              status: o.status,
              creationDate: o.creationDate,
              deliveryCost: o.deliveryCost,
              customer: {
                firstName: "Иван",
                lastName: "Иванов",
                cellPhone: "7000000000",
              },
            },
          })),
          meta: {
            pageCount: Math.ceil(rows.length / size),
            totalCount: rows.length,
          },
        });
      }
      if (path === "/v2/orders" && req.method === "POST") {
        const body = JSON.parse(raw);
        state.posts.push(body);
        const o = state.orders.find(
          (x) => x.id === body.data.id && x.code === body.data.attributes.code,
        );
        if (!o) return send(400, { errors: [{ title: "not found" }] });
        o.status = body.data.attributes.status;
        return send(200, {
          data: {
            type: "orders",
            id: o.id,
            attributes: { code: o.code, status: o.status },
          },
        });
      }
      const entries = /^\/v2\/orders\/([^/]+)\/entries$/.exec(path);
      if (entries) {
        const o = state.orders.find((x) => x.id === entries[1]);
        return send(200, {
          data: (o?.entries || []).map((e, i) => ({
            type: "orderentries",
            id: e.id,
            attributes: {
              unitType: "PIECES",
              quantity: e.quantity,
              totalPrice: e.basePrice * e.quantity,
              basePrice: e.basePrice,
              entryNumber: i,
              deliveryCost: 0,
            },
          })),
          included: [],
        });
      }
      const product = /^\/v2\/orderentries\/([^/]+)\/product$/.exec(path);
      if (product) {
        const e = state.orders
          .flatMap((o) => o.entries)
          .find((x) => x.id === product[1]);
        return e
          ? send(200, {
              data: {
                type: "masterproducts",
                id: `mp-${e.product}`,
                attributes: { code: e.product, name: e.name, category: "Тест" },
              },
            })
          : send(404, {});
      }
      send(404, {});
    });
  });
}
const NOW = Date.UTC(2026, 9, 15, 6, 0, 0),
  DAY = 86_400_000;
const state = {
  orders: [] as KOrder[],
  requests: [] as string[],
  failOnce: { rate: false },
  posts: [] as unknown[],
};
let server: Server,
  base: string,
  db: Database,
  p: Platform,
  org: string,
  owner: string,
  seller: string,
  svc: KaspiService,
  connection: string;
let branch: string, warehouse: string;
const key = () => randomUUID();
beforeAll(async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  server = kaspiServer(state);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/shop/api`;
  for (let i = 0; i < 130; i++)
    state.orders.push({
      id: `ord-${i}`,
      code: `${700000 + i}`,
      state: i % 3 === 0 ? "NEW" : i % 3 === 1 ? "PICKUP" : "ARCHIVE",
      status: i % 3 === 2 ? "COMPLETED" : "APPROVED_BY_BANK",
      totalPrice: i === 5 ? 1000.005 : 96045,
      deliveryCost: 1000,
      creationDate: NOW - (i % 25) * DAY - 3600_000,
      entries: [
        {
          id: `ent-${i}`,
          product: `10340${i % 4}`,
          name: `Товар Kaspi ${i % 4}`,
          quantity: 1,
          basePrice: 96045,
        },
      ],
    });
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  const user = () =>
    p.register({
      name: "Kaspi",
      email: `${key()}@example.test`,
      password: "Synthetic-Kaspi-661!",
    });
  owner = (await user()).token;
  org = (
    await p.createOrganization(owner, { name: "Kaspi Lab", profile: "retail" })
  ).id;
  branch = (await p.workspace(owner, org)).branches[0].id;
  warehouse = (
    await new InventoryService(db).createWarehouse(owner, org, {
      branchId: branch,
      name: "Склад Kaspi",
    })
  ).id;
  const u = await user(),
    inv = await p.invite(owner, org, {
      email: u.user.email,
      role: "sales",
      branchId: branch,
    });
  await p.acceptInvitation(u.token, { token: inv.token });
  seller = u.token;
  svc = KaspiService.forContractServer(db, base, fetch, () => NOW);
});
afterAll(async () => {
  await db?.close();
  await new Promise((r) => server.close(r));
});
it("T034: Kaspi token sealed, owner only, writes off by default, contract check is not live", async () => {
  await expect(
    svc.configure(seller, org, {
      key: key(),
      token: KASPI_TOKEN,
      branchId: branch,
      warehouseId: warehouse,
    }),
  ).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  connection = (
    await svc.configure(owner, org, {
      key: key(),
      token: KASPI_TOKEN,
      branchId: branch,
      warehouseId: warehouse,
    })
  ).id;
  const [row] = await db.query<{
    credentials: Uint8Array;
    settings: { writes: boolean };
  }>("SELECT credentials,settings FROM integration_connections WHERE id=$1", [
    connection,
  ]);
  expect(Buffer.from(row.credentials).toString("utf8")).not.toContain(
    KASPI_TOKEN,
  );
  expect(row.settings.writes).toBe(false);
  await svc.check(owner, org, connection);
  const [c] = await db.query<{
    status: string;
    verification: { scope: string };
  }>("SELECT status,verification FROM integration_connections WHERE id=$1", [
    connection,
  ]);
  expect(c).toMatchObject({
    status: "configured",
    verification: { scope: "contract_server" },
  });
});
it("T034: orders are read per state in ≤14-day windows and pages of 100, with exact tiyn; reruns only record status changes", async () => {
  state.failOnce.rate = true;
  const before = state.requests.length;
  const stats = await svc.syncNow(owner, org, connection);
  // 130 orders inside 30 days; order 5 has a fractional tiyn total and is skipped, not rounded.
  expect(stats).toMatchObject({ created: 129, skipped: 1 });
  const lists = state.requests.slice(before).filter((r) =>
    r.startsWith("GET /shop/api/v2/orders?"),
  );
  expect(lists.every((r) => /page\[size\]=100/.test(r))).toBe(true);
  for (const r of lists) {
    const ge = Number(/\$ge\]=(\d+)/.exec(r)![1]),
      le = Number(/\$le\]=(\d+)/.exec(r)![1]);
    expect(le - ge).toBeLessThan(14 * DAY);
  }
  const [o] = await db.query<{
    total_minor: string;
    delivery_minor: string;
    lines: { productCode: string; price_minor: string }[];
  }>(
    "SELECT total_minor::text,delivery_minor::text,lines FROM channel_orders WHERE external_id='ord-0'",
  );
  expect(o).toMatchObject({ total_minor: "9604500", delivery_minor: "100000" });
  expect(o.lines[0]).toMatchObject({
    productCode: "103400",
    price_minor: "9604500",
  });
  state.orders.find((x) => x.id === "ord-1")!.status = "COMPLETED";
  const again = await svc.syncNow(owner, org, connection);
  expect(again).toMatchObject({ updated: 1 });
  expect(again.created || 0).toBe(0);
  const [h] = await db.query<{ history: { status: string }[] }>(
    "SELECT history FROM channel_orders WHERE external_id='ord-1'",
  );
  expect(h.history.map((x) => x.status)).toEqual([
    "APPROVED_BY_BANK",
    "COMPLETED",
  ]);
  // No list or sync touched stock or money.
  expect(
    await db.query("SELECT id FROM stock_movements WHERE organization_id=$1", [
      org,
    ]),
  ).toHaveLength(0);
  expect(
    await db.query("SELECT id FROM sales_orders WHERE organization_id=$1", [
      org,
    ]),
  ).toHaveLength(0);
});
it("T034: a revoked token degrades the connection with a visible error", async () => {
  await svc.configure(owner, org, {
    key: key(),
    token: "kaspi-revoked-token-BBBBBBBBBBBBBBBB",
    branchId: branch,
    warehouseId: warehouse,
  });
  await expect(svc.check(owner, org, connection)).rejects.toMatchObject({
    code: "KASPI_AUTH_FAILED",
  });
  const [c] = await db.query<{ status: string }>(
    "SELECT status FROM integration_connections WHERE id=$1",
    [connection],
  );
  expect(c.status).toBe("degraded");
});
