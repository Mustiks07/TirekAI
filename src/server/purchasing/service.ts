import { createHash, randomUUID } from "node:crypto";
import type { Database, Sql } from "../db/database";
import { sessionAccess, audit } from "../access";
import { AppError } from "../../domain/errors";
import { idSchema } from "../../domain/contracts";
import { pagination } from "../../domain/import-contracts";
import { minorUnits } from "../../domain/decimal";
import { allocatedValue, toBase, type Item } from "../../domain/inventory";
import { InventoryService } from "../inventory/service";
import {
  D,
  supplierInput,
  offerInput,
  compareInput,
  procurementQuery,
  priceOffer,
  purchaseInput,
  purchaseCommand,
  documentUpload,
  documentReview,
  receiptInput,
  needInput,
  budgetInput,
  type OfferData,
  type SupplierData,
  type PurchaseRow,
  type PurchaseLine,
  type DocumentView,
} from "../../domain/purchasing";
import { extractDocument } from "./extract";
const orderColumns =
  "o.id,o.branch_id,o.warehouse_id,o.supplier_id,s.name supplier_name,o.number,o.state,o.version,o.due_date::text,o.total_minor::text,o.budget_minor::text,o.note,o.created_at";
const lineColumns =
  "id,item_id,offer_id,name,base_unit,quantity::text,received::text,total_minor::text,snapshot";
const docColumns =
  "d.id,d.order_id,d.filename,d.sha256,d.state,d.version,d.external_id,d.number,d.date::text,d.extraction,d.review,d.discrepancies,d.obligation_id,d.created_at";
