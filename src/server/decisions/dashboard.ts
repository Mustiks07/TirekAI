import { randomUUID } from "node:crypto";
import type { Database, Sql } from "../db/database";
import { sessionAccess, audit, type Credential } from "../access";
import { AppError } from "../../domain/errors";
import { can } from "../../domain/permissions";
import type { Role } from "../../domain/contracts";
import { D } from "../../domain/purchasing";
import {
  dashboardQuery,
  reserveInput,
  type DashboardView,
  type MainSituation,
  type MissingReason,
  type NotificationsView,
} from "../../domain/dashboard";
import { idempotent, organizationClock } from "../execution/core";
import { visibleRules } from "./insights";
import { CommerceService } from "../commerce/service";

// T005/T052 main screen. Read-only composition of existing data: situations (insights),
// the payment calendar (CommerceService.calendar), the sales ledger (sales_events) and the
// purchase and stock records. Nothing here writes business journals. Money is bigint minor
// units and quantities are decimals; an input that is missing is named, never taken as zero.
type Scope = { actorId: string; branchId: string | null; role: Role };
const PERIOD = 14,
  HISTORY = 28,
  SHORT_HISTORY = 7;
const net = "CASE WHEN e.kind='fulfill' THEN e.quantity ELSE -e.quantity END";
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (from: string, to: string) =>
  Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() -
      new Date(`${from}T00:00:00Z`).getTime()) /
      86_400_000,
  );
