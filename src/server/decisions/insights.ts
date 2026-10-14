import { randomUUID } from "node:crypto";
import type { Database, Sql } from "../db/database";
import { sessionAccess, audit, type Credential } from "../access";
import { AppError } from "../../domain/errors";
import { idSchema, type Role } from "../../domain/contracts";
import { can, type Permission } from "../../domain/permissions";
import { pagination } from "../../domain/import-contracts";
import { D, priceOffer, type OfferData } from "../../domain/purchasing";
import {
  insightQuery,
  insightCommand,
  reorderInput,
  type InsightRow,
} from "../../domain/decisions";
import { idempotent, emit, organizationClock } from "../execution/core";

type Evidence = InsightRow["evidence"];
type Candidate = {
  rule: InsightRow["rule"];
  branch: string | null;
  entityType: string;
  entityId: string;
  severity: number;
  evidence: Evidence;
};
// Each rule is visible only to roles that can read its underlying data.
export const rulePermission: Record<InsightRow["rule"], Permission> = {
  low_stock: "inventory:read",
  overdue_receivable: "finance:read",
  overdue_payable: "finance:read",
  purchase_pending: "purchasing:read",
  document_review: "purchasing:read",
  overdue_task: "tasks:manage",
};
export function visibleRules(role: Role) {
  return (Object.keys(rulePermission) as InsightRow["rule"][]).filter((r) =>
    can(role, rulePermission[r]),
  );
}
const columns =
  "i.id,i.branch_id,i.rule,i.entity_type,i.entity_id,i.severity,i.state,i.evidence,i.resolution,i.detected_at,i.last_seen_at,i.resolved_at,i.version";