async function command(tx: Sql, org: string, key: string, payload: unknown) {
  const hash = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
    id = randomUUID();
  const added = await tx.query(
    "INSERT INTO procurement_commands(id,organization_id,request_key,payload_hash,result_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,request_key) DO NOTHING RETURNING id",
    [randomUUID(), org, key, hash, id],
  );
  if (added.length) return { id, reused: false };
  const [old] = await tx.query<{ result_id: string; payload_hash: string }>(
    "SELECT result_id,payload_hash FROM procurement_commands WHERE organization_id=$1 AND request_key=$2",
    [org, key],
  );
  if (old.payload_hash !== hash)
    throw new AppError("IDEMPOTENCY_CONFLICT", 409);
  return { id: old.result_id, reused: true };
}
async function event(
  tx: Sql,
  org: string,
  order: string,
  actor: string,
  kind: string,
  note: string,
) {
  await tx.query(
    "INSERT INTO purchase_events(id,organization_id,order_id,actor_id,kind,note) VALUES($1,$2,$3,$4,$5,$6)",
    [randomUUID(), org, order, actor, kind, note],
  );
}
export class PurchasingService {
  constructor(private db: Database) {}
  private async order(
    tx: Sql,
    org: string,
    id: string,
    branch: string | null,
    lock = false,
  ) {
    idSchema.parse(id);
    const [o] = await tx.query<PurchaseRow>(
      `SELECT ${orderColumns} FROM purchase_orders o JOIN suppliers s ON s.organization_id=o.organization_id AND s.id=o.supplier_id WHERE o.organization_id=$1 AND o.id=$2 AND ($3::uuid IS NULL OR o.branch_id=$3) ${lock ? "FOR UPDATE OF o" : ""}`,
      [org, id, branch],
    );
    if (!o) throw new AppError("NOT_FOUND", 404);
    return o;
  }
  async suppliers(secret: string, org: string, input: unknown) {
    const q = procurementQuery.parse(input);
    return this.db.transaction(async (tx) => {
      await sessionAccess(tx, secret, org, "purchasing:read", q.branchId);
      const [c] = await tx.query<{ total: number }>(
        "SELECT count(*)::int total FROM suppliers WHERE organization_id=$1 AND position(lower($2) in lower(name))>0",
        [org, q.q],
      );
      return {
        items: await tx.query(
          "SELECT id,data,created_at FROM suppliers WHERE organization_id=$1 AND position(lower($2) in lower(name))>0 ORDER BY name,id LIMIT $3 OFFSET $4",
          [org, q.q, q.limit, (q.page - 1) * q.limit],
        ),
        pagination: pagination(q.page, q.limit, c.total),
      };
    });
  }
  async createSupplier(secret: string, org: string, input: unknown) {
    const c = supplierInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "purchasing:write"),
        r = await command(tx, org, c.key, { operation: "supplier", ...c });
      if (r.reused) return r;
      if (
        !(
          await tx.query(
            "INSERT INTO suppliers(id,organization_id,name,data) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,name) DO NOTHING RETURNING id",
            [r.id, org, c.name, JSON.stringify(c)],
          )
        ).length
      )
        throw new AppError("SUPPLIER_EXISTS", 409);
      await audit(tx, org, s.actorId, "supplier.created", s.branchId, {
        supplierId: r.id,
      });
      return r;
    });
  }
  async createOffer(secret: string, org: string, input: unknown) {
    const c = offerInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "purchasing:write"),
        r = await command(tx, org, c.key, { operation: "offer", ...c });
      if (r.reused) return r;
      const [item] = await tx.query<{ base_unit: string; kind: string }>(
        "SELECT base_unit,kind FROM catalog_items WHERE organization_id=$1 AND id=$2 AND active FOR SHARE",
        [org, c.itemId],
      );
      if (!item || item.kind !== "goods" || c.baseUnit !== item.base_unit)
        throw new AppError("ITEM_MISMATCH", 422);
      if (
        !(
          await tx.query(
            "SELECT id FROM suppliers WHERE organization_id=$1 AND id=$2",
            [org, c.supplierId],
          )
        ).length
      )
        throw new AppError("NOT_FOUND", 404);
      await tx.query(
        "INSERT INTO supplier_offers(id,organization_id,supplier_id,item_id,data) VALUES($1,$2,$3,$4,$5)",
        [r.id, org, c.supplierId, c.itemId, JSON.stringify(c)],
      );
      await audit(tx, org, s.actorId, "supplier.offer_added", s.branchId, {
        offerId: r.id,
      });
      return r;
    });
  }
  private async offers(
    tx: Sql,
    org: string,
    c: ReturnType<typeof compareInput.parse>,
  ) {
    // Explicit bound: never silently compare only the first page of offers.
    const rows = await tx.query<{
      id: string;
      supplier_name: string;
      data: OfferData;
      supplier: SupplierData;
    }>(
      "SELECT f.id,s.name supplier_name,f.data,s.data supplier FROM supplier_offers f JOIN suppliers s ON s.organization_id=f.organization_id AND s.id=f.supplier_id WHERE f.organization_id=$1 AND f.item_id=$2 ORDER BY f.created_at DESC,f.id LIMIT 501",
      [org, c.itemId],
    );
    if (rows.length > 500) throw new AppError("TOO_MANY_OFFERS", 422);
    return rows
      .map(({ supplier, ...o }) => ({
        ...o,
        quality: supplier.quality,
        reliability: supplier.reliability,
        ...priceOffer(o.data, c.quantity, c.date),
      }))
      .sort((a, b) =>
        a.total_minor === null
          ? 1
          : b.total_minor === null
            ? -1
            : new D(a.total_minor).cmp(b.total_minor),
      );
  }
  async compare(secret: string, org: string, input: unknown) {
    const c = compareInput.parse(input);
    return this.db.transaction(async (tx) => {
      await sessionAccess(tx, secret, org, "purchasing:read");
      return {
        itemId: c.itemId,
        quantity: c.quantity,
        offers: await this.offers(tx, org, c),
      };
    });
  }
  async budget(secret: string, org: string, input: unknown) {
    const c = budgetInput.parse(input);
    if (new Set(c.lines.map((l) => l.itemId)).size !== c.lines.length)
      throw new AppError("DUPLICATE_LINE", 422);
    return this.db.transaction(async (tx) => {
      await sessionAccess(tx, secret, org, "purchasing:read");
      let remaining = minorUnits(c.budget);
      const lines = [];
      for (const l of [...c.lines].sort(
        (a, b) => a.priority - b.priority || a.itemId.localeCompare(b.itemId),
      )) {
        const alternatives = await this.offers(tx, org, { ...l, date: c.date });
        // Unknown lead time, quality or reliability require a human choice, never a cheapest-only automatic decision.
        const eligible = alternatives.filter(
          (a) =>
            a.comparable &&
            a.data.leadDays !== null &&
            a.quality !== null &&
            a.reliability !== null &&
            a.quality >= 3 &&
            a.reliability >= 3,
        );
        const selected = eligible.find(
          (a) => BigInt(a.total_minor!) <= remaining,
        );
        if (selected) remaining -= BigInt(selected.total_minor!);
        lines.push({
          ...l,
          selected_offer_id: selected?.id || null,
          reason: selected
            ? "within_budget"
            : eligible.length
              ? "budget"
              : "review_conditions",
          alternatives,
        });
      }
      return {
        budget_minor: minorUnits(c.budget).toString(),
        remaining_minor: remaining.toString(),
        lines,
        assumptions: [
          "priority_then_price",
          "quality_and_reliability_at_least_3",
          "delivery_per_line_conservative",
          "manual_approval_required",
        ],
      };
    });
  }
  async need(secret: string, org: string, input: unknown) {
    const c = needInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "purchasing:read");
      const [w] = await tx.query(
        "SELECT id FROM warehouses WHERE organization_id=$1 AND id=$2 AND ($3::uuid IS NULL OR branch_id=$3)",
        [org, c.warehouseId, s.branchId],
      );
      if (!w) throw new AppError("NOT_FOUND", 404);
      const [row] = await tx.query<{
        quantity: string;
        reserved: string;
        in_transit: string;
        demand: string;
        observed_days: number;
        in_stock_days: number;
      }>(
        `WITH days AS (SELECT generate_series(current_date-($4::int-1),current_date,'1 day') AS business_day), bal AS (SELECT coalesce((SELECT quantity FROM stock_balances WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3),0) qty), stats AS (
        SELECT count(*) FILTER(WHERE business_day>=(SELECT min(created_at)::date FROM stock_movements WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3))::int observed_days,
        count(*) FILTER(WHERE (SELECT qty FROM bal)-coalesce((SELECT sum(quantity) FROM stock_movements WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3 AND created_at>=business_day+interval '1 day'),0)>0)::int in_stock_days FROM days)
        SELECT (SELECT qty FROM bal)::text quantity,coalesce((SELECT reserved FROM stock_balances WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3),0)::text reserved,
        (coalesce((SELECT sum(quantity-received) FROM purchase_lines l JOIN purchase_orders o ON o.organization_id=l.organization_id AND o.id=l.order_id WHERE l.organization_id=$1 AND o.warehouse_id=$2 AND l.item_id=$3 AND o.state IN ('sent','partial')),0)+coalesce((SELECT sum(quantity) FROM stock_transfers WHERE organization_id=$1 AND destination_id=$2 AND item_id=$3 AND state='in_transit'),0))::text in_transit,
        coalesce((SELECT sum(e.quantity*l.base_quantity/l.quantity) FROM sales_events e JOIN sales_order_lines l ON l.organization_id=e.organization_id AND l.id=e.line_id JOIN sales_orders o ON o.organization_id=e.organization_id AND o.id=e.order_id WHERE e.organization_id=$1 AND o.warehouse_id=$2 AND l.item_id=$3 AND e.kind='fulfill' AND e.created_at>=current_date-($4::int-1)),0)::text demand,stats.* FROM stats`,
        [org, c.warehouseId, c.itemId, c.historyDays],
      );
      const available = new D(row.quantity).minus(row.reserved),
        sufficient =
          row.observed_days >= c.historyDays && row.in_stock_days >= 14;
      const daily = sufficient
        ? new D(row.demand).div(row.in_stock_days)
        : null;
      const target = daily
        ? D.max(c.minimum, daily.mul(c.leadDays).plus(c.safety))
        : new D(c.minimum).plus(c.safety);
      return {
        ...row,
        available: available.toFixed(),
        target: target.toFixed(6),
        need: D.max(0, target.minus(available).minus(row.in_transit))
          .toDecimalPlaces(6, D.ROUND_CEIL)
          .toFixed(),
        daily_demand: daily?.toFixed(6) || null,
        method: sufficient ? "observed_in_stock_days" : "minimum_rule",
        warnings: [
          ...(sufficient ? [] : ["insufficient_history"]),
          ...(row.in_stock_days < c.historyDays
            ? ["stockout_days_excluded"]
            : []),
          ...(new D(row.demand).eq(0) ? ["zero_sales_not_zero_demand"] : []),
        ],
        inputs: c,
      };
    });
  }
  async create(secret: string, org: string, input: unknown) {
    const c = purchaseInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
          tx,
          secret,
          org,
          "purchasing:write",
          c.branchId,
        ),
        r = await command(tx, org, c.key, { operation: "purchase", ...c });
      if (r.reused) return r;
      if (
        !(
          await tx.query(
            "SELECT id FROM warehouses WHERE organization_id=$1 AND id=$2 AND branch_id=$3",
            [org, c.warehouseId, c.branchId],
          )
        ).length
      )
        throw new AppError("WAREHOUSE_SCOPE", 422);
      const lines = [];
      let goods = 0n,
        delivery = 0n;
      const items = new Set<string>();
      for (const l of [...c.lines].sort((a, b) =>
        a.offerId.localeCompare(b.offerId),
      )) {
        const [offer] = await tx.query<{
          data: OfferData;
          name: string;
          base_unit: string;
          active: boolean;
        }>(
          "SELECT f.data,i.name_ru name,i.base_unit,i.active FROM supplier_offers f JOIN catalog_items i ON i.organization_id=f.organization_id AND i.id=f.item_id WHERE f.organization_id=$1 AND f.id=$2 AND f.supplier_id=$3 FOR SHARE OF i",
          [org, l.offerId, c.supplierId],
        );
        if (!offer || !offer.active) throw new AppError("ITEM_MISMATCH", 422);
        if (items.has(offer.data.itemId))
          throw new AppError("DUPLICATE_LINE", 422);
        items.add(offer.data.itemId);
        const priced = priceOffer(offer.data, l.quantity, c.date);
        if (!priced.comparable) throw new AppError("OFFER_INCOMPARABLE", 422);
        goods += BigInt(priced.goods_minor!);
        // One delivery charge per supplier order. Different quotes must agree on this charge.
        if (lines.length && delivery !== BigInt(priced.delivery_minor!))
          throw new AppError("DELIVERY_CONFLICT", 422);
        delivery = BigInt(priced.delivery_minor!);
        lines.push({ ...l, ...offer, ...priced });
      }
      const total = goods + delivery,
        budget = minorUnits(c.budget);
      if (total > budget) throw new AppError("BUDGET_EXCEEDED", 422);
      await tx.query(
        "INSERT INTO purchase_orders(id,organization_id,branch_id,warehouse_id,supplier_id,state,due_date,total_minor,budget_minor,note) VALUES($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9)",
        [
          r.id,
          org,
          c.branchId,
          c.warehouseId,
          c.supplierId,
          c.dueDate,
          total.toString(),
          budget.toString(),
          c.note,
        ],
      );
      let accumulated = 0n,
        allocated = 0n;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        accumulated += BigInt(l.goods_minor!);
        const share =
          goods === 0n
            ? i === lines.length - 1
              ? delivery
              : 0n
            : accumulated === 0n
              ? 0n
              : allocatedValue(
                  delivery,
                  accumulated.toString(),
                  goods.toString(),
                );
        const extra = share - allocated;
        allocated = share;
        await tx.query(
          "INSERT INTO purchase_lines(id,organization_id,order_id,item_id,offer_id,name,base_unit,quantity,total_minor,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            randomUUID(),
            org,
            r.id,
            l.data.itemId,
            l.offerId,
            l.name,
            l.base_unit,
            l.quantity,
            (BigInt(l.goods_minor!) + extra).toString(),
            JSON.stringify(l.data),
          ],
        );
      }
      await event(tx, org, r.id, s.actorId, "created", c.note);
      await audit(tx, org, s.actorId, "purchase.created", c.branchId, {
        orderId: r.id,
      });
      return r;
    });
  }
  async list(secret: string, org: string, input: unknown) {
    const q = procurementQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        "purchasing:read",
        q.branchId,
      );
      const where =
          "o.organization_id=$1 AND ($2::uuid IS NULL OR o.branch_id=$2) AND position(lower($3) in lower(s.name||' '||o.number::text))>0",
        join =
          "purchase_orders o JOIN suppliers s ON s.organization_id=o.organization_id AND s.id=o.supplier_id";
      const [c] = await tx.query<{ total: number }>(
        `SELECT count(*)::int total FROM ${join} WHERE ${where}`,
        [org, s.branchId, q.q],
      );
      return {
        items: await tx.query(
          `SELECT ${orderColumns} FROM ${join} WHERE ${where} ORDER BY o.created_at DESC,o.id LIMIT $4 OFFSET $5`,
          [org, s.branchId, q.q, q.limit, (q.page - 1) * q.limit],
        ),
        pagination: pagination(q.page, q.limit, c.total),
      };
    });
  }
  async get(secret: string, org: string, id: string, input: unknown = {}) {
    const q = procurementQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "purchasing:read");
      const order = await this.order(tx, org, id, s.branchId, true);
      const [c] = await tx.query<{ total: number }>(
        "SELECT count(*)::int total FROM purchase_events WHERE organization_id=$1 AND order_id=$2",
        [org, id],
      );
      return {
        order,
        lines: await tx.query<PurchaseLine>(
          `SELECT ${lineColumns} FROM purchase_lines WHERE organization_id=$1 AND order_id=$2 ORDER BY item_id`,
          [org, id],
        ),
        events: await tx.query(
          "SELECT e.id,e.kind,e.note,e.created_at,u.name actor_name FROM purchase_events e JOIN users u ON u.id=e.actor_id WHERE e.organization_id=$1 AND e.order_id=$2 ORDER BY e.created_at DESC,e.id DESC LIMIT $3 OFFSET $4",
          [org, id, q.limit, (q.page - 1) * q.limit],
        ),
        eventPagination: pagination(q.page, q.limit, c.total),
      };
    });
  }
  async transition(secret: string, org: string, id: string, input: unknown) {
    const c = purchaseCommand.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
          tx,
          secret,
          org,
          c.kind === "approve" ? "purchasing:approve" : "purchasing:write",
        ),
        o = await this.order(tx, org, id, s.branchId, true),
        r = await command(tx, org, c.key, {
          operation: "purchase.transition",
          id,
          ...c,
        });
      if (r.reused) return r;
      if (o.version !== c.version) throw new AppError("VERSION_CONFLICT", 409);
      const target = {
        submit: "pending",
        approve: "approved",
        sent: "sent",
        cancel: "cancelled",
      }[c.kind];
      if (
        c.kind === "cancel"
          ? ["completed", "cancelled"].includes(o.state)
          : o.state !==
            {
              submit: "draft",
              approve: "pending",
              sent: "approved",
              cancel: "",
            }[c.kind]
      )
        throw new AppError("ORDER_STATE", 409);
      await tx.query(
        "UPDATE purchase_orders SET state=$3,version=version+1 WHERE organization_id=$1 AND id=$2",
        [org, id, target],
      );
      await event(tx, org, id, s.actorId, c.kind, c.note);
      await audit(tx, org, s.actorId, `purchase.${c.kind}`, o.branch_id, {
        orderId: id,
      });
      return r;
    });
  }
  async upload(secret: string, org: string, input: unknown) {
    const c = documentUpload.parse(input);
    // Authorization before decoding / local extraction; rechecked before persisting.
    await this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "purchasing:write");
      await this.order(tx, org, c.orderId, s.branchId);
    });
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        c.content,
      )
    )
      throw new AppError("INVALID_INPUT", 422);
    const bytes = Buffer.from(c.content, "base64");
    if (bytes.length > 5 * 1024 * 1024) throw new AppError("TOO_LARGE", 413);
    const hash = createHash("sha256").update(bytes).digest("hex"),
      extraction = await extractDocument(c.filename, bytes);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "purchasing:write"),
        o = await this.order(tx, org, c.orderId, s.branchId, true),
        r = await command(tx, org, c.key, {
          operation: "document.upload",
          orderId: c.orderId,
          filename: c.filename,
          hash,
          externalId: c.externalId,
        });
      if (r.reused) return r;
      const inserted = await tx.query(
        "INSERT INTO purchase_documents(id,organization_id,order_id,supplier_id,filename,sha256,original,external_id,extraction) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id",
        [
          r.id,
          org,
          o.id,
          o.supplier_id,
          c.filename,
          hash,
          bytes,
          c.externalId,
          JSON.stringify(extraction),
        ],
      );
      if (!inserted.length) throw new AppError("DUPLICATE_DOCUMENT", 409);
      await event(tx, org, o.id, s.actorId, "document_uploaded", c.filename);
      await audit(
        tx,
        org,
        s.actorId,
        "purchase.document_uploaded",
        o.branch_id,
        { documentId: r.id },
      );
      return r;
    });
  }
  async documents(secret: string, org: string, input: unknown) {
    const q = procurementQuery
      .extend({ orderId: idSchema.optional() })
      .parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
          tx,
          secret,
          org,
          "purchasing:read",
          q.branchId,
        ),
        join =
          "purchase_documents d JOIN purchase_orders o ON o.organization_id=d.organization_id AND o.id=d.order_id",
        where =
          "d.organization_id=$1 AND ($2::uuid IS NULL OR o.branch_id=$2) AND ($3::uuid IS NULL OR d.order_id=$3)";
      const [c] = await tx.query<{ total: number }>(
        `SELECT count(*)::int total FROM ${join} WHERE ${where}`,
        [org, s.branchId, q.orderId || null],
      );
      return {
        items: await tx.query(
          `SELECT ${docColumns} FROM ${join} WHERE ${where} ORDER BY d.created_at DESC,d.id LIMIT $4 OFFSET $5`,
          [org, s.branchId, q.orderId || null, q.limit, (q.page - 1) * q.limit],
        ),
        pagination: pagination(q.page, q.limit, c.total),
      };
    });
  }
  async document(secret: string, org: string, id: string, original = false) {
    idSchema.parse(id);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "purchasing:read");
      const [d] = await tx.query<DocumentView["document"]>(
        `SELECT ${docColumns} FROM purchase_documents d JOIN purchase_orders o ON o.organization_id=d.organization_id AND o.id=d.order_id WHERE d.organization_id=$1 AND d.id=$2 AND ($3::uuid IS NULL OR o.branch_id=$3) FOR SHARE OF d`,
        [org, id, s.branchId],
      );
      if (!d) throw new AppError("NOT_FOUND", 404);
      if (original) {
        const [b] = await tx.query<{ original: Uint8Array }>(
          "SELECT original FROM purchase_documents WHERE organization_id=$1 AND id=$2",
          [org, id],
        );
        return {
          filename: d.filename,
          content: Buffer.from(b.original).toString("base64"),
        };
      }
      return {
        document: d,
        lines: await tx.query(
          "SELECT id,item_id,name,unit,quantity::text,base_quantity::text,received::text,total_minor::text FROM purchase_document_lines WHERE organization_id=$1 AND document_id=$2 ORDER BY item_id",
          [org, id],
        ),
        revisions: await tx.query(
          "SELECT r.id,r.version,r.note,r.created_at,u.name actor_name FROM document_revisions r JOIN users u ON u.id=r.actor_id WHERE r.organization_id=$1 AND r.document_id=$2 ORDER BY r.version",
          [org, id],
        ),
      };
    });
  }
  async review(
    secret: string,
    org: string,
    id: string,
    input: unknown,
    mode: "approve" | "draft" | "preview" = "approve",
  ) {
    idSchema.parse(id);
    const c = documentReview.parse(input);
    if (new Set(c.lines.map((l) => l.itemId)).size !== c.lines.length)
      throw new AppError("DUPLICATE_LINE", 422);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "purchasing:write");
      const [ref] = await tx.query<{ order_id: string }>(
        "SELECT order_id FROM purchase_documents WHERE organization_id=$1 AND id=$2",
        [org, id],
      );
      if (!ref) throw new AppError("NOT_FOUND", 404);
      const o = await this.order(tx, org, ref.order_id, s.branchId, true);
      const [doc] = await tx.query<{ version: number; state: string }>(
        "SELECT version,state FROM purchase_documents WHERE organization_id=$1 AND id=$2 FOR UPDATE",
        [org, id],
      );
      const r =
        mode === "preview"
          ? { id, reused: false }
          : await command(tx, org, c.key, {
              operation: `document.${mode}`,
              id,
              ...c,
            });
      if (r.reused) return r;
      if (doc.version !== c.version)
        throw new AppError("VERSION_CONFLICT", 409);
      if (doc.state !== "review") throw new AppError("DOCUMENT_APPROVED", 409);
      if (!["approved", "sent", "partial"].includes(o.state))
        throw new AppError("ORDER_STATE", 409);
      // Serialize invoice identity checks across different orders of the same supplier.
      await tx.query(
        "SELECT id FROM suppliers WHERE organization_id=$1 AND id=$2 FOR UPDATE",
        [org, o.supplier_id],
      );
      if (
        (
          await tx.query(
            "SELECT id FROM purchase_documents WHERE organization_id=$1 AND supplier_id=$2 AND number=$3 AND date=$4 AND id<>$5",
            [org, o.supplier_id, c.number, c.date, id],
          )
        ).length
      )
        throw new AppError("DUPLICATE_DOCUMENT", 409);
      const ordered = await tx.query<PurchaseLine>(
        `SELECT ${lineColumns} FROM purchase_lines WHERE organization_id=$1 AND order_id=$2`,
        [org, o.id],
      );
      const discrepancies: string[] = [];
      const lines = [];
      let goods = 0n;
      for (const l of [...c.lines].sort((a, b) =>
        a.itemId.localeCompare(b.itemId),
      )) {
        const [item] = await tx.query<Item>(
          "SELECT *,purchase_price::text,sale_price::text FROM catalog_items WHERE organization_id=$1 AND id=$2 FOR SHARE",
          [org, l.itemId],
        );
        if (!item || item.kind !== "goods")
          throw new AppError("ITEM_MISMATCH", 422);
        const qty = toBase(l.quantity, l.unit, item),
          total = new D(l.unitPrice)
            .mul(l.quantity)
            .mul(100)
            .toDecimalPlaces(0)
            .toFixed(),
          order = ordered.find((x) => x.item_id === l.itemId);
        if (!order) discrepancies.push(`item:${l.itemId}`);
        else {
          if (!new D(order.quantity).eq(qty))
            discrepancies.push(`quantity:${l.itemId}`);
          if (
            !new D(
              priceOffer(order.snapshot, order.quantity, order.snapshot.dated)
                .goods_minor!,
            )
              .div(order.quantity)
              .eq(new D(total).div(qty))
          )
            discrepancies.push(`price:${l.itemId}`);
        }
        goods += BigInt(total);
        lines.push({ ...l, qty, total });
      }
      for (const l of ordered)
        if (!lines.some((x) => x.itemId === l.item_id))
          discrepancies.push(`missing:${l.item_id}`);
      const delivery = minorUnits(c.delivery),
        total = goods + delivery;
      if (total !== minorUnits(c.total) || total === 0n)
        throw new AppError("DOCUMENT_TOTAL_MISMATCH", 422);
      if (total !== BigInt(o.total_minor)) discrepancies.push("total");
      if (mode === "preview")
        return { ...r, discrepancies, total_minor: total.toString() };
      if (
        mode === "approve" &&
        discrepancies.length &&
        !c.acknowledgeDiscrepancies
      )
        throw new AppError("DISCREPANCY_REVIEW_REQUIRED", 422);
      if (doc.version >= 100)
        throw new AppError("DOCUMENT_REVISION_LIMIT", 422);
      // Original extraction and every accepted correction remain immutable.
      await tx.query(
        "INSERT INTO document_revisions(id,organization_id,document_id,version,data,note,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          randomUUID(),
          org,
          id,
          c.version,
          JSON.stringify(c),
          c.note,
          s.actorId,
        ],
      );
      if (mode === "draft") {
        await tx.query(
          "UPDATE purchase_documents SET review=$3,discrepancies=$4,version=version+1 WHERE organization_id=$1 AND id=$2",
          [org, id, JSON.stringify(c), JSON.stringify(discrepancies)],
        );
        await audit(
          tx,
          org,
          s.actorId,
          "purchase.document_corrected",
          o.branch_id,
          { documentId: id },
        );
        return r;
      }
      let cumulative = 0n,
        allocated = 0n;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        cumulative += BigInt(l.total);
        const share =
            goods === 0n
              ? i === lines.length - 1
                ? delivery
                : 0n
              : cumulative === 0n
                ? 0n
                : allocatedValue(
                    delivery,
                    cumulative.toString(),
                    goods.toString(),
                  ),
          extra = share - allocated;
        allocated = share;
        await tx.query(
          "INSERT INTO purchase_document_lines(id,organization_id,document_id,item_id,name,unit,quantity,base_quantity,total_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            randomUUID(),
            org,
            id,
            l.itemId,
            l.name,
            l.unit,
            l.quantity,
            l.qty,
            (BigInt(l.total) + extra).toString(),
          ],
        );
      }
      const obligation = randomUUID();
      await tx.query(
        "INSERT INTO supplier_obligations(id,organization_id,branch_id,supplier,amount_minor,due_date,note,purchase_order_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          obligation,
          org,
          o.branch_id,
          o.supplier_name,
          total.toString(),
          c.dueDate,
          c.note,
          o.id,
        ],
      );
      await tx.query(
        "UPDATE purchase_documents SET state='approved',version=version+1,number=$3,date=$4,review=$5,discrepancies=$6,obligation_id=$7 WHERE organization_id=$1 AND id=$2",
        [
          org,
          id,
          c.number,
          c.date,
          JSON.stringify(c),
          JSON.stringify(discrepancies),
          obligation,
        ],
      );
      await event(tx, org, o.id, s.actorId, "document_approved", c.note);
      await audit(
        tx,
        org,
        s.actorId,
        "purchase.document_approved",
        o.branch_id,
        { documentId: id, obligationId: obligation },
      );
      return r;
    });
  }
  async receive(secret: string, org: string, id: string, input: unknown) {
    idSchema.parse(id);
    const c = receiptInput.parse(input);
    if (new Set(c.lines.map((l) => l.lineId)).size !== c.lines.length)
      throw new AppError("DUPLICATE_LINE", 422);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "purchasing:write"),
        o = await this.order(tx, org, id, s.branchId, true),
        r = await command(tx, org, c.key, {
          operation: "purchase.receive",
          id,
          ...c,
        });
      if (r.reused) return r;
      if (o.version !== c.version) throw new AppError("VERSION_CONFLICT", 409);
      if (!["sent", "partial"].includes(o.state))
        throw new AppError("ORDER_STATE", 409);
      const [doc] = await tx.query<{ state: string }>(
        "SELECT state FROM purchase_documents WHERE organization_id=$1 AND id=$2 AND order_id=$3 FOR UPDATE",
        [org, c.documentId, id],
      );
      if (!doc || doc.state !== "approved")
        throw new AppError("DOCUMENT_NOT_APPROVED", 409);
      const doclines = await tx.query<DocumentView["lines"][number]>(
        "SELECT id,item_id,name,unit,quantity::text,base_quantity::text,received::text,total_minor::text FROM purchase_document_lines WHERE organization_id=$1 AND document_id=$2 ORDER BY item_id FOR UPDATE",
        [org, c.documentId],
      );
      const lines = await tx.query<PurchaseLine>(
        `SELECT ${lineColumns} FROM purchase_lines WHERE organization_id=$1 AND order_id=$2 ORDER BY item_id FOR UPDATE`,
        [org, id],
      );
      for (const l of [...c.lines].sort((a, b) => {
        const ai = doclines.find((d) => d.id === a.lineId)?.item_id || "",
          bi = doclines.find((d) => d.id === b.lineId)?.item_id || "";
        return ai.localeCompare(bi);
      })) {
        const d = doclines.find((x) => x.id === l.lineId),
          p = d && lines.find((x) => x.item_id === d.item_id);
        if (!d || !p) throw new AppError("ITEM_MISMATCH", 422);
        const next = new D(d.received).plus(l.quantity),
          poNext = new D(p.received).plus(l.quantity);
        if (next.gt(d.base_quantity) || poNext.gt(p.quantity))
          throw new AppError("QUANTITY_EXCEEDS", 422);
        const before = new D(d.received).eq(0)
            ? 0n
            : allocatedValue(
                BigInt(d.total_minor),
                d.received,
                d.base_quantity,
              ),
          value =
            allocatedValue(
              BigInt(d.total_minor),
              next.toFixed(),
              d.base_quantity,
            ) - before;
        const movement = await new InventoryService(
          this.db,
        ).executeInTransaction(
          tx,
          secret,
          org,
          {
            key: randomUUID(),
            kind: "receipt",
            warehouseId: o.warehouse_id,
            itemId: d.item_id,
            quantity: l.quantity,
            unit: p.base_unit,
            unitCost: "0",
            note: c.note,
          },
          undefined,
          value,
        );
        await tx.query(
          "INSERT INTO purchase_receipts(id,organization_id,document_line_id,purchase_line_id,movement_id,quantity,value_minor,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            randomUUID(),
            org,
            d.id,
            p.id,
            movement.id,
            l.quantity,
            value.toString(),
            c.note,
          ],
        );
        await tx.query(
          "UPDATE purchase_document_lines SET received=$3 WHERE organization_id=$1 AND id=$2",
          [org, d.id, next.toFixed()],
        );
        await tx.query(
          "UPDATE purchase_lines SET received=$3 WHERE organization_id=$1 AND id=$2",
          [org, p.id, poNext.toFixed()],
        );
      }
      const [left] = await tx.query<{ remaining: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM purchase_lines WHERE organization_id=$1 AND order_id=$2 AND received<quantity) remaining",
        [org, id],
      );
      await tx.query(
        "UPDATE purchase_orders SET state=$3,version=version+1 WHERE organization_id=$1 AND id=$2",
        [org, id, left.remaining ? "partial" : "completed"],
      );
      await event(tx, org, id, s.actorId, "received", c.note);
      await audit(tx, org, s.actorId, "purchase.received", o.branch_id, {
        orderId: id,
        documentId: c.documentId,
      });
      return r;
    });
  }
}
