import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import type { Database, Sql } from "../db/database";
import {
  sessionAccess,
  audit,
  InternalActor,
  actorAccess,
  type Credential,
} from "../access";
import { AppError } from "../../domain/errors";
import { idSchema } from "../../domain/contracts";
import { idempotent } from "../execution/core";
import { InventoryService } from "../inventory/service";
import {
  MoySkladClient,
  MOYSKLAD_BASE_URL,
  MOYSKLAD_CONTRACT,
  entityIdFromHref,
  kztCurrency,
  kztPrice,
  mapUnit,
  toMoscow,
  type Fetch,
  type MsProduct,
  type MsWebhookEvent,
} from "./moysklad";
import { passports } from "./registry";
import {
  externalCode,
  supplySettings,
  unitPriceMinor,
  type SupplyPosition,
} from "./writeback";

export const configureInput = z
  .object({
    key: z.uuid(),
    provider: z.literal("moysklad"),
    token: z
      .string()
      .trim()
      .min(16)
      .max(200)
      .regex(/^[\x21-\x7e]+$/),
  })
  .strict();
export const linkInput = z
  .object({ warehouseId: z.uuid(), storeId: z.uuid() })
  .strict();
export const supplySettingsInput = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    enabled: z.boolean(),
    organizationId: z.uuid().nullable(),
  })
  .strict()
  .refine((v) => !v.enabled || v.organizationId, {
    path: ["organizationId"],
  });
export const counterpartyInput = z
  .object({
    key: z.uuid(),
    supplierId: z.uuid(),
    counterpartyId: z.uuid().nullable(),
  })
  .strict();
export const partiesQuery = z
  .object({ search: z.string().trim().max(80).default("") })
  .strict();
export const conflictDecision = z
  .object({ key: z.uuid(), decision: z.enum(["kept_local", "took_remote"]) })
  .strict();
const webhookBody = z
  .object({
    auditContext: z.unknown().optional(),
    events: z
      .array(
        z.object({
          meta: z.object({
            href: z.string().max(500),
            type: z.string().max(60),
          }),
          action: z.enum(["CREATE", "UPDATE", "DELETE", "PROCESSED"]),
          accountId: z.string().max(60),
          updatedFields: z.array(z.string().max(60)).max(100).optional(),
        }),
      )
      .min(1)
      .max(100),
  })
  .passthrough();
