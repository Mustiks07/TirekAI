import { z } from "zod";
import type { Sql } from "../db/database";
import { D } from "../../domain/purchasing";

// T058 pilot measurement (DEVELOPMENT_PLAN §12): the baseline is measured before the change and
// the same metrics after it, from the organization's own operations, in its time zone. Unknown
// cost stays unknown (null) with the number of affected events. The comparison reports
// differences with explicit limits; it never attributes a change to the pilot by itself.
export const pilotPeriod = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    branchId: z.uuid().nullable().default(null),
  })
  .strict()
  .refine((p) => p.to >= p.from, { path: ["to"] });
export type PilotMetrics = Awaited<ReturnType<typeof pilotMetrics>>;
export async function pilotMetrics(
  tx: Sql,
  org: string,
  input: z.input<typeof pilotPeriod>,
) {
  const p = pilotPeriod.parse(input);
  const args = [org, p.from, p.to, p.branchId];
  const inPeriod = (column: string) =>
    `(${column} AT TIME ZONE g.timezone)::date BETWEEN $2::date AND $3::date`;
  const [sales] = await tx.query<{
    orders: number;
    revenue: string;
    cost: string;
    unknown: number;
    returns: number;
  }>(
    `SELECT count(DISTINCT e.order_id) FILTER(WHERE e.kind='fulfill')::int orders,
      coalesce(sum(e.revenue_minor),0)::text revenue, coalesce(sum(e.cost_minor),0)::text cost,
      count(*) FILTER(WHERE e.cost_minor IS NULL)::int unknown,
      count(*) FILTER(WHERE e.kind='return')::int returns
     FROM sales_events e JOIN sales_orders o ON o.organization_id=e.organization_id AND o.id=e.order_id
     JOIN organizations g ON g.id=e.organization_id
     WHERE e.organization_id=$1 AND e.kind IN ('fulfill','return') AND ($4::uuid IS NULL OR o.branch_id=$4) AND ${inPeriod("e.created_at")}`,
    args,
  );
  const [cash] = await tx.query<{ incoming: string; outgoing: string }>(
    `SELECT coalesce(sum(e.amount_minor) FILTER(WHERE e.amount_minor>0 AND e.kind<>'transfer'),0)::text incoming,
      coalesce(-sum(e.amount_minor) FILTER(WHERE e.amount_minor<0 AND e.kind<>'transfer'),0)::text outgoing
     FROM money_entries e JOIN money_accounts a ON a.organization_id=e.organization_id AND a.id=e.account_id
     JOIN organizations g ON g.id=e.organization_id
     WHERE e.organization_id=$1 AND e.kind NOT IN ('opening') AND ($4::uuid IS NULL OR a.branch_id=$4) AND ${inPeriod("e.created_at")}`,
    args,
  );
  const [stock] = await tx.query<{ waste: number; waste_value: string }>(
    `SELECT count(*)::int waste, coalesce(sum(-m.value_minor),0)::text waste_value
     FROM stock_movements m JOIN warehouses w ON w.organization_id=m.organization_id AND w.id=m.warehouse_id
     JOIN industry_stock_links l ON l.organization_id=m.organization_id AND l.movement_id=m.id
     JOIN industry_documents d ON d.organization_id=l.organization_id AND d.id=l.document_id AND d.kind='waste'
     JOIN organizations g ON g.id=m.organization_id
     WHERE m.organization_id=$1 AND ($4::uuid IS NULL OR w.branch_id=$4) AND ${inPeriod("m.created_at")}`,
    args,
  );
  const [tasks] = await tx.query<{
    created: number;
    completed: number;
    late: number;
    median_hours: string | null;
  }>(
    `SELECT count(*) FILTER(WHERE ${inPeriod("t.created_at")})::int created,
      count(*) FILTER(WHERE t.completed_at IS NOT NULL AND ${inPeriod("t.completed_at")})::int completed,
      count(*) FILTER(WHERE t.completed_at IS NOT NULL AND ${inPeriod("t.completed_at")} AND t.due_at IS NOT NULL AND t.completed_at>t.due_at)::int late,
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.completed_at-t.created_at)/3600) FILTER(WHERE t.completed_at IS NOT NULL AND ${inPeriod("t.completed_at")}))::numeric(12,2)::text median_hours
     FROM tasks t JOIN organizations g ON g.id=t.organization_id
     WHERE t.organization_id=$1 AND ($4::uuid IS NULL OR t.branch_id=$4)`,
    args,
  );
  const [situations] = await tx.query<{ opened: number; resolved: number }>(
    `SELECT count(*) FILTER(WHERE ${inPeriod("i.detected_at")})::int opened,
      count(*) FILTER(WHERE i.resolved_at IS NOT NULL AND ${inPeriod("i.resolved_at")})::int resolved
     FROM insights i JOIN organizations g ON g.id=i.organization_id
     WHERE i.organization_id=$1 AND ($4::uuid IS NULL OR i.branch_id IS NULL OR i.branch_id=$4)`,
    args,
  );
  const [days] = await tx.query<{ n: number }>(
    "SELECT ($2::date-$1::date+1)::int n",
    [p.from, p.to],
  );
  return {
    period: { from: p.from, to: p.to, days: days.n, branchId: p.branchId },
    sales: {
      ordersFulfilled: sales.orders,
      revenueMinor: sales.revenue,
      costMinor: sales.unknown ? null : sales.cost,
      eventsWithUnknownCost: sales.unknown,
      grossProfitMinor: sales.unknown
        ? null
        : (BigInt(sales.revenue) - BigInt(sales.cost)).toString(),
      returnEvents: sales.returns,
    },
    cash: { incomingMinor: cash.incoming, outgoingMinor: cash.outgoing },
    stock: { wasteDocuments: stock.waste, wasteValueMinor: stock.waste_value },
    tasks: {
      created: tasks.created,
      completed: tasks.completed,
      completedLate: tasks.late,
      medianHoursToComplete: tasks.median_hours,
    },
    situations: { opened: situations.opened, resolved: situations.resolved },
  };
}
const diff = (a: string | null, b: string | null) =>
  a === null || b === null ? null : new D(b).minus(a).toFixed();
export function comparePilot(baseline: PilotMetrics, pilot: PilotMetrics) {
  const caveats = ["not_causal", "seasonality_not_adjusted"];
  if (baseline.period.days !== pilot.period.days)
    caveats.push("periods_of_different_length");
  if (pilot.period.from <= baseline.period.to) caveats.push("periods_overlap");
  if (baseline.sales.eventsWithUnknownCost || pilot.sales.eventsWithUnknownCost)
    caveats.push("unknown_costs");
  if (baseline.sales.ordersFulfilled < 30 || pilot.sales.ordersFulfilled < 30)
    caveats.push("small_sample");
  return {
    baseline,
    pilot,
    difference: {
      revenueMinor: diff(baseline.sales.revenueMinor, pilot.sales.revenueMinor),
      grossProfitMinor: diff(
        baseline.sales.grossProfitMinor,
        pilot.sales.grossProfitMinor,
      ),
      ordersFulfilled:
        pilot.sales.ordersFulfilled - baseline.sales.ordersFulfilled,
      wasteValueMinor: diff(
        baseline.stock.wasteValueMinor,
        pilot.stock.wasteValueMinor,
      ),
      tasksCompletedLate:
        pilot.tasks.completedLate - baseline.tasks.completedLate,
      medianHoursToComplete: diff(
        baseline.tasks.medianHoursToComplete,
        pilot.tasks.medianHoursToComplete,
      ),
    },
    caveats,
  };
}
