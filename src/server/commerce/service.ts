import { randomUUID, createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { Database, Sql } from "../db/database";
import { sessionAccess, audit, type Credential } from "../access";
import { AppError } from "../../domain/errors";
import { can } from "../../domain/permissions";
import { idSchema } from "../../domain/contracts";
import { pagination, pageQuery } from "../../domain/import-contracts";
import {
  orderInput,
  orderCommand,
  moneyCommand,
  accountInput,
  obligationInput,
  commerceQuery,
  calendarQuery,
  discountedTotal,
  type Order,
  type OrderView,
} from "../../domain/commerce";
import { toBase, allocatedValue, type Item } from "../../domain/inventory";
import { minorUnits, marginPercent } from "../../domain/decimal";
import { InventoryService } from "../inventory/service";
const D = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP });
type Scope = Awaited<ReturnType<typeof sessionAccess>>;
type Line = OrderView["lines"][number];
const target = `CASE WHEN o.state='draft' THEN 0 WHEN o.state='cancelled' THEN o.revenue_minor ELSE o.total_minor+coalesce((SELECT sum(e.revenue_minor) FROM sales_events e WHERE e.organization_id=o.organization_id AND e.order_id=o.id AND e.kind='return'),0) END`;
const orderColumns = `o.id,o.number,o.branch_id,o.customer_id,o.inquiry_id,o.quote_id,c.name customer_name,o.warehouse_id,o.state,o.version,o.due_date::text,o.delivery,o.note,o.tax_mode,o.total_minor::text,o.revenue_minor::text,o.paid_minor::text,greatest(o.revenue_minor-o.paid_minor,0)::text receivable_minor,greatest(o.paid_minor-(${target}),0)::text credit_minor,greatest((${target})-o.paid_minor,0)::text expected_minor,o.created_at`;
const lineColumns =
  "id,item_id,sku,name_ru,name_kk,kind,unit,base_unit,quantity::text,base_quantity::text,price::text,discount::text,total_minor::text,fulfilled::text,returned::text,reservation_id";