type Connection = {
  id: string;
  organization_id: string;
  provider: string;
  status: string;
  credentials: Uint8Array | null;
  webhook_token_hash: string | null;
  settings: unknown;
  disconnected_at: string | null;
  created_by: string;
  last_success_at: string | null;
  version: number;
};
// Credentials at rest: AES-256-GCM with a server-only key. Without the key nothing is stored.
function secretKey() {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY || "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32)
    throw new AppError("CREDENTIAL_STORAGE_NOT_CONFIGURED", 503);
  return key;
}
export function seal(text: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
export function open(sealed: Uint8Array) {
  const b = Buffer.from(sealed),
    decipher = createDecipheriv("aes-256-gcm", secretKey(), b.subarray(0, 12));
  decipher.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([
    decipher.update(b.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
// Stock mirror older than this is shown as stale and the connection as degraded.
export const STALE_MINUTES = 60;
export class IntegrationService {
  constructor(
    private db: Database,
    // Tests inject a contract server; production always uses the official host.
    private client: (token: string) => MoySkladClient = (token) =>
      new MoySkladClient(token),
    private baseUrl = MOYSKLAD_BASE_URL,
  ) {}
  static forContractServer(
    db: Database,
    baseUrl: string,
    fetcher: Fetch = fetch,
    sleep?: (ms: number) => Promise<void>,
  ) {
    return new IntegrationService(
      db,
      (token) => new MoySkladClient(token, baseUrl, fetcher, sleep),
      baseUrl,
    );
  }
  private async connection(tx: Sql, org: string, id: string, lock = false) {
    idSchema.parse(id);
    const [c] = await tx.query<Connection>(
      `SELECT * FROM integration_connections WHERE organization_id=$1 AND id=$2 AND provider='moysklad' ${lock ? "FOR UPDATE" : ""}`,
      [org, id],
    );
    if (!c) throw new AppError("NOT_FOUND", 404);
    return c;
  }
  async overview(secret: Credential, org: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:read");
      const connections = await tx.query(
        `SELECT c.id,c.provider,CASE WHEN c.status IN ('configured','live_verified','sandbox_verified') AND (c.last_success_at IS NULL OR c.last_success_at<now()-make_interval(mins=>${STALE_MINUTES})) AND EXISTS(SELECT 1 FROM sync_runs r WHERE r.connection_id=c.id AND r.kind<>'check') THEN 'degraded' ELSE c.status END status,c.credentials_hint,c.ownership,c.contract_version,c.last_success_at,c.last_error_code,c.last_error_at,c.verification,c.version,c.created_at,c.disconnected_at,
        (SELECT count(*)::int FROM sync_conflicts x WHERE x.connection_id=c.id AND x.state='open') open_conflicts,
        (SELECT count(*)::int FROM integration_inbox i WHERE i.connection_id=c.id AND i.state IN ('received','failed')) pending_events,
        c.settings->'supply' supply
        FROM integration_connections c WHERE c.organization_id=$1 ORDER BY c.created_at DESC LIMIT 20`,
        [org],
      );
      return {
        passports,
        connections,
        links: await tx.query(
          "SELECT l.warehouse_id,w.name warehouse_name,l.connection_id,l.external_store_id,(SELECT max(as_of) FROM external_stock e WHERE e.connection_id=l.connection_id AND e.warehouse_id=l.warehouse_id) stock_as_of FROM integration_warehouse_links l JOIN warehouses w ON w.organization_id=l.organization_id AND w.id=l.warehouse_id WHERE l.organization_id=$1 AND ($2::uuid IS NULL OR w.branch_id=$2)",
          [org, s.branchId],
        ),
        runs: await tx.query(
          "SELECT id,connection_id,kind,state,stats,error_code,started_at,finished_at FROM sync_runs WHERE organization_id=$1 ORDER BY started_at DESC LIMIT 20",
          [org],
        ),
        conflicts: await tx.query(
          "SELECT id,connection_id,entity_type,external_id,internal_id,reason,local,remote,state,created_at FROM sync_conflicts WHERE organization_id=$1 AND state='open' ORDER BY created_at DESC LIMIT 50",
          [org],
        ),
        exports: await tx.query(
          "SELECT e.id,e.connection_id,e.purchase_order_id,o.number order_number,e.warehouse_id,e.state,e.attempts,e.expected_minor::text,e.external_sum_minor::text,e.external_id,e.warning,e.error_code,e.created_at,e.sent_at,e.next_attempt_at FROM integration_exports e JOIN purchase_orders o ON o.organization_id=e.organization_id AND o.id=e.purchase_order_id JOIN warehouses w ON w.organization_id=e.organization_id AND w.id=e.warehouse_id WHERE e.organization_id=$1 AND ($2::uuid IS NULL OR w.branch_id=$2) ORDER BY e.created_at DESC LIMIT 30",
          [org, s.branchId],
        ),
        counterparties: await tx.query(
          "SELECT m.connection_id,m.internal_id supplier_id,s.name supplier_name,m.external_id counterparty_id FROM integration_mappings m JOIN suppliers s ON s.organization_id=m.organization_id AND s.id=m.internal_id WHERE m.organization_id=$1 AND m.entity_type='counterparty' AND m.state='active' ORDER BY s.name",
          [org],
        ),
        canWrite: s.role === "owner",
      };
    });
  }
  async configure(secret: Credential, org: string, input: unknown) {
    const c = configureInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      const r = await idempotent(tx, org, c.key, {
        operation: "integration.configure",
        provider: c.provider,
        token: sha(c.token),
      });
      if (r.reused) return { id: r.id, reused: true, webhookToken: null };
      const sealed = seal(c.token),
        webhookToken = randomBytes(32).toString("hex");
      const [existing] = await tx.query<{ id: string }>(
        "SELECT id FROM integration_connections WHERE organization_id=$1 AND provider=$2 AND disconnected_at IS NULL FOR UPDATE",
        [org, c.provider],
      );
      const id = existing?.id || r.id;
      if (existing)
        await tx.query(
          "UPDATE integration_connections SET credentials=$3,credentials_hint=$4,webhook_token_hash=$5,status='configured',verification=NULL,last_error_code=NULL,version=version+1 WHERE organization_id=$1 AND id=$2",
          [org, id, sealed, `…${c.token.slice(-4)}`, sha(webhookToken)],
        );
      else
        await tx.query(
          "INSERT INTO integration_connections(id,organization_id,provider,status,credentials,credentials_hint,webhook_token_hash,ownership,contract_version,created_by) VALUES($1,$2,$3,'configured',$4,$5,$6,$7,$8,$9)",
          [
            id,
            org,
            c.provider,
            sealed,
            `…${c.token.slice(-4)}`,
            sha(webhookToken),
            JSON.stringify(passports[0].ownership),
            MOYSKLAD_CONTRACT,
            s.actorId,
          ],
        );
      await audit(tx, org, s.actorId, "integration.configured", null, {
        connectionId: id,
        provider: c.provider,
      });
      // The inbound URL token is shown once and stored only as a hash.
      return { id, reused: false, webhookToken };
    });
  }
  private async run<T>(
    conn: Connection,
    kind: string,
    work: (client: MoySkladClient, stats: Record<string, number>) => Promise<T>,
  ) {
    if (!conn.credentials || conn.status === "disconnected")
      throw new AppError("INTEGRATION_NOT_CONFIGURED", 409);
    const runId = randomUUID(),
      stats: Record<string, number> = {};
    await this.db.query(
      "INSERT INTO sync_runs(id,organization_id,connection_id,kind,state) VALUES($1,$2,$3,$4,'running')",
      [runId, conn.organization_id, conn.id, kind],
    );
    try {
      const result = await work(this.client(open(conn.credentials)), stats);
      const partial = (stats.conflicts || 0) + (stats.unmapped || 0) > 0;
      await this.db.query(
        "UPDATE sync_runs SET state=$2,stats=$3,finished_at=now() WHERE id=$1",
        [runId, partial ? "partial" : "succeeded", JSON.stringify(stats)],
      );
      await this.db.query(
        "UPDATE integration_connections SET last_success_at=now(),last_error_code=NULL WHERE id=$1",
        [conn.id],
      );
      return { runId, stats, result };
    } catch (error) {
      const code =
        error instanceof AppError ? error.code : "INTEGRATION_FAILED";
      // A failed exchange is recorded as a failure with its code, never as success.
      await this.db.query(
        "UPDATE sync_runs SET state='failed',stats=$2,error_code=$3,finished_at=now() WHERE id=$1",
        [runId, JSON.stringify(stats), code],
      );
      await this.db.query(
        "UPDATE integration_connections SET last_error_code=$2,last_error_at=now(),status=CASE WHEN $2 IN ('MOYSKLAD_AUTH_FAILED','MOYSKLAD_FORBIDDEN') THEN 'degraded' ELSE status END WHERE id=$1",
        [conn.id, code],
      );
      throw error;
    }
  }
  async check(secret: Credential, org: string, id: string) {
    const conn = await this.db.transaction(async (tx) => {
      await sessionAccess(tx, secret, org, "integrations:write");
      return this.connection(tx, org, id);
    });
    const r = await this.run(conn, "check", async (client) => client.context());
    // Only the official host can mark a live account as verified; a contract server cannot.
    const live = this.baseUrl === MOYSKLAD_BASE_URL;
    await this.db.query(
      "UPDATE integration_connections SET status=$2,verification=$3,version=version+1 WHERE id=$1",
      [
        id,
        live ? "live_verified" : "configured",
        JSON.stringify({
          operation: "check",
          checked_at: new Date().toISOString(),
          host: new URL(this.baseUrl).host,
          run_id: r.runId,
          scope: live ? "connection_only" : "contract_server",
        }),
      ],
    );
    return { ok: true };
  }
  async stores(secret: Credential, org: string, id: string) {
    const conn = await this.db.transaction(async (tx) => {
      await sessionAccess(tx, secret, org, "integrations:read");
      return this.connection(tx, org, id);
    });
    const r = await this.run(conn, "check", async (client, stats) => {
      const rows = await client.stores();
      stats.stores = rows.length;
      return rows.map((s) => ({
        id: s.id,
        name: s.name,
        archived: s.archived,
      }));
    });
    return { items: r.result };
  }
  // A local warehouse becomes a read-only mirror only if its own ledger is empty.
  async link(secret: Credential, org: string, id: string, input: unknown) {
    const c = linkInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      await this.connection(tx, org, id, true);
      const [w] = await tx.query(
        "SELECT id FROM warehouses WHERE organization_id=$1 AND id=$2 FOR UPDATE",
        [org, c.warehouseId],
      );
      if (!w) throw new AppError("NOT_FOUND", 404);
      const [ledger] = await tx.query<{ n: number }>(
        "SELECT (SELECT count(*)::int FROM stock_movements WHERE organization_id=$1 AND warehouse_id=$2)+(SELECT count(*)::int FROM stock_reservations WHERE organization_id=$1 AND warehouse_id=$2) n",
        [org, c.warehouseId],
      );
      if (ledger.n) throw new AppError("WAREHOUSE_HAS_LEDGER", 409);
      const added = await tx.query(
        "INSERT INTO integration_warehouse_links(organization_id,warehouse_id,connection_id,external_store_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING warehouse_id",
        [org, c.warehouseId, id, c.storeId],
      );
      if (!added.length) throw new AppError("LINK_EXISTS", 409);
      await audit(tx, org, s.actorId, "integration.warehouse_linked", null, {
        connectionId: id,
        warehouseId: c.warehouseId,
      });
      return { ok: true };
    });
  }
  async unlink(
    secret: Credential,
    org: string,
    id: string,
    warehouseId: string,
  ) {
    idSchema.parse(warehouseId);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      await this.connection(tx, org, id, true);
      await tx.query(
        "DELETE FROM external_stock WHERE organization_id=$1 AND connection_id=$2 AND warehouse_id=$3",
        [org, id, warehouseId],
      );
      const rows = await tx.query(
        "DELETE FROM integration_warehouse_links WHERE organization_id=$1 AND connection_id=$2 AND warehouse_id=$3 RETURNING warehouse_id",
        [org, id, warehouseId],
      );
      if (!rows.length) throw new AppError("NOT_FOUND", 404);
      await audit(tx, org, s.actorId, "integration.warehouse_unlinked", null, {
        connectionId: id,
        warehouseId,
      });
      return { ok: true };
    });
  }
  async disconnect(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      await this.connection(tx, org, id, true);
      // Credentials are erased, not just hidden.
      await tx.query(
        "UPDATE integration_connections SET status='disconnected',credentials=NULL,credentials_hint=NULL,webhook_token_hash=NULL,disconnected_at=now(),version=version+1 WHERE organization_id=$1 AND id=$2",
        [org, id],
      );
      await audit(tx, org, s.actorId, "integration.disconnected", null, {
        connectionId: id,
      });
      return { ok: true };
    });
  }
  async syncNow(secret: Credential, org: string, id: string) {
    const conn = await this.db.transaction(async (tx) => {
      await sessionAccess(tx, secret, org, "integrations:write");
      return this.connection(tx, org, id);
    });
    const products = await this.syncProducts(conn);
    const stock = await this.syncStock(conn);
    return { products: products.stats, stock: stock.stats };
  }
  // Incremental product import with an overlapping cursor; each page commits on its own so a
  // restart resumes without losing or duplicating changes.
  async syncProducts(conn: Connection) {
    const [cursor] = await this.db.query<{ cursor: string }>(
      "SELECT cursor FROM sync_cursors WHERE connection_id=$1 AND entity_type='product'",
      [conn.id],
    );
    return this.run(
      conn,
      cursor ? "incremental" : "initial",
      async (client, stats) => {
        let from: string | null = null;
        if (cursor)
          from = toMoscow(
            new Date(
              new Date(cursor.cursor.replace(" ", "T") + "+03:00").getTime() -
                5 * 60_000,
            ),
          );
        const kzt = await kztCurrency(client);
        if (!kzt) stats.no_kzt_currency = 1;
        for await (const page of client.products(from)) {
          let max = cursor?.cursor || "";
          await this.db.transaction(async (tx) => {
            for (const p of page) {
              const outcome = await this.applyProduct(tx, conn, p, kzt);
              stats[outcome] = (stats[outcome] || 0) + 1;
              if (!p.archived && !kztPrice(p.salePrices?.[0], kzt))
                stats.sale_price_unknown = (stats.sale_price_unknown || 0) + 1;
              if (p.updated > max) max = p.updated;
            }
            if (max)
              await tx.query(
                "INSERT INTO sync_cursors(connection_id,entity_type,cursor) VALUES($1,'product',$2) ON CONFLICT(connection_id,entity_type) DO UPDATE SET cursor=greatest(sync_cursors.cursor,$2),updated_at=now()",
                [conn.id, max],
              );
          });
        }
      },
    );
  }
  private async applyProduct(
    tx: Sql,
    conn: Connection,
    p: MsProduct,
    kzt: string | null,
  ): Promise<string> {
    // The first sale price is the account's default price type.
    const purchase = kztPrice(p.buyPrice, kzt),
      sale = kztPrice(p.salePrices?.[0], kzt);
    const org = conn.organization_id;
    const actor = new InternalActor(conn.created_by, "integration");
    // The connection owner's rights are re-checked for every applied change.
    await actorAccess(tx, conn.created_by, org, "catalog:write");
    const conflict = async (
      reason: string,
      internal: string | null,
      local: unknown,
    ) => {
      await tx.query(
        "INSERT INTO sync_conflicts(id,organization_id,connection_id,entity_type,external_id,internal_id,reason,local,remote,state) VALUES($1,$2,$3,'product',$4,$5,$6,$7,$8,'open') ON CONFLICT DO NOTHING",
        [
          randomUUID(),
          org,
          conn.id,
          p.id,
          internal,
          reason,
          local ? JSON.stringify(local) : null,
          JSON.stringify({
            id: p.id,
            name: p.name,
            code: p.code || null,
            updated: p.updated,
            archived: p.archived,
            uom: p.uom?.code || null,
          }),
        ],
      );
      return "conflicts";
    };
    const [m] = await tx.query<{
      internal_id: string;
      external_updated: string | null;
      local_version: number | null;
      state: string;
    }>(
      "SELECT internal_id,external_updated,local_version,state FROM integration_mappings WHERE connection_id=$1 AND entity_type='product' AND external_id=$2 FOR UPDATE",
      [conn.id, p.id],
    );
    if (m && m.external_updated && p.updated <= m.external_updated)
      return "unchanged";
    const unit = mapUnit(p.uom);
    if (!m) {
      if (p.archived) return "skipped_archived";
      if (!unit) return conflict("unit_unmapped", null, null);
      const sku = (p.code || p.article || p.externalCode || p.id)
        .replace(/[^\p{L}\p{N}_.:-]/gu, "-")
        .slice(0, 60);
      const [taken] = await tx.query<{ id: string }>(
        "SELECT id FROM catalog_items WHERE organization_id=$1 AND sku=$2",
        [org, sku],
      );
      // An existing local SKU is never merged silently with an external product.
      if (taken) return conflict("sku_exists", taken.id, { sku });
      const created = await new InventoryService(this.db).saveItemInTransaction(
        tx,
        actor,
        org,
        {
          sku,
          name_ru: p.name.slice(0, 120).padEnd(2, "."),
          kind: "goods",
          base_unit: unit,
          purchase_price: purchase,
          sale_price: sale,
          category: "МойСклад",
        },
      );
      await tx.query(
        "INSERT INTO integration_mappings(organization_id,connection_id,entity_type,external_id,internal_id,external_updated,local_version,state) VALUES($1,$2,'product',$3,$4,$5,1,'active')",
        [org, conn.id, p.id, created.id, p.updated],
      );
      return "created";
    }
    const [item] = await tx.query<{
      version: number;
      name_ru: string;
      base_unit: string;
      sku: string;
      active: boolean;
    }>(
      "SELECT version,name_ru,base_unit,sku,active FROM catalog_items WHERE organization_id=$1 AND id=$2 FOR UPDATE",
      [org, m.internal_id],
    );
    // Local edits since the last sync win until a person resolves the conflict.
    if (item.version !== m.local_version)
      return conflict("local_modified", m.internal_id, {
        name: item.name_ru,
        version: item.version,
      });
    if (unit && unit !== item.base_unit)
      return conflict("unit_changed", m.internal_id, {
        base_unit: item.base_unit,
      });
    const updated = await new InventoryService(this.db).updateItemFields(
      tx,
      actor,
      org,
      m.internal_id,
      item.version,
      {
        name_ru: p.name.slice(0, 120).padEnd(2, "."),
        active: !p.archived,
        // A missing or non-KZT remote price leaves the local price as it is.
        ...(purchase ? { purchase_price: purchase } : {}),
        ...(sale ? { sale_price: sale } : {}),
      },
    );
    await tx.query(
      "UPDATE integration_mappings SET external_updated=$3,local_version=$4,state=$5,updated_at=now() WHERE connection_id=$1 AND entity_type='product' AND external_id=$2",
      [
        conn.id,
        p.id,
        p.updated,
        updated.version,
        p.archived ? "archived" : "active",
      ],
    );
    return p.archived ? "archived" : "updated";
  }
  async syncStock(conn: Connection) {
    const [cursor] = await this.db.query<{
      cursor: string;
      updated_at: string;
    }>(
      "SELECT cursor,updated_at FROM sync_cursors WHERE connection_id=$1 AND entity_type='stock'",
      [conn.id],
    );
    // changedSince is limited to 24 h; otherwise (and daily) a full snapshot is taken.
    const recent =
      cursor &&
      Date.now() - new Date(cursor.updated_at).getTime() < 20 * 3600_000;
    return this.run(conn, "stock", async (client, stats) => {
      const startedMsk = toMoscow(new Date());
      const rows = await client.stock(recent ? cursor!.cursor : null);
      await this.db.transaction(async (tx) => {
        const links = await tx.query<{
          warehouse_id: string;
          external_store_id: string;
        }>(
          "SELECT warehouse_id,external_store_id FROM integration_warehouse_links WHERE connection_id=$1",
          [conn.id],
        );
        const products = new Map(
          (
            await tx.query<{ external_id: string; internal_id: string }>(
              "SELECT external_id,internal_id FROM integration_mappings WHERE connection_id=$1 AND entity_type='product'",
              [conn.id],
            )
          ).map((r) => [r.external_id, r.internal_id]),
        );
        for (const row of rows) {
          const link = links.find((l) => l.external_store_id === row.storeId);
          const item = products.get(row.assortmentId);
          if (!link) {
            stats.other_stores = (stats.other_stores || 0) + 1;
            continue;
          }
          if (!item || row.stock === null || !Number.isFinite(row.stock)) {
            stats.unmapped = (stats.unmapped || 0) + 1;
            continue;
          }
          await tx.query(
            "INSERT INTO external_stock(organization_id,connection_id,warehouse_id,item_id,quantity,as_of) VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(connection_id,warehouse_id,item_id) DO UPDATE SET quantity=$5,as_of=now()",
            [
              conn.organization_id,
              conn.id,
              link.warehouse_id,
              item,
              String(row.stock),
            ],
          );
          stats.mirrored = (stats.mirrored || 0) + 1;
        }
        if (!recent) {
          // A full snapshot is authoritative: rows absent from it are zero, not unknown.
          await tx.query(
            "UPDATE external_stock SET quantity=0,as_of=now() WHERE connection_id=$1 AND as_of<now()",
            [conn.id],
          );
        }
        await tx.query(
          "INSERT INTO sync_cursors(connection_id,entity_type,cursor) VALUES($1,'stock',$2) ON CONFLICT(connection_id,entity_type) DO UPDATE SET cursor=$2,updated_at=CASE WHEN $3::boolean THEN sync_cursors.updated_at ELSE now() END",
          [
            conn.id,
            toMoscow(
              new Date(
                new Date(startedMsk.replace(" ", "T") + "+03:00").getTime() -
                  5 * 60_000,
              ),
            ),
            recent,
          ],
        );
      });
    });
  }
  // Public inbound endpoint: constant-time token check, size limit in the route, dedupe by requestId.
  async receiveWebhook(
    connectionId: string,
    token: string,
    requestId: string | null,
    body: unknown,
  ) {
    if (
      !idSchema.safeParse(connectionId).success ||
      !/^[a-f0-9]{64}$/.test(token)
    )
      throw new AppError("NOT_FOUND", 404);
    const [conn] = await this.db.query<Connection>(
      "SELECT * FROM integration_connections WHERE id=$1 AND provider='moysklad' AND disconnected_at IS NULL",
      [connectionId],
    );
    const expected = Buffer.from(
      conn?.webhook_token_hash || "0".repeat(64),
      "hex",
    );
    if (!conn || !timingSafeEqual(expected, Buffer.from(sha(token), "hex")))
      throw new AppError("NOT_FOUND", 404);
    const parsed = webhookBody.safeParse(body);
    if (!parsed.success) throw new AppError("INVALID_INPUT", 400);
    const eventId =
      requestId && /^[A-Za-z0-9-]{8,80}$/.test(requestId)
        ? requestId
        : sha(JSON.stringify(body));
    const added = await this.db.query(
      "INSERT INTO integration_inbox(id,organization_id,connection_id,external_event_id,payload,state) VALUES($1,$2,$3,$4,$5,'received') ON CONFLICT(connection_id,external_event_id) DO NOTHING RETURNING id",
      [
        randomUUID(),
        conn.organization_id,
        conn.id,
        eventId,
        JSON.stringify(parsed.data),
      ],
    );
    return { accepted: true, duplicate: !added.length };
  }
  async processInbox() {
    const items = await this.db.query<{
      id: string;
      connection_id: string;
      payload: { events: MsWebhookEvent[] };
      attempts: number;
    }>(
      "SELECT i.id,i.connection_id,i.payload,i.attempts FROM integration_inbox i JOIN integration_connections c ON c.id=i.connection_id AND c.provider='moysklad' WHERE i.state IN ('received','failed') AND i.attempts<5 ORDER BY i.received_at LIMIT 20",
    );
    let processed = 0;
    for (const item of items) {
      const [conn] = await this.db.query<Connection>(
        "SELECT * FROM integration_connections WHERE id=$1",
        [item.connection_id],
      );
      try {
        if (!conn.credentials)
          throw new AppError("INTEGRATION_NOT_CONFIGURED", 409);
        await this.run(conn, "webhook", async (client, stats) => {
          let kzt: string | null | undefined;
          for (const e of item.payload.events) {
            const id = entityIdFromHref(e.meta.href, "product");
            if (e.meta.type !== "product" || !id) {
              stats.ignored = (stats.ignored || 0) + 1;
              continue;
            }
            if (e.action === "DELETE") {
              await this.db.transaction(async (tx) => {
                const [m] = await tx.query<{ internal_id: string }>(
                  "SELECT internal_id FROM integration_mappings WHERE connection_id=$1 AND entity_type='product' AND external_id=$2 FOR UPDATE",
                  [conn.id, id],
                );
                if (!m) return;
                const [it] = await tx.query<{ version: number }>(
                  "SELECT version FROM catalog_items WHERE id=$1",
                  [m.internal_id],
                );
                const u = await new InventoryService(this.db).updateItemFields(
                  tx,
                  new InternalActor(conn.created_by, "integration"),
                  conn.organization_id,
                  m.internal_id,
                  it.version,
                  { active: false },
                );
                await tx.query(
                  "UPDATE integration_mappings SET state='deleted',local_version=$3,updated_at=now() WHERE connection_id=$1 AND entity_type='product' AND external_id=$2",
                  [conn.id, id, u.version],
                );
              });
              stats.deleted = (stats.deleted || 0) + 1;
              continue;
            }
            // The entity is re-read by id from the official API; the event body is not trusted.
            const product = await client.product(id);
            if (kzt === undefined) kzt = await kztCurrency(client);
            const outcome = await this.db.transaction((tx) =>
              this.applyProduct(tx, conn, product, kzt!),
            );
            stats[outcome] = (stats[outcome] || 0) + 1;
          }
        });
        await this.db.query(
          "UPDATE integration_inbox SET state='processed',processed_at=now(),attempts=attempts+1 WHERE id=$1",
          [item.id],
        );
        processed++;
      } catch (error) {
        await this.db.query(
          "UPDATE integration_inbox SET state='failed',attempts=attempts+1,error_code=$2 WHERE id=$1",
          [
            item.id,
            error instanceof AppError ? error.code : "INTEGRATION_FAILED",
          ],
        );
      }
    }
    return processed;
  }
  async resolve(
    secret: Credential,
    org: string,
    conflictId: string,
    input: unknown,
  ) {
    const c = conflictDecision.parse(input);
    idSchema.parse(conflictId);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      const [x] = await tx.query<{
        connection_id: string;
        external_id: string;
        internal_id: string | null;
        reason: string;
        remote: { name: string; updated: string; archived: boolean };
      }>(
        "SELECT x.connection_id,x.external_id,x.internal_id,x.reason,x.remote FROM sync_conflicts x JOIN integration_connections c ON c.id=x.connection_id AND c.provider='moysklad' WHERE x.organization_id=$1 AND x.id=$2 AND x.state='open' FOR UPDATE OF x",
        [org, conflictId],
      );
      if (!x) throw new AppError("NOT_FOUND", 404);
      const r = await idempotent(tx, org, c.key, {
        operation: "integration.resolve",
        conflictId,
        ...c,
      });
      if (r.reused) return r;
      if (x.reason === "local_modified" && x.internal_id) {
        const [item] = await tx.query<{ version: number }>(
          "SELECT version FROM catalog_items WHERE organization_id=$1 AND id=$2 FOR UPDATE",
          [org, x.internal_id],
        );
        let version = item.version;
        if (c.decision === "took_remote")
          version = (
            await new InventoryService(this.db).updateItemFields(
              tx,
              secret,
              org,
              x.internal_id,
              item.version,
              {
                name_ru: x.remote.name.slice(0, 120).padEnd(2, "."),
                active: !x.remote.archived,
              },
            )
          ).version;
        // Both decisions re-baseline the mapping so the next sync compares against this version.
        await tx.query(
          "UPDATE integration_mappings SET local_version=$3,external_updated=$4,updated_at=now() WHERE connection_id=$1 AND entity_type='product' AND external_id=$2",
          [x.connection_id, x.external_id, version, x.remote.updated],
        );
      } else if (c.decision === "took_remote")
        throw new AppError("CONFLICT_NEEDS_CATALOG_ACTION", 422);
      await tx.query(
        "UPDATE sync_conflicts SET state=$3,resolved_by=$4,resolved_at=now() WHERE organization_id=$1 AND id=$2",
        [org, conflictId, c.decision, s.actorId],
      );
      await audit(tx, org, s.actorId, "integration.conflict_resolved", null, {
        conflictId,
        decision: c.decision,
      });
      return r;
    });
  }
  // Legal entities and counterparties for the owner's explicit choices; nothing is matched by name.
  async parties(secret: Credential, org: string, id: string, input: unknown) {
    const q = partiesQuery.parse(input ?? {});
    const conn = await this.db.transaction(async (tx) => {
      await sessionAccess(tx, secret, org, "integrations:write");
      return this.connection(tx, org, id);
    });
    const r = await this.run(conn, "check", async (client, stats) => {
      const [organizations, counterparties] = [
        await client.organizations(),
        await client.counterparties(q.search),
      ];
      stats.organizations = organizations.length;
      stats.counterparties = counterparties.length;
      const pick = (x: { id: string; name: string; archived?: boolean }) => ({
        id: x.id,
        name: String(x.name).slice(0, 200),
        archived: Boolean(x.archived),
      });
      return {
        organizations: organizations.map(pick),
        counterparties: counterparties.map(pick),
      };
    });
    return r.result;
  }
  // Write-back is off until the owner turns it on for a chosen MoySklad legal entity.
  async configureSupply(
    secret: Credential,
    org: string,
    id: string,
    input: unknown,
  ) {
    const c = supplySettingsInput.parse(input);
    if (c.enabled) {
      // The entity must exist in the account (checked against the API, not trusted from input).
      const conn = await this.db.transaction(async (tx) => {
        await sessionAccess(tx, secret, org, "integrations:write");
        return this.connection(tx, org, id);
      });
      const r = await this.run(conn, "check", async (client) => ({
        organizations: await client.organizations(),
        kzt: await kztCurrency(client),
      }));
      if (
        !r.result.organizations.some(
          (o) => o.id === c.organizationId && !o.archived,
        )
      )
        throw new AppError("MOYSKLAD_ORGANIZATION_NOT_FOUND", 422);
      if (!r.result.kzt) throw new AppError("MOYSKLAD_NO_KZT_CURRENCY", 422);
    }
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      const conn = await this.connection(tx, org, id, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "integration.supply_settings",
        connectionId: id,
        ...c,
      });
      if (r.reused) return r;
      if (conn.disconnected_at || conn.status === "disconnected")
        throw new AppError("INTEGRATION_NOT_CONFIGURED", 409);
      if (conn.version !== c.version)
        throw new AppError("VERSION_CONFLICT", 409);
      await tx.query(
        "UPDATE integration_connections SET settings=jsonb_set(settings,'{supply}',$3::jsonb),version=version+1 WHERE organization_id=$1 AND id=$2",
        [
          org,
          id,
          JSON.stringify({
            enabled: c.enabled,
            organization_id: c.enabled ? c.organizationId : null,
            changed_by: s.actorId,
            changed_at: new Date().toISOString(),
          }),
        ],
      );
      await audit(tx, org, s.actorId, "integration.supply_settings", null, {
        connectionId: id,
        enabled: String(c.enabled),
      });
      return r;
    });
  }
  async mapCounterparty(
    secret: Credential,
    org: string,
    id: string,
    input: unknown,
  ) {
    const c = counterpartyInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      await this.connection(tx, org, id, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "integration.counterparty",
        connectionId: id,
        ...c,
      });
      if (r.reused) return r;
      const [supplier] = await tx.query(
        "SELECT id FROM suppliers WHERE organization_id=$1 AND id=$2",
        [org, c.supplierId],
      );
      if (!supplier) throw new AppError("NOT_FOUND", 404);
      await tx.query(
        "DELETE FROM integration_mappings WHERE connection_id=$1 AND entity_type='counterparty' AND internal_id=$2",
        [id, c.supplierId],
      );
      if (c.counterpartyId) {
        const added = await tx.query(
          "INSERT INTO integration_mappings(organization_id,connection_id,entity_type,external_id,internal_id,state) VALUES($1,$2,'counterparty',$3,$4,'active') ON CONFLICT DO NOTHING RETURNING internal_id",
          [org, id, c.counterpartyId, c.supplierId],
        );
        // One counterparty stands for one local supplier, so receipts are attributable.
        if (!added.length) throw new AppError("COUNTERPARTY_MAPPED", 409);
      }
      await audit(tx, org, s.actorId, "integration.counterparty_mapped", null, {
        connectionId: id,
        supplierId: c.supplierId,
        mapped: String(Boolean(c.counterpartyId)),
      });
      return r;
    });
  }
  // Worker: sends queued supplies. Lookup by externalCode first, so a timed-out POST that did
  // reach MoySklad is found instead of duplicated; POST itself is attempted once per tick.
  async processExports(limit = 10) {
    const due = await this.db.query<{
      id: string;
      organization_id: string;
      connection_id: string;
      attempts: number;
      expected_minor: string;
      created_by: string;
      payload: {
        organization: string;
        agent: string;
        store: string;
        order_number: string;
        note: string;
        positions: SupplyPosition[];
      };
    }>(
      "SELECT id,organization_id,connection_id,attempts,expected_minor::text,created_by,payload FROM integration_exports WHERE state IN ('pending','failed') AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT $1",
      [limit],
    );
    let sent = 0;
    for (const x of due) {
      const claimed = await this.db.query(
        "UPDATE integration_exports SET attempts=attempts+1,next_attempt_at=now()+interval '10 minutes' WHERE id=$1 AND state IN ('pending','failed') AND attempts=$2 RETURNING id",
        [x.id, x.attempts],
      );
      if (!claimed.length) continue;
      const [conn] = await this.db.query<Connection>(
        "SELECT * FROM integration_connections WHERE id=$1",
        [x.connection_id],
      );
      try {
        if (!supplySettings(conn.settings).enabled)
          throw new AppError("WRITEBACK_DISABLED", 409);
        await this.db.transaction(async (tx) => {
          const [scope] = await tx.query<{ branch_id: string }>(
            "SELECT w.branch_id FROM integration_exports e JOIN warehouses w ON w.organization_id=e.organization_id AND w.id=e.warehouse_id WHERE e.id=$1",
            [x.id],
          );
          if (!scope) throw new AppError("NOT_FOUND", 404);
          await actorAccess(
            tx,
            x.created_by,
            x.organization_id,
            "purchasing:write",
            scope.branch_id,
          );
        });
        const r = await this.run(conn, "export", async (client, stats) => {
          const code = externalCode(x.id);
          let supply = await client.supplyByExternalCode(code);
          if (supply) stats.found_existing = 1;
          else {
            const kzt = await kztCurrency(client);
            if (!kzt) throw new AppError("MOYSKLAD_NO_KZT_CURRENCY", 422);
            supply = await client.createSupply({
              externalCode: code,
              organization: client.meta("organization", x.payload.organization),
              agent: client.meta("counterparty", x.payload.agent),
              store: client.meta("store", x.payload.store),
              rate: { currency: client.meta("currency", kzt) },
              applicable: true,
              description:
                `Taraz: закупка №${x.payload.order_number}. ${x.payload.note}`.slice(
                  0,
                  4096,
                ),
              // JSON numbers are required by the API; values are formed from exact decimals.
              positions: x.payload.positions.map((p) => ({
                assortment: client.meta("product", p.product),
                quantity: Number(p.quantity),
                price: Number(unitPriceMinor(p.value_minor, p.quantity)),
              })),
            });
            stats.created = 1;
          }
          return supply;
        });
        const sum =
          typeof r.result.sum === "number" && Number.isFinite(r.result.sum)
            ? BigInt(Math.round(r.result.sum)).toString()
            : null;
        // The document sum is compared back; a rounding difference is shown, not hidden.
        const warning =
          sum === null
            ? "sum_not_returned"
            : sum !== x.expected_minor
              ? "sum_mismatch"
              : null;
        await this.db.transaction(async (tx) => {
          await tx.query(
            "UPDATE integration_exports SET state='sent',external_id=$2,external_sum_minor=$3,warning=$4,error_code=NULL,sent_at=now() WHERE id=$1",
            [x.id, r.result.id, sum, warning],
          );
          await audit(
            tx,
            x.organization_id,
            x.created_by,
            "integration.supply_sent",
            null,
            { exportId: x.id, warning: warning || "none" },
          );
        });
        sent++;
      } catch (error) {
        const code =
          error instanceof AppError ? error.code : "INTEGRATION_FAILED";
        // Request/config errors will not fix themselves; transient ones back off up to 8 tries.
        const permanent = [
          "FORBIDDEN",
          "MOYSKLAD_REQUEST_REJECTED",
          "MOYSKLAD_REQUEST_INVALID",
          "MOYSKLAD_NOT_FOUND",
          "MOYSKLAD_NO_KZT_CURRENCY",
        ].includes(code);
        const dead = permanent || x.attempts + 1 >= 8;
        await this.db.transaction(async (tx) => {
          await tx.query(
            "UPDATE integration_exports SET state=$2,error_code=$3,next_attempt_at=now()+make_interval(mins=>$4) WHERE id=$1",
            [
              x.id,
              dead ? "dead" : "failed",
              code,
              2 ** Math.min(x.attempts, 8),
            ],
          );
          if (dead)
            await audit(
              tx,
              x.organization_id,
              x.created_by,
              "integration.supply_dead",
              null,
              { exportId: x.id, code },
            );
        });
      }
    }
    return sent;
  }
  // Owner re-queues a dead export after fixing the cause (mapping, legal entity, currency).
  async retryExport(
    secret: Credential,
    org: string,
    exportId: string,
    input: unknown,
  ) {
    idSchema.parse(exportId);
    const c = z.object({ key: z.uuid() }).strict().parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      const r = await idempotent(tx, org, c.key, {
        operation: "integration.export_retry",
        exportId,
      });
      if (r.reused) return r;
      const rows = await tx.query(
        "UPDATE integration_exports SET state='pending',attempts=0,next_attempt_at=now(),error_code=NULL WHERE organization_id=$1 AND id=$2 AND state IN ('dead','failed') RETURNING id",
        [org, exportId],
      );
      if (!rows.length) throw new AppError("EXPORT_STATE", 409);
      await audit(tx, org, s.actorId, "integration.supply_retry", null, {
        exportId,
      });
      return r;
    });
  }
  // Worker: periodic sync of configured connections (stock every 15 min), and the inbox.
  async runOnce() {
    const due = await this.db.query<Connection>(
      "SELECT c.* FROM integration_connections c WHERE c.provider='moysklad' AND c.disconnected_at IS NULL AND c.credentials IS NOT NULL AND c.status<>'not_configured' AND NOT EXISTS(SELECT 1 FROM sync_runs r WHERE r.connection_id=c.id AND r.kind IN ('stock','incremental','initial') AND r.started_at>now()-interval '15 minutes') LIMIT 5",
    );
    for (const conn of due) {
      try {
        await this.syncProducts(conn);
        await this.syncStock(conn);
      } catch {
        // Recorded in sync_runs and on the connection; the next tick retries.
      }
    }
    return {
      synced: due.length,
      inbox: await this.processInbox(),
      exports: await this.processExports(),
    };
  }
}