// Percent change with one decimal, or null when there is nothing to compare with.
function change(now: InstanceType<typeof D>, before: InstanceType<typeof D>) {
  if (before.lte(0)) return null;
  return now.minus(before).div(before).times(100).toDecimalPlaces(1).toFixed();
}
const entityLink = (
  type: string,
  id: string | null,
  branchId: string | null,
): MainSituation["link"] => {
  const page =
    type === "sales_order"
      ? "orders"
      : type === "purchase_order" || type === "purchase_document"
        ? "purchasing"
        : type === "obligation"
          ? "finance"
          : type === "task"
            ? "tasks"
            : type === "stock" || type === "item"
              ? "inventory"
              : "today";
  return {
    page,
    id: page === "orders" || page === "purchasing" ? id : null,
    branchId,
  };
};
export class DashboardService {
  constructor(private db: Database) {}
  async view(
    secret: Credential,
    org: string,
    input: unknown,
  ): Promise<DashboardView> {
    const q = dashboardQuery.parse(input);
    const base = await this.db.transaction(async (tx) => {
      const s = (await sessionAccess(
        tx,
        secret,
        org,
        "organization:read",
        q.branchId,
      )) as Scope;
      const clock = await organizationClock(tx, org);
      const branches = await tx.query<{ id: string; name: string }>(
        "SELECT id,name FROM branches WHERE organization_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY name,id",
        [org, s.branchId],
      );
      const [run] = await tx.query<{ finished_at: string }>(
        "SELECT finished_at FROM insight_runs WHERE organization_id=$1 AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1",
        [org],
      );
      const situations = await this.situations(tx, org, s, clock);
      const slow = can(s.role, "orders:read")
        ? await this.slowBranch(
            tx,
            org,
            s,
            clock,
            branches,
            situations.main?.stock?.item_id ?? null,
          )
        : null;
      const revenue = can(s.role, "finance:read")
        ? await this.branchRevenue(tx, org, s, clock, branches)
        : null;
      const events = await this.events(tx, org, s, clock);
      const [reserve] = await tx.query<{
        minimum_minor: string;
        version: number;
      }>(
        "SELECT minimum_minor::text,version FROM cash_reserves WHERE organization_id=$1 AND branch_id IS NOT DISTINCT FROM $2::uuid",
        [org, s.branchId],
      );
      const [accounts] = await tx.query<{ n: number }>(
        "SELECT count(*)::int n FROM money_accounts WHERE organization_id=$1 AND ($2::uuid IS NULL OR branch_id=$2)",
        [org, s.branchId],
      );
      return {
        s,
        clock,
        branches,
        run,
        situations,
        slow,
        revenue,
        events,
        reserve: reserve ?? null,
        accounts: accounts.n,
      };
    });
    const { s, clock } = base;
    const finance = can(s.role, "finance:read");
    // The payment calendar is the existing finance calculation (its own transaction, read-only).
    const calendar = finance
      ? await new CommerceService(this.db).calendar(secret, org, {
          ...(s.branchId ? { branchId: s.branchId } : {}),
          days: PERIOD,
        })
      : null;
    const reserveMinor = base.reserve?.minimum_minor ?? null;
    const balanceOn = (day: string) =>
      calendar?.days.find(
        (d) => d.date === (day < clock.today ? clock.today : day),
      )?.baseline_minor ?? null;
    const cash: DashboardView["cash"] = (() => {
      if (!calendar)
        return {
          state: "no_access",
          missing: [],
          opening_minor: null,
          reserve_minor: null,
          reserve_version: 0,
          lowest_minor: null,
          lowest_date: null,
          planned_in_minor: null,
          planned_out_minor: null,
          days: [],
          can_set_reserve: false,
        };
      const missing: MissingReason[] = [];
      if (!base.accounts) missing.push("no_accounts");
      if (reserveMinor === null) missing.push("no_reserve");
      let lowest = calendar.days[0];
      for (const d of calendar.days)
        if (BigInt(d.baseline_minor) < BigInt(lowest.baseline_minor))
          lowest = d;
      return {
        state: base.accounts ? "ok" : "insufficient",
        missing,
        // Without any money account the balance is unknown, not zero.
        opening_minor: base.accounts ? calendar.opening_minor : null,
        reserve_minor: reserveMinor,
        reserve_version: base.reserve?.version ?? 0,
        lowest_minor: base.accounts ? lowest.baseline_minor : null,
        lowest_date: base.accounts ? lowest.date : null,
        planned_in_minor: calendar.planned_in_minor,
        planned_out_minor: calendar.planned_out_minor,
        days: base.accounts
          ? calendar.days.map((d) => ({
              date: d.date,
              balance_minor: d.baseline_minor,
            }))
          : [],
        can_set_reserve: can(s.role, "finance:write"),
      };
    })();
    const payment: DashboardView["payment"] = (() => {
      const empty = {
        missing: [] as MissingReason[],
        supplier: null,
        kind: null,
        id: null,
        due_date: null,
        days: null,
        overdue: false,
        amount_minor: null,
        after_minor: null,
        reserve_minor: reserveMinor,
        below_reserve: null,
        upcoming: 0,
        link: null,
      };
      if (!calendar) return { ...empty, state: "no_access" as const };
      const out = calendar.documents
        .filter((d) => d.kind !== "order")
        .sort((a, b) =>
          a.due_date === b.due_date
            ? a.id.localeCompare(b.id)
            : a.due_date < b.due_date
              ? -1
              : 1,
        );
      const next = out[0];
      if (!next) return { ...empty, state: "no_data" as const };
      const after = base.accounts ? balanceOn(next.due_date) : null;
      const missing: MissingReason[] = [];
      if (!base.accounts) missing.push("no_accounts");
      if (reserveMinor === null) missing.push("no_reserve");
      return {
        ...empty,
        state: base.accounts ? ("ok" as const) : ("insufficient" as const),
        missing,
        supplier: next.name,
        kind: next.kind as "supplier" | "purchase",
        id: next.id,
        due_date: next.due_date,
        days: daysBetween(clock.today, next.due_date),
        overdue: next.overdue,
        amount_minor: next.amount_minor,
        after_minor: after,
        below_reserve:
          after !== null && reserveMinor !== null
            ? BigInt(after) < BigInt(reserveMinor)
            : null,
        upcoming: out.length,
        link:
          next.kind === "purchase"
            ? { page: "purchasing" as const, id: next.id, branchId: s.branchId }
            : { page: "finance" as const, id: null, branchId: s.branchId },
      };
    })();
    return {
      as_of: new Date().toISOString(),
      today: clock.today,
      timezone: clock.timezone,
      branch_id: s.branchId,
      last_detection: base.run?.finished_at ?? null,
      can_refresh: can(s.role, "insights:read"),
      situations: base.situations,
      payment,
      slow_branch: base.slow ?? {
        state: "no_access",
        missing: [],
        item: null,
        period_days: PERIOD,
        from: addDays(clock.today, -(PERIOD - 1)),
        rows: [],
        slow_branch_id: null,
      },
      cash,
      branches: base.revenue ?? {
        state: "no_access",
        missing: [],
        until: clock.local_time,
        rows: [],
      },
      events: base.events,
    };
  }
  private async situations(
    tx: Sql,
    org: string,
    s: Scope,
    clock: { today: string; timezone: string },
  ): Promise<DashboardView["situations"]> {
    if (!can(s.role, "insights:read"))
      return { state: "no_access", total: 0, main: null, others: [] };
    const rules = visibleRules(s.role);
    const scope =
      "i.organization_id=$1 AND ($2::uuid IS NULL OR i.branch_id IS NULL OR i.branch_id=$2) AND i.rule=ANY($3::text[]) AND i.state IN ('open','acknowledged')";
    const rows = await tx.query<{
      id: string;
      branch_id: string | null;
      rule: string;
      entity_type: string;
      entity_id: string | null;
      severity: number;
      evidence: {
        title: string;
        facts: Record<string, unknown>;
        calculation: string;
        sources: { type: string; id: string | null; label: string }[];
      };
      detected_at: string;
    }>(
      `SELECT i.id,i.branch_id,i.rule,i.entity_type,i.entity_id,i.severity,i.evidence,i.detected_at FROM insights i WHERE ${scope} ORDER BY i.severity DESC,(i.rule='low_stock') DESC,i.detected_at DESC,i.id LIMIT 3`,
      [org, s.branchId, rules],
    );
    const [count] = await tx.query<{ n: number }>(
      `SELECT count(*)::int n FROM insights i WHERE ${scope}`,
      [org, s.branchId, rules],
    );
    const top = rows[0];
    if (!top) return { state: "no_data", total: 0, main: null, others: [] };
    const f = top.evidence.facts;
    const [branch] = top.branch_id
      ? await tx.query<{ name: string }>(
          "SELECT name FROM branches WHERE organization_id=$1 AND id=$2",
          [org, top.branch_id],
        )
      : [];
    const missing: MissingReason[] = [];
    let stock: MainSituation["stock"] = null;
    if (top.rule === "low_stock") {
      const warehouseId = String(f.warehouse_id),
        itemId = String(f.item_id);
      const [item] = await tx.query<{
        sku: string;
        name_ru: string;
        name_kk: string;
        base_unit: string;
      }>(
        "SELECT sku,name_ru,name_kk,base_unit FROM catalog_items WHERE organization_id=$1 AND id=$2",
        [org, itemId],
      );
      const [w] = await tx.query<{ name: string; branch_id: string }>(
        "SELECT name,branch_id FROM warehouses WHERE organization_id=$1 AND id=$2",
        [org, warehouseId],
      );
      // Sales of this item from this warehouse over the last 28 days (net of returns).
      const [sales] = await tx.query<{
        sold: string;
        fulfilled: string;
        fulfilled_minor: string;
        first_day: string | null;
      }>(
        `SELECT coalesce(sum(${net}),0)::text sold,coalesce(sum(e.quantity) FILTER (WHERE e.kind='fulfill'),0)::text fulfilled,coalesce(sum(e.revenue_minor) FILTER (WHERE e.kind='fulfill'),0)::text fulfilled_minor,min((e.created_at AT TIME ZONE $4)::date)::text first_day FROM sales_events e JOIN sales_order_lines l ON l.organization_id=e.organization_id AND l.id=e.line_id JOIN sales_orders o ON o.organization_id=e.organization_id AND o.id=e.order_id WHERE e.organization_id=$1 AND o.warehouse_id=$2 AND l.item_id=$3 AND e.kind IN ('fulfill','return') AND e.created_at>=now()-make_interval(days=>${HISTORY})`,
        [org, warehouseId, itemId, clock.timezone],
      );
      const sold = new D(sales.sold),
        historyDays = sales.first_day
          ? Math.max(1, daysBetween(sales.first_day, clock.today) + 1)
          : 0;
      const available = new D(String(f.available)),
        lead =
          f.lead_days === null || f.lead_days === undefined
            ? null
            : Number(f.lead_days);
      const daily =
        historyDays && sold.gt(0)
          ? sold.div(historyDays).toDecimalPlaces(2)
          : null;
      if (!daily) missing.push("no_sales_history");
      else if (historyDays < SHORT_HISTORY) missing.push("short_sales_history");
      const price = new D(sales.fulfilled).gt(0)
        ? new D(sales.fulfilled_minor)
            .div(sales.fulfilled)
            .toDecimalPlaces(0)
            .toFixed(0)
        : null;
      if (!price) missing.push("no_sale_price");
      if (lead === null) missing.push("no_lead_time");
      if (!f.suggested_offer_id) missing.push("no_offer");
      // Units that cannot be sold before a new delivery arrives, and the revenue they carry.
      const lost =
        daily && lead !== null
          ? D.max(0, daily.times(lead).minus(available.gt(0) ? available : 0))
          : null;
      const atRisk =
        lost && price ? lost.times(price).toDecimalPlaces(0).toFixed(0) : null;
      // A transfer is offered only from a warehouse whose own minimum is known and exceeded.
      const donors = await tx.query<{
        warehouse: string;
        branch_name: string;
        available: string;
        target: string | null;
      }>(
        "SELECT w.name warehouse,b.name branch_name,(x.quantity-x.reserved)::text available,(r.minimum+r.safety)::text target FROM stock_balances x JOIN warehouses w ON w.organization_id=x.organization_id AND w.id=x.warehouse_id JOIN branches b ON b.organization_id=w.organization_id AND b.id=w.branch_id LEFT JOIN reorder_points r ON r.organization_id=x.organization_id AND r.warehouse_id=x.warehouse_id AND r.item_id=x.item_id WHERE x.organization_id=$1 AND x.item_id=$2 AND x.warehouse_id<>$3 AND x.quantity-x.reserved>0 AND ($4::uuid IS NULL OR w.branch_id=$4) ORDER BY x.quantity-x.reserved DESC LIMIT 5",
        [org, itemId, warehouseId, s.branchId],
      );
      const donor = donors
        .filter((d) => d.target !== null)
        .map((d) => ({ ...d, spare: new D(d.available).minus(d.target!) }))
        .find((d) => d.spare.gt(0));
      stock = {
        item_id: itemId,
        sku: item?.sku ?? "",
        name_ru: item?.name_ru ?? top.evidence.title,
        name_kk: item?.name_kk || item?.name_ru || top.evidence.title,
        unit: item?.base_unit ?? String(f.unit ?? ""),
        warehouse: w?.name ?? "",
        available: available.toFixed(),
        minimum: new D(String(f.minimum ?? 0)).toFixed(),
        safety: new D(String(f.safety ?? 0)).toFixed(),
        shortage: new D(String(f.shortage ?? 0)).toFixed(),
        lead_days: lead,
        sold: sold.toFixed(),
        history_days: historyDays,
        period_from: sales.first_day,
        daily_sales: daily ? daily.toFixed() : null,
        days_left:
          daily && daily.gt(0)
            ? D.max(0, available).div(daily).toDecimalPlaces(1).toFixed()
            : null,
        average_price_minor: price,
        revenue_at_risk_minor: atRisk,
        lost_units: lost ? lost.toDecimalPlaces(2).toFixed() : null,
        order:
          f.suggested_supplier &&
          f.suggested_quantity &&
          f.suggested_total_minor
            ? {
                supplier: String(f.suggested_supplier),
                quantity: new D(String(f.suggested_quantity)).toFixed(),
                total_minor: String(f.suggested_total_minor),
              }
            : null,
        transfer: donor
          ? {
              warehouse: donor.warehouse,
              branch_name: donor.branch_name,
              available: new D(donor.available).toFixed(),
              spare: D.min(
                donor.spare,
                new D(String(f.shortage ?? 0)),
              ).toFixed(),
            }
          : null,
      };
    }
    const canPropose = can(s.role, "proposals:write");
    const main: MainSituation = {
      insight_id: top.id,
      rule: top.rule,
      severity: top.severity,
      title: top.evidence.title,
      branch_name: branch?.name ?? null,
      detected_at: top.detected_at,
      stock,
      facts: Object.fromEntries(
        Object.entries(f).filter(
          ([k, v]) => !k.endsWith("_id") && v !== null && typeof v !== "object",
        ),
      ),
      calculation: top.evidence.calculation,
      sources: (top.evidence.sources ?? []).map((x) => ({
        type: x.type,
        label: x.label,
      })),
      missing,
      can_prepare:
        canPropose &&
        (top.rule === "low_stock"
          ? !!f.suggested_offer_id
          : top.branch_id !== null),
      link: entityLink(top.entity_type, top.entity_id, top.branch_id),
    };
    return {
      state: "ok",
      total: count.n,
      main,
      others: rows.slice(1).map((r) => ({
        insight_id: r.id,
        rule: r.rule,
        severity: r.severity,
        title: r.evidence.title,
      })),
    };
  }
  // Units of one item per branch: the last 14 days against the 14 days before.
  private async slowBranch(
    tx: Sql,
    org: string,
    s: Scope,
    clock: { today: string; timezone: string },
    branches: { id: string; name: string }[],
    mainItem: string | null,
  ): Promise<DashboardView["slow_branch"]> {
    const from = addDays(clock.today, -(PERIOD - 1)),
      before = addDays(from, -PERIOD);
    const empty = {
      item: null,
      period_days: PERIOD,
      from,
      rows: [],
      slow_branch_id: null,
    };
    if (branches.length < 2)
      return { ...empty, state: "insufficient", missing: ["single_branch"] };
    // The item of the main situation if two or more branches sold it; otherwise the best
    // seller among items sold in at least two branches. A branch that never sold the item is
    // not "slower" — it is left out.
    const multi = await tx.query<{ item_id: string }>(
      `SELECT l.item_id FROM sales_events e JOIN sales_order_lines l ON l.organization_id=e.organization_id AND l.id=e.line_id JOIN sales_orders o ON o.organization_id=e.organization_id AND o.id=e.order_id WHERE e.organization_id=$1 AND ($4::uuid IS NULL OR o.branch_id=$4) AND e.kind='fulfill' AND (e.created_at AT TIME ZONE $2)::date>=$3::date GROUP BY l.item_id HAVING count(DISTINCT o.branch_id)>=2 ORDER BY (l.item_id=$5::uuid) DESC,sum(e.quantity) DESC,l.item_id LIMIT 1`,
      [org, clock.timezone, before, s.branchId, mainItem],
    );
    const itemId = multi[0]?.item_id ?? null;
    if (!itemId)
      return { ...empty, state: "insufficient", missing: ["single_branch"] };
    const [item] = await tx.query<{
      id: string;
      name_ru: string;
      name_kk: string;
      unit: string;
    }>(
      "SELECT id,name_ru,coalesce(nullif(name_kk,''),name_ru) name_kk,base_unit unit FROM catalog_items WHERE organization_id=$1 AND id=$2",
      [org, itemId],
    );
    const sales = await tx.query<{
      branch_id: string;
      units: string;
      previous: string;
    }>(
      `SELECT o.branch_id,coalesce(sum(${net}) FILTER (WHERE (e.created_at AT TIME ZONE $3)::date>=$4::date),0)::text units,coalesce(sum(${net}) FILTER (WHERE (e.created_at AT TIME ZONE $3)::date<$4::date),0)::text previous FROM sales_events e JOIN sales_order_lines l ON l.organization_id=e.organization_id AND l.id=e.line_id JOIN sales_orders o ON o.organization_id=e.organization_id AND o.id=e.order_id WHERE e.organization_id=$1 AND l.item_id=$2 AND e.kind IN ('fulfill','return') AND (e.created_at AT TIME ZONE $3)::date>=$5::date GROUP BY o.branch_id`,
      [org, itemId, clock.timezone, from, before],
    );
    const rows = branches
      .filter((b) => sales.some((x) => x.branch_id === b.id))
      .map((b) => {
        const r = sales.find((x) => x.branch_id === b.id);
        const units = new D(r?.units ?? 0),
          previous = new D(r?.previous ?? 0);
        return {
          branch_id: b.id,
          name: b.name,
          units: units.toFixed(),
          previous: previous.toFixed(),
          change_percent: change(units, previous),
        };
      })
      .sort((a, b) => new D(b.units).comparedTo(a.units));
    if (rows.every((r) => new D(r.units).lte(0)))
      return {
        ...empty,
        item: item ?? null,
        rows,
        state: "no_data",
        missing: ["no_sales_history"],
      };
    const slow = rows[rows.length - 1];
    const missing: MissingReason[] = rows.some((r) => r.change_percent === null)
      ? ["no_previous_period"]
      : [];
    return {
      state: "ok",
      missing,
      item: item ?? null,
      period_days: PERIOD,
      from,
      rows,
      slow_branch_id: new D(slow.units).lt(rows[0].units)
        ? slow.branch_id
        : null,
    };
  }
  // Revenue today until now against yesterday until the same time (comparable windows).
  private async branchRevenue(
    tx: Sql,
    org: string,
    s: Scope,
    clock: { today: string; timezone: string; local_time: string },
    branches: { id: string; name: string }[],
  ): Promise<DashboardView["branches"]> {
    const rows = await tx.query<{
      branch_id: string;
      today_minor: string;
      yesterday_minor: string;
    }>(
      `SELECT o.branch_id,coalesce(sum(e.revenue_minor) FILTER (WHERE e.created_at>=($3::date::timestamp AT TIME ZONE $4)),0)::text today_minor,coalesce(sum(e.revenue_minor) FILTER (WHERE e.created_at<($3::date::timestamp AT TIME ZONE $4) AND e.created_at<now()-interval '1 day'),0)::text yesterday_minor FROM sales_events e JOIN sales_orders o ON o.organization_id=e.organization_id AND o.id=e.order_id WHERE e.organization_id=$1 AND ($2::uuid IS NULL OR o.branch_id=$2) AND e.kind IN ('fulfill','return') AND e.created_at>=(($3::date-1)::timestamp AT TIME ZONE $4) GROUP BY o.branch_id`,
      [org, s.branchId, clock.today, clock.timezone],
    );
    const out = branches
      .map((b) => {
        const r = rows.find((x) => x.branch_id === b.id);
        const today = BigInt(r?.today_minor ?? "0"),
          yesterday = BigInt(r?.yesterday_minor ?? "0");
        return {
          branch_id: b.id,
          name: b.name,
          today_minor: today.toString(),
          yesterday_minor: yesterday.toString(),
          change_percent: change(
            new D(today.toString()),
            new D(yesterday.toString()),
          ),
        };
      })
      .sort((a, b) =>
        BigInt(b.today_minor) === BigInt(a.today_minor)
          ? a.name.localeCompare(b.name)
          : BigInt(b.today_minor) > BigInt(a.today_minor)
            ? 1
            : -1,
      );
    const any = out.some(
      (r) => BigInt(r.today_minor) !== 0n || BigInt(r.yesterday_minor) !== 0n,
    );
    return {
      state: any ? "ok" : "no_data",
      missing: out.some((r) => BigInt(r.today_minor) !== 0n)
        ? []
        : ["no_sales_today"],
      until: clock.local_time,
      rows: out,
    };
  }
  private async events(
    tx: Sql,
    org: string,
    s: Scope,
    clock: { today: string; timezone: string },
  ): Promise<DashboardView["events"]> {
    const items: DashboardView["events"]["items"] = [];
    const start = [clock.today, clock.timezone];
    const role = s.role;
    if (can(role, "orders:read")) {
      const orders = await tx.query<{
        id: string;
        number: number;
        branch_id: string;
        total_minor: string;
        customer: string;
        created_at: string;
      }>(
        "SELECT o.id,o.number,o.branch_id,o.total_minor::text,c.name customer,o.created_at FROM sales_orders o JOIN customers c ON c.organization_id=o.organization_id AND c.id=o.customer_id WHERE o.organization_id=$1 AND ($2::uuid IS NULL OR o.branch_id=$2) AND o.created_at>=($3::date::timestamp AT TIME ZONE $4) ORDER BY o.created_at DESC,o.id LIMIT 4",
        [org, s.branchId, ...start],
      );
      for (const o of orders)
        items.push({
          at: new Date(o.created_at).toISOString(),
          kind: "order_created",
          text: {
            number: o.number,
            customer: o.customer,
            amount_minor: o.total_minor,
          },
          tone: "neutral",
          link: { page: "orders", id: o.id, branchId: o.branch_id },
        });
      // Average check: orders created today until now against yesterday until the same time.
      const [check] = await tx.query<{
        today_n: number;
        today_sum: string;
        y_n: number;
        y_sum: string;
        last: string | null;
      }>(
        "SELECT count(*) FILTER (WHERE o.created_at>=($3::date::timestamp AT TIME ZONE $4))::int today_n,coalesce(sum(o.total_minor) FILTER (WHERE o.created_at>=($3::date::timestamp AT TIME ZONE $4)),0)::text today_sum,count(*) FILTER (WHERE o.created_at<($3::date::timestamp AT TIME ZONE $4) AND o.created_at<now()-interval '1 day')::int y_n,coalesce(sum(o.total_minor) FILTER (WHERE o.created_at<($3::date::timestamp AT TIME ZONE $4) AND o.created_at<now()-interval '1 day'),0)::text y_sum,max(o.created_at) FILTER (WHERE o.created_at>=($3::date::timestamp AT TIME ZONE $4)) last FROM sales_orders o WHERE o.organization_id=$1 AND ($2::uuid IS NULL OR o.branch_id=$2) AND o.state NOT IN ('draft','cancelled') AND o.created_at>=(($3::date-1)::timestamp AT TIME ZONE $4)",
        [org, s.branchId, ...start],
      );
      if (check.today_n && check.y_n) {
        const now = new D(check.today_sum).div(check.today_n),
          before = new D(check.y_sum).div(check.y_n),
          pct = change(now, before)!;
        items.push({
          at: new Date(check.last!).toISOString(),
          kind: "average_check",
          text: {
            percent: pct,
            amount_minor: now.toDecimalPlaces(0).toFixed(0),
          },
          tone: new D(pct).gte(0) ? "up" : "down",
          link: { page: "orders", id: null, branchId: s.branchId },
        });
      }
      // The item whose sales changed most against the same time yesterday.
      const movers = await tx.query<{
        name_ru: string;
        name_kk: string;
        branch_id: string;
        branch: string;
        today: string;
        yesterday: string;
        last: string;
      }>(
        `SELECT l.name_ru,coalesce(nullif(l.name_kk,''),l.name_ru) name_kk,o.branch_id,b.name branch,coalesce(sum(${net}) FILTER (WHERE e.created_at>=($3::date::timestamp AT TIME ZONE $4)),0)::text today,coalesce(sum(${net}) FILTER (WHERE e.created_at<($3::date::timestamp AT TIME ZONE $4) AND e.created_at<now()-interval '1 day'),0)::text yesterday,max(e.created_at) last FROM sales_events e JOIN sales_order_lines l ON l.organization_id=e.organization_id AND l.id=e.line_id JOIN sales_orders o ON o.organization_id=e.organization_id AND o.id=e.order_id JOIN branches b ON b.organization_id=o.organization_id AND b.id=o.branch_id WHERE e.organization_id=$1 AND ($2::uuid IS NULL OR o.branch_id=$2) AND e.kind IN ('fulfill','return') AND e.created_at>=(($3::date-1)::timestamp AT TIME ZONE $4) GROUP BY l.name_ru,l.name_kk,o.branch_id,b.name`,
        [org, s.branchId, ...start],
      );
      const best = movers
        .map((m) => ({ ...m, pct: change(new D(m.today), new D(m.yesterday)) }))
        .filter((m) => m.pct !== null && new D(m.pct).abs().gte(10))
        .sort((a, b) => new D(b.pct!).abs().comparedTo(new D(a.pct!).abs()))[0];
      if (best)
        items.push({
          at: new Date(best.last).toISOString(),
          kind: "item_sales",
          text: {
            name_ru: best.name_ru,
            name_kk: best.name_kk,
            branch: best.branch,
            percent: best.pct!,
            today: new D(best.today).toFixed(),
            yesterday: new D(best.yesterday).toFixed(),
          },
          tone: new D(best.pct!).gte(0) ? "up" : "down",
          link: { page: "inventory", id: null, branchId: best.branch_id },
        });
    }
    if (can(role, "purchasing:read")) {
      const created = await tx.query<{
        id: string;
        number: number;
        branch_id: string;
        supplier: string;
        total_minor: string;
        created_at: string;
      }>(
        "SELECT p.id,p.number,p.branch_id,s.name supplier,p.total_minor::text,p.created_at FROM purchase_orders p JOIN suppliers s ON s.organization_id=p.organization_id AND s.id=p.supplier_id WHERE p.organization_id=$1 AND ($2::uuid IS NULL OR p.branch_id=$2) AND p.created_at>=($3::date::timestamp AT TIME ZONE $4) ORDER BY p.created_at DESC,p.id LIMIT 3",
        [org, s.branchId, ...start],
      );
      for (const p of created)
        items.push({
          at: new Date(p.created_at).toISOString(),
          kind: "purchase_created",
          text: {
            number: p.number,
            supplier: p.supplier,
            amount_minor: p.total_minor,
          },
          tone: "neutral",
          link: { page: "purchasing", id: p.id, branchId: p.branch_id },
        });
      const receipts = await tx.query<{
        order_id: string;
        branch_id: string;
        name: string;
        unit: string;
        quantity: string;
        warehouse: string;
        at: string;
      }>(
        "SELECT p.id order_id,p.branch_id,l.name,l.base_unit unit,sum(r.quantity)::text quantity,w.name warehouse,max(r.created_at) at FROM purchase_receipts r JOIN purchase_lines l ON l.organization_id=r.organization_id AND l.id=r.purchase_line_id JOIN purchase_orders p ON p.organization_id=l.organization_id AND p.id=l.order_id JOIN warehouses w ON w.organization_id=p.organization_id AND w.id=p.warehouse_id WHERE r.organization_id=$1 AND ($2::uuid IS NULL OR p.branch_id=$2) AND r.created_at>=($3::date::timestamp AT TIME ZONE $4) GROUP BY p.id,p.branch_id,l.name,l.base_unit,w.name ORDER BY max(r.created_at) DESC LIMIT 3",
        [org, s.branchId, ...start],
      );
      for (const r of receipts)
        items.push({
          at: new Date(r.at).toISOString(),
          kind: "receipt",
          text: {
            name: r.name,
            quantity: new D(r.quantity).toFixed(),
            unit: r.unit,
            warehouse: r.warehouse,
          },
          tone: "up",
          link: { page: "purchasing", id: r.order_id, branchId: r.branch_id },
        });
    }
    if (can(role, "insights:read")) {
      const opened = await tx.query<{
        id: string;
        branch_id: string | null;
        title: string;
        entity_type: string;
        entity_id: string | null;
        detected_at: string;
      }>(
        "SELECT i.id,i.branch_id,i.evidence->>'title' title,i.entity_type,i.entity_id,i.detected_at FROM insights i WHERE i.organization_id=$1 AND ($2::uuid IS NULL OR i.branch_id IS NULL OR i.branch_id=$2) AND i.rule=ANY($5::text[]) AND i.state IN ('open','acknowledged') AND i.detected_at>=($3::date::timestamp AT TIME ZONE $4) ORDER BY i.detected_at DESC,i.id LIMIT 3",
        [org, s.branchId, ...start, visibleRules(role)],
      );
      for (const i of opened)
        items.push({
          at: new Date(i.detected_at).toISOString(),
          kind: "situation_opened",
          text: { title: i.title },
          tone: "risk",
          link: entityLink(i.entity_type, i.entity_id, i.branch_id),
        });
    }
    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return {
      state: items.length ? "ok" : "no_data",
      items: items.slice(0, 8),
    };
  }
  async notifications(
    secret: Credential,
    org: string,
  ): Promise<NotificationsView> {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "organization:read");
      const [approvals] = await tx.query<{ n: number }>(
        "SELECT count(*)::int n FROM action_proposals p WHERE p.organization_id=$1 AND ($2::uuid IS NULL OR p.branch_id=$2) AND p.state='pending' AND p.created_by<>$3 AND p.expires_at>now() AND ((p.kind='purchase_order' AND $4::boolean) OR (p.kind='task' AND $5::boolean) OR EXISTS(SELECT 1 FROM approval_delegations g WHERE g.organization_id=p.organization_id AND g.to_user=$3 AND g.kind=p.kind AND g.revoked_at IS NULL AND g.valid_until>now()))",
        [
          org,
          s.branchId,
          s.actorId,
          can(s.role, "purchasing:approve"),
          can(s.role, "tasks:manage"),
        ],
      );
      const [tasks] = await tx.query<{ n: number }>(
        "SELECT count(*)::int n FROM tasks t WHERE t.organization_id=$1 AND t.assignee_id=$2 AND t.due_at<now() AND t.state NOT IN ('done','verified','cancelled')",
        [org, s.actorId],
      );
      let situations = 0;
      if (can(s.role, "insights:read")) {
        const [c] = await tx.query<{ n: number }>(
          "SELECT count(*)::int n FROM insights i WHERE i.organization_id=$1 AND ($2::uuid IS NULL OR i.branch_id IS NULL OR i.branch_id=$2) AND i.rule=ANY($3::text[]) AND i.state='open'",
          [org, s.branchId, visibleRules(s.role)],
        );
        situations = c.n;
      }
      return {
        approvals: approvals.n,
        overdue_tasks: tasks.n,
        situations,
      };
    });
  }
  // Minimum cash reserve for the organization or one branch (a warning threshold only).
  async setReserve(secret: Credential, org: string, input: unknown) {
    const c = reserveInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        "finance:write",
        c.branchId ?? undefined,
      );
      // A branch-bound person sets only their branch's reserve.
      if (s.branchId && c.branchId !== s.branchId)
        throw new AppError("FORBIDDEN", 403);
      const r = await idempotent(tx, org, c.key, {
        operation: "finance.reserve",
        ...c,
      });
      if (r.reused) return r;
      const [row] = await tx.query<{ id: string; version: number }>(
        "SELECT id,version FROM cash_reserves WHERE organization_id=$1 AND branch_id IS NOT DISTINCT FROM $2::uuid FOR UPDATE",
        [org, c.branchId],
      );
      if ((row?.version ?? 0) !== c.version)
        throw new AppError("VERSION_CONFLICT", 409);
      const minor = new D(c.minimum).times(100).toFixed(0);
      if (row)
        await tx.query(
          "UPDATE cash_reserves SET minimum_minor=$2,version=version+1,updated_by=$3,updated_at=now() WHERE id=$1",
          [row.id, minor, s.actorId],
        );
      else
        await tx.query(
          "INSERT INTO cash_reserves(id,organization_id,branch_id,minimum_minor,updated_by) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), org, c.branchId, minor, s.actorId],
        );
      await audit(tx, org, s.actorId, "finance.reserve_set", c.branchId, {
        minimum_minor: minor,
      });
      return r;
    });
  }
}
