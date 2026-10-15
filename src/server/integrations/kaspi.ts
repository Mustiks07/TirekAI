import Decimal from "decimal.js";
import { AppError } from "../../domain/errors";
import type { Fetch } from "./moysklad";

// Kaspi Shop API adapter (T034/T040). Contract checked 2026-10-15 against the official partner
// guide (https://guide.kaspi.kz/partner/ru/shop/api/orders): https://kaspi.kz/shop/api/v2,
// header X-Auth-Token, Content-Type application/vnd.api+json (JSON:API), GET /v2/orders with
// page[number] (from 0) and page[size] ≤ 100, filter[orders][state], filter[orders][creationDate]
// [$ge]/[$le] in milliseconds; GET /v2/orders/{id}/entries; GET /v2/orderentries/{id}/product;
// POST /v2/orders {data:{type:"orders",id,attributes:{code,status}}} to change the status.
export const KASPI_CONTRACT = "kaspi-shop-api-v2@2026-10-15";
export const KASPI_BASE = "https://kaspi.kz/shop/api";
export const KASPI_STATES = [
  "NEW",
  "SIGN_REQUIRED",
  "PICKUP",
  "DELIVERY",
  "KASPI_DELIVERY",
  "ARCHIVE",
] as const;
export type KaspiOrder = {
  id: string;
  attributes: {
    code: string;
    totalPrice: number;
    deliveryCost?: number | null;
    deliveryMode?: string;
    paymentMode?: string;
    state: string;
    status: string;
    creationDate: number;
    customer?: { firstName?: string; lastName?: string; cellPhone?: string };
  };
};
export type KaspiEntry = {
  id: string;
  attributes: {
    quantity: number;
    basePrice: number;
    totalPrice: number;
    unitType?: string;
    entryNumber?: number;
  };
};
export function validKaspiToken(token: string) {
  return /^[A-Za-z0-9+/=_-]{20,200}$/.test(token);
}
// Amounts are tenge as JSON numbers; tiyn must be exact or the value is refused.
export function tengeToMinor(v: unknown) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  const m = new Decimal(String(v)).mul(100);
  return m.isInteger() ? BigInt(m.toFixed(0)) : null;
}
export class KaspiClient {
  constructor(
    private token: string,
    private base = KASPI_BASE,
    private fetcher: Fetch = fetch,
    private sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    once = false,
  ) {
    let last = "KASPI_UNAVAILABLE";
    for (let attempt = 0; attempt < (once ? 1 : 3); attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(`${this.base}${path}`, {
          method,
          headers: {
            "Content-Type": "application/vnd.api+json",
            Accept: "application/vnd.api+json",
            "X-Auth-Token": this.token,
          },
          body: body ? JSON.stringify(body) : undefined,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        last = "KASPI_TIMEOUT";
        if (!once) await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (response.ok) {
        try {
          return (await response.json()) as T;
        } catch {
          throw new AppError("KASPI_INVALID_RESPONSE", 502);
        }
      }
      if (response.status === 429 || response.status >= 500) {
        last =
          response.status === 429
            ? "KASPI_RATE_LIMITED"
            : `KASPI_${response.status}`;
        if (!once)
          await this.sleep(
            Math.min(
              Number(response.headers.get("retry-after") || 2 ** attempt),
              30,
            ) * 1000,
          );
        continue;
      }
      throw new AppError(
        response.status === 401
          ? "KASPI_AUTH_FAILED"
          : response.status === 403
            ? "KASPI_FORBIDDEN"
            : response.status === 404
              ? "KASPI_NOT_FOUND"
              : "KASPI_REQUEST_REJECTED",
        502,
      );
    }
    throw new AppError(last, 503);
  }
  async *orders(state: string, from: number, to: number, size = 100) {
    for (let page = 0; page < 1000; page++) {
      const q = new URLSearchParams({
        "page[number]": String(page),
        "page[size]": String(size),
        "filter[orders][state]": state,
        "filter[orders][creationDate][$ge]": String(from),
        "filter[orders][creationDate][$le]": String(to),
      });
      const r = await this.request<{ data?: KaspiOrder[] }>(
        "GET",
        `/v2/orders?${q}`,
      );
      if (!Array.isArray(r.data))
        throw new AppError("KASPI_INVALID_RESPONSE", 502);
      yield r.data;
      if (r.data.length < size) return;
    }
  }
  async entries(orderId: string) {
    const r = await this.request<{ data?: KaspiEntry[] }>(
      "GET",
      `/v2/orders/${encodeURIComponent(orderId)}/entries`,
    );
    if (!Array.isArray(r.data))
      throw new AppError("KASPI_INVALID_RESPONSE", 502);
    return r.data;
  }
  async product(entryId: string) {
    const r = await this.request<{
      data?: { id: string; attributes: { code: string; name: string } };
    }>("GET", `/v2/orderentries/${encodeURIComponent(entryId)}/product`);
    if (!r.data?.attributes) throw new AppError("KASPI_INVALID_RESPONSE", 502);
    return r.data;
  }
  // Changing a status in Kaspi is a real action for the buyer: attempted once per click.
  setStatus(orderId: string, code: string, status: "ACCEPTED_BY_MERCHANT") {
    return this.request<{ data?: { attributes?: { status?: string } } }>(
      "POST",
      "/v2/orders",
      { data: { type: "orders", id: orderId, attributes: { code, status } } },
      true,
    );
  }
}