const money = (minor: string) => new D(minor).div(100).toFixed(2);
export class InsightService {
  constructor(private db: Database) {}
  async setReorderPoint(secret: Credential, org: string, input: unknown) {
    const c = reorderInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "inventory:write");
      const [w] = await tx.query<{ branch_id: string }>(
        "SELECT branch_id FROM warehouses WHERE organization_id=$1 AND id=$2",
        [org, c.warehouseId],
      );
      if (!w || (s.branchId && w.branch_id !== s.branchId))
        throw new AppError("NOT_FOUND", 404);
      const [item] = await tx.query<{ kind: string }>(
        "SELECT kind FROM catalog_items WHERE organization_id=$1 AND id=$2",
        [org, c.itemId],
      );
      if (!item || item.kind !== "goods")
        throw new AppError("ITEM_MISMATCH", 422);
      const [row] = await tx.query<{ version: number }>(
        "SELECT version FROM reorder_points WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3 FOR UPDATE",
        [org, c.warehouseId, c.itemId],
      );
      if ((row?.version || 0) !== c.version)
        throw new AppError("VERSION_CONFLICT", 409);
      await tx.query(
        "INSERT INTO reorder_points(organization_id,warehouse_id,item_id,minimum,safety,lead_days,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,warehouse_id,item_id) DO UPDATE SET minimum=$4,safety=$5,lead_days=$6,updated_by=$7,updated_at=now(),version=reorder_points.version+1",
        [
          org,
          c.warehouseId,
          c.itemId,
          c.minimum,
          c.safety,
          c.leadDays,
          s.actorId,
        ],
      );
      await audit(tx, org, s.actorId, "reorder_point.saved", w.branch_id, {
        warehouseId: c.warehouseId,
        itemId: c.itemId,
      });
      return { ok: true };
    });
  }
  async reorderPoints(secret: Credential, org: string, input: unknown) {
    const q = insightQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        "inventory:read",
        q.branchId,
      );
      return {
        items: await tx.query(
          "SELECT r.warehouse_id,w.name warehouse_name,r.item_id,i.sku,i.name_ru,i.name_kk,i.base_unit,r.minimum::text,r.safety::text,r.lead_days,r.version FROM reorder_points r JOIN warehouses w ON w.organization_id=r.organization_id AND w.id=r.warehouse_id JOIN catalog_items i ON i.organization_id=r.organization_id AND i.id=r.item_id WHERE r.organization_id=$1 AND ($2::uuid IS NULL OR w.branch_id=$2) ORDER BY w.name,i.sku LIMIT 500",
          [org, s.branchId],
        ),
      };
    });
  }
  private async candidates(tx: Sql, org: string): Promise<Candidate[]> {
    const clock = await organizationClock(tx, org);
    const asOf = new Date().toISOString();
    const out: Candidate[] = [];
    // Low stock: available = on hand - reserved; approved/sent/partial purchases count as incoming.
    const stock = await tx.query<{
      warehouse_id: string;
      branch_id: string;
      warehouse_name: string;
      item_id: string;
      sku: string;
      name_ru: string;
      base_unit: string;
      quantity: string;
      reserved: string;
      incoming: string;
      orders: string[];
      minimum: string;
      safety: string;
      lead_days: number;
      elsewhere: string;
      external: boolean;
      external_as_of: string | null;
      stale: boolean;
    }>(
      `WITH incoming AS (SELECT o.warehouse_id,l.item_id,sum(l.quantity-l.received) qty,jsonb_agg(DISTINCT o.id) orders FROM purchase_lines l JOIN purchase_orders o ON o.organization_id=l.organization_id AND o.id=l.order_id WHERE l.organization_id=$1 AND o.state IN ('approved','sent','partial') GROUP BY o.warehouse_id,l.item_id)
       SELECT r.warehouse_id,w.branch_id,w.name warehouse_name,r.item_id,i.sku,i.name_ru,i.base_unit,(CASE WHEN l.warehouse_id IS NOT NULL THEN coalesce(es.quantity,0) ELSE coalesce(b.quantity,0) END)::text quantity,(CASE WHEN l.warehouse_id IS NOT NULL THEN 0 ELSE coalesce(b.reserved,0) END)::text reserved,(l.warehouse_id IS NOT NULL) external,es.as_of::text external_as_of,(l.warehouse_id IS NOT NULL AND (es.as_of IS NULL OR es.as_of<now()-interval '60 minutes')) stale,coalesce(n.qty,0)::text incoming,coalesce(n.orders,'[]'::jsonb) orders,r.minimum::text,r.safety::text,r.lead_days,
       (SELECT coalesce(sum(x.quantity-x.reserved),0)::text FROM stock_balances x WHERE x.organization_id=r.organization_id AND x.item_id=r.item_id AND x.warehouse_id<>r.warehouse_id) elsewhere
       FROM reorder_points r JOIN warehouses w ON w.organization_id=r.organization_id AND w.id=r.warehouse_id JOIN catalog_items i ON i.organization_id=r.organization_id AND i.id=r.item_id
       LEFT JOIN stock_balances b ON b.organization_id=r.organization_id AND b.warehouse_id=r.warehouse_id AND b.item_id=r.item_id
       LEFT JOIN integration_warehouse_links l ON l.organization_id=r.organization_id AND l.warehouse_id=r.warehouse_id
       LEFT JOIN external_stock es ON es.connection_id=l.connection_id AND es.warehouse_id=r.warehouse_id AND es.item_id=r.item_id
       LEFT JOIN incoming n ON n.warehouse_id=r.warehouse_id AND n.item_id=r.item_id
       WHERE r.organization_id=$1 AND i.active ORDER BY r.warehouse_id,r.item_id`,
      [org],
    );
    for (const r of stock) {
      const available = new D(r.quantity).minus(r.reserved),
        target = new D(r.minimum).plus(r.safety),
        covered = available.plus(r.incoming);
      if (covered.gte(target) || target.eq(0)) continue;
      const shortage = target.minus(covered);
      const offers = await tx.query<{
        id: string;
        data: OfferData;
        supplier: string;
      }>(
        "SELECT f.id,f.data,s.name supplier FROM supplier_offers f JOIN suppliers s ON s.organization_id=f.organization_id AND s.id=f.supplier_id WHERE f.organization_id=$1 AND f.item_id=$2 ORDER BY f.created_at DESC LIMIT 50",
        [org, r.item_id],
      );
      const priced = offers
        .map((o) => ({
          ...o,
          price: priceOffer(o.data, shortage.toFixed(), clock.today),
        }))
        .filter((o) => o.price.comparable)
        .sort((a, b) =>
          BigInt(a.price.total_minor!) < BigInt(b.price.total_minor!) ? -1 : 1,
        );
      const best = priced[0];
      out.push({
        rule: "low_stock",
        branch: r.branch_id,
        entityType: "stock",
        entityId: r.item_id,
        severity: available.lte(0) ? 4 : available.lt(r.minimum) ? 3 : 2,
        evidence: {
          title: `${r.sku} · ${r.name_ru} · ${r.warehouse_name}`,
          facts: {
            warehouse_id: r.warehouse_id,
            item_id: r.item_id,
            unit: r.base_unit,
            on_hand: new D(r.quantity).toFixed(),
            reserved: new D(r.reserved).toFixed(),
            available: available.toFixed(),
            incoming: new D(r.incoming).toFixed(),
            minimum: new D(r.minimum).toFixed(),
            safety: new D(r.safety).toFixed(),
            lead_days: r.lead_days,
            shortage: shortage.toFixed(),
            other_warehouses_available: new D(r.elsewhere).toFixed(),
            stock_source: r.external ? "moysklad" : "ledger",
            stock_as_of: r.external_as_of,
            stock_stale: r.stale ? "yes" : "no",
            suggested_offer_id: best?.id || null,
            suggested_supplier: best?.supplier || null,
            suggested_quantity: best?.price.quantity || null,
            suggested_total_minor: best?.price.total_minor || null,
          },
          calculation: "available + incoming < minimum + safety",
          sources: [
            r.external
              ? {
                  type: "external_stock",
                  id: r.item_id,
                  label: `МойСклад · ${r.warehouse_name} · ${r.external_as_of || "no data"}${r.stale ? " · stale" : ""}`,
                }
              : {
                  type: "stock_balance",
                  id: r.item_id,
                  label: r.warehouse_name,
                },
            ...r.orders.map((id) => ({
              type: "purchase_order",
              id,
              label: "incoming",
            })),
            ...(best
              ? [{ type: "supplier_offer", id: best.id, label: best.supplier }]
              : []),
          ],
          as_of: asOf,
          suggestion: best
            ? "purchase_order"
            : new D(r.elsewhere).gt(0)
              ? "transfer_or_purchase"
              : "add_comparable_offer",
        },
      });
    }
    const receivable = await tx.query<{
      id: string;
      branch_id: string;
      number: number;
      customer: string;
      revenue_minor: string;
      paid_minor: string;
      due_date: string;
      days: number;
    }>(
      "SELECT o.id,o.branch_id,o.number,c.name customer,o.revenue_minor::text,o.paid_minor::text,o.due_date::text,($2::date-o.due_date) days FROM sales_orders o JOIN customers c ON c.organization_id=o.organization_id AND c.id=o.customer_id WHERE o.organization_id=$1 AND o.state<>'draft' AND o.revenue_minor>o.paid_minor AND o.due_date<$2::date ORDER BY o.due_date LIMIT 200",
      [org, clock.today],
    );
    for (const r of receivable) {
      const outstanding = (
        BigInt(r.revenue_minor) - BigInt(r.paid_minor)
      ).toString();
      out.push({
        rule: "overdue_receivable",
        branch: r.branch_id,
        entityType: "sales_order",
        entityId: r.id,
        severity: r.days > 30 ? 4 : r.days > 7 ? 3 : 2,
        evidence: {
          title: `№${r.number} · ${r.customer}`,
          facts: {
            revenue_minor: r.revenue_minor,
            paid_minor: r.paid_minor,
            outstanding_minor: outstanding,
            outstanding_kzt: money(outstanding),
            due_date: r.due_date,
            days_overdue: r.days,
          },
          calculation: "fulfilled revenue - payments, due date before today",
          sources: [{ type: "sales_order", id: r.id, label: `№${r.number}` }],
          as_of: asOf,
          suggestion: "task",
        },
      });
    }
    const payable = await tx.query<{
      id: string;
      branch_id: string;
      supplier: string;
      amount_minor: string;
      paid_minor: string;
      due_date: string;
      days: number;
      purchase_order_id: string | null;
    }>(
      "SELECT id,branch_id,supplier,amount_minor::text,paid_minor::text,due_date::text,($2::date-due_date) days,purchase_order_id FROM supplier_obligations WHERE organization_id=$1 AND paid_minor<amount_minor AND due_date<$2::date ORDER BY due_date LIMIT 200",
      [org, clock.today],
    );
    for (const r of payable) {
      const outstanding = (
        BigInt(r.amount_minor) - BigInt(r.paid_minor)
      ).toString();
      out.push({
        rule: "overdue_payable",
        branch: r.branch_id,
        entityType: "obligation",
        entityId: r.id,
        severity: r.days > 14 ? 4 : 3,
        evidence: {
          title: r.supplier,
          facts: {
            amount_minor: r.amount_minor,
            paid_minor: r.paid_minor,
            outstanding_minor: outstanding,
            outstanding_kzt: money(outstanding),
            due_date: r.due_date,
            days_overdue: r.days,
          },
          calculation: "obligation amount - payments, due date before today",
          sources: [
            { type: "obligation", id: r.id, label: r.supplier },
            ...(r.purchase_order_id
              ? [
                  {
                    type: "purchase_order",
                    id: r.purchase_order_id,
                    label: "purchase",
                  },
                ]
              : []),
          ],
          as_of: asOf,
          suggestion: "task",
        },
      });
    }
    for (const r of await tx.query<{
      id: string;
      branch_id: string;
      number: number;
      supplier: string;
      total_minor: string;
      days: number;
    }>(
      "SELECT o.id,o.branch_id,o.number,s.name supplier,o.total_minor::text,greatest(0,($2::date-(o.created_at AT TIME ZONE $3)::date))::int days FROM purchase_orders o JOIN suppliers s ON s.organization_id=o.organization_id AND s.id=o.supplier_id WHERE o.organization_id=$1 AND o.state='pending' LIMIT 200",
      [org, clock.today, clock.timezone],
    ))
      out.push({
        rule: "purchase_pending",
        branch: r.branch_id,
        entityType: "purchase_order",
        entityId: r.id,
        severity: r.days > 2 ? 3 : 2,
        evidence: {
          title: `№${r.number} · ${r.supplier}`,
          facts: {
            total_minor: r.total_minor,
            total_kzt: money(r.total_minor),
            days_waiting: r.days,
          },
          calculation: "purchase order in pending state",
          sources: [
            { type: "purchase_order", id: r.id, label: `№${r.number}` },
          ],
          as_of: asOf,
          suggestion: "approve_or_reject",
        },
      });
    for (const r of await tx.query<{
      id: string;
      branch_id: string;
      filename: string;
      order_id: string;
      days: number;
    }>(
      "SELECT d.id,o.branch_id,d.filename,d.order_id,greatest(0,($2::date-(d.created_at AT TIME ZONE $3)::date))::int days FROM purchase_documents d JOIN purchase_orders o ON o.organization_id=d.organization_id AND o.id=d.order_id WHERE d.organization_id=$1 AND d.state='review' LIMIT 200",
      [org, clock.today, clock.timezone],
    ))
      out.push({
        rule: "document_review",
        branch: r.branch_id,
        entityType: "purchase_document",
        entityId: r.id,
        severity: r.days > 1 ? 3 : 1,
        evidence: {
          title: r.filename,
          facts: { days_waiting: r.days, order_id: r.order_id },
          calculation: "uploaded supplier document not yet reviewed",
          sources: [
            { type: "purchase_document", id: r.id, label: r.filename },
            { type: "purchase_order", id: r.order_id, label: "purchase" },
          ],
          as_of: asOf,
          suggestion: "review_document",
        },
      });
    for (const r of await tx.query<{
      id: string;
      branch_id: string;
      number: number;
      title: string;
      assignee: string | null;
      due_at: string;
      hours: number;
    }>(
      "SELECT t.id,t.branch_id,t.number,t.title,u.name assignee,t.due_at::text,floor(extract(epoch FROM now()-t.due_at)/3600)::int hours FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.organization_id=$1 AND t.due_at<now() AND t.state NOT IN ('done','verified','cancelled') LIMIT 200",
      [org],
    ))
      out.push({
        rule: "overdue_task",
        branch: r.branch_id,
        entityType: "task",
        entityId: r.id,
        severity: r.hours > 24 ? 3 : 2,
        evidence: {
          title: `№${r.number} · ${r.title}`,
          facts: {
            assignee: r.assignee,
            due_at: r.due_at,
            hours_overdue: r.hours,
          },
          calculation: "task due time passed and task not completed",
          sources: [{ type: "task", id: r.id, label: `№${r.number}` }],
          as_of: asOf,
          suggestion: "reassign_or_escalate",
        },
      });
    return out;
  }
  // Detection is deterministic over committed operations; repeated runs only refresh evidence.
  async detect(org: string) {
    return this.db.transaction(async (tx) => {
      // One detector per organization at a time.
      await tx.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
        org,
      ]);
      const run = randomUUID();
      await tx.query(
        "INSERT INTO insight_runs(id,organization_id) VALUES($1,$2)",
        [run, org],
      );
      const found = await this.candidates(tx, org);
      const active = await tx.query<{
        id: string;
        fingerprint: string;
        rule: string;
        branch_id: string | null;
        evidence: Evidence;
      }>(
        "SELECT id,fingerprint,rule,branch_id,evidence FROM insights WHERE organization_id=$1 AND state IN ('open','acknowledged') FOR UPDATE",
        [org],
      );
      const suppressed = new Set(
        (
          await tx.query<{ fingerprint: string }>(
            "SELECT fingerprint FROM insights WHERE organization_id=$1 AND state='dismissed' AND resolved_at IS NULL",
            [org],
          )
        ).map((r) => r.fingerprint),
      );
      const seen = new Set<string>();
      let opened = 0,
        resolved = 0;
      for (const c of found) {
        const fingerprint = `${c.rule}:${c.entityType}:${c.entityId}:${c.evidence.facts.warehouse_id || ""}`;
        seen.add(fingerprint);
        if (suppressed.has(fingerprint)) continue;
        const existing = active.find((a) => a.fingerprint === fingerprint);
        if (existing) {
          await tx.query(
            "UPDATE insights SET evidence=$2,severity=$3,last_seen_at=now() WHERE id=$1",
            [existing.id, JSON.stringify(c.evidence), c.severity],
          );
          continue;
        }
        const id = randomUUID();
        await tx.query(
          "INSERT INTO insights(id,organization_id,branch_id,rule,entity_type,entity_id,fingerprint,severity,state,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'open',$9)",
          [
            id,
            org,
            c.branch,
            c.rule,
            c.entityType,
            c.entityId,
            fingerprint,
            c.severity,
            JSON.stringify(c.evidence),
          ],
        );
        await emit(tx, {
          org,
          branch: c.branch,
          topic: "insight.opened",
          entityType: "insight",
          entityId: id,
          payload: {
            rule: c.rule,
            severity: c.severity,
            entityType: c.entityType,
            entityId: c.entityId,
          },
          actorId: null,
          dedupeKey: `insight.opened:${id}`,
        });
        opened++;
      }
      for (const a of active)
        if (!seen.has(a.fingerprint)) {
          await tx.query(
            "UPDATE insights SET state='resolved',resolved_at=now(),resolution=$2,version=version+1 WHERE id=$1",
            [
              a.id,
              JSON.stringify({
                reason: "condition_cleared",
                detected_by: "rule",
              }),
            ],
          );
          await emit(tx, {
            org,
            branch: a.branch_id,
            topic: "insight.resolved",
            entityType: "insight",
            entityId: a.id,
            payload: { rule: a.rule },
            actorId: null,
            dedupeKey: `insight.resolved:${a.id}`,
          });
          resolved++;
        }
      // A dismissed situation may reopen only after its condition actually cleared once.
      await tx.query(
        "UPDATE insights SET resolved_at=now() WHERE organization_id=$1 AND state='dismissed' AND resolved_at IS NULL AND NOT (fingerprint = ANY($2::text[]))",
        [org, [...seen]],
      );
      await this.checkOutcomes(tx, org);
      await tx.query(
        "UPDATE insight_runs SET finished_at=now(),opened=$2,resolved=$3,seen=$4 WHERE id=$1",
        [run, opened, resolved, found.length],
      );
      return { opened, resolved, seen: found.length };
    });
  }
  // Effect check: an executed proposal is "effect_verified" only when its situation cleared
  // and, for stock, the goods are physically on hand, not merely ordered.
  private async checkOutcomes(tx: Sql, org: string) {
    const proposals = await tx.query<{
      id: string;
      insight_id: string;
      kind: string;
      state: string;
      rule: string;
      insight_state: string;
      evidence: Evidence;
      result_id: string;
    }>(
      "SELECT p.id,p.insight_id,p.kind,p.state,i.rule,i.state insight_state,i.evidence,p.result_id FROM action_proposals p JOIN insights i ON i.organization_id=p.organization_id AND i.id=p.insight_id WHERE p.organization_id=$1 AND p.state='executed' AND coalesce(p.outcome->>'status','')<>'effect_verified'",
      [org],
    );
    for (const p of proposals) {
      let status = "pending_effect";
      const details: Record<string, unknown> = {
        insight_state: p.insight_state,
      };
      if (p.rule === "low_stock") {
        const f = p.evidence.facts;
        const [b] = await tx.query<{ available: string }>(
          "SELECT (quantity-reserved)::text available FROM stock_balances WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3",
          [org, f.warehouse_id, f.item_id],
        );
        details.available_now = b?.available ?? "0";
        details.minimum = f.minimum;
        if (b && new D(b.available).gte(String(f.minimum)))
          status = "effect_verified";
      } else if (["resolved"].includes(p.insight_state))
        status = "effect_verified";
      await tx.query(
        "UPDATE action_proposals SET outcome=$2,updated_at=now() WHERE id=$1",
        [
          p.id,
          JSON.stringify({
            status,
            checked_at: new Date().toISOString(),
            ...details,
          }),
        ],
      );
    }
  }
  async refresh(secret: Credential, org: string) {
    await this.db.transaction((tx) =>
      sessionAccess(tx, secret, org, "insights:read"),
    );
    return this.detect(org);
  }
  async list(secret: Credential, org: string, input: unknown) {
    const q = insightQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        "insights:read",
        q.branchId,
      );
      const rules = visibleRules(s.role).filter((r) => !q.rule || r === q.rule);
      const where =
        "i.organization_id=$1 AND ($2::uuid IS NULL OR i.branch_id IS NULL OR i.branch_id=$2) AND i.rule=ANY($3::text[]) AND (CASE $4::text WHEN 'active' THEN i.state IN ('open','acknowledged') ELSE i.state=$4 END)";
      const params = [org, s.branchId, rules, q.state];
      const [c] = await tx.query<{ total: number }>(
        `SELECT count(*)::int total FROM insights i WHERE ${where}`,
        params,
      );
      const [run] = await tx.query<{ finished_at: string }>(
        "SELECT finished_at FROM insight_runs WHERE organization_id=$1 AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1",
        [org],
      );
      return {
        items: await tx.query(
          `SELECT ${columns} FROM insights i WHERE ${where} ORDER BY i.severity DESC,i.detected_at DESC,i.id LIMIT $5 OFFSET $6`,
          [...params, q.limit, (q.page - 1) * q.limit],
        ),
        pagination: pagination(q.page, q.limit, c.total),
        last_run: run?.finished_at || null,
      };
    });
  }
  async get(secret: Credential, org: string, id: string) {
    idSchema.parse(id);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "insights:read");
      return this.load(tx, org, id, s);
    });
  }
  async load(
    tx: Sql,
    org: string,
    id: string,
    s: { branchId: string | null; role: Role },
    lock = false,
  ) {
    const [row] = await tx.query<InsightRow>(
      `SELECT ${columns} FROM insights i WHERE i.organization_id=$1 AND i.id=$2 AND ($3::uuid IS NULL OR i.branch_id IS NULL OR i.branch_id=$3) AND i.rule=ANY($4::text[]) ${lock ? "FOR UPDATE" : ""}`,
      [org, id, s.branchId, visibleRules(s.role)],
    );
    if (!row) throw new AppError("NOT_FOUND", 404);
    return row;
  }
  async command(secret: Credential, org: string, id: string, input: unknown) {
    const c = insightCommand.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "insights:read");
      const i = await this.load(tx, org, id, s, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "insight.command",
        id,
        ...c,
      });
      if (r.reused) return r;
      if (i.version !== c.version) throw new AppError("VERSION_CONFLICT", 409);
      if (!["open", "acknowledged"].includes(i.state))
        throw new AppError("INSIGHT_STATE", 409);
      await tx.query(
        "UPDATE insights SET state=$3,version=version+1,resolution=$4 WHERE organization_id=$1 AND id=$2",
        [
          org,
          id,
          c.kind === "acknowledge" ? "acknowledged" : "dismissed",
          c.kind === "dismiss"
            ? JSON.stringify({
                reason: "dismissed",
                note: c.note,
                by: s.actorId,
              })
            : null,
        ],
      );
      await audit(tx, org, s.actorId, `insight.${c.kind}`, i.branch_id, {
        insightId: id,
      });
      return r;
    });
  }
  // All organizations: used by the worker schedule.
  async detectAll() {
    const orgs = await this.db.query<{ id: string }>(
      "SELECT id FROM organizations ORDER BY id LIMIT 1000",
    );
    let opened = 0;
    for (const o of orgs) opened += (await this.detect(o.id)).opened;
    return opened;
  }
}
