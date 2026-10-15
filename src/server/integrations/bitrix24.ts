import { AppError } from "../../domain/errors";
import type { Fetch } from "./moysklad";

// Bitrix24 REST adapter (T031). Contract checked 2026-10-15 against the official documentation
// (https://apidocs.bitrix24.ru/api-reference/, source github.com/bitrix24/b24restdocs): inbound
// webhook URL https://<portal>/rest/<user>/<code>/<method>.json, crm.item.list/crm.item.get with
// entityTypeId=3 (contact), pages of 50 via start/next, outbound events with
// auth[application_token], errors 503 QUERY_LIMIT_EXCEEDED, 429 OPERATION_TIME_LIMIT, 401 codes.
export const BITRIX24_CONTRACT = "b24-rest@2026-10-15";
export const CONTACT = 3;
export type B24Multi = { typeId: string; value: string; valueType?: string };
export type B24Contact = {
  id: number;
  name: string | null;
  lastName: string | null;
  secondName?: string | null;
  updatedTime: string;
  fm?: B24Multi[];
};
// Cloud portals only: a self-hosted URL could point into a private network (SSRF).
const cloud =
  /^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.bitrix24\.(ru|kz|com|by|de|eu|net|es|fr|it|pl|br|in|cn|jp|tr|ua|id|vn|uk|co|mx)\/rest\/\d{1,10}\/[A-Za-z0-9]{8,64}\/$/;
export function validWebhookUrl(url: string) {
  return cloud.test(url);
}
export class Bitrix24Client {
  constructor(
    private webhookUrl: string,
    private fetcher: Fetch = fetch,
    private sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  get host() {
    return new URL(this.webhookUrl).host;
  }
  async call<T>(method: string, params: Record<string, unknown> = {}) {
    let last = "BITRIX24_UNAVAILABLE";
    for (let attempt = 0; attempt < 4; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(`${this.webhookUrl}${method}.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(params),
          redirect: "error",
          signal: AbortSignal.timeout(65_000),
        });
      } catch {
        last = "BITRIX24_TIMEOUT";
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      let body: {
        result?: T;
        total?: number;
        next?: number;
        error?: string;
      };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        if (response.status >= 500) {
          last = `BITRIX24_${response.status}`;
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new AppError("BITRIX24_INVALID_RESPONSE", 502);
      }
      if (response.ok && !body.error) return body;
      const error = body.error || "";
      // Leaky bucket: back off and retry; the method time limit is not retried in a loop.
      if (error === "QUERY_LIMIT_EXCEEDED" || response.status === 503) {
        last = "BITRIX24_RATE_LIMITED";
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (error === "OPERATION_TIME_LIMIT" || response.status === 429)
        throw new AppError("BITRIX24_OPERATION_TIME_LIMIT", 503);
      if (response.status >= 500) {
        last = `BITRIX24_${response.status}`;
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      const code =
        {
          INVALID_CREDENTIALS: "BITRIX24_AUTH_FAILED",
          NO_AUTH_FOUND: "BITRIX24_AUTH_FAILED",
          expired_token: "BITRIX24_AUTH_FAILED",
          insufficient_scope: "BITRIX24_SCOPE",
          // 401: REST not available on the plan; 400/403: no access to this item.
          ACCESS_DENIED:
            response.status === 401 ? "BITRIX24_PLAN" : "BITRIX24_FORBIDDEN",
          ERROR_METHOD_NOT_FOUND: "BITRIX24_METHOD_NOT_FOUND",
          NOT_FOUND: "BITRIX24_NOT_FOUND",
          PORTAL_DELETED: "BITRIX24_FORBIDDEN",
        }[error] ||
        (response.status === 401
          ? "BITRIX24_AUTH_FAILED"
          : response.status === 403
            ? "BITRIX24_FORBIDDEN"
            : response.status === 404
              ? "BITRIX24_NOT_FOUND"
              : "BITRIX24_REQUEST_REJECTED");
      throw new AppError(code, code === "BITRIX24_NOT_FOUND" ? 404 : 502);
    }
    throw new AppError(last, 503);
  }
  async profile() {
    const r = await this.call<{ ID: string; NAME?: string }>("profile");
    if (!r.result || typeof r.result !== "object")
      throw new AppError("BITRIX24_INVALID_RESPONSE", 502);
    return r.result;
  }
  // Pages of 50 ordered by updatedTime then id; the caller commits each page with its cursor.
  async *contacts(updatedFrom: string | null) {
    let start: number | undefined = 0;
    for (let guard = 0; guard < 20_000 && start !== undefined; guard++) {
      const r: {
        result?: { items: B24Contact[] };
        next?: number;
      } = await this.call<{ items: B24Contact[] }>("crm.item.list", {
        entityTypeId: CONTACT,
        select: ["*"],
        filter: updatedFrom ? { ">=updatedTime": updatedFrom } : {},
        order: { updatedTime: "ASC", id: "ASC" },
        start,
      });
      if (!r.result || !Array.isArray(r.result.items))
        throw new AppError("BITRIX24_INVALID_RESPONSE", 502);
      yield r.result.items;
      start = typeof r.next === "number" ? r.next : undefined;
    }
  }
  async contact(id: number) {
    const r = await this.call<{ item: B24Contact }>("crm.item.get", {
      entityTypeId: CONTACT,
      id,
    });
    if (!r.result?.item) throw new AppError("BITRIX24_INVALID_RESPONSE", 502);
    return r.result.item;
  }
}
export function contactFields(c: B24Contact) {
  const name = [c.name, c.secondName, c.lastName]
    .map((x) => (x || "").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 120);
  const first = (type: string, valid: (v: string) => boolean) =>
    (c.fm || [])
      .filter((m) => m.typeId === type)
      .map((m) => String(m.value || "").trim())
      .find(valid) || "";
  return {
    name: name.length >= 2 ? name : `Bitrix24 #${c.id}`,
    email: first(
      "EMAIL",
      (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254,
    ).toLowerCase(),
    phone: first("PHONE", (v) => v.length > 0).slice(0, 50),
  };
}
