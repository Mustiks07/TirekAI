import { z } from "zod";

// T005/T052 main screen ("Сегодня требуют внимания"). The view is assembled on the server from
// existing services and read-only queries; every figure carries its period and source, and a
// missing input is reported by name instead of being replaced with zero.
const minor = z.string().regex(/^-?\d+$/);
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const date = z.iso.date();
const time = z.string();
export const dashboardQuery = z
  .object({ branchId: z.uuid().optional() })
  .strict();
export const reserveInput = z
  .object({
    key: z.uuid(),
    branchId: z.uuid().nullable(),
    version: z.number().int().min(0),
    // KZT with up to two decimals, as typed by a person.
    minimum: z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/),
  })
  .strict();
// Why a block cannot be computed; shown to the user as plain text.
export const missingReason = z.enum([
  "no_sales_history",
  "short_sales_history",
  "no_sale_price",
  "no_lead_time",
  "no_reorder_point",
  "no_offer",
  "no_reserve",
  "no_accounts",
  "single_branch",
  "no_previous_period",
  "no_sales_today",
]);
export type MissingReason = z.infer<typeof missingReason>;
const state = z.enum(["ok", "no_access", "no_data", "insufficient"]);
const link = z
  .object({
    page: z.enum([
      "orders",
      "finance",
      "purchasing",
      "inventory",
      "approvals",
      "tasks",
      "today",
      "outcomes",
    ]),
    id: z.uuid().nullable(),
    branchId: z.uuid().nullable(),
  })
  .strict();
const source = z.object({ type: z.string(), label: z.string() }).strict();
export const mainSituation = z.object({
  insight_id: z.uuid(),
  rule: z.string(),
  severity: z.number().int(),
  title: z.string(),
  branch_name: z.string().nullable(),
  detected_at: z.string(),
  // low_stock only (null for other rules)
  stock: z
    .object({
      item_id: z.uuid(),
      sku: z.string(),
      name_ru: z.string(),
      name_kk: z.string(),
      unit: z.string(),
      warehouse: z.string(),
      available: decimal,
      minimum: decimal,
      safety: decimal,
      shortage: decimal,
      lead_days: z.number().int().nullable(),
      sold: decimal,
      history_days: z.number().int(),
      period_from: date.nullable(),
      daily_sales: decimal.nullable(),
      days_left: decimal.nullable(),
      average_price_minor: minor.nullable(),
      revenue_at_risk_minor: minor.nullable(),
      lost_units: decimal.nullable(),
      order: z
        .object({
          supplier: z.string(),
          quantity: decimal,
          total_minor: minor,
        })
        .nullable(),
      transfer: z
        .object({
          warehouse: z.string(),
          branch_name: z.string(),
          available: decimal,
          spare: decimal,
        })
        .nullable(),
    })
    .nullable(),
  facts: z.record(z.string(), z.unknown()),
  calculation: z.string(),
  sources: z.array(source),
  missing: z.array(missingReason),
  can_prepare: z.boolean(),
  link,
});
export type MainSituation = z.infer<typeof mainSituation>;
export const dashboardView = z.object({
  as_of: z.string(),
  today: date,
  timezone: z.string(),
  branch_id: z.uuid().nullable(),
  last_detection: z.string().nullable(),
  can_refresh: z.boolean(),
  situations: z.object({
    state,
    total: z.number().int(),
    main: mainSituation.nullable(),
    others: z.array(
      z.object({
        insight_id: z.uuid(),
        rule: z.string(),
        severity: z.number().int(),
        title: z.string(),
      }),
    ),
  }),
  payment: z.object({
    state,
    missing: z.array(missingReason),
    supplier: z.string().nullable(),
    kind: z.enum(["supplier", "purchase"]).nullable(),
    id: z.uuid().nullable(),
    due_date: date.nullable(),
    days: z.number().int().nullable(),
    overdue: z.boolean(),
    amount_minor: minor.nullable(),
    after_minor: minor.nullable(),
    reserve_minor: minor.nullable(),
    below_reserve: z.boolean().nullable(),
    upcoming: z.number().int(),
    link: link.nullable(),
  }),
  slow_branch: z.object({
    state,
    missing: z.array(missingReason),
    item: z
      .object({
        id: z.uuid(),
        name_ru: z.string(),
        name_kk: z.string(),
        unit: z.string(),
      })
      .nullable(),
    period_days: z.number().int(),
    from: date,
    rows: z.array(
      z.object({
        branch_id: z.uuid(),
        name: z.string(),
        units: decimal,
        previous: decimal,
        change_percent: decimal.nullable(),
      }),
    ),
    slow_branch_id: z.uuid().nullable(),
  }),
  cash: z.object({
    state,
    missing: z.array(missingReason),
    opening_minor: minor.nullable(),
    reserve_minor: minor.nullable(),
    reserve_version: z.number().int(),
    lowest_minor: minor.nullable(),
    lowest_date: date.nullable(),
    planned_in_minor: minor.nullable(),
    planned_out_minor: minor.nullable(),
    days: z.array(z.object({ date, balance_minor: minor })),
    can_set_reserve: z.boolean(),
  }),
  branches: z.object({
    state,
    missing: z.array(missingReason),
    until: time,
    rows: z.array(
      z.object({
        branch_id: z.uuid(),
        name: z.string(),
        today_minor: minor,
        yesterday_minor: minor,
        change_percent: decimal.nullable(),
      }),
    ),
  }),
  events: z.object({
    state,
    items: z.array(
      z.object({
        at: z.string(),
        kind: z.enum([
          "order_created",
          "order_fulfilled",
          "purchase_created",
          "receipt",
          "situation_opened",
          "average_check",
          "item_sales",
        ]),
        text: z.record(z.string(), z.union([z.string(), z.number()])),
        tone: z.enum(["up", "down", "neutral", "risk"]),
        link: link.nullable(),
      }),
    ),
  }),
});
export type DashboardView = z.infer<typeof dashboardView>;
export const notificationsView = z.object({
  approvals: z.number().int(),
  overdue_tasks: z.number().int(),
  situations: z.number().int(),
});
export type NotificationsView = z.infer<typeof notificationsView>;
