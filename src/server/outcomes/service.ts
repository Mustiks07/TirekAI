import type { Database, Sql } from "../db/database";
import { sessionAccess, audit, type Credential } from "../access";
import {
  outcomeInput,
  outcomeQuery,
  outcomeView,
  type OutcomeView,
} from "../../domain/outcomes";
import { minorUnits } from "../../domain/decimal";
import { D, priceOffer, type OfferData } from "../../domain/purchasing";
import { AppError } from "../../domain/errors";
import { idempotent } from "../execution/core";
import { purchaseQuantities } from "../purchasing/quantities";
type PurchaseLine = { item_id: string; quantity: string; snapshot: OfferData };
const bounded = <T>(rows: T[]) => {
  if (rows.length > 5000) throw new AppError("RESULT_RANGE_TOO_LARGE", 422);
  return rows;
};
export class OutcomeService {
  constructor(private db: Database) {}
  private async source(
    tx: Sql,
    org: string,
    type: "order" | "purchase",
    id: string,
  ) {
    const table = type === "order" ? "sales_orders" : "purchase_orders";
    const [row] = await tx.query<{ branch_id: string; state: string }>(
      `SELECT branch_id,state FROM ${table} WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
      [org, id],
    );
    if (!row) throw new AppError("NOT_FOUND", 404);
    return row;
  }
  async create(secret: Credential, org: string, input: unknown) {
    const c = outcomeInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        "outcomes:write",
        c.branchId,
      );
      const src = await this.source(tx, org, c.sourceType, c.sourceId);
      if (src.branch_id !== c.branchId) throw new AppError("FORBIDDEN", 403);
      const r = await idempotent(tx, org, c.key, {
        operation: "outcome.create",
        ...c,
      });
      if (r.reused) return r;
      if (
        (
          await tx.query(
            "SELECT id FROM outcome_measurements WHERE organization_id=$1 AND source_type=$2 AND source_id=$3",
            [org, c.sourceType, c.sourceId],
          )
        ).length
      )
        throw new AppError("OUTCOME_ALREADY_TRACKED", 409);
      // Forecasts and alternatives must be frozen before any fulfillment/receipt, not reconstructed after the fact.
      if (
        c.sourceType === "order" &&
        !["draft", "confirmed"].includes(src.state)
      )
        throw new AppError("BASELINE_TOO_LATE", 409);
      if (
        c.sourceType === "purchase" &&
        (["partial", "completed", "cancelled"].includes(src.state) ||
          (
            await tx.query(
              "SELECT id FROM purchase_documents WHERE organization_id=$1 AND order_id=$2 AND state='approved'",
              [org, c.sourceId],
            )
          ).length)
      )
        throw new AppError("BASELINE_TOO_LATE", 409);
      let baselineMinor: string | null = null;
      let baseline: unknown = {};
      if (c.sourceType === "purchase") {
        const lines = await tx.query<PurchaseLine>(
          "SELECT item_id,quantity::text,snapshot FROM purchase_lines WHERE organization_id=$1 AND order_id=$2 ORDER BY item_id",
          [org, c.sourceId],
        );
        if (
          new Set(c.alternativeOfferIds).size !== lines.length ||
          c.alternativeOfferIds.length !== lines.length
        )
          throw new AppError("OFFER_INCOMPARABLE", 422);
        const offers = await tx.query<{
          id: string;
          data: OfferData;
          terms: string;
        }>(
          "SELECT f.id,f.data,s.data->>'paymentTerms' terms FROM supplier_offers f JOIN suppliers s ON s.organization_id=f.organization_id AND s.id=f.supplier_id WHERE f.organization_id=$1 AND f.id=ANY($2::uuid[])",
          [org, c.alternativeOfferIds],
        );
        if (new Set(offers.map((o) => o.data.supplierId)).size !== 1)
          throw new AppError("OFFER_INCOMPARABLE", 422);
        const [supplier] = await tx.query<{ terms: string }>(
          "SELECT s.data->>'paymentTerms' terms FROM purchase_orders o JOIN suppliers s ON s.organization_id=o.organization_id AND s.id=o.supplier_id WHERE o.organization_id=$1 AND o.id=$2",
          [org, c.sourceId],
        );
        const [{ today }] = await tx.query<{ today: string }>(
          "SELECT (now() AT TIME ZONE timezone)::date::text today FROM organizations WHERE id=$1",
          [org],
        );
        let goods = 0n,
          delivery: bigint | null = null;
        const snapshots = [];
        for (const l of lines) {
          const a = offers.find((o) => o.data.itemId === l.item_id);
          if (
            !a ||
            !supplier.terms ||
            a.terms !== supplier.terms ||
            a.data.leadDays === null ||
            a.data.leadDays !== l.snapshot.leadDays ||
            a.data.baseUnit !== l.snapshot.baseUnit
          )
            throw new AppError("OFFER_INCOMPARABLE", 422);
          const priced = priceOffer(a.data, l.quantity, today);
          if (
            !priced.comparable ||
            !new D(priced.quantity).eq(l.quantity) ||
            (delivery !== null && delivery !== BigInt(priced.delivery_minor!))
          )
            throw new AppError("OFFER_INCOMPARABLE", 422);
          goods += BigInt(priced.goods_minor!);
          delivery = BigInt(priced.delivery_minor!);
          snapshots.push({
            itemId: l.item_id,
            quantity: l.quantity,
            offerId: a.id,
            offer: a.data,
            terms: a.terms,
          });
        }
        baselineMinor = (goods + (delivery ?? 0n)).toString();
        baseline = { lines: snapshots };
      } else if (c.alternativeOfferIds.length)
        throw new AppError("INVALID_INPUT", 422);
      await tx.query(
        "INSERT INTO outcome_measurements(id,organization_id,branch_id,source_type,source_id,forecast_minor,baseline_minor,baseline,limitations,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          r.id,
          org,
          c.branchId,
          c.sourceType,
          c.sourceId,
          c.forecast === null ? null : minorUnits(c.forecast).toString(),
          baselineMinor,
          JSON.stringify(baseline),
          c.limitations,
          s.actorId,
        ],
      );
      await audit(tx, org, s.actorId, "outcome.baseline_saved", c.branchId, {
        measurementId: r.id,
        sourceType: c.sourceType,
        sourceId: c.sourceId,
      });
      return r;
    });
  }
  async view(secret: Credential, org: string, input: unknown) {
    const q = outcomeQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        "outcomes:read",
        q.branchId,
      );
      // All totals are a cohort of orders created in the selected local dates, evaluated now.
      const rows = bounded(
        await tx.query<{
          id: string;
          number: number;
          branch_id: string;
          state: string;
          revenue: string;
          paid: string;
          known_cost: string;
          cost: string | null;
        }>(
          `SELECT o.id,o.number,o.branch_id,o.state,o.revenue_minor::text revenue,o.paid_minor::text paid,coalesce((SELECT sum(e.cost_minor) FROM sales_events e WHERE e.organization_id=o.organization_id AND e.order_id=o.id),0)::text known_cost,
        CASE WHEN EXISTS(SELECT 1 FROM sales_events e WHERE e.organization_id=o.organization_id AND e.order_id=o.id AND e.kind='fulfill' AND e.cost_minor IS NULL) THEN NULL ELSE coalesce((SELECT sum(e.cost_minor) FROM sales_events e WHERE e.organization_id=o.organization_id AND e.order_id=o.id),0)::text END cost
        FROM sales_orders o JOIN organizations g ON g.id=o.organization_id WHERE o.organization_id=$1 AND ($2::uuid IS NULL OR o.branch_id=$2) AND (o.created_at AT TIME ZONE g.timezone)::date BETWEEN $3::date AND $4::date ORDER BY o.created_at DESC,o.id LIMIT 5001`,
          [org, s.branchId, q.from, q.to],
        ),
      );
      const facts: OutcomeView["facts"] = [];
      const orderIds = rows.map((r) => r.id);
      const linked = await tx.query<{
        id: string;
        state: string;
        order_id: string;
        type: "industry" | "proposal" | "channel";
      }>(
        `SELECT d.id,d.state,o.id order_id,'industry' type FROM industry_documents d JOIN sales_orders o ON o.organization_id=d.organization_id AND o.branch_id=d.branch_id AND (d.data->>'orderId'=o.id::text OR d.data->'orderIds' ? o.id::text) WHERE d.organization_id=$1 AND d.kind<>'clinic' AND o.id=ANY($2::uuid[])
        UNION ALL SELECT id,state,result_id,'proposal' FROM action_proposals WHERE organization_id=$1 AND result_id=ANY($2::uuid[])
        UNION ALL SELECT id,state,sales_order_id,'channel' FROM channel_orders WHERE organization_id=$1 AND sales_order_id=ANY($2::uuid[])`,
        [org, orderIds],
      );
      const events = await tx.query<{ id: string; order_id: string }>(
        "SELECT id,order_id FROM sales_events WHERE organization_id=$1 AND order_id=ANY($2::uuid[]) ORDER BY created_at,id",
        [org, orderIds],
      );
      const sourceMap = new Map<
          string,
          OutcomeView["facts"][number]["sources"]
        >(),
        eventMap = new Map<string, string[]>();
      for (const link of linked)
        sourceMap.set(link.order_id, [
          ...(sourceMap.get(link.order_id) ?? []),
          { id: link.id, state: link.state, type: link.type },
        ]);
      for (const event of events)
        eventMap.set(event.order_id, [
          ...(eventMap.get(event.order_id) ?? []),
          event.id,
        ]);
      for (const r of rows) {
        facts.push({
          id: r.id,
          number: r.number,
          branchId: r.branch_id,
          state: r.state,
          revenueMinor: r.revenue,
          paidMinor: r.paid,
          costMinor: r.cost,
          sources: sourceMap.get(r.id) ?? [],
          eventIds: eventMap.get(r.id) ?? [],
        });
      }
      const proposals = bounded(
        await tx.query<{
          id: string;
          state: string;
          resultType: string | null;
          resultId: string | null;
          amountMinor: string | null;
        }>(
          `SELECT p.id,p.state,p.result_type "resultType",p.result_id "resultId",p.amount_minor::text "amountMinor" FROM action_proposals p JOIN organizations g ON g.id=p.organization_id WHERE p.organization_id=$1 AND ($2::uuid IS NULL OR p.branch_id=$2) AND (p.created_at AT TIME ZONE g.timezone)::date BETWEEN $3::date AND $4::date ORDER BY p.created_at DESC LIMIT 5001`,
          [org, s.branchId, q.from, q.to],
        ),
      );
      const ms = bounded(
        await tx.query<{
          id: string;
          source_type: "order" | "purchase";
          source_id: string;
          forecast_minor: string | null;
          baseline_minor: string | null;
          baseline: { lines?: { itemId: string; quantity: string }[] };
          limitations: string;
          created_at: string;
        }>(
          "SELECT m.*,forecast_minor::text,baseline_minor::text,created_at::text FROM outcome_measurements m WHERE organization_id=$1 AND ($2::uuid IS NULL OR branch_id=$2) ORDER BY m.created_at DESC LIMIT 5001",
          [org, s.branchId],
        ),
      );
      const measurements: OutcomeView["measurements"] = [];
      const actions = bounded(
        await tx.query<{
          id: string;
          module: "industry" | "marketing" | "channel";
          kind: string;
          state: string;
        }>(
          `SELECT a.id,a.module,a.kind,a.state FROM (
          SELECT d.id,'industry' module,d.kind,d.state,d.created_at,d.branch_id FROM industry_documents d WHERE d.organization_id=$1 AND d.kind IN ('production','appointment','project','construction','enrollment')
          UNION ALL SELECT p.id,'marketing',p.channel,p.state,p.created_at,c.branch_id FROM marketing_publications p JOIN marketing_campaigns c ON c.organization_id=p.organization_id AND c.id=p.campaign_id WHERE p.organization_id=$1
          UNION ALL SELECT c.id,'channel','kaspi',c.state,c.created_external,coalesce(o.branch_id,(i.settings->>'branchId')::uuid) FROM channel_orders c JOIN integration_connections i ON i.organization_id=c.organization_id AND i.id=c.connection_id LEFT JOIN sales_orders o ON o.organization_id=c.organization_id AND o.id=c.sales_order_id WHERE c.organization_id=$1
        ) a JOIN organizations g ON g.id=$1 WHERE ($2::uuid IS NULL OR a.branch_id=$2) AND (a.created_at AT TIME ZONE g.timezone)::date BETWEEN $3::date AND $4::date ORDER BY a.created_at DESC LIMIT 5001`,
          [org, s.branchId, q.from, q.to],
        ),
      );
      for (const m of ms) {
        let actual: string | null = null,
          status: "pending" | "measured" | "incomparable" = "pending",
          evidenceIds: string[] = [];
        if (m.source_type === "order") {
          const [order] = await tx.query<{ revenue: string; state: string }>(
            "SELECT revenue_minor::text revenue,state FROM sales_orders WHERE organization_id=$1 AND id=$2",
            [org, m.source_id],
          );
          if (order.state === "fulfilled") {
            actual = order.revenue;
            status = "measured";
          }
          if (order.state === "cancelled") status = "incomparable";
          evidenceIds = (
            await tx.query<{ id: string }>(
              "SELECT id FROM sales_events WHERE organization_id=$1 AND order_id=$2",
              [org, m.source_id],
            )
          ).map((e) => e.id);
        } else {
          const [purchase] = await tx.query<{ state: string }>(
            "SELECT state FROM purchase_orders WHERE organization_id=$1 AND id=$2",
            [org, m.source_id],
          );
          if (purchase.state === "cancelled") status = "incomparable";
          if (purchase.state === "completed") {
            const received = await purchaseQuantities(tx, org, [m.source_id]);
            if (
              received.length !== m.baseline.lines?.length ||
              m.baseline.lines.some(
                (l) =>
                  !new D(
                    received.find((r) => r.item_id === l.itemId)?.quantity ??
                      "0",
                  ).eq(l.quantity),
              )
            )
              status = "incomparable";
            else {
              const amounts = await tx.query<{ id: string; amount: string }>(
                "SELECT id,amount_minor::text amount FROM supplier_obligations WHERE organization_id=$1 AND purchase_order_id=$2",
                [org, m.source_id],
              );
              if (amounts.length) {
                actual = amounts
                  .reduce((n, a) => n + BigInt(a.amount), 0n)
                  .toString();
                status = "measured";
                evidenceIds = amounts.map((a) => a.id);
              }
            }
          }
        }
        measurements.push({
          id: m.id,
          sourceType: m.source_type,
          sourceId: m.source_id,
          forecastMinor: m.forecast_minor,
          baselineMinor: m.baseline_minor,
          actualMinor: actual,
          differenceMinor:
            actual === null
              ? null
              : m.source_type === "purchase"
                ? (BigInt(m.baseline_minor!) - BigInt(actual)).toString()
                : m.forecast_minor === null
                  ? null
                  : (BigInt(actual) - BigInt(m.forecast_minor)).toString(),
          status,
          limitations: m.limitations,
          createdAt: m.created_at,
          evidenceIds,
        });
      }
      return outcomeView.parse({
        from: q.from,
        to: q.to,
        asOf: new Date().toISOString(),
        revenueMinor: facts
          .reduce((n, f) => n + BigInt(f.revenueMinor), 0n)
          .toString(),
        paidMinor: facts
          .reduce((n, f) => n + BigInt(f.paidMinor), 0n)
          .toString(),
        knownCostMinor: rows
          .reduce((n, f) => n + BigInt(f.known_cost), 0n)
          .toString(),
        unknownCostOrders: facts.filter((f) => f.costMinor === null).length,
        facts,
        proposals,
        actions,
        measurements,
      });
    });
  }
}