async function command(tx: Sql, org: string, key: string, payload: unknown) {
  const hash = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex"),
    id = randomUUID(),
    result = randomUUID();
  const inserted = await tx.query(
    "INSERT INTO commerce_commands(id,organization_id,request_key,payload_hash,result_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,request_key) DO NOTHING RETURNING id",
    [id, org, key, hash, result],
  );
  if (inserted.length) return { commandId: id, id: result, reused: false };
  const [old] = await tx.query<{
    id: string;
    payload_hash: string;
    result_id: string;
  }>(
    "SELECT id,payload_hash,result_id FROM commerce_commands WHERE organization_id=$1 AND request_key=$2",
    [org, key],
  );
  if (old.payload_hash !== hash)
    throw new AppError("IDEMPOTENCY_CONFLICT", 409);
  return { commandId: old.id, id: old.result_id, reused: true };
}
export class CommerceService {
  constructor(private db: Database) {}
  private async order(
    tx: Sql,
    org: string,
    id: string,
    scope: Scope,
    lock = false,
  ) {
    idSchema.parse(id);
    const [o] = await tx.query<Order>(
      `SELECT ${orderColumns} FROM sales_orders o JOIN customers c ON c.organization_id=o.organization_id AND c.id=o.customer_id WHERE o.organization_id=$1 AND o.id=$2 AND ($3::uuid IS NULL OR o.branch_id=$3) ${lock ? "FOR UPDATE OF o" : ""}`,
      [org, id, scope.branchId],
    );
    if (!o) throw new AppError("NOT_FOUND", 404);
    return o;
  }
  async customers(secret: Credential, org: string, input: unknown) {
    const q = commerceQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "orders:read", q.branchId),
        where =
          "organization_id=$1 AND ($2::uuid IS NULL OR branch_id=$2) AND position(lower($3) in lower(name))>0";
      const [count] = await tx.query<{ total: number }>(
        `SELECT count(*)::int total FROM customers WHERE ${where}`,
        [org, s.branchId, q.q],
      );
      return {
        items: await tx.query(
          `SELECT id,name FROM customers WHERE ${where} ORDER BY name,id LIMIT $4 OFFSET $5`,
          [org, s.branchId, q.q, q.limit, (q.page - 1) * q.limit],
        ),
        pagination: pagination(q.page, q.limit, count.total),
      };
    });
  }
  async list(secret: Credential, org: string, input: unknown) {
    const q = commerceQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "orders:read", q.branchId),
        where =
          "o.organization_id=$1 AND ($2::uuid IS NULL OR o.branch_id=$2) AND position(lower($3) in lower(c.name||' '||o.number::text))>0",
        join =
          "sales_orders o JOIN customers c ON c.organization_id=o.organization_id AND c.id=o.customer_id";
      const [count] = await tx.query<{ total: number }>(
        `SELECT count(*)::int total FROM ${join} WHERE ${where}`,
        [org, s.branchId, q.q],
      );
      return {
        items: await tx.query(
          `SELECT ${orderColumns} FROM ${join} WHERE ${where} ORDER BY o.created_at DESC,o.id DESC LIMIT $4 OFFSET $5`,
          [org, s.branchId, q.q, q.limit, (q.page - 1) * q.limit],
        ),
        pagination: pagination(q.page, q.limit, count.total),
      };
    });
  }
  async get(secret: Credential, org: string, id: string, input: unknown = {}) {
    const q = pageQuery.pick({ page: true, limit: true }).parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "orders:read"),
        order = await this.order(tx, org, id, s, true);
      const [count] = await tx.query<{ total: number }>(
        "SELECT count(*)::int total FROM sales_events WHERE organization_id=$1 AND order_id=$2",
        [org, id],
      );
      return {
        order,
        eventPagination: pagination(q.page, q.limit, count.total),
        lines: await tx.query<Line>(
          `SELECT ${lineColumns} FROM sales_order_lines WHERE organization_id=$1 AND order_id=$2 ORDER BY sku,id`,
          [org, id],
        ),
        events: await tx.query(
          `SELECT e.id,e.kind,e.line_id,e.source_id,e.movement_id,e.quantity::text,e.revenue_minor::text${can(s.role, "inventory:cost") ? ",e.cost_minor::text" : ""},e.note,u.name actor_name,e.created_at FROM sales_events e JOIN users u ON u.id=e.actor_id WHERE e.organization_id=$1 AND e.order_id=$2 ORDER BY e.created_at DESC,e.id DESC LIMIT $3 OFFSET $4`,
          [org, id, q.limit, (q.page - 1) * q.limit],
        ),
      };
    });
  }
  async create(secret: Credential, org: string, input: unknown) {
    return this.db.transaction((tx) =>
      this.createInTransaction(tx, secret, org, input),
    );
  }
  async createInTransaction(
    tx: Sql,
    secret: Credential,
    org: string,
    input: unknown,
  ) {
    const c = orderInput.parse(input);
    {
      const s = await sessionAccess(
          tx,
          secret,
          org,
          "orders:write",
          c.branchId,
        ),
        r = await command(tx, org, c.key, { operation: "order.create", ...c });
      if (r.reused) return r;
      if (
        !(
          await tx.query(
            "SELECT id FROM customers WHERE organization_id=$1 AND id=$2 AND branch_id=$3 FOR SHARE",
            [org, c.customerId, c.branchId],
          )
        ).length
      )
        throw new AppError("CUSTOMER_SCOPE", 422);
      if (
        !(
          await tx.query(
            "SELECT id FROM warehouses WHERE organization_id=$1 AND id=$2 AND branch_id=$3",
            [org, c.warehouseId, c.branchId],
          )
        ).length
      )
        throw new AppError("WAREHOUSE_SCOPE", 422);
      if (new Set(c.lines.map((l) => l.itemId)).size !== c.lines.length)
        throw new AppError("DUPLICATE_LINE", 422);
      const lines = [];
      let total = 0n;
      for (const l of [...c.lines].sort((a, b) =>
        a.itemId.localeCompare(b.itemId),
      )) {
        const [item] = await tx.query<Item>(
          "SELECT id,sku,name_ru,name_kk,kind,base_unit,conversions,active FROM catalog_items WHERE organization_id=$1 AND id=$2 FOR SHARE",
          [org, l.itemId],
        );
        if (!item) throw new AppError("NOT_FOUND", 404);
        if (!item.active) throw new AppError("ITEM_ARCHIVED", 409);
        const base = toBase(l.quantity, l.unit, item),
          amount = discountedTotal(l.price, l.quantity, l.discount);
        total += amount;
        lines.push({ l, item, base, amount });
      }
      if (total >= 10n ** 38n) throw new AppError("AMOUNT_LIMIT", 422);
      await tx.query(
        "INSERT INTO sales_orders(id,organization_id,branch_id,customer_id,warehouse_id,state,due_date,delivery,note,tax_mode,total_minor) VALUES($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10)",
        [
          r.id,
          org,
          c.branchId,
          c.customerId,
          c.warehouseId,
          c.dueDate,
          c.delivery,
          c.note,
          c.taxMode,
          total.toString(),
        ],
      );
      for (const { l, item, base, amount } of lines)
        await tx.query(
          "INSERT INTO sales_order_lines(id,organization_id,order_id,item_id,sku,name_ru,name_kk,kind,unit,base_unit,quantity,base_quantity,price,discount,total_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
          [
            randomUUID(),
            org,
            r.id,
            l.itemId,
            item.sku,
            item.name_ru,
            item.name_kk,
            item.kind,
            l.unit,
            item.base_unit,
            l.quantity,
            base,
            l.price,
            l.discount,
            amount.toString(),
          ],
        );
      await this.event(tx, org, r.id, s, "created", c.note);
      await audit(tx, org, s.actorId, "order.created", c.branchId, {
        orderId: r.id,
      });
      return r;
    }
  }
  private async event(
    tx: Sql,
    org: string,
    orderId: string,
    s: Scope,
    kind: string,
    note: string,
    extra: {
      id?: string;
      line?: string;
      source?: string;
      movement?: string;
      quantity?: string;
      revenue?: bigint;
      cost?: bigint | null;
    } = {},
  ) {
    await tx.query(
      "INSERT INTO sales_events(id,organization_id,order_id,kind,note,actor_id,line_id,source_id,movement_id,quantity,revenue_minor,cost_minor) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [
        extra.id || randomUUID(),
        org,
        orderId,
        kind,
        note,
        s.actorId,
        extra.line || null,
        extra.source || null,
        extra.movement || null,
        extra.quantity || "0",
        String(extra.revenue ?? 0n),
        extra.cost === null ? null : String(extra.cost ?? 0n),
      ],
    );
  }
  async transition(
    secret: Credential,
    org: string,
    id: string,
    input: unknown,
  ) {
    const c = orderCommand.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "orders:write"),
        o = await this.order(tx, org, id, s, true),
        r = await command(tx, org, c.key, {
          operation: "order.command",
          orderId: id,
          ...c,
        });
      if (r.reused) return r;
      if (o.version !== c.version) throw new AppError("VERSION_CONFLICT", 409);
      const lines = await tx.query<Line>(
        `SELECT ${lineColumns} FROM sales_order_lines WHERE organization_id=$1 AND order_id=$2 ORDER BY item_id`,
        [org, id],
      );
      const inventory = new InventoryService(this.db);
      const stock = async (
        l: Line,
        kind: string,
        extra: Record<string, unknown> = {},
      ) => {
        const result = await inventory.executeInTransaction(
          tx,
          secret,
          org,
          {
            key: randomUUID(),
            warehouseId: o.warehouse_id,
            itemId: l.item_id,
            kind,
            note: c.note,
            ...extra,
          },
          id,
        );
        if (kind !== "release")
          await tx.query(
            "INSERT INTO order_stock_links(organization_id,order_id,object_id,kind) VALUES($1,$2,$3,$4)",
            [
              org,
              id,
              result.id,
              kind === "reserve" ? "reservation" : "movement",
            ],
          );
        return result.id;
      };
      let state = o.state,
        revenueDelta = 0n;
      if (c.kind === "confirm") {
        if (o.state !== "draft") throw new AppError("ORDER_STATE", 409);
        const active = await tx.query<{ active: boolean }>(
          "SELECT i.active FROM catalog_items i JOIN sales_order_lines l ON l.organization_id=i.organization_id AND l.item_id=i.id WHERE l.organization_id=$1 AND l.order_id=$2 ORDER BY i.id FOR SHARE OF i",
          [org, id],
        );
        if (active.some((i) => !i.active))
          throw new AppError("ITEM_ARCHIVED", 409);
        for (const l of lines)
          if (l.kind === "goods") {
            const reservation = await stock(l, "reserve", {
              quantity: l.quantity,
              unit: l.unit,
            });
            await tx.query(
              "UPDATE sales_order_lines SET reservation_id=$3 WHERE organization_id=$1 AND id=$2",
              [org, l.id, reservation],
            );
          }
        state = "confirmed";
        await this.event(tx, org, id, s, c.kind, c.note, { id: r.id });
      } else if (c.kind === "cancel") {
        if (!["draft", "confirmed", "partial"].includes(o.state))
          throw new AppError("ORDER_STATE", 409);
        for (const l of lines)
          if (l.reservation_id) {
            await stock(l, "release", { reservationId: l.reservation_id });
            await tx.query(
              "UPDATE sales_order_lines SET reservation_id=NULL WHERE organization_id=$1 AND id=$2",
              [org, l.id],
            );
          }
        state = "cancelled";
        await this.event(tx, org, id, s, c.kind, c.note, { id: r.id });
      } else if (c.kind === "fulfill") {
        if (!["confirmed", "partial"].includes(o.state))
          throw new AppError("ORDER_STATE", 409);
        const l = lines.find((l) => l.id === c.lineId);
        if (!l) throw new AppError("NOT_FOUND", 404);
        const next = new D(l.fulfilled).plus(c.quantity);
        if (next.gt(l.quantity)) throw new AppError("QUANTITY_EXCEEDS", 409);
        revenueDelta =
          allocatedValue(BigInt(l.total_minor), next.toFixed(), l.quantity) -
          (new D(l.fulfilled).isZero()
            ? 0n
            : allocatedValue(BigInt(l.total_minor), l.fulfilled, l.quantity));
        let movement: string | undefined,
          cost: bigint | null = null,
          reservation: string | null = null;
        if (l.kind === "goods") {
          if (c.serviceCost !== undefined)
            throw new AppError("INVALID_INPUT", 422);
          if (!l.reservation_id)
            throw new AppError("RESERVATION_MISMATCH", 409);
          await stock(l, "release", { reservationId: l.reservation_id });
          movement = await stock(l, "issue", {
            quantity: c.quantity,
            unit: l.unit,
          });
          const [m] = await tx.query<{ value_minor: string }>(
            "SELECT value_minor::text FROM stock_movements WHERE organization_id=$1 AND id=$2",
            [org, movement],
          );
          cost = -BigInt(m.value_minor);
          const remaining = new D(l.quantity).minus(next);
          if (remaining.gt(0))
            reservation = await stock(l, "reserve", {
              quantity: remaining.toFixed(),
              unit: l.unit,
            });
        } else if (c.serviceCost !== undefined) {
          if (!can(s.role, "inventory:cost"))
            throw new AppError("FORBIDDEN", 403);
          cost = minorUnits(c.serviceCost);
        }
        await tx.query(
          "UPDATE sales_order_lines SET fulfilled=$3,reservation_id=$4 WHERE organization_id=$1 AND id=$2",
          [org, l.id, next.toFixed(), reservation],
        );
        state = lines.every((v) =>
          v.id === l.id
            ? next.eq(v.quantity)
            : new D(v.fulfilled).eq(v.quantity),
        )
          ? "fulfilled"
          : "partial";
        await this.event(tx, org, id, s, c.kind, c.note, {
          id: r.id,
          line: l.id,
          movement,
          quantity: c.quantity,
          revenue: revenueDelta,
          cost,
        });
      } else {
        if (o.state === "draft") throw new AppError("ORDER_STATE", 409);
        const [e] = await tx.query<{
          line_id: string;
          movement_id: string | null;
          quantity: string;
          revenue_minor: string;
          cost_minor: string | null;
        }>(
          "SELECT line_id,movement_id,quantity::text,revenue_minor::text,cost_minor::text FROM sales_events WHERE organization_id=$1 AND order_id=$2 AND id=$3 AND kind='fulfill'",
          [org, id, c.eventId],
        );
        if (!e) throw new AppError("RETURN_SOURCE", 404);
        const l = lines.find((v) => v.id === e.line_id)!;
        const [returned] = await tx.query<{
          quantity: string;
          revenue: string;
          cost: string;
        }>(
          "SELECT coalesce(sum(quantity),0)::text quantity,coalesce(sum(revenue_minor),0)::text revenue,coalesce(sum(cost_minor),0)::text cost FROM sales_events WHERE organization_id=$1 AND source_id=$2",
          [org, c.eventId],
        );
        const next = new D(returned.quantity).plus(c.quantity);
        if (next.gt(e.quantity)) throw new AppError("RETURN_EXCEEDS", 409);
        revenueDelta =
          -allocatedValue(BigInt(e.revenue_minor), next.toFixed(), e.quantity) -
          BigInt(returned.revenue);
        let movement: string | undefined,
          cost: bigint | null = null;
        if (e.movement_id) {
          movement = await stock(l, "return", {
            quantity: c.quantity,
            unit: l.unit,
            movementId: e.movement_id,
          });
          const [m] = await tx.query<{ value_minor: string }>(
            "SELECT value_minor::text FROM stock_movements WHERE organization_id=$1 AND id=$2",
            [org, movement],
          );
          cost = -BigInt(m.value_minor);
        } else if (e.cost_minor !== null)
          cost =
            -allocatedValue(BigInt(e.cost_minor), next.toFixed(), e.quantity) -
            BigInt(returned.cost);
        await tx.query(
          "UPDATE sales_order_lines SET returned=returned+$3 WHERE organization_id=$1 AND id=$2",
          [org, l.id, c.quantity],
        );
        await this.event(tx, org, id, s, c.kind, c.note, {
          id: r.id,
          line: l.id,
          source: c.eventId,
          movement,
          quantity: c.quantity,
          revenue: revenueDelta,
          cost,
        });
      }
      await tx.query(
        "UPDATE sales_orders SET state=$3,revenue_minor=revenue_minor+$4,version=version+1 WHERE organization_id=$1 AND id=$2",
        [org, id, state, revenueDelta.toString()],
      );
      await audit(tx, org, s.actorId, `order.${c.kind}`, o.branch_id, {
        orderId: id,
        eventId: r.id,
      });
      return r;
    });
  }
  async accounts(secret: Credential, org: string, input: unknown) {
    const q = commerceQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        "finance:read",
        q.branchId,
      );
      return {
        items: await tx.query(
          "SELECT id,branch_id,name,balance_minor::text FROM money_accounts WHERE organization_id=$1 AND ($2::uuid IS NULL OR branch_id=$2) ORDER BY name,id",
          [org, s.branchId],
        ),
      };
    });
  }
  private async entry(
    tx: Sql,
    org: string,
    s: Scope,
    r: { commandId: string; id: string },
    account: string,
    kind: string,
    value: bigint,
    note: string,
    extra: {
      order?: string;
      obligation?: string;
      category?: string;
      counterparty?: string;
      operating?: boolean;
    } = {},
  ) {
    await tx.query(
      "UPDATE money_accounts SET balance_minor=balance_minor+$3 WHERE organization_id=$1 AND id=$2",
      [org, account, value.toString()],
    );
    await tx.query(
      "INSERT INTO money_entries(id,organization_id,account_id,command_id,kind,amount_minor,category,counterparty,note,operating,order_id,obligation_id,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [
        r.id,
        org,
        account,
        r.commandId,
        kind,
        value.toString(),
        extra.category || kind,
        extra.counterparty || "",
        note,
        extra.operating || false,
        extra.order || null,
        extra.obligation || null,
        s.actorId,
      ],
    );
  }
  async createAccount(secret: Credential, org: string, input: unknown) {
    const c = accountInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
          tx,
          secret,
          org,
          "finance:write",
          c.branchId,
        ),
        r = await command(tx, org, c.key, {
          operation: "account.create",
          ...c,
        });
      if (r.reused) return r;
      await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
        org,
      ]);
      const [count] = await tx.query<{ n: number }>(
        "SELECT count(*)::int n FROM money_accounts WHERE organization_id=$1",
        [org],
      );
      if (count.n >= 100) throw new AppError("ACCOUNT_LIMIT", 409);
      if (
        (
          await tx.query(
            "SELECT id FROM money_accounts WHERE organization_id=$1 AND branch_id=$2 AND name=$3",
            [org, c.branchId, c.name],
          )
        ).length
      )
        throw new AppError("ACCOUNT_EXISTS", 409);
      await tx.query(
        "INSERT INTO money_accounts(id,organization_id,branch_id,name) VALUES($1,$2,$3,$4)",
        [r.id, org, c.branchId, c.name],
      );
      await this.entry(
        tx,
        org,
        s,
        { ...r, id: randomUUID() },
        r.id,
        "opening",
        minorUnits(c.opening),
        "Opening balance",
      );
      await audit(tx, org, s.actorId, "account.created", c.branchId, {
        accountId: r.id,
      });
      return r;
    });
  }
  async createObligation(secret: Credential, org: string, input: unknown) {
    const c = obligationInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
          tx,
          secret,
          org,
          "finance:write",
          c.branchId,
        ),
        r = await command(tx, org, c.key, {
          operation: "obligation.create",
          ...c,
        });
      if (r.reused) return r;
      await tx.query(
        "INSERT INTO supplier_obligations(id,organization_id,branch_id,supplier,amount_minor,due_date,note) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          r.id,
          org,
          c.branchId,
          c.supplier,
          minorUnits(c.amount).toString(),
          c.dueDate,
          c.note,
        ],
      );
      await audit(tx, org, s.actorId, "obligation.created", c.branchId, {
        obligationId: r.id,
      });
      return r;
    });
  }
  async money(secret: Credential, org: string, input: unknown) {
    const c = moneyCommand.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "finance:write");
      const o =
        "orderId" in c
          ? await this.order(tx, org, c.orderId, s, true)
          : undefined;
      const [ob] =
        "obligationId" in c
          ? await tx.query<{
              id: string;
              branch_id: string;
              supplier: string;
              amount_minor: string;
              paid_minor: string;
            }>(
              "SELECT id,branch_id,supplier,amount_minor::text,paid_minor::text FROM supplier_obligations WHERE organization_id=$1 AND id=$2 AND ($3::uuid IS NULL OR branch_id=$3) FOR UPDATE",
              [org, c.obligationId, s.branchId],
            )
          : [];
      if ("obligationId" in c && !ob) throw new AppError("NOT_FOUND", 404);
      const ids = [
        c.accountId,
        ...(c.kind === "transfer" ? [c.destinationId] : []),
      ].sort();
      if (new Set(ids).size !== ids.length)
        throw new AppError("SAME_ACCOUNT", 422);
      const accounts = await tx.query<{
        id: string;
        branch_id: string;
        balance_minor: string;
      }>(
        "SELECT id,branch_id,balance_minor::text FROM money_accounts WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND ($3::uuid IS NULL OR branch_id=$3) ORDER BY id FOR UPDATE",
        [org, ids, s.branchId],
      );
      if (accounts.length !== ids.length) throw new AppError("NOT_FOUND", 404);
      const account = accounts.find((a) => a.id === c.accountId)!;
      if (
        (o && o.branch_id !== account.branch_id) ||
        (ob && ob.branch_id !== account.branch_id)
      )
        throw new AppError("ACCOUNT_SCOPE", 422);
      const r = await command(tx, org, c.key, {
        operation: "money.command",
        ...c,
      });
      if (r.reused) return r;
      const value = minorUnits(c.amount),
        out = ["refund", "supplier_payment", "expense", "transfer"].includes(
          c.kind,
        ),
        signed = out ? -value : value;
      if (out && BigInt(account.balance_minor) < value)
        throw new AppError("INSUFFICIENT_MONEY", 409);
      if (BigInt(account.balance_minor) + signed >= 10n ** 38n)
        throw new AppError("AMOUNT_LIMIT", 422);
      if (o) {
        if (o.state === "draft") throw new AppError("ORDER_STATE", 409);
        if (c.kind === "payment" && value > BigInt(o.expected_minor))
          throw new AppError("PAYMENT_EXCEEDS", 409);
        if (c.kind === "refund" && value > BigInt(o.paid_minor))
          throw new AppError("REFUND_EXCEEDS", 409);
        await tx.query(
          "UPDATE sales_orders SET paid_minor=paid_minor+$3,version=version+1 WHERE organization_id=$1 AND id=$2",
          [org, o.id, signed.toString()],
        );
        await this.event(tx, org, o.id, s, c.kind, c.note, { id: r.id });
      }
      if (ob) {
        if (value > BigInt(ob.amount_minor) - BigInt(ob.paid_minor))
          throw new AppError("PAYMENT_EXCEEDS", 409);
        await tx.query(
          "UPDATE supplier_obligations SET paid_minor=paid_minor+$3 WHERE organization_id=$1 AND id=$2",
          [org, ob.id, value.toString()],
        );
      }
      await this.entry(tx, org, s, r, c.accountId, c.kind, signed, c.note, {
        order: o?.id,
        obligation: ob?.id,
        category: "category" in c ? c.category : undefined,
        counterparty:
          o?.customer_name ||
          ob?.supplier ||
          ("counterparty" in c ? c.counterparty : undefined),
        operating: c.kind === "expense" && c.operating,
      });
      if (c.kind === "transfer") {
        const dest = accounts.find((a) => a.id === c.destinationId)!;
        if (BigInt(dest.balance_minor) + value >= 10n ** 38n)
          throw new AppError("AMOUNT_LIMIT", 422);
        await this.entry(
          tx,
          org,
          s,
          { ...r, id: randomUUID() },
          c.destinationId,
          c.kind,
          value,
          c.note,
        );
        if (dest.branch_id !== account.branch_id)
          await audit(tx, org, s.actorId, "money.transfer", dest.branch_id, {
            entryId: r.id,
          });
      }
      await audit(tx, org, s.actorId, `money.${c.kind}`, account.branch_id, {
        entryId: r.id,
      });
      return r;
    });
  }
  async ledger(secret: Credential, org: string, input: unknown) {
    const q = commerceQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
          tx,
          secret,
          org,
          "finance:read",
          q.branchId,
        ),
        join =
          "money_entries e JOIN money_accounts a ON a.organization_id=e.organization_id AND a.id=e.account_id",
        where =
          "e.organization_id=$1 AND ($2::uuid IS NULL OR a.branch_id=$2) AND position(lower($3) in lower(e.note||' '||e.counterparty||' '||e.category))>0";
      const [count] = await tx.query<{ total: number }>(
        `SELECT count(*)::int total FROM ${join} WHERE ${where}`,
        [org, s.branchId, q.q],
      );
      return {
        items: await tx.query(
          `SELECT e.id,e.account_id,a.name account_name,e.kind,e.amount_minor::text,e.category,e.counterparty,e.note,e.order_id,e.obligation_id,e.created_at FROM ${join} WHERE ${where} ORDER BY e.created_at DESC,e.id DESC LIMIT $4 OFFSET $5`,
          [org, s.branchId, q.q, q.limit, (q.page - 1) * q.limit],
        ),
        pagination: pagination(q.page, q.limit, count.total),
      };
    });
  }
  async obligations(secret: Credential, org: string, input: unknown) {
    const q = commerceQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
          tx,
          secret,
          org,
          "finance:read",
          q.branchId,
        ),
        where =
          "organization_id=$1 AND ($2::uuid IS NULL OR branch_id=$2) AND position(lower($3) in lower(supplier||' '||note))>0";
      const [count] = await tx.query<{ total: number }>(
        `SELECT count(*)::int total FROM supplier_obligations WHERE ${where}`,
        [org, s.branchId, q.q],
      );
      return {
        items: await tx.query(
          `SELECT id,branch_id,supplier,purchase_order_id,amount_minor::text,paid_minor::text,due_date::text,note FROM supplier_obligations WHERE ${where} ORDER BY due_date,id LIMIT $4 OFFSET $5`,
          [org, s.branchId, q.q, q.limit, (q.page - 1) * q.limit],
        ),
        pagination: pagination(q.page, q.limit, count.total),
      };
    });
  }
  async calendar(secret: Credential, org: string, input: unknown) {
    const q = calendarQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        "finance:read",
        q.branchId,
      );
      const [data] = await tx.query<{
        today: string;
        opening: string;
        documents: {
          id: string;
          kind: "order" | "supplier" | "purchase";
          name: string;
          due_date: string;
          amount_minor: string;
        }[];
      }>(
        `WITH settings AS (SELECT (now() AT TIME ZONE timezone)::date today FROM organizations WHERE id=$1), docs AS (SELECT o.id,'order' kind,c.name,o.due_date,greatest((${target})-o.paid_minor,0)::text amount_minor FROM sales_orders o JOIN customers c ON c.organization_id=o.organization_id AND c.id=o.customer_id WHERE o.organization_id=$1 AND ($2::uuid IS NULL OR o.branch_id=$2) AND o.state<>'draft' UNION ALL SELECT id,'supplier',supplier,due_date,(amount_minor-paid_minor)::text FROM supplier_obligations WHERE organization_id=$1 AND ($2::uuid IS NULL OR branch_id=$2) UNION ALL SELECT p.id,'purchase',s.name,p.due_date,greatest(p.total_minor-coalesce((SELECT sum(b.amount_minor) FROM supplier_obligations b WHERE b.organization_id=p.organization_id AND b.purchase_order_id=p.id),0),0)::text FROM purchase_orders p JOIN suppliers s ON s.organization_id=p.organization_id AND s.id=p.supplier_id WHERE p.organization_id=$1 AND ($2::uuid IS NULL OR p.branch_id=$2) AND p.state IN ('approved','sent','partial')), planned AS (SELECT id,kind,name,due_date::text,amount_minor FROM docs WHERE amount_minor::numeric>0 AND due_date<=(SELECT today FROM settings)+$3::int ORDER BY due_date,id LIMIT 5001) SELECT today::text,(SELECT coalesce(sum(balance_minor),0)::text FROM money_accounts WHERE organization_id=$1 AND ($2::uuid IS NULL OR branch_id=$2)) opening,coalesce((SELECT jsonb_agg(planned) FROM planned),'[]'::jsonb) documents FROM settings`,
        [org, s.branchId, q.days - 1],
      );
      if (data.documents.length > 5000)
        throw new AppError("CALENDAR_LIMIT", 422);
      const addDays = (day: string, n: number) => {
        const d = new Date(`${day}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
      };
      let baseline = BigInt(data.opening),
        scenario = baseline,
        incoming = 0n,
        outgoing = 0n;
      const documents = data.documents.map((d) => ({
        ...d,
        overdue: d.due_date < data.today,
      }));
      const flows = new Map<string, { base: bigint; scenario: bigint }>();
      const add = (date: string, value: bigint, mode: "base" | "scenario") => {
        const day = date < data.today ? data.today : date,
          f = flows.get(day) || { base: 0n, scenario: 0n };
        f[mode] += value;
        flows.set(day, f);
      };
      for (const d of documents) {
        const amount = BigInt(d.amount_minor);
        if (d.kind === "order") {
          incoming += amount;
          add(d.due_date, amount, "base");
          add(
            addDays(
              d.due_date < data.today ? data.today : d.due_date,
              q.delayDays,
            ),
            amount,
            "scenario",
          );
        } else {
          outgoing += amount;
          add(d.due_date, -amount, "base");
          add(
            d.due_date,
            -BigInt(
              new D(amount.toString())
                .times(q.expensePercent)
                .div(100)
                .toDecimalPlaces(0)
                .toFixed(0),
            ),
            "scenario",
          );
        }
      }
      const days = Array.from({ length: q.days }, (_, i) => {
        const date = addDays(data.today, i),
          f = flows.get(date);
        baseline += f?.base || 0n;
        scenario += f?.scenario || 0n;
        return {
          date,
          baseline_minor: String(baseline),
          scenario_minor: String(scenario),
        };
      });
      return {
        today: data.today,
        through: days.at(-1)!.date,
        opening_minor: data.opening,
        baseline_minor: String(baseline),
        scenario_minor: String(scenario),
        planned_in_minor: String(incoming),
        planned_out_minor: String(outgoing),
        delay_days: q.delayDays,
        expense_percent: q.expensePercent,
        complete: false as const,
        days,
        documents,
      };
    });
  }
  async summary(secret: Credential, org: string, input: unknown) {
    const q = commerceQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
          tx,
          secret,
          org,
          "finance:read",
          q.branchId,
        ),
        params = [org, s.branchId];
      // One SQL statement supplies a single MVCC snapshot of all report components.
      const [r] = await tx.query<{
        revenue_minor: string;
        cost_minor: string;
        operating_expenses_minor: string;
        cash_minor: string;
        receivable_minor: string;
        customer_credit_minor: string;
        payable_minor: string;
        overdue_minor: string;
        unknown_cost_events: number;
      }>(
        `WITH scoped_orders AS (SELECT o.* FROM sales_orders o WHERE o.organization_id=$1 AND ($2::uuid IS NULL OR o.branch_id=$2)), scoped_accounts AS (SELECT * FROM money_accounts WHERE organization_id=$1 AND ($2::uuid IS NULL OR branch_id=$2)), sales AS (SELECT coalesce(sum(e.revenue_minor),0)::text revenue_minor,coalesce(sum(e.cost_minor),0)::text cost_minor,count(*) FILTER(WHERE e.cost_minor IS NULL)::int unknown_cost_events FROM sales_events e JOIN scoped_orders o ON o.id=e.order_id AND o.organization_id=e.organization_id WHERE e.kind IN ('fulfill','return')) SELECT sales.*, (SELECT coalesce(-sum(e.amount_minor),0)::text FROM money_entries e JOIN scoped_accounts a ON a.id=e.account_id AND a.organization_id=e.organization_id WHERE e.operating) operating_expenses_minor,(SELECT coalesce(sum(balance_minor),0)::text FROM scoped_accounts) cash_minor,(SELECT coalesce(sum(greatest(revenue_minor-paid_minor,0)),0)::text FROM scoped_orders) receivable_minor,(SELECT coalesce(sum(greatest(paid_minor-revenue_minor,0)),0)::text FROM scoped_orders) customer_credit_minor,(SELECT coalesce(sum(amount_minor-paid_minor),0)::text FROM supplier_obligations WHERE organization_id=$1 AND ($2::uuid IS NULL OR branch_id=$2)) payable_minor,(SELECT coalesce(sum(greatest(o.revenue_minor-o.paid_minor,0)),0)::text FROM scoped_orders o JOIN organizations g ON g.id=o.organization_id WHERE o.due_date<(now() AT TIME ZONE g.timezone)::date) overdue_minor FROM sales`,
        params,
      );
      const revenue = BigInt(r.revenue_minor),
        cost = BigInt(r.cost_minor),
        gross = revenue - cost,
        unknown = r.unknown_cost_events > 0;
      return {
        ...r,
        gross_profit_minor: unknown ? null : String(gross),
        operating_result_minor: unknown
          ? null
          : String(gross - BigInt(r.operating_expenses_minor)),
        margin_percent: unknown ? null : marginPercent(revenue, cost),
        markup_percent:
          unknown || cost === 0n
            ? null
            : new D(gross.toString())
                .div(cost.toString())
                .times(100)
                .toFixed(2),
        tax_mode: "excluded" as const,
        expenses_complete: false as const,
      };
    });
  }
}
