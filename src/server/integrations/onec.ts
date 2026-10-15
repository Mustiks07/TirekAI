import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "../../domain/errors";
import type { Fetch } from "./moysklad";
import { publicAddress, publicHttps } from "./public-https";

// 1C:Enterprise standard OData interface (T032). Contract checked 2026-10-15 against the official
// 1C:Enterprise 8.3.27 Developer Guide, §17.4 (kb.1ci.com): <infobase>/odata/standard.odata/,
// resource names <Prefix>_<ObjectName> (Catalog_…), $format=json → {"odata.metadata","value"},
// $select/$filter/$orderby/$top/$skip, keys guid'…', DataVersion, DeletionMark, 4XX/5XX with an
// m:error code. Object names depend on the configuration and are set by the owner.
export const ONEC_CONTRACT = "1c-odata-standard@8.3.27/2026-10-15";
export type OneCItem = {
  Ref_Key: string;
  DataVersion: string;
  DeletionMark: boolean;
  IsFolder?: boolean;
  Code?: string;
  Description?: string;
  [field: string]: unknown;
};
export type OneCSettings = {
  products: string;
  units: string;
  unitField: string;
  skuField: string;
};
export const defaultOneC: OneCSettings = {
  // Typical names in Russian-language trade configurations; they must exist in the infobase.
  products: "Catalog_Номенклатура",
  units: "Catalog_КлассификаторЕдиницИзмерения",
  unitField: "ЕдиницаИзмерения_Key",
  skuField: "Артикул",
};
const name = /^(Catalog|Document|InformationRegister)_[\p{L}\p{N}_]{1,80}$/u;
const field = /^[\p{L}\p{N}_]{1,80}$/u;
export function validSettings(s: OneCSettings) {
  return (
    name.test(s.products) &&
    name.test(s.units) &&
    field.test(s.unitField) &&
    field.test(s.skuField)
  );
}
function privateAddress(ip: string) {
  return !publicAddress(ip);
}
// HTTPS publication on a public host only: the server must not be turned into a proxy into
// the owner's or our private network.
export function validInfobaseUrl(url: string) {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.hostname !== "localhost" &&
      !(
        isIP(u.hostname.replace(/^\[|\]$/g, "")) && privateAddress(u.hostname)
      ) &&
      /^[\w./%-]*$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}
export async function publicHost(host: string) {
  const all = await lookup(host, { all: true }).catch(() => []);
  return all.length > 0 && all.every((a) => !privateAddress(a.address));
}
export class OneCClient {
  private root: string;
  constructor(
    infobase: string,
    private user: string,
    private password: string,
    private fetcher: Fetch = publicHttps,
    private sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    private resolveCheck: (host: string) => Promise<boolean> = publicHost,
  ) {
    this.root = `${infobase.replace(/\/+$/, "")}/odata/standard.odata/`;
  }
  get host() {
    return new URL(this.root).host;
  }
  private async get<T>(resource: string, params: Record<string, string>) {
    if (!(await this.resolveCheck(new URL(this.root).hostname)))
      throw new AppError("ONEC_HOST_NOT_ALLOWED", 422);
    const url = new URL(this.root + encodeURIComponent(resource));
    url.searchParams.set("$format", "json");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let last = "ONEC_UNAVAILABLE";
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          headers: {
            Authorization: `Basic ${Buffer.from(`${this.user}:${this.password}`, "utf8").toString("base64")}`,
            Accept: "application/json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        last = "ONEC_TIMEOUT";
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (response.ok) {
        try {
          return (await response.json()) as T;
        } catch {
          throw new AppError("ONEC_INVALID_RESPONSE", 502);
        }
      }
      if (response.status >= 500) {
        last = `ONEC_${response.status}`;
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      // m:error carries an internal code: 8 = no entity type, 20 = access rights.
      const text = await response.text().catch(() => "");
      const code = /<m:code>(\d+)<\/m:code>|"code"\s*:\s*"?(\d+)/.exec(text);
      const internal = Number(code?.[1] ?? code?.[2] ?? -1);
      throw new AppError(
        response.status === 401
          ? "ONEC_AUTH_FAILED"
          : internal === 20 || response.status === 403
            ? "ONEC_FORBIDDEN"
            : internal === 8 || response.status === 404
              ? "ONEC_ENTITY_NOT_FOUND"
              : "ONEC_REQUEST_REJECTED",
        502,
      );
    }
    throw new AppError(last, 503);
  }
  // Pages ordered by key; there is no change timestamp, so changes are found via DataVersion.
  async *list(resource: string, select: string[], page = 200) {
    for (let skip = 0; skip < 1_000_000; skip += page) {
      const r = await this.get<{ value?: OneCItem[] }>(resource, {
        $select: select.join(","),
        $orderby: "Ref_Key asc",
        $top: String(page),
        $skip: String(skip),
      });
      if (!Array.isArray(r.value))
        throw new AppError("ONEC_INVALID_RESPONSE", 502);
      yield r.value;
      if (r.value.length < page) return;
    }
  }
  async probe(resource: string) {
    const r = await this.get<{ value?: unknown[] }>(resource, {
      $select: "Ref_Key",
      $top: "1",
    });
    if (!Array.isArray(r.value))
      throw new AppError("ONEC_INVALID_RESPONSE", 502);
    return true;
  }
}
