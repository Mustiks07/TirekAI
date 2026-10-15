import type { Database, Sql } from "../db/database";
import { sessionAccess, audit, type Credential } from "../access";
import { AppError } from "../../domain/errors";
import { idSchema } from "../../domain/contracts";
import { D } from "../../domain/purchasing";
import {
  CLOSED_STATUSES,
  channelOrderCommand,
  channelStep,
  productLinkInput,
  settlementInput,
  writesInput,
} from "../../domain/channel-trade";
import { idempotent } from "../execution/core";
import { stableUuid } from "../tasks/service";
import { CommerceService } from "../commerce/service";
import { CrmService } from "../crm/service";
import { KaspiService } from "./kaspi-service";
import {
  connectionFor,
  credentialsOf,
  trackRun,
  type ConnectionRow,
} from "./common";

type ChannelOrder = {
  id: string;
  connection_id: string;
  external_id: string;
  code: string;
  status: string;
  state: string;
  delivery_mode: string;
  total_minor: string;
  lines:
    | {
        entryId: string;
        productCode: string;
        name: string;
        quantity: string;
        price_minor: string | null;
        total_minor: string | null;
      }[]
    | null;
  sales_order_id: string | null;
  accept_state: "sent" | "unknown" | "failed" | null;
  version: number;
};
const kzt = (minor: bigint | string) =>
  new D(minor.toString()).div(100).toFixed(2);
const quantityPattern = /^(0|[1-9]\d{0,14})(\.\d{1,6})?$/;

