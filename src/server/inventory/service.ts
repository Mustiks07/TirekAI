import { randomUUID, createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { Database, Sql } from "../db/database";
import { sessionAccess, audit, type Credential } from "../access";
import { AppError } from "../../domain/errors";
import { can, type Permission } from "../../domain/permissions";
import { idSchema } from "../../domain/contracts";
import {
  itemInput,
  itemUpdate,
  catalogQuery,
  warehouseInput,
  stockCommand,
  stockQuery,
  toBase,
  allocatedValue,
  type CatalogInput,
  type Item,
  type Warehouse,
} from "../../domain/inventory";
import { pagination, pageQuery } from "../../domain/import-contracts";
import { lineAmount } from "../../domain/decimal";
import { applyLots, type LotContext } from "./lots";
const D = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP });
type Scope = Awaited<ReturnType<typeof sessionAccess>>;
type Balance = {
  quantity: string;
  reserved: string;
  value_minor: string;
  version: number;
};
const itemColumns =
  "id,sku,name_ru,name_kk,category,variant,barcode,kind,base_unit,conversions,sale_price::text,active,version";
function validateItem(item: CatalogInput) {
  if (
    new Set(item.conversions.map((c) => c.unit)).size !==
      item.conversions.length ||
    item.conversions.some((c) => c.unit === item.base_unit)
  )
    throw new AppError("UNIT_DUPLICATE", 422);
  if (item.kind === "goods" && item.base_unit === "hour")
    throw new AppError("UNIT_NOT_ALLOWED", 422);
}
function conflict(error: unknown): never {
  if ((error as { code?: string }).code === "23505")
    throw new AppError("ITEM_EXISTS", 409);
  throw error;
}
export class InventoryService {
  constructor(private db: Database) {}
  async catalog(secret: Credential, org: string, input: unknown = {}) {
    const q = catalogQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const scope = await sessionAccess(tx, secret, org, "catalog:read"),
        cost = can(scope.role, "inventory:cost");
      const where =
        "organization_id=$1 AND ($2='' OR position(lower($2) in lower(sku||' '||name_ru||' '||name_kk||' '||barcode))>0)";
      const [count] = await tx.query<{ total: number }>(
        `SELECT count(*)::int total FROM catalog_items WHERE ${where}`,
        [org, q.q],
      );
      const items = await tx.query<Item>(
        `SELECT ${itemColumns}${cost ? ",purchase_price::text" : ""} FROM catalog_items WHERE ${where} ORDER BY sku,id LIMIT $3 OFFSET $4`,
        [org, q.q, q.limit, (q.page - 1) * q.limit],
      );
      return {
        items,
        pagination: pagination(q.page, q.limit, count.total),
        canWrite: can(scope.role, "catalog:write") && !scope.branchId,
        canReadCost: cost,
      };
    });
  }
  async saveItem(secret: Credential, org: string, input: unknown, id?: string) {
    try {
      return await this.db.transaction((tx) =>
        this.saveItemInTransaction(tx, secret, org, input, id),
      );
    } catch (e) {
      conflict(e);
    }
  }
  // Internal composition (integrations): same validation, rights and audit, caller's transaction.
  async saveItemInTransaction(
    tx: Sql,
    secret: Credential,
    org: string,
    input: unknown,
    id?: string,
  ) {
    if (id) idSchema.parse(id);
    const data = id ? itemUpdate.parse(input) : itemInput.parse(input);
    validateItem(data);
    const scope = await sessionAccess(tx, secret, org, "catalog:write");
    // A branch manager cannot mutate the shared organization-wide catalogue.
    if (scope.branchId) throw new AppError("FORBIDDEN", 403);
    const values = [
      data.sku,
      data.name_ru,
      data.name_kk,
      data.category,
      data.variant,
      data.barcode,
      data.kind,
      data.base_unit,
      JSON.stringify(data.conversions),
      data.purchase_price,
      data.sale_price,
      data.active,
    ];
    if (id) {
      const [old] = await tx.query<Item>(
        `SELECT ${itemColumns},purchase_price::text FROM catalog_items WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
        [org, id],
      );
      if (!old) throw new AppError("NOT_FOUND", 404);
      if (old.version !== ("version" in data ? data.version : undefined))
        throw new AppError("VERSION_CONFLICT", 409);
      const unitsChanged =
        old.base_unit !== data.base_unit ||
        old.kind !== data.kind ||
        JSON.stringify(old.conversions) !== JSON.stringify(data.conversions);
      if (
        unitsChanged &&
        (
          await tx.query(
            "SELECT id FROM stock_commands WHERE organization_id=$1 AND item_id=$2 UNION ALL SELECT id FROM sales_order_lines WHERE organization_id=$1 AND item_id=$2 UNION ALL SELECT id FROM supplier_offers WHERE organization_id=$1 AND item_id=$2 UNION ALL SELECT quote_id id FROM quote_items WHERE organization_id=$1 AND item_id=$2 UNION ALL SELECT document_id id FROM industry_item_links WHERE organization_id=$1 AND item_id=$2 LIMIT 1",
            [org, id],
          )
        ).length
      )
        throw new AppError("UNIT_LOCKED", 409);
      await tx.query(
        "UPDATE catalog_items SET sku=$3,name_ru=$4,name_kk=$5,category=$6,variant=$7,barcode=$8,kind=$9,base_unit=$10,conversions=$11,purchase_price=$12,sale_price=$13,active=$14,version=version+1 WHERE organization_id=$1 AND id=$2",
        [org, id, ...values],
      );
    } else {
      id = randomUUID();
      await tx.query(
        "INSERT INTO catalog_items(organization_id,id,sku,name_ru,name_kk,category,variant,barcode,kind,base_unit,conversions,purchase_price,sale_price,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        [org, id, ...values],
      );
    }
    await audit(tx, org, scope.actorId, "catalog.saved", null, {
      itemId: id,
    });
    return { id: id! };
  }
  async updateItemFields(
    tx: Sql,
    secret: Credential,
    org: string,
    id: string,
    version: number,
    patch: {
      name_ru?: string;
      active?: boolean;
      purchase_price?: string;
      sale_price?: string;
    },
  ) {
    const [old] = await tx.query<Item & { purchase_price: string | null }>(
      `SELECT ${itemColumns},purchase_price::text FROM catalog_items WHERE organization_id=$1 AND id=$2`,
      [org, id],
    );
    if (!old) throw new AppError("NOT_FOUND", 404);
    await this.saveItemInTransaction(
      tx,
      secret,
      org,
      {
        sku: old.sku,
        name_ru: patch.name_ru ?? old.name_ru,
        name_kk: old.name_kk,
        category: old.category,
        variant: old.variant,
        barcode: old.barcode,
        kind: old.kind,
        base_unit: old.base_unit,
        conversions: old.conversions,
        purchase_price: patch.purchase_price ?? old.purchase_price,
        sale_price: patch.sale_price ?? old.sale_price,
        active: patch.active ?? old.active,
        version,
      },
      id,
    );
    return { version: version + 1 };
  }
  async warehouses(secret: Credential, org: string, input: unknown = {}) {
    const q = pageQuery.pick({ branchId: true }).parse(input);
    return this.db.transaction(async (tx) => {
      const scope = await sessionAccess(
        tx,
        secret,
        org,
        "inventory:read",
        q.branchId,
      );
      return {
        items: await tx.query<Warehouse>(
          "SELECT id,branch_id,name FROM warehouses WHERE organization_id=$1 AND ($2::uuid IS NULL OR branch_id=$2) ORDER BY name,id",
          [org, scope.branchId],
        ),
      };
    });
  }
  async createWarehouse(secret: Credential, org: string, input: unknown) {
    const data = warehouseInput.parse(input);
    try {
      return await this.db.transaction(async (tx) => {
        const scope = await sessionAccess(
          tx,
          secret,
          org,
          "inventory:write",
          data.branchId,
        );
        await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
          org,
        ]);
        const [count] = await tx.query<{ n: number }>(
          "SELECT count(*)::int n FROM warehouses WHERE organization_id=$1",
          [org],
        );
        if (count.n >= 100) throw new AppError("WAREHOUSE_LIMIT", 409);
        const id = randomUUID();
        await tx.query(
          "INSERT INTO warehouses(id,organization_id,branch_id,name) VALUES($1,$2,$3,$4)",
          [id, org, data.branchId, data.name],
        );
        await audit(
          tx,
          org,
          scope.actorId,
          "warehouse.created",
          data.branchId,
          { warehouseId: id },
        );
        return { id };
      });
    } catch (e) {
      conflict(e);
    }
  }
  private async warehouse(tx: Sql, org: string, id: string, scope: Scope) {
    const [warehouse] = await tx.query<Warehouse>(
      "SELECT id,branch_id,name FROM warehouses WHERE organization_id=$1 AND id=$2 AND ($3::uuid IS NULL OR branch_id=$3)",
      [org, id, scope.branchId],
    );
    if (!warehouse) throw new AppError("NOT_FOUND", 404);
    return warehouse;
  }
  async view(
    secret: Credential,
    org: string,
    section: "balances" | "movements" | "reservations" | "transfers",
    input: unknown,
  ) {
    const q = stockQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const scope = await sessionAccess(tx, secret, org, "inventory:read");
      await this.warehouse(tx, org, q.warehouseId, scope);
      const cost = can(scope.role, "inventory:cost");
      const tables = {
        balances: "stock_balances",
        movements: "stock_movements",
        reservations: "stock_reservations",
        transfers: "stock_transfers",
      };
      const where =
        section === "transfers"
          ? "s.organization_id=$1 AND (s.source_id=$2 OR s.destination_id=$2) AND ($5::uuid IS NULL OR (ws.branch_id=$5 AND wd.branch_id=$5))"
          : "s.organization_id=$1 AND s.warehouse_id=$2";
      const joins =
        section === "transfers"
          ? " JOIN warehouses ws ON ws.organization_id=s.organization_id AND ws.id=s.source_id JOIN warehouses wd ON wd.organization_id=s.organization_id AND wd.id=s.destination_id"
          : "";
      const countWhere = where.replaceAll("$5", "$3");
      const [count] = await tx.query<{ total: number }>(
        `SELECT count(*)::int total FROM ${tables[section]} s${joins} WHERE ${countWhere}`,
        [
          org,
          q.warehouseId,
          ...(section === "transfers" ? [scope.branchId] : []),
        ],
      );
      const fields = {
        balances: `s.item_id,i.sku,i.name_ru,i.name_kk,i.base_unit,s.quantity::text,s.reserved::text,(s.quantity-s.reserved)::text available,s.version${cost ? ",s.value_minor::text" : ""}`,
        movements: `s.id,s.item_id,i.sku,i.base_unit,s.kind,s.quantity::text,s.note,s.created_at,s.source_id,s.transfer_id${cost ? ",s.value_minor::text" : ""}`,
        reservations:
          "s.id,s.item_id,i.sku,i.base_unit,s.quantity::text,s.status,s.note",
        transfers:
          "s.id,s.item_id,i.sku,i.base_unit,s.source_id,s.destination_id,wd.name destination_name,s.quantity::text,s.state,s.note",
      };
      const order =
        section === "balances"
          ? "i.sku,s.item_id"
          : "s.created_at DESC,s.id DESC";
      const items = await tx.query(
        `SELECT ${fields[section]} FROM ${tables[section]} s JOIN catalog_items i ON i.organization_id=s.organization_id AND i.id=s.item_id${joins} WHERE ${where} ORDER BY ${order} LIMIT $3 OFFSET $4`,
        [
          org,
          q.warehouseId,
          q.limit,
          (q.page - 1) * q.limit,
          ...(section === "transfers" ? [scope.branchId] : []),
        ],
      );
      return { items, pagination: pagination(q.page, q.limit, count.total) };
    });
  }
  async execute(secret: Credential, org: string, input: unknown) {
    return this.db.transaction((tx) =>
      this.executeInTransaction(tx, secret, org, input),
    );
  }
  // Internal composition only: HTTP callers cannot provide linkedOrderId.
  async executeInTransaction(
    tx: Sql,
    secret: Credential,
    org: string,
    input: unknown,
    linkedOrderId?: string,
    receiptValueMinor?: bigint,
    lotContext?: LotContext,
  ) {
    const c = stockCommand.parse(input);
    const permission: Permission = [
      "issue",
      "reserve",
      "release",
      "return",
    ].includes(c.kind)
      ? "inventory:sell"
      : "inventory:write";
    if (
      receiptValueMinor !== undefined &&
      (c.kind !== "receipt" ||
        receiptValueMinor < 0n ||
        receiptValueMinor >= 10n ** 38n)
    )
      throw new AppError("INVALID_INPUT", 422);
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          ...c,
          ...(receiptValueMinor === undefined
            ? {}
            : { receiptValueMinor: receiptValueMinor.toString() }),
          ...(lotContext ? { industry: lotContext } : {}),
        }),
      )
      .digest("hex");
    {
      const scope = await sessionAccess(tx, secret, org, permission),
        warehouse = await this.warehouse(tx, org, c.warehouseId, scope);
      const source =
        "reservationId" in c
          ? c.reservationId
          : "movementId" in c
            ? c.movementId
            : undefined;
      if (source) {
        const [operation] = await tx.query<{ document_id: string }>(
          "SELECT document_id FROM industry_stock_links WHERE organization_id=$1 AND movement_id=$2",
          [org, source],
        );
        if (operation && operation.document_id !== lotContext?.documentId)
          throw new AppError("INDUSTRY_OPERATION_REQUIRED", 409);
        const [link] = await tx.query<{ order_id: string }>(
          "SELECT order_id FROM order_stock_links WHERE organization_id=$1 AND object_id=$2",
          [org, source],
        );
        if (link && link.order_id !== linkedOrderId)
          throw new AppError("ORDER_OPERATION_REQUIRED", 409);
      }
      if (c.kind === "dispatch")
        await this.warehouse(tx, org, c.destinationId, scope);
      // A warehouse whose stock is owned by an external system (T030) is a read-only mirror:
      // local receipts, issues, reservations and counts would create a second, diverging balance.
      if (
        (
          await tx.query(
            "SELECT warehouse_id FROM integration_warehouse_links WHERE organization_id=$1 AND warehouse_id=ANY($2::uuid[])",
            [
              org,
              [
                c.warehouseId,
                ...(c.kind === "dispatch" ? [c.destinationId] : []),
              ],
            ],
          )
        ).length
      )
        throw new AppError("EXTERNAL_SOURCE_OF_TRUTH", 409);
      const [item] = await tx.query<Item>(
        `SELECT ${itemColumns} FROM catalog_items WHERE organization_id=$1 AND id=$2 FOR SHARE`,
        [org, c.itemId],
      );
      if (!item) throw new AppError("NOT_FOUND", 404);
      const commandId = randomUUID();
      const inserted = await tx.query(
        "INSERT INTO stock_commands(id,organization_id,warehouse_id,item_id,request_key,payload_hash,kind) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,request_key) DO NOTHING RETURNING id",
        [commandId, org, c.warehouseId, c.itemId, c.key, hash, c.kind],
      );
      if (!inserted.length) {
        const [prior] = await tx.query<{
          payload_hash: string;
          result: { id: string; kind: string };
        }>(
          "SELECT payload_hash,result FROM stock_commands WHERE organization_id=$1 AND request_key=$2",
          [org, c.key],
        );
        if (prior.payload_hash !== hash)
          throw new AppError("IDEMPOTENCY_CONFLICT", 409);
        return { ...prior.result, reused: true };
      }
      if (item.kind !== "goods") throw new AppError("SERVICE_NO_STOCK", 422);
      if (!item.active && !["return", "receive", "release"].includes(c.kind))
        throw new AppError("ITEM_ARCHIVED", 409);
      await tx.query(
        "INSERT INTO stock_balances(organization_id,warehouse_id,item_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [org, c.warehouseId, c.itemId],
      );
      const [b] = await tx.query<Balance>(
        "SELECT quantity::text,reserved::text,value_minor::text,version FROM stock_balances WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3 FOR UPDATE",
        [org, c.warehouseId, c.itemId],
      );
      let qty = "0",
        value = 0n,
        reserved = new D(b.reserved),
        resultId: string = randomUUID(),
        sourceId: string | null = null;
      const amount = "quantity" in c ? toBase(c.quantity, c.unit, item) : "0";
      const available = new D(b.quantity).minus(b.reserved);
      const requireAvailable = (q: string) => {
        if (available.lt(q)) throw new AppError("INSUFFICIENT_STOCK", 409);
      };
      if (c.kind === "receipt") {
        qty = amount;
        value = receiptValueMinor ?? lineAmount(c.unitCost, c.quantity);
      }
      if (c.kind === "issue" || c.kind === "dispatch") {
        if (c.kind === "issue" && c.reservationId) {
          const [r] = await tx.query<{ quantity: string; status: string }>(
            "SELECT quantity::text,status FROM stock_reservations WHERE organization_id=$1 AND id=$2 AND warehouse_id=$3 AND item_id=$4 FOR UPDATE",
            [org, c.reservationId, c.warehouseId, c.itemId],
          );
          if (!r || r.status !== "active" || !new D(r.quantity).eq(amount))
            throw new AppError("RESERVATION_MISMATCH", 409);
          reserved = reserved.minus(amount);
          await tx.query(
            "UPDATE stock_reservations SET status='fulfilled' WHERE organization_id=$1 AND id=$2",
            [org, c.reservationId],
          );
        } else requireAvailable(amount);
        qty = new D(amount).negated().toFixed();
        value = -allocatedValue(BigInt(b.value_minor), amount, b.quantity);
        if (c.kind === "dispatch") {
          if (c.destinationId === c.warehouseId)
            throw new AppError("SAME_WAREHOUSE", 422);
          await tx.query(
            "INSERT INTO stock_transfers(id,organization_id,item_id,source_id,destination_id,quantity,value_minor,state,note) VALUES($1,$2,$3,$4,$5,$6,$7,'in_transit',$8)",
            [
              resultId,
              org,
              c.itemId,
              c.warehouseId,
              c.destinationId,
              amount,
              (-value).toString(),
              c.note,
            ],
          );
        }
      }
      if (c.kind === "reserve") {
        requireAvailable(amount);
        reserved = reserved.plus(amount);
        await tx.query(
          "INSERT INTO stock_reservations(id,organization_id,warehouse_id,item_id,quantity,status,note) VALUES($1,$2,$3,$4,$5,'active',$6)",
          [resultId, org, c.warehouseId, c.itemId, amount, c.note],
        );
      }
      if (c.kind === "release") {
        const [r] = await tx.query<{ quantity: string; status: string }>(
          "SELECT quantity::text,status FROM stock_reservations WHERE organization_id=$1 AND id=$2 AND warehouse_id=$3 AND item_id=$4 FOR UPDATE",
          [org, c.reservationId, c.warehouseId, c.itemId],
        );
        if (!r || r.status !== "active")
          throw new AppError("RESERVATION_MISMATCH", 409);
        reserved = reserved.minus(r.quantity);
        await tx.query(
          "UPDATE stock_reservations SET status='released' WHERE organization_id=$1 AND id=$2",
          [org, c.reservationId],
        );
        resultId = c.reservationId;
      }
      if (c.kind === "receive") {
        const [t] = await tx.query<{
          quantity: string;
          value_minor: string;
          state: string;
          source_id: string;
        }>(
          "SELECT quantity::text,value_minor::text,state,source_id FROM stock_transfers WHERE organization_id=$1 AND id=$2 AND destination_id=$3 AND item_id=$4 FOR UPDATE",
          [org, c.transferId, c.warehouseId, c.itemId],
        );
        if (!t || t.state !== "in_transit")
          throw new AppError("TRANSFER_STATE", 409);
        await this.warehouse(tx, org, t.source_id, scope);
        qty = t.quantity;
        value = BigInt(t.value_minor);
        resultId = c.transferId;
        await tx.query(
          "UPDATE stock_transfers SET state='received' WHERE organization_id=$1 AND id=$2",
          [org, c.transferId],
        );
      }
      if (c.kind === "count") {
        if (c.version !== b.version)
          throw new AppError("VERSION_CONFLICT", 409);
        if (new D(amount).lt(reserved))
          throw new AppError("COUNT_BELOW_RESERVED", 409);
        qty = new D(amount).minus(b.quantity).toFixed();
        if (new D(qty).lt(0))
          value = -allocatedValue(
            BigInt(b.value_minor),
            new D(qty).negated().toFixed(),
            b.quantity,
          );
        else if (new D(qty).gt(0)) {
          if (c.unitCost === undefined)
            throw new AppError("COUNT_COST_REQUIRED", 422);
          // Count valuation is explicitly per base unit, unlike receipt cost per selected unit.
          value = lineAmount(c.unitCost, qty);
        }
      }
      if (c.kind === "return") {
        const [original] = await tx.query<{
          quantity: string;
          value_minor: string;
        }>(
          "SELECT quantity::text,value_minor::text FROM stock_movements WHERE organization_id=$1 AND id=$2 AND warehouse_id=$3 AND item_id=$4 AND kind='issue' FOR UPDATE",
          [org, c.movementId, c.warehouseId, c.itemId],
        );
        if (!original) throw new AppError("RETURN_SOURCE", 404);
        const [returned] = await tx.query<{
          quantity: string;
          value_minor: string;
        }>(
          "SELECT coalesce(sum(quantity),0)::text quantity,coalesce(sum(value_minor),0)::text value_minor FROM stock_movements WHERE organization_id=$1 AND source_id=$2 AND kind='return'",
          [org, c.movementId],
        );
        const remaining = new D(original.quantity)
          .negated()
          .minus(returned.quantity);
        if (new D(amount).gt(remaining))
          throw new AppError("RETURN_EXCEEDS", 409);
        const cost = -BigInt(original.value_minor),
          remainingCost = cost - BigInt(returned.value_minor);
        // Allocate original cost cumulatively; the final return restores the exact remainder.
        value = new D(amount).eq(remaining)
          ? remainingCost
          : allocatedValue(
              cost,
              new D(returned.quantity).plus(amount).toFixed(),
              new D(original.quantity).negated().toFixed(),
            ) - BigInt(returned.value_minor);
        qty = amount;
        sourceId = c.movementId;
      }
      const newQty = new D(b.quantity).plus(qty),
        newValue = BigInt(b.value_minor) + value;
      if (newQty.lt(0) || newQty.lt(reserved))
        throw new AppError("INSUFFICIENT_STOCK", 409);
      if (newQty.gte("1000000000000000") || newValue >= 10n ** 38n)
        throw new AppError("STOCK_LIMIT", 422);
      await tx.query(
        "UPDATE stock_balances SET quantity=$4,reserved=$5,value_minor=$6,version=version+1 WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3",
        [
          org,
          c.warehouseId,
          c.itemId,
          newQty.toFixed(),
          reserved.toFixed(),
          newValue.toString(),
        ],
      );
      if (!["reserve", "release"].includes(c.kind)) {
        const movementId = ["dispatch", "receive"].includes(c.kind)
          ? randomUUID()
          : resultId;
        await tx.query(
          "INSERT INTO stock_movements(id,organization_id,warehouse_id,item_id,command_id,kind,quantity,value_minor,source_id,note,actor_id,transfer_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [
            movementId,
            org,
            c.warehouseId,
            c.itemId,
            commandId,
            c.kind,
            qty,
            value.toString(),
            sourceId,
            c.note,
            scope.actorId,
            ["dispatch", "receive"].includes(c.kind) ? resultId : null,
          ],
        );
        await applyLots(tx, org, movementId, c, qty, b.quantity, lotContext);
        if (lotContext)
          await tx.query(
            "INSERT INTO industry_stock_links(organization_id,movement_id,document_id) VALUES($1,$2,$3)",
            [org, movementId, lotContext.documentId],
          );
      }
      const result = { id: resultId, kind: c.kind };
      await tx.query(
        "UPDATE stock_commands SET result=$3 WHERE organization_id=$1 AND id=$2",
        [org, commandId, JSON.stringify(result)],
      );
      await audit(
        tx,
        org,
        scope.actorId,
        `stock.${c.kind}`,
        warehouse.branch_id,
        { itemId: c.itemId, operationId: resultId },
      );
      return { ...result, reused: false };
    }
  }
  async snapshot(secret: Credential, org: string, input: unknown) {
    const q = stockQuery
      .pick({ warehouseId: true })
      .extend({ itemId: idSchema })
      .strict()
      .parse(input);
    return this.db.transaction(async (tx) => {
      const scope = await sessionAccess(tx, secret, org, "inventory:read");
      await this.warehouse(tx, org, q.warehouseId, scope);
      if (
        !(
          await tx.query(
            "SELECT id FROM catalog_items WHERE organization_id=$1 AND id=$2",
            [org, q.itemId],
          )
        ).length
      )
        throw new AppError("NOT_FOUND", 404);
      const [b] = await tx.query<{ quantity: string; version: number }>(
        "SELECT quantity::text,version FROM stock_balances WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3",
        [org, q.warehouseId, q.itemId],
      );
      return b || { quantity: "0", version: 0 };
    });
  }
}
