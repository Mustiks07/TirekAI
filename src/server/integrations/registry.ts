import { MOYSKLAD_BASE_URL, MOYSKLAD_CONTRACT } from "./moysklad";

// T029 registry: each adapter declares concrete operations, direction, source of truth,
// required rights, how it is verified, and what is not verified live. Planned adapters are
// listed honestly as not implemented; nothing here implies a live connection.
export type Operation = {
  id: string;
  direction: "read" | "write" | "inbound";
  entity: string;
  endpoint: string;
  implementation: "implemented" | "planned";
  verification: "contract_test" | "none";
  live: "not_verified";
  notes: string;
};
export type Passport = {
  provider: string;
  name: string;
  contract: { source: string; checked: string; version: string } | null;
  auth: string;
  limits: string[];
  ownership: Record<string, "external" | "internal">;
  operations: Operation[];
  unverified: string[];
  disconnect: string;
};
export const passports: Passport[] = [
  {
    provider: "moysklad",
    name: "МойСклад",
    contract: {
      source: "https://dev.moysklad.ru/doc/api/remap/1.2/",
      checked: "2026-10-14",
      version: MOYSKLAD_CONTRACT,
    },
    auth: "Authorization: Bearer <token> (user or solution token); Accept-Encoding: gzip is mandatory",
    limits: [
      "45 request units per 3 s per user/solution; user-token requests weigh 3 units from 2026-09-01 and 4 from 2026-12-01",
      "/report/stock/* requests weigh 5 units",
      "≤ 5 parallel requests per user, ≤ 20 per account; 429 with X-Lognex-Retry-After (ms)",
      "expand only with limit ≤ 100; collections up to limit 1000",
    ],
    ownership: {
      catalog: "external",
      stock_linked_warehouses: "external",
      tasks: "internal",
      purchases: "internal",
    },
    operations: [
      {
        id: "check",
        direction: "read",
        entity: "employee",
        endpoint: `GET ${MOYSKLAD_BASE_URL}/context/employee`,
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes: "connection check",
      },
      {
        id: "stores",
        direction: "read",
        entity: "store",
        endpoint: "GET /entity/store",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes:
          "stores are linked to local warehouses only by an explicit owner action",
      },
      {
        id: "products",
        direction: "read",
        entity: "product",
        endpoint:
          "GET /entity/product?limit=100&offset=N&expand=uom&filter=updated>=…",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes:
          "cursor on updated (MSK) with overlap; units by OKEI code; local edits are not overwritten silently",
      },
      {
        id: "stock",
        direction: "read",
        entity: "stock",
        endpoint:
          "GET /report/stock/bystore/current?stockType=stock[&changedSince=…]",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes:
          "mirrors physical stock for linked warehouses; local ledger commands on them are blocked",
      },
      {
        id: "webhook",
        direction: "inbound",
        entity: "product",
        endpoint:
          "POST /api/integrations/moysklad/{connection}/{token}?requestId=…",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes:
          "no signature in the official contract: secret URL token + requestId deduplication; acknowledged before processing (1500 ms limit)",
      },
      {
        id: "webhook_register",
        direction: "write",
        entity: "webhook",
        endpoint: "POST /entity/webhook",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes:
          "explicit owner action; requires a public HTTPS APP_ORIGIN; paid tariff",
      },
      {
        id: "supply_create",
        direction: "write",
        entity: "supply",
        endpoint: "POST /entity/supply",
        implementation: "planned",
        verification: "none",
        live: "not_verified",
        notes:
          "write-back of receipts is not enabled: receipts for linked warehouses happen in MoySklad to avoid double posting",
      },
    ],
    unverified: [
      "live account, tariff and token rights",
      "real webhook delivery to a public URL",
      "rate-limit behaviour under load",
      "time zone of 'updated' for accounts outside MSK",
    ],
    disconnect:
      "Owner disconnects: credentials are erased, links and the stock mirror stop updating and are marked stale; local warehouses become writable again only by an explicit unlink.",
  },
  ...[
    ["bitrix24", "Битрикс24", "T031"],
    ["1c", "1С", "T032"],
    ["cash_bank", "Кассы и банки", "T033"],
    ["messaging_kaspi", "Каналы и Kaspi", "T034"],
  ].map(([provider, name, task]) => ({
    provider,
    name,
    contract: null,
    auth: "not defined",
    limits: [],
    ownership: {},
    operations: [],
    unverified: [
      `${task}: adapter not implemented; official contract to be checked`,
    ],
    disconnect: "n/a",
  })),
];
