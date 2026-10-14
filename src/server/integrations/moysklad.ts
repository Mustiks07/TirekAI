import Decimal from "decimal.js";
import { AppError } from "../../domain/errors";

// MoySklad JSON API 1.2 adapter. Contract checked 2026-10-14 against
// https://dev.moysklad.ru/doc/api/remap/1.2/ (sections: general, restrictions, product,
// store, report/stock, webhook, currency, organization, counterparty, supply). Only operations
// listed in the passport are implemented.
export const MOYSKLAD_BASE_URL = "https://api.moysklad.ru/api/remap/1.2";
export const MOYSKLAD_CONTRACT = "remap-1.2@2026-10-14";
export type Fetch = typeof fetch;
export type MsMeta = { href: string; type: string };
export type MsProduct = {
  id: string;
  meta: MsMeta;
  updated: string;
  name: string;
  code?: string;
  article?: string;
  externalCode: string;
  archived: boolean;
  uom?: { name?: string; code?: string; meta?: MsMeta };
  // Prices are in minor units ("копейки") of the referenced currency.
  buyPrice?: MsPrice;
  salePrices?: (MsPrice & { priceType?: { id?: string; name?: string } })[];
};
export type MsPrice = { value: number; currency?: { meta?: MsMeta } };
export type MsCurrency = {
  id: string;
  isoCode: string;
  default?: boolean;
  archived?: boolean;
};
export type MsParty = { id: string; name: string; archived?: boolean };
export type MsSupply = {
  id: string;
  externalCode: string;
  sum?: number;
  meta?: MsMeta;
};
export type MsStore = {
  id: string;
  name: string;
  code?: string;
  archived: boolean;
  updated: string;
};
export type MsStockRow = {
  assortmentId: string;
  storeId: string | null;
  stock: number | null;
};
export type MsWebhookEvent = {
  meta: MsMeta;
  action: "CREATE" | "UPDATE" | "DELETE" | "PROCESSED";
  accountId: string;
  updatedFields?: string[];
};
// OKEI codes of MoySklad units → catalogue base units; anything else needs a human decision.
const UNITS: Record<string, "pc" | "kg" | "l" | "m" | "hour"> = {
  "796": "pc",
  "166": "kg",
  "112": "l",
  "006": "m",
  "356": "hour",
};
export function mapUnit(uom: MsProduct["uom"]) {
  return (uom?.code && UNITS[uom.code]) || null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Event hrefs are never fetched as given (SSRF): only the entity id is taken from them.
export function entityIdFromHref(href: string, type: string) {
  const m = /\/entity\/([a-z]+)\/([0-9a-f-]{36})(?:[/?]|$)/i.exec(href);
  if (!m || m[1] !== type || !uuid.test(m[2])) return null;
  return m[2].toLowerCase();
}
// Prices arrive in minor units of the referenced currency. Only KZT prices are taken; a price in
// another currency, without a currency, or 0 (MoySklad's "not set") stays unknown — never 0.
export function kztPrice(price: MsPrice | undefined, kzt: string | null) {
  if (!price || !kzt || typeof price.value !== "number") return null;
  if (!Number.isFinite(price.value) || price.value <= 0) return null;
  const href = price.currency?.meta?.href;
  if (!href || entityIdFromHref(href, "currency") !== kzt) return null;
  const value = new Decimal(String(price.value)).div(100);
  if (value.gte(1e15) || value.decimalPlaces() > 6) return null;
  return value.toFixed();
}
export async function kztCurrency(client: MoySkladClient) {
  const rows = await client.currencies();
  return rows.find((c) => c.isoCode === "KZT" && !c.archived)?.id || null;
}
// MoySklad date-times are Moscow time "YYYY-MM-DD HH:mm:ss" (UTC+3, no DST).
export function toMoscow(date: Date) {
  const msk = new Date(date.getTime() + 3 * 3600_000);
  return msk.toISOString().replace("T", " ").slice(0, 19);
}
export class MoySkladClient {
  constructor(
    private token: string,
    private baseUrl = MOYSKLAD_BASE_URL,
    private fetcher: Fetch = fetch,
    private sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    params: Record<string, string> = {},
    body?: unknown,
    // Document creation is never retried blindly: a lost response could create a duplicate.
    // The caller looks the document up by externalCode before trying again.
    once = false,
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let lastCode = "MOYSKLAD_UNAVAILABLE";
    for (let attempt = 0; attempt < 4; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            // The API rejects requests without gzip with 415.
            "Accept-Encoding": "gzip",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        lastCode = "MOYSKLAD_TIMEOUT";
        if (once) break;
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      if (response.ok) {
        const length = Number(response.headers.get("content-length") || 0);
        if (length > 20 * 1024 * 1024)
          throw new AppError("MOYSKLAD_RESPONSE_TOO_LARGE", 502);
        try {
          return (await response.json()) as T;
        } catch {
          throw new AppError("MOYSKLAD_INVALID_RESPONSE", 502);
        }
      }
      // Bounded retries: rate limit waits for the server-provided reset; 5xx backs off.
      if (response.status === 429) {
        const wait = Number(
          response.headers.get("x-lognex-retry-after") || 1000,
        );
        lastCode = "MOYSKLAD_RATE_LIMITED";
        if (once) break;
        await this.sleep(Math.min(Number.isFinite(wait) ? wait : 1000, 10_000));
        continue;
      }
      if (response.status >= 500) {
        lastCode = `MOYSKLAD_${response.status}`;
        if (once) break;
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      const code =
        {
          401: "MOYSKLAD_AUTH_FAILED",
          403: "MOYSKLAD_FORBIDDEN",
          404: "MOYSKLAD_NOT_FOUND",
          410: "MOYSKLAD_API_VERSION_RETIRED",
          400: "MOYSKLAD_REQUEST_REJECTED",
          412: "MOYSKLAD_REQUEST_INVALID",
          415: "MOYSKLAD_ENCODING_REJECTED",
        }[response.status] || `MOYSKLAD_${response.status}`;
      throw new AppError(code, response.status === 404 ? 404 : 502);
    }
    throw new AppError(lastCode, 503);
  }
  context() {
    return this.request<{ id: string; name: string }>(
      "GET",
      "/context/employee",
    );
  }
  // Paged by limit/offset; expand works only up to limit 100, so pages are 100 rows.
  async *products(updatedFrom: string | null) {
    for (let offset = 0; offset < 1_000_000; offset += 100) {
      const page = await this.request<{
        meta: { size: number; limit: number; offset: number };
        rows: MsProduct[];
      }>("GET", "/entity/product", {
        limit: "100",
        offset: String(offset),
        expand: "uom",
        order: "updated,asc",
        ...(updatedFrom ? { filter: `updated>=${updatedFrom}` } : {}),
      });
      if (!Array.isArray(page.rows))
        throw new AppError("MOYSKLAD_INVALID_RESPONSE", 502);
      yield page.rows;
      if (offset + page.rows.length >= page.meta.size || !page.rows.length)
        return;
    }
  }
  product(id: string) {
    return this.request<MsProduct>("GET", `/entity/product/${id}`, {
      expand: "uom",
    });
  }
  async stores() {
    const page = await this.request<{ rows: MsStore[] }>(
      "GET",
      "/entity/store",
      { limit: "1000" },
    );
    if (!Array.isArray(page.rows))
      throw new AppError("MOYSKLAD_INVALID_RESPONSE", 502);
    return page.rows;
  }
  // Short stock report: whole response, no paging; changedSince ≤ 24 h in the past.
  async stock(changedSince: string | null) {
    const rows = await this.request<MsStockRow[]>(
      "GET",
      "/report/stock/bystore/current",
      {
        stockType: "stock",
        ...(changedSince ? { changedSince } : {}),
      },
    );
    if (!Array.isArray(rows))
      throw new AppError("MOYSKLAD_INVALID_RESPONSE", 502);
    return rows;
  }
  async currencies() {
    const page = await this.request<{ rows: MsCurrency[] }>(
      "GET",
      "/entity/currency",
      { limit: "1000" },
    );
    if (!Array.isArray(page.rows))
      throw new AppError("MOYSKLAD_INVALID_RESPONSE", 502);
    return page.rows;
  }
  async organizations() {
    const page = await this.request<{ rows: MsParty[] }>(
      "GET",
      "/entity/organization",
      { limit: "100" },
    );
    if (!Array.isArray(page.rows))
      throw new AppError("MOYSKLAD_INVALID_RESPONSE", 502);
    return page.rows;
  }
  // Context search (substring, not prefix) over counterparties; a bounded page for a picker.
  async counterparties(search: string) {
    const page = await this.request<{ rows: MsParty[] }>(
      "GET",
      "/entity/counterparty",
      { limit: "50", ...(search ? { search } : {}) },
    );
    if (!Array.isArray(page.rows))
      throw new AppError("MOYSKLAD_INVALID_RESPONSE", 502);
    return page.rows;
  }
  async supplyByExternalCode(externalCode: string) {
    const page = await this.request<{ rows: MsSupply[] }>(
      "GET",
      "/entity/supply",
      { limit: "2", filter: `externalCode=${externalCode}` },
    );
    if (!Array.isArray(page.rows))
      throw new AppError("MOYSKLAD_INVALID_RESPONSE", 502);
    return page.rows.find((r) => r.externalCode === externalCode) || null;
  }
  createSupply(body: unknown) {
    return this.request<MsSupply>("POST", "/entity/supply", {}, body, true);
  }
  meta(type: string, id: string) {
    return {
      meta: {
        href: `${this.baseUrl}/entity/${type}/${id}`,
        type,
        mediaType: "application/json",
      },
    };
  }
  // Explicit owner action only: registers our inbound URL for one entity type and action.
  registerWebhook(
    url: string,
    entityType: "product" | "store",
    action: "CREATE" | "UPDATE" | "DELETE",
  ) {
    return this.request<{ id: string }>(
      "POST",
      "/entity/webhook",
      {},
      { url, action, entityType },
    );
  }
}
