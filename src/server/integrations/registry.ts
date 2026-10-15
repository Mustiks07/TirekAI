import { MOYSKLAD_BASE_URL, MOYSKLAD_CONTRACT } from "./moysklad";
import { BITRIX24_CONTRACT } from "./bitrix24";
import { ONEC_CONTRACT } from "./onec";
import { TELEGRAM_CONTRACT } from "./telegram";
import { KASPI_CONTRACT } from "./kaspi";

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
      receipts_linked_warehouses: "external",
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
          "cursor on updated (MSK) with overlap; units by OKEI code; local edits are not overwritten silently; buyPrice and the first salePrices entry are taken only in KZT (minor units ÷ 100), otherwise the price stays unknown",
      },
      {
        id: "currencies",
        direction: "read",
        entity: "currency",
        endpoint: "GET /entity/currency",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes:
          "isoCode resolves the currency of prices; KZT is required for price import and supply write-back",
      },
      {
        id: "parties",
        direction: "read",
        entity: "organization, counterparty",
        endpoint:
          "GET /entity/organization; GET /entity/counterparty?search=…&limit=50",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes:
          "owner picks the legal entity and maps each local supplier to a counterparty explicitly",
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
        endpoint:
          "GET /entity/supply?filter=externalCode=…; POST /entity/supply",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes:
          "off by default; when the owner enables it, a confirmed receipt into a linked warehouse posts no local movement and is queued as a supply (organization, counterparty, store, KZT, positions with price in minor units); externalCode makes retries idempotent; POST is never retried blindly",
      },
    ],
    unverified: [
      "live account, tariff and token rights",
      "real webhook delivery to a public URL",
      "rate-limit behaviour under load",
      "time zone of 'updated' for accounts outside MSK",
      "supply creation, VAT defaults and rounding of the document sum in a live account",
    ],
    disconnect:
      "Owner disconnects: credentials are erased, links and the stock mirror stop updating and are marked stale; local warehouses become writable again only by an explicit unlink.",
  },
  {
    provider: "bitrix24",
    name: "Битрикс24",
    contract: {
      source: "https://apidocs.bitrix24.ru/api-reference/",
      checked: "2026-10-15",
      version: BITRIX24_CONTRACT,
    },
    auth: "Inbound webhook URL https://<portal>.bitrix24.<zone>/rest/<user>/<code>/ (scope crm + basic); outbound webhook verified by auth[application_token]",
    limits: [
      "leaky bucket: 2 requests/s with a burst of 50 (Enterprise 5/s, 250); 503 QUERY_LIMIT_EXCEEDED",
      "429 OPERATION_TIME_LIMIT when the accumulated method time is exceeded (not retried in a loop)",
      "one request ≤ 60 s; list pages of 50 via start/next",
    ],
    ownership: { customers_imported: "external", deals: "internal" },
    operations: [
      {
        id: "check",
        direction: "read",
        entity: "profile",
        endpoint: "POST <webhook>/profile.json",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes: "connection check (scope basic)",
      },
      {
        id: "contacts",
        direction: "read",
        entity: "contact",
        endpoint:
          "POST <webhook>/crm.item.list.json {entityTypeId:3, select:['*'], filter:{'>=updatedTime':…}, order:{updatedTime,id}, start}",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes:
          "cursor on updatedTime with a 5-minute overlap; e-mail/phone from fm; imported customers get no marketing consent; same e-mail/phone or a local edit → conflict",
      },
      {
        id: "contact_get",
        direction: "read",
        entity: "contact",
        endpoint: "POST <webhook>/crm.item.get.json {entityTypeId:3, id}",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes: "events carry only an id; the contact is re-read",
      },
      {
        id: "events",
        direction: "inbound",
        entity: "contact",
        endpoint:
          "POST /api/integrations/bitrix24/{connection}/{token} (ONCRMCONTACTADD/UPDATE/DELETE)",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes:
          "secret path token + auth[application_token]; dedupe by event/id/ts; deletion is recorded, the local customer stays",
      },
      {
        id: "deal_write",
        direction: "write",
        entity: "deal",
        endpoint: "crm.item.add / crm.item.update",
        implementation: "planned",
        verification: "none",
        live: "not_verified",
        notes:
          "not enabled: deals and orders stay in this application; no write to the portal",
      },
    ],
    unverified: [
      "live portal, plan with REST access and webhook rights",
      "outbound webhook delivery to a public HTTPS address",
      "self-hosted portals (refused: private-network risk)",
    ],
    disconnect:
      "Owner disconnects: the webhook URL and tokens are erased; imported customers and their history stay.",
  },
  {
    provider: "onec",
    name: "1С",
    contract: {
      source:
        "https://kb.1ci.com/1C_Enterprise_Platform/Guides/Developer_Guides/1C_Enterprise_Developer_Guide/8.3.27/Chapter_17._Integration_with_external_systems/17.4._Standard_OData_interface/",
      checked: "2026-10-15",
      version: ONEC_CONTRACT,
    },
    auth: "HTTP Basic (1C user with read rights); the infobase must publish the standard OData interface over HTTPS",
    limits: [
      "no change timestamp in the standard interface: full ordered scan ($orderby=Ref_Key, $top/$skip) at most hourly; unchanged DataVersion is skipped",
      "object names depend on the configuration (default Catalog_Номенклатура, Catalog_КлассификаторЕдиницИзмерения) and are checked against the infobase",
    ],
    ownership: {
      catalog_imported: "external",
      stock: "internal",
      purchases: "internal",
    },
    operations: [
      {
        id: "check",
        direction: "read",
        entity: "configuration objects",
        endpoint:
          "GET <infobase>/odata/standard.odata/<Catalog_…>?$select=Ref_Key&$top=1&$format=json",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes: "both configured objects must exist and be readable",
      },
      {
        id: "products",
        direction: "read",
        entity: "Catalog_Номенклатура",
        endpoint:
          "GET <infobase>/odata/standard.odata/Catalog_Номенклатура?$select=Ref_Key,DataVersion,DeletionMark,IsFolder,Code,Description,Артикул,ЕдиницаИзмерения_Key&$orderby=Ref_Key asc&$top=200&$skip=N&$format=json",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes:
          "folders skipped; unit via the OKEI code of the unit classifier; DeletionMark archives; products missing from a complete scan are archived; prices are not read (unknown, not 0)",
      },
      {
        id: "write",
        direction: "write",
        entity: "documents",
        endpoint: "POST/PATCH …/standard.odata/Document_…",
        implementation: "planned",
        verification: "none",
        live: "not_verified",
        notes: "no writes into the accounting infobase",
      },
    ],
    unverified: [
      "a live infobase, its configuration and object names",
      "publication over HTTPS and the 1C user's rights",
      "counterparties, prices and stock registers (not read)",
    ],
    disconnect:
      "Owner disconnects: the login and password are erased; imported catalogue items stay.",
  },
  {
    provider: "cash_bank",
    name: "Кассы и банки",
    contract: {
      source: "https://v8.1c.ru/edi/edi_stnd/100/101.htm",
      checked: "2026-10-15",
      version: "1CClientBankExchange 1.02/1.03",
    },
    auth: "file exchange: the statement is exported from the bank's client and uploaded by a person with finance rights",
    limits: ["file ≤ 2 MB; encodings Windows (cp1251), DOS (cp866) or UTF-8"],
    ownership: { bank_movements: "external", money_ledger: "internal" },
    operations: [
      {
        id: "statement_import",
        direction: "inbound",
        entity: "bank statement",
        endpoint:
          "POST /api/v1/organizations/{org}/bank/statements (1CClientBankExchange)",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes:
          "account sections checked (opening + in − out = closing, turnovers); lines deduplicated across overlapping statements; posting only by a person through the money command",
      },
      {
        id: "cash_register",
        direction: "read",
        entity: "fiscal receipts (OFD)",
        endpoint: "—",
        implementation: "planned",
        verification: "none",
        live: "not_verified",
        notes:
          "not_configured: no verified official OFD/cash-register contract selected; sales are entered through orders",
      },
      {
        id: "bank_api",
        direction: "read",
        entity: "bank API",
        endpoint: "—",
        implementation: "planned",
        verification: "none",
        live: "not_verified",
        notes:
          "direct bank APIs need a bank agreement and its contract; not connected",
      },
    ],
    unverified: [
      "statements exported by specific Kazakhstan banks (field variants)",
      "cash register / OFD exchange",
    ],
    disconnect:
      "Nothing is stored except uploaded statements and decisions; no credentials are kept.",
  },
  {
    provider: "telegram",
    name: "Telegram",
    contract: {
      source: "https://core.telegram.org/bots/api",
      checked: "2026-10-15",
      version: TELEGRAM_CONTRACT,
    },
    auth: "bot token from @BotFather (sealed); webhook verified by a secret path and the X-Telegram-Bot-Api-Secret-Token header",
    limits: [
      "429 with parameters.retry_after: waited for, the message stays queued",
      "sendMessage is attempted once per worker step: a timeout leaves the message 'unknown', it is not resent automatically",
    ],
    ownership: {
      messages: "external",
      customers: "internal",
      consents: "internal",
    },
    operations: [
      {
        id: "check",
        direction: "read",
        entity: "bot",
        endpoint: "POST https://api.telegram.org/bot<token>/getMe",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes: "token check, bot username for the /start link",
      },
      {
        id: "webhook_register",
        direction: "write",
        entity: "webhook",
        endpoint: "setWebhook {url, secret_token, allowed_updates:['message']}",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes: "explicit owner action; needs a public HTTPS APP_ORIGIN",
      },
      {
        id: "updates",
        direction: "inbound",
        entity: "message",
        endpoint: "POST /api/integrations/telegram/{connection}/{token}",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes:
          "private chats only; /start <code> links a customer and records the customer's own consent, /stop withdraws it; dedupe by update_id",
      },
      {
        id: "send",
        direction: "write",
        entity: "message",
        endpoint: "sendMessage {chat_id, text}",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes:
          "off by default; needs owner enablement, a linked chat and the customer's messenger consent, re-checked at send time",
      },
    ],
    unverified: [
      "a live bot and real delivery",
      "WhatsApp and other messengers (no adapter: official business contracts not selected)",
    ],
    disconnect:
      "Owner disconnects: the bot token is erased; chats, messages and consent history stay.",
  },
  {
    provider: "kaspi",
    name: "Kaspi",
    contract: {
      source: "https://guide.kaspi.kz/partner/ru/shop/api/orders",
      checked: "2026-10-15",
      version: KASPI_CONTRACT,
    },
    auth: "X-Auth-Token from the merchant cabinet (sealed); Content-Type application/vnd.api+json",
    limits: [
      "page[size] ≤ 100, page[number] from 0; creationDate filter in milliseconds, scanned in windows of ≤ 14 days",
      "429 and 5xx are retried with backoff; status changes are attempted once",
    ],
    ownership: {
      channel_orders: "external",
      fulfilment: "internal",
      money: "internal",
    },
    operations: [
      {
        id: "orders",
        direction: "read",
        entity: "orders",
        endpoint:
          "GET /shop/api/v2/orders?page[number]&page[size]&filter[orders][state]&filter[orders][creationDate][$ge|$le]",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes:
          "states NEW, SIGN_REQUIRED, PICKUP, DELIVERY, KASPI_DELIVERY, ARCHIVE; tenge to exact tiyn (fractions refused); status history kept; no stock or money change",
      },
      {
        id: "entries",
        direction: "read",
        entity: "order entries",
        endpoint:
          "GET /v2/orders/{id}/entries; GET /v2/orderentries/{id}/product",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes: "quantity, base price and the Kaspi product code of each line",
      },
      {
        id: "accept",
        direction: "write",
        entity: "order status",
        endpoint:
          "POST /v2/orders {data:{type:'orders',id,attributes:{code,status:'ACCEPTED_BY_MERCHANT'}}}",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes:
          "T040: off until the owner allows status changes; an explicit staff action per order after the stock is reserved; sent once, a timeout is recorded as unknown and not resent",
      },
      {
        id: "settlements",
        direction: "inbound",
        entity: "commission and payout",
        endpoint: "settlement report (manual entry), not in the orders API",
        implementation: "implemented",
        verification: "contract_test",
        live: "not_verified",
        notes:
          "T040: gross, commission and net copied from the Kaspi settlement report (gross − commission = net checked); payout = order payment + operating commission expense, return = refund + commission correction; one report line is posted once. File import of the report is not implemented",
      },
    ],
    unverified: [
      "a live merchant cabinet and token rights",
      "real window and rate limits of the API",
      "completion with the buyer's security code (COMPLETED) is not implemented",
      "the settlement report is entered manually; its file format was not verified",
    ],
    disconnect:
      "Owner disconnects: the token is erased; channel orders and their links stay.",
  },
];
