import { createServer } from "node:http";

// Local stand-in with the shapes from the Kaspi partner guide (JSON:API, X-Auth-Token, page[number]
// from 0, page[size] ≤ 100, filter[orders][state]/[creationDate][$ge|$le] in ms, entries and
// masterproducts, POST /v2/orders status change). Not a live merchant cabinet.
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
