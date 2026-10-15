import { z } from "zod";
import type { Database, Sql } from "../db/database";
import {
  sessionAccess,
  actorAccess,
  InternalActor,
  type Credential,
} from "../access";
import { AppError } from "../../domain/errors";
import { InventoryService } from "../inventory/service";
import type { Fetch } from "./moysklad";
import {
  OneCClient,
  ONEC_CONTRACT,
  defaultOneC,
  validInfobaseUrl,
  validSettings,
  type OneCItem,
  type OneCSettings,
} from "./onec";
import {
  connectionFor,
  credentialsOf,
  disconnectConnection,
  dueConnections,
  markChecked,
  recordConflict,
  saveConnection,
  trackRun,
  type ConnectionRow,
} from "./common";

export const onecInput = z
  .object({
    key: z.uuid(),
    infobaseUrl: z.string().trim().max(300),
    user: z.string().trim().min(1).max(100),
    password: z.string().min(1).max(200),
    products: z.string().trim().max(90).default(defaultOneC.products),
    units: z.string().trim().max(90).default(defaultOneC.units),
    unitField: z.string().trim().max(90).default(defaultOneC.unitField),
    skuField: z.string().trim().max(90).default(defaultOneC.skuField),
  })
  .strict();
type Secrets = { infobaseUrl: string; user: string; password: string };
// OKEI codes of the unit classifier → catalogue base units; anything else needs a person.
const OKEI: Record<string, "pc" | "kg" | "l" | "m" | "hour"> = {
  "796": "pc",
  "166": "kg",
  "112": "l",
  "006": "m",
  "356": "hour",
};
const ownership = {
  catalog_imported: "external",
  stock: "internal",
  purchases: "internal",
};
export class OneCService {
  constructor(
    private db: Database,
    private client: (s: Secrets) => OneCClient = (s) =>
      new OneCClient(s.infobaseUrl, s.user, s.password),
    private live = true,
  ) {}
  static forContractServer(db: Database, fetcher: Fetch) {
    return new OneCService(
      db,
      (s) =>
        new OneCClient(
          s.infobaseUrl,
          s.user,
          s.password,
          fetcher,
          async () => {},
          async () => true,
        ),
      false,
    );
  }
  async configure(secret: Credential, org: string, input: unknown) {
    const c = onecInput.parse(input);
    const settings: OneCSettings = {
      products: c.products,
      units: c.units,
      unitField: c.unitField,
      skuField: c.skuField,
    };
    if (!validInfobaseUrl(c.infobaseUrl))
      throw new AppError("ONEC_URL_INVALID", 422);
    if (!validSettings(settings))
      throw new AppError("ONEC_SETTINGS_INVALID", 422);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      return saveConnection(tx, {
        org,
        actorId: s.actorId,
        key: c.key,
        provider: "onec",
        credentials: {
          infobaseUrl: c.infobaseUrl,
          user: c.user,
          password: c.password,
        },
        hint: `${new URL(c.infobaseUrl).host} · ${c.user}`,
        settings,
        ownership,
        contract: ONEC_CONTRACT,
        inbound: false,
      });
    });
  }
  private async load(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      await sessionAccess(tx, secret, org, "integrations:write");
      return connectionFor(tx, org, id, "onec");
    });
  }
  private settings(conn: ConnectionRow) {
    return { ...defaultOneC, ...(conn.settings as Partial<OneCSettings>) };
  }
  // Both configured objects must exist in this infobase and be readable by the 1C user.
  async check(secret: Credential, org: string, id: string) {
    const conn = await this.load(secret, org, id);
    const client = this.client(credentialsOf<Secrets>(conn)),
      s = this.settings(conn);
    const r = await trackRun(this.db, conn, "check", async () => {
      await client.probe(s.products);
      await client.probe(s.units);
    });
    await markChecked(this.db, conn, r.runId, this.live, client.host);
    return { ok: true };
  }
  async syncNow(secret: Credential, org: string, id: string) {
    const conn = await this.load(secret, org, id);
    return (await this.syncProducts(conn)).stats;
  }
  // Full ordered scan: unchanged DataVersion is skipped, so a rerun applies nothing twice.
  async syncProducts(conn: ConnectionRow) {
    const client = this.client(credentialsOf<Secrets>(conn)),
      s = this.settings(conn);
    const [seenBefore] = await this.db.query<{ n: number }>(
      "SELECT count(*)::int n FROM integration_mappings WHERE connection_id=$1 AND entity_type='product'",
      [conn.id],
    );
    return trackRun(
      this.db,
      conn,
      seenBefore.n ? "incremental" : "initial",
      async (stats) => {
        const units = new Map<string, string>();
        for await (const page of client.list(s.units, [
          "Ref_Key",
          "DataVersion",
          "DeletionMark",
          "Code",
        ]))
          for (const u of page)
            if (u.Code) units.set(u.Ref_Key, String(u.Code).trim());
        const seen = new Set<string>();
        for await (const page of client.list(s.products, [
          "Ref_Key",
          "DataVersion",
          "DeletionMark",
          "IsFolder",
          "Code",
          "Description",
          s.skuField,
          s.unitField,
        ]))
          await this.db.transaction(async (tx) => {
            for (const p of page) {
              if (p.IsFolder) continue;
              seen.add(p.Ref_Key);
              const outcome = await this.apply(tx, conn, s, units, p);
              stats[outcome] = (stats[outcome] || 0) + 1;
            }
          });
        // Only after a complete scan: products that disappeared are archived here, not deleted.
        await this.db.transaction(async (tx) => {
          const gone = await tx.query<{
            external_id: string;
            internal_id: string;
            local_version: number;
          }>(
            "SELECT external_id,internal_id,local_version FROM integration_mappings WHERE connection_id=$1 AND entity_type='product' AND state<>'deleted' FOR UPDATE",
            [conn.id],
          );
          for (const g of gone.filter((x) => !seen.has(x.external_id))) {
            const [item] = await tx.query<{ version: number }>(
              "SELECT version FROM catalog_items WHERE organization_id=$1 AND id=$2 FOR UPDATE",
              [conn.organization_id, g.internal_id],
            );
            let version = item.version;
            if (item.version === g.local_version)
              version = (
                await new InventoryService(this.db).updateItemFields(
                  tx,
                  new InternalActor(conn.created_by, "integration"),
                  conn.organization_id,
                  g.internal_id,
                  item.version,
                  { active: false },
                )
              ).version;
            await tx.query(
              "UPDATE integration_mappings SET state='deleted',local_version=$3,updated_at=now() WHERE connection_id=$1 AND entity_type='product' AND external_id=$2",
              [conn.id, g.external_id, version],
            );
            stats.removed = (stats.removed || 0) + 1;
          }
        });
      },
    );
  }
  private async apply(
    tx: Sql,
    conn: ConnectionRow,
    s: OneCSettings,
    units: Map<string, string>,
    p: OneCItem,
  ) {
    const org = conn.organization_id,
      actor = new InternalActor(conn.created_by, "integration");
    await actorAccess(tx, conn.created_by, org, "catalog:write");
    const okei = units.get(String(p[s.unitField] || "")) || null,
      unit = okei ? OKEI[okei] || null : null,
      name = String(p.Description || "")
        .trim()
        .slice(0, 120)
        .padEnd(2, "."),
      remote = {
        ref: p.Ref_Key,
        name,
        code: p.Code || null,
        okei,
        dataVersion: p.DataVersion,
        deleted: p.DeletionMark,
      };
    const [m] = await tx.query<{
      internal_id: string;
      external_updated: string | null;
      local_version: number | null;
    }>(
      "SELECT internal_id,external_updated,local_version FROM integration_mappings WHERE connection_id=$1 AND entity_type='product' AND external_id=$2 FOR UPDATE",
      [conn.id, p.Ref_Key],
    );
    if (m && m.external_updated === p.DataVersion) return "unchanged";
    if (!m) {
      if (p.DeletionMark) return "skipped_deleted";
      if (!unit)
        return recordConflict(
          tx,
          conn,
          "product",
          p.Ref_Key,
          null,
          "unit_unmapped",
          null,
          remote,
        );
      const sku = String(p[s.skuField] || p.Code || p.Ref_Key)
        .trim()
        .replace(/[^\p{L}\p{N}_.:-]/gu, "-")
        .slice(0, 60);
      const [taken] = await tx.query<{ id: string }>(
        "SELECT id FROM catalog_items WHERE organization_id=$1 AND sku=$2",
        [org, sku],
      );
      if (taken)
        return recordConflict(
          tx,
          conn,
          "product",
          p.Ref_Key,
          taken.id,
          "sku_exists",
          { sku },
          remote,
        );
      const created = await new InventoryService(this.db).saveItemInTransaction(
        tx,
        actor,
        org,
        {
          sku,
          name_ru: name,
          kind: "goods",
          base_unit: unit,
          // Prices live in 1C price registers; they are not read, so they stay unknown, not 0.
          purchase_price: null,
          sale_price: null,
          category: "1С",
        },
      );
      await tx.query(
        "INSERT INTO integration_mappings(organization_id,connection_id,entity_type,external_id,internal_id,external_updated,local_version,state) VALUES($1,$2,'product',$3,$4,$5,1,'active')",
        [org, conn.id, p.Ref_Key, created.id, p.DataVersion],
      );
      return "created";
    }
    const [item] = await tx.query<{
      version: number;
      name_ru: string;
      base_unit: string;
    }>(
      "SELECT version,name_ru,base_unit FROM catalog_items WHERE organization_id=$1 AND id=$2 FOR UPDATE",
      [org, m.internal_id],
    );
    if (item.version !== m.local_version)
      return recordConflict(
        tx,
        conn,
        "product",
        p.Ref_Key,
        m.internal_id,
        "local_modified",
        { name: item.name_ru, version: item.version },
        remote,
      );
    if (unit && unit !== item.base_unit)
      return recordConflict(
        tx,
        conn,
        "product",
        p.Ref_Key,
        m.internal_id,
        "unit_changed",
        { base_unit: item.base_unit },
        remote,
      );
    const next = await new InventoryService(this.db).updateItemFields(
      tx,
      actor,
      org,
      m.internal_id,
      item.version,
      {
        name_ru: name,
        active: !p.DeletionMark,
      },
    );
    await tx.query(
      "UPDATE integration_mappings SET external_updated=$3,local_version=$4,state=$5,updated_at=now() WHERE connection_id=$1 AND entity_type='product' AND external_id=$2",
      [
        conn.id,
        p.Ref_Key,
        p.DataVersion,
        next.version,
        p.DeletionMark ? "archived" : "active",
      ],
    );
    return p.DeletionMark ? "archived" : "updated";
  }
  async resolve(
    secret: Credential,
    org: string,
    conflictId: string,
    input: unknown,
  ) {
    const c = z
      .object({
        key: z.uuid(),
        decision: z.enum(["kept_local", "took_remote"]),
      })
      .strict()
      .parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      const [x] = await tx.query<{
        connection_id: string;
        external_id: string;
        internal_id: string | null;
        reason: string;
        remote: { name: string; dataVersion: string; deleted: boolean };
      }>(
        "SELECT x.connection_id,x.external_id,x.internal_id,x.reason,x.remote FROM sync_conflicts x JOIN integration_connections c ON c.id=x.connection_id AND c.provider='onec' WHERE x.organization_id=$1 AND x.id=$2 AND x.state='open' FOR UPDATE OF x",
        [org, conflictId],
      );
      if (!x) throw new AppError("NOT_FOUND", 404);
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
                name_ru: x.remote.name,
                active: !x.remote.deleted,
              },
            )
          ).version;
        await tx.query(
          "UPDATE integration_mappings SET local_version=$3,external_updated=$4,updated_at=now() WHERE connection_id=$1 AND entity_type='product' AND external_id=$2",
          [x.connection_id, x.external_id, version, x.remote.dataVersion],
        );
      } else if (c.decision === "took_remote")
        throw new AppError("CONFLICT_NEEDS_CATALOG_ACTION", 422);
      await tx.query(
        "UPDATE sync_conflicts SET state=$3,resolved_by=$4,resolved_at=now() WHERE organization_id=$1 AND id=$2",
        [org, conflictId, c.decision, s.actorId],
      );
      return { ok: true };
    });
  }
  async disconnect(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      await disconnectConnection(
        tx,
        org,
        s.actorId,
        await connectionFor(tx, org, id, "onec", true),
      );
      return { ok: true };
    });
  }
  // A full scan costs the 1C server more than a cursor read: at most every 60 minutes.
  async runOnce() {
    for (const conn of await dueConnections(this.db, "onec", 60))
      await this.syncProducts(conn).catch(() => undefined);
    return {};
  }
}