// T040: Kaspi order → internal sales order (reserve) → acceptance in Kaspi → issue → payout with
// commission from the settlement report → return with refund and commission correction. Every
// stock and money change goes through the commerce services inside one transaction.
export class KaspiTradeService {
  constructor(
    private db: Database,
    private kaspi = new KaspiService(db),
    private commerce = new CommerceService(db),
    private crm = new CrmService(db),
  ) {}
  private async channelOrder(
    tx: Sql,
    org: string,
    id: string,
    branch: string | null,
  ) {
    idSchema.parse(id);
    const [o] = await tx.query<ChannelOrder>(
      "SELECT id,connection_id,external_id,code,status,state,delivery_mode,total_minor::text,lines,sales_order_id,accept_state,version FROM channel_orders WHERE organization_id=$1 AND id=$2 FOR UPDATE",
      [org, id],
    );
    if (!o) throw new AppError("NOT_FOUND", 404);
    const conn = await connectionFor(tx, org, o.connection_id, "kaspi");
    if (branch && branch !== conn.settings.branchId)
      throw new AppError("FORBIDDEN", 403);
    return { o, conn };
  }
  // Owner switch: status changes in Kaspi are real actions for buyers.
  async setWrites(secret: Credential, org: string, id: string, input: unknown) {
    const c = writesInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      const conn = await connectionFor(tx, org, id, "kaspi", true);
      const r = await idempotent(tx, org, c.key, {
        operation: "kaspi.writes",
        id,
        ...c,
      });
      if (r.reused) return { ok: true };
      if (conn.version !== c.version)
        throw new AppError("VERSION_CONFLICT", 409);
      await tx.query(
        "UPDATE integration_connections SET settings=jsonb_set(settings,'{writes}',to_jsonb($3::boolean)),version=version+1 WHERE organization_id=$1 AND id=$2",
        [org, id, c.enabled],
      );
      await audit(tx, org, s.actorId, "kaspi.writes", null, {
        connectionId: id,
        enabled: String(c.enabled),
      });
      return { ok: true };
    });
  }
  // Kaspi product codes seen in orders, with their catalog link.
  async products(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "orders:read");
      const conn = await connectionFor(tx, org, id, "kaspi");
      if (s.branchId && s.branchId !== conn.settings.branchId)
        throw new AppError("FORBIDDEN", 403);
      return {
        items: await tx.query(
          `SELECT p."productCode" product_code,max(p.name) name,count(DISTINCT o.id)::int orders,m.internal_id item_id,i.sku,i.name_ru
           FROM channel_orders o CROSS JOIN LATERAL jsonb_to_recordset(CASE WHEN jsonb_typeof(o.lines)='array' THEN o.lines ELSE '[]'::jsonb END) AS p("productCode" text,name text)
           LEFT JOIN integration_mappings m ON m.connection_id=o.connection_id AND m.entity_type='product' AND m.external_id=p."productCode" AND m.state='active'
           LEFT JOIN catalog_items i ON i.organization_id=o.organization_id AND i.id=m.internal_id
           WHERE o.organization_id=$1 AND o.connection_id=$2 GROUP BY p."productCode",m.internal_id,i.sku,i.name_ru ORDER BY 1`,
          [org, id],
        ),
      };
    });
  }
  async linkProduct(
    secret: Credential,
    org: string,
    id: string,
    input: unknown,
  ) {
    const c = productLinkInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "orders:write");
      const conn = await connectionFor(tx, org, id, "kaspi", true);
      if (s.branchId && s.branchId !== conn.settings.branchId)
        throw new AppError("FORBIDDEN", 403);
      const r = await idempotent(tx, org, c.key, {
        operation: "kaspi.link",
        id,
        ...c,
      });
      if (r.reused) return { ok: true };
      const [item] = await tx.query(
        "SELECT id FROM catalog_items WHERE organization_id=$1 AND id=$2 AND active",
        [org, c.itemId],
      );
      if (!item) throw new AppError("NOT_FOUND", 404);
      try {
        await tx.query(
          "INSERT INTO integration_mappings(organization_id,connection_id,entity_type,external_id,internal_id,state) VALUES($1,$2,'product',$3,$4,'active') ON CONFLICT(connection_id,entity_type,external_id) DO UPDATE SET internal_id=$4,state='active',updated_at=now()",
          [org, id, c.productCode, c.itemId],
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23505")
          throw new AppError("ITEM_ALREADY_LINKED", 409);
        throw error;
      }
      await audit(tx, org, s.actorId, "kaspi.product_linked", null, {
        connectionId: id,
        itemId: c.itemId,
      });
      return { ok: true };
    });
  }
  // Creates the internal order at Kaspi prices and confirms it, which reserves stock.
  async importOrder(
    secret: Credential,
    org: string,
    id: string,
    input: unknown,
  ) {
    const c = channelOrderCommand.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "orders:write");
      const { o, conn } = await this.channelOrder(tx, org, id, s.branchId);
      const r = await idempotent(tx, org, c.key, {
        operation: "kaspi.import",
        id,
        ...c,
      });
      if (r.reused) return { id: o.sales_order_id!, reused: true };
      if (o.version !== c.version) throw new AppError("VERSION_CONFLICT", 409);
      if (o.sales_order_id) throw new AppError("ALREADY_IMPORTED", 409);
      if (CLOSED_STATUSES.includes(o.status))
        throw new AppError("CHANNEL_ORDER_CLOSED", 409);
      if (!o.lines?.length) throw new AppError("CHANNEL_LINES_MISSING", 409);
      const branchId = String(conn.settings.branchId),
        warehouseId = String(conn.settings.warehouseId);
      const lines = [];
      let sum = 0n;
      for (const l of o.lines) {
        const [m] = await tx.query<{ item_id: string; base_unit: string }>(
          "SELECT i.id item_id,i.base_unit FROM integration_mappings m JOIN catalog_items i ON i.organization_id=m.organization_id AND i.id=m.internal_id WHERE m.connection_id=$1 AND m.entity_type='product' AND m.external_id=$2 AND m.state='active' AND i.active",
          [conn.id, l.productCode],
        );
        if (!m) throw new AppError("PRODUCT_NOT_LINKED", 409);
        if (
          l.price_minor === null ||
          l.total_minor === null ||
          !quantityPattern.test(l.quantity)
        )
          throw new AppError("CHANNEL_LINE_INVALID", 409);
        // The internal line must reproduce Kaspi's line total exactly.
        const expected = BigInt(
          new D(l.price_minor).times(l.quantity).toDecimalPlaces(0).toFixed(0),
        );
        if (expected !== BigInt(l.total_minor))
          throw new AppError("LINE_TOTAL_MISMATCH", 409);
        sum += expected;
        lines.push({
          itemId: m.item_id,
          quantity: l.quantity,
          unit: m.base_unit,
          price: kzt(l.price_minor),
          discount: "0",
        });
      }
      if (sum !== BigInt(o.total_minor))
        throw new AppError("TOTAL_MISMATCH", 409);
      const customerId = await this.channelCustomer(
        tx,
        secret,
        org,
        conn,
        branchId,
      );
      const [{ today }] = await tx.query<{ today: string }>(
        "SELECT (now() AT TIME ZONE timezone)::date::text today FROM organizations WHERE id=$1",
        [org],
      );
      const order = await this.commerce.createInTransaction(tx, secret, org, {
        key: stableUuid(`kaspi-order:${c.key}`),
        branchId,
        customerId,
        warehouseId,
        dueDate: today,
        delivery: /PICKUP/.test(o.delivery_mode) ? "pickup" : "delivery",
        note: `Kaspi ${o.code}`,
        taxMode: "excluded",
        lines,
      });
      await this.commerce.transitionInTransaction(tx, secret, org, order.id, {
        key: stableUuid(`kaspi-confirm:${c.key}`),
        version: 1,
        kind: "confirm",
        note: `Kaspi ${o.code}: резерв`,
      });
      await tx.query(
        "UPDATE channel_orders SET sales_order_id=$3,imported_by=$4,version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2",
        [org, id, order.id, s.actorId],
      );
      await audit(tx, org, s.actorId, "kaspi.order_imported", branchId, {
        channelOrderId: id,
        orderId: order.id,
      });
      return { id: order.id, reused: false };
    });
  }
  // One internal customer per connection; the buyer's name and phone stay on the channel order.
  private async channelCustomer(
    tx: Sql,
    secret: Credential,
    org: string,
    conn: ConnectionRow,
    branchId: string,
  ) {
    const externalId = `kaspi:${conn.id}`;
    const [found] = await tx.query<{ id: string }>(
      "SELECT id FROM customers WHERE organization_id=$1 AND branch_id=$2 AND external_id=$3",
      [org, branchId, externalId],
    );
    if (found) return found.id;
    return (
      await this.crm.importCustomerInTransaction(tx, secret, org, {
        branchId,
        externalId,
        name: "Покупатели Kaspi",
        email: "",
        phone: "",
        note: "Канал продаж Kaspi; согласий на рассылки нет",
      })
    ).id;
  }
  // Explicit action, owner-enabled writes, after the stock is reserved. Sent once; a timeout is
  // recorded as unknown and not resent automatically.
  async accept(secret: Credential, org: string, id: string, input: unknown) {
    const c = channelOrderCommand.parse(input);
    const claim = await this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "orders:write");
      const { o, conn } = await this.channelOrder(tx, org, id, s.branchId);
      const r = await idempotent(tx, org, c.key, {
        operation: "kaspi.accept",
        id,
        ...c,
      });
      if (r.reused) return { reused: true as const, state: o.accept_state };
      if (o.version !== c.version) throw new AppError("VERSION_CONFLICT", 409);
      if (!conn.settings.writes) throw new AppError("CHANNEL_WRITES_OFF", 409);
      if (!o.sales_order_id) throw new AppError("NOT_IMPORTED", 409);
      if (o.status !== "APPROVED_BY_BANK")
        throw new AppError("CHANNEL_ORDER_STATE", 409);
      if (o.accept_state === "sent" || o.accept_state === "unknown")
        throw new AppError("ACCEPT_ALREADY_SENT", 409);
      await tx.query(
        "UPDATE channel_orders SET accept_state='unknown',accept_error=NULL,version=version+1 WHERE organization_id=$1 AND id=$2",
        [org, id],
      );
      await audit(tx, org, s.actorId, "kaspi.accept_sent", null, {
        channelOrderId: id,
      });
      return { reused: false as const, o, conn };
    });
    if (claim.reused) return { state: claim.state };
    let state: "sent" | "unknown" | "failed" = "sent",
      error: string | null = null;
    try {
      const token = credentialsOf<{ token: string }>(claim.conn).token;
      await trackRun(this.db, claim.conn, "export", () =>
        this.kaspi
          .client(token)
          .setStatus(claim.o.external_id, claim.o.code, "ACCEPTED_BY_MERCHANT"),
      );
    } catch (e) {
      error = e instanceof AppError ? e.code : "KASPI_UNAVAILABLE";
      state = /TIMEOUT|UNAVAILABLE|_5\d\d$|RATE_LIMITED/.test(error)
        ? "unknown"
        : "failed";
    }
    await this.db.query(
      "UPDATE channel_orders SET accept_state=$3,accept_error=$4,accepted_at=CASE WHEN $3='sent' THEN now() END,status=CASE WHEN $3='sent' THEN 'ACCEPTED_BY_MERCHANT' ELSE status END,history=history||$5::jsonb,version=version+1 WHERE organization_id=$1 AND id=$2",
      [
        org,
        id,
        state,
        error,
        JSON.stringify([
          {
            at: new Date().toISOString(),
            action: "accept",
            result: state,
            ...(error ? { error } : {}),
          },
        ]),
      ],
    );
    return { state, error };
  }
  // Issue of every remaining quantity: stock leaves the warehouse and revenue is recognised.
  async issue(secret: Credential, org: string, id: string, input: unknown) {
    const c = channelStep.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "orders:write");
      const { o } = await this.channelOrder(tx, org, id, s.branchId);
      const r = await idempotent(tx, org, c.key, {
        operation: "kaspi.issue",
        id,
        ...c,
      });
      if (r.reused) return { id: o.sales_order_id!, reused: true };
      if (!o.sales_order_id) throw new AppError("NOT_IMPORTED", 409);
      const lines = await tx.query<{
        id: string;
        quantity: string;
        fulfilled: string;
      }>(
        "SELECT id,quantity::text,fulfilled::text FROM sales_order_lines WHERE organization_id=$1 AND order_id=$2 ORDER BY id",
        [org, o.sales_order_id],
      );
      let issued = 0;
      for (const l of lines) {
        const rest = new D(l.quantity).minus(l.fulfilled);
        if (rest.lte(0)) continue;
        const [{ version }] = await tx.query<{ version: number }>(
          "SELECT version FROM sales_orders WHERE organization_id=$1 AND id=$2",
          [org, o.sales_order_id],
        );
        await this.commerce.transitionInTransaction(
          tx,
          secret,
          org,
          o.sales_order_id,
          {
            key: stableUuid(`kaspi-issue:${c.key}:${l.id}`),
            version,
            kind: "fulfill",
            lineId: l.id,
            quantity: rest.toFixed(),
            note: c.note,
          },
        );
        issued++;
      }
      if (!issued) throw new AppError("NOTHING_TO_ISSUE", 409);
      return { id: o.sales_order_id, reused: false };
    });
  }
  // Return of every issued, not yet returned quantity: stock comes back, revenue is reversed.
  // Money is a separate step (settlement of kind "return").
  async returnGoods(
    secret: Credential,
    org: string,
    id: string,
    input: unknown,
  ) {
    const c = channelStep.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "orders:write");
      const { o } = await this.channelOrder(tx, org, id, s.branchId);
      const r = await idempotent(tx, org, c.key, {
        operation: "kaspi.return",
        id,
        ...c,
      });
      if (r.reused) return { id: o.sales_order_id!, reused: true };
      if (!o.sales_order_id) throw new AppError("NOT_IMPORTED", 409);
      const events = await tx.query<{ id: string; rest: string }>(
        "SELECT e.id,(e.quantity-coalesce((SELECT sum(x.quantity) FROM sales_events x WHERE x.organization_id=e.organization_id AND x.source_id=e.id AND x.kind='return'),0))::text rest FROM sales_events e WHERE e.organization_id=$1 AND e.order_id=$2 AND e.kind='fulfill' ORDER BY e.created_at,e.id",
        [org, o.sales_order_id],
      );
      let returned = 0;
      for (const e of events) {
        if (new D(e.rest).lte(0)) continue;
        const [{ version }] = await tx.query<{ version: number }>(
          "SELECT version FROM sales_orders WHERE organization_id=$1 AND id=$2",
          [org, o.sales_order_id],
        );
        await this.commerce.transitionInTransaction(
          tx,
          secret,
          org,
          o.sales_order_id,
          {
            key: stableUuid(`kaspi-return:${c.key}:${e.id}`),
            version,
            kind: "return",
            eventId: e.id,
            quantity: new D(e.rest).toFixed(),
            note: c.note,
          },
        );
        returned++;
      }
      if (!returned) throw new AppError("NOTHING_TO_RETURN", 409);
      return { id: o.sales_order_id, reused: false };
    });
  }
  // A settlement-report line: payout = payment of the order (gross) + commission expense;
  // return = refund (gross) + commission correction (operating income). Net cash = report net.
  async settle(secret: Credential, org: string, id: string, input: unknown) {
    const parsed = settlementInput.safeParse(input);
    if (!parsed.success)
      throw new AppError(
        parsed.error.issues.some((i) => i.message === "SETTLEMENT_ARITHMETIC")
          ? "SETTLEMENT_ARITHMETIC"
          : "INVALID_INPUT",
        422,
      );
    const c = parsed.data;
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "finance:write");
      const { o, conn } = await this.channelOrder(tx, org, id, s.branchId);
      const r = await idempotent(tx, org, c.key, {
        operation: "kaspi.settle",
        id,
        ...c,
      });
      if (r.reused) return { id: r.id, reused: true };
      if (!o.sales_order_id) throw new AppError("NOT_IMPORTED", 409);
      const [dup] = await tx.query(
        "SELECT id FROM channel_settlements WHERE connection_id=$1 AND kind=$2 AND document=$3 AND channel_order_id=$4",
        [conn.id, c.kind, c.document, id],
      );
      if (dup) throw new AppError("SETTLEMENT_DUPLICATE", 409);
      if (c.kind === "return") {
        const [{ n }] = await tx.query<{ n: number }>(
          "SELECT count(*)::int n FROM sales_events WHERE organization_id=$1 AND order_id=$2 AND kind='return'",
          [org, o.sales_order_id],
        );
        // The refund follows the goods: record the return of goods first.
        if (!n) throw new AppError("RETURN_GOODS_FIRST", 409);
      }
      const base = `kaspi-settle:${c.key}`;
      const order = () =>
        this.commerce.moneyInTransaction(tx, secret, org, {
          key: stableUuid(`${base}:order`),
          kind: c.kind === "payout" ? "payment" : "refund",
          accountId: c.accountId,
          orderId: o.sales_order_id,
          amount: c.gross,
          note: `Kaspi ${o.code}: ${c.kind === "payout" ? "выплата" : "возврат"} по отчёту ${c.document}`,
        });
      const commission = () =>
        new D(c.commission).gt(0)
          ? this.commerce.moneyInTransaction(tx, secret, org, {
              key: stableUuid(`${base}:commission`),
              kind: c.kind === "payout" ? "expense" : "income",
              accountId: c.accountId,
              amount: c.commission,
              category: "Комиссия Kaspi",
              counterparty: "Kaspi.kz",
              operating: true,
              note: `Kaspi ${o.code}: ${c.kind === "payout" ? "комиссия" : "возврат комиссии"} по отчёту ${c.document}`,
            })
          : Promise.resolve(null);
      // Within the report line the account never goes below the report's net movement:
      // payout = payment then commission; return = commission returned then refund.
      let orderEntry: { id: string }, commissionEntry: { id: string } | null;
      if (c.kind === "payout") {
        orderEntry = await order();
        commissionEntry = await commission();
      } else {
        commissionEntry = await commission();
        orderEntry = await order();
      }
      const toMinor = (v: string) => new D(v).times(100).toFixed(0);
      await tx.query(
        "INSERT INTO channel_settlements(id,organization_id,connection_id,channel_order_id,account_id,kind,document,report_date,gross_minor,commission_minor,net_minor,order_entry_id,commission_entry_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        [
          r.id,
          org,
          conn.id,
          id,
          c.accountId,
          c.kind,
          c.document,
          c.reportDate,
          toMinor(c.gross),
          toMinor(c.commission),
          toMinor(c.net),
          orderEntry.id,
          commissionEntry?.id ?? null,
          s.actorId,
        ],
      );
      await audit(tx, org, s.actorId, `kaspi.settlement_${c.kind}`, null, {
        channelOrderId: id,
        settlementId: r.id,
      });
      return { id: r.id, reused: false };
    });
  }
  // Sales page entry point: the active Kaspi connection of the organization, if any.
  async overview(secret: Credential, org: string) {
    const [conn] = await this.db.query<{ id: string }>(
      "SELECT id FROM integration_connections WHERE organization_id=$1 AND provider='kaspi' AND disconnected_at IS NULL ORDER BY created_at LIMIT 1",
      [org],
    );
    if (!conn) {
      await this.db.transaction((tx) =>
        sessionAccess(tx, secret, org, "orders:read"),
      );
      return { connectionId: null, writes: false, version: 0, items: [] };
    }
    return {
      connectionId: conn.id,
      ...(await this.trade(secret, org, conn.id)),
    };
  }
  // Channel orders with their internal order, money and settlement totals.
  async trade(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "orders:read");
      const conn = await connectionFor(tx, org, id, "kaspi");
      if (s.branchId && s.branchId !== conn.settings.branchId)
        throw new AppError("FORBIDDEN", 403);
      const items = await tx.query(
        `SELECT c.id,c.code,c.status,c.state,c.total_minor::text,c.customer_name,c.created_external,c.lines,c.sales_order_id,c.accept_state,c.accept_error,c.version,
          o.number order_number,o.state order_state,o.revenue_minor::text,o.paid_minor::text,
          (SELECT coalesce(sum(CASE WHEN x.kind='payout' THEN x.gross_minor ELSE -x.gross_minor END),0)::text FROM channel_settlements x WHERE x.organization_id=c.organization_id AND x.channel_order_id=c.id) settled_gross_minor,
          (SELECT coalesce(sum(CASE WHEN x.kind='payout' THEN x.commission_minor ELSE -x.commission_minor END),0)::text FROM channel_settlements x WHERE x.organization_id=c.organization_id AND x.channel_order_id=c.id) commission_minor,
          (SELECT coalesce(sum(CASE WHEN x.kind='payout' THEN x.net_minor ELSE -x.net_minor END),0)::text FROM channel_settlements x WHERE x.organization_id=c.organization_id AND x.channel_order_id=c.id) net_minor,
          (SELECT count(*)::int FROM channel_settlements x WHERE x.organization_id=c.organization_id AND x.channel_order_id=c.id) settlements
         FROM channel_orders c LEFT JOIN sales_orders o ON o.organization_id=c.organization_id AND o.id=c.sales_order_id
         WHERE c.organization_id=$1 AND c.connection_id=$2 ORDER BY c.created_external DESC LIMIT 100`,
        [org, id],
      );
      return {
        writes: Boolean(conn.settings.writes),
        version: conn.version,
        items,
      };
    });
  }
}
