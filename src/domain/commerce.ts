import { z } from "zod";
import Decimal from "decimal.js";
import { pageQuery, paginationSchema } from "./import-contracts";
const D = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP });
export const amount = z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,6})?$/);
export const positive = amount.refine((v) => new D(v).gt(0));
const money = z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/);
const note = z.string().trim().min(3).max(250);
const date = z.iso.date();
export const orderInput = z
  .object({
    key: z.uuid(),
    branchId: z.uuid(),
    customerId: z.uuid(),
    warehouseId: z.uuid(),
    dueDate: date,
    delivery: z.enum(["pickup", "delivery"]),
    note,
    taxMode: z.literal("excluded"),
    lines: z
      .array(
        z
          .object({
            itemId: z.uuid(),
            quantity: positive,
            unit: z.string().min(1).max(20),
            price: amount,
            discount: amount.refine((v) => new D(v).lte(100)).default("0"),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();
const base = { key: z.uuid(), version: z.number().int().positive(), note };
export const orderCommand = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("confirm") }).strict(),
  z.object({ ...base, kind: z.literal("cancel") }).strict(),
  z
    .object({
      ...base,
      kind: z.literal("fulfill"),
      lineId: z.uuid(),
      quantity: positive,
      serviceCost: money.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("return"),
      eventId: z.uuid(),
      quantity: positive,
    })
    .strict(),
]);
export const accountInput = z
  .object({
    key: z.uuid(),
    branchId: z.uuid(),
    name: z.string().trim().min(2).max(80),
    opening: money,
  })
  .strict();
export const obligationInput = z
  .object({
    key: z.uuid(),
    branchId: z.uuid(),
    supplier: z.string().trim().min(2).max(120),
    amount: money.refine((v) => new D(v).gt(0)),
    dueDate: date,
    note,
  })
  .strict();
const movement = {
  key: z.uuid(),
  accountId: z.uuid(),
  amount: money.refine((v) => new D(v).gt(0)),
  note,
};
export const moneyCommand = z.discriminatedUnion("kind", [
  z
    .object({ ...movement, kind: z.literal("payment"), orderId: z.uuid() })
    .strict(),
  z
    .object({ ...movement, kind: z.literal("refund"), orderId: z.uuid() })
    .strict(),
  z
    .object({
      ...movement,
      kind: z.literal("supplier_payment"),
      obligationId: z.uuid(),
    })
    .strict(),
  z
    .object({
      ...movement,
      kind: z.literal("income"),
      category: z.string().trim().min(2).max(80),
      counterparty: z.string().trim().min(2).max(120),
    })
    .strict(),
  z
    .object({
      ...movement,
      kind: z.literal("expense"),
      category: z.string().trim().min(2).max(80),
      counterparty: z.string().trim().min(2).max(120),
      operating: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...movement,
      kind: z.literal("transfer"),
      destinationId: z.uuid(),
    })
    .strict(),
]);
export const commerceQuery = pageQuery.extend({
  q: z.string().trim().max(120).default(""),
});
export const calendarQuery = pageQuery
  .pick({ branchId: true })
  .extend({
    days: z.coerce.number().int().min(1).max(365).default(30),
    delayDays: z.coerce.number().int().min(0).max(365).default(0),
    expensePercent: amount.refine((v) => new D(v).lte(300)).default("100"),
  })
  .strict();
const minor = z.string().regex(/^-?\d+$/),
  decimal = z.string(),
  time = z.iso.datetime({ offset: true });
export const orderSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  branch_id: z.uuid(),
  customer_id: z.uuid(),
  customer_name: z.string(),
  warehouse_id: z.uuid(),
  state: z.enum(["draft", "confirmed", "partial", "fulfilled", "cancelled"]),
  version: z.number().int(),
  due_date: date,
  delivery: z.enum(["pickup", "delivery"]),
  note: z.string(),
  tax_mode: z.literal("excluded"),
  total_minor: minor,
  revenue_minor: minor,
  paid_minor: minor,
  receivable_minor: minor,
  credit_minor: minor,
  expected_minor: minor,
  created_at: time,
});
export const orderLineSchema = z.object({
  id: z.uuid(),
  item_id: z.uuid(),
  sku: z.string(),
  name_ru: z.string(),
  name_kk: z.string(),
  kind: z.enum(["goods", "service"]),
  unit: z.string(),
  base_unit: z.string(),
  quantity: decimal,
  base_quantity: decimal,
  price: decimal,
  discount: decimal,
  total_minor: minor,
  fulfilled: decimal,
  returned: decimal,
  reservation_id: z.uuid().nullable(),
});
export const orderEventSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  line_id: z.uuid().nullable(),
  source_id: z.uuid().nullable(),
  movement_id: z.uuid().nullable(),
  quantity: decimal,
  revenue_minor: minor,
  cost_minor: minor.nullable().optional(),
  note: z.string(),
  actor_name: z.string(),
  created_at: time,
});
export const ordersView = z.object({
  items: z.array(orderSchema),
  pagination: paginationSchema,
});
export const orderView = z.object({
  order: orderSchema,
  lines: z.array(orderLineSchema),
  events: z.array(orderEventSchema),
  eventPagination: paginationSchema,
});
export const accountSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  name: z.string(),
  balance_minor: minor,
});
export const accountsView = z.object({ items: z.array(accountSchema) });
export const ledgerSchema = z.object({
  id: z.uuid(),
  account_id: z.uuid(),
  account_name: z.string(),
  kind: z.string(),
  amount_minor: minor,
  category: z.string(),
  counterparty: z.string(),
  note: z.string(),
  order_id: z.uuid().nullable(),
  obligation_id: z.uuid().nullable(),
  created_at: time,
});
export const ledgerView = z.object({
  items: z.array(ledgerSchema),
  pagination: paginationSchema,
});
export const obligationSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  supplier: z.string(),
  amount_minor: minor,
  paid_minor: minor,
  due_date: date,
  note: z.string(),
});
export const obligationsView = z.object({
  items: z.array(obligationSchema),
  pagination: paginationSchema,
});
export const financeSummary = z.object({
  revenue_minor: minor,
  cost_minor: minor,
  operating_expenses_minor: minor,
  cash_minor: minor,
  receivable_minor: minor,
  customer_credit_minor: minor,
  payable_minor: minor,
  overdue_minor: minor,
  gross_profit_minor: minor.nullable(),
  operating_result_minor: minor.nullable(),
  margin_percent: z.string().nullable(),
  markup_percent: z.string().nullable(),
  unknown_cost_events: z.number().int(),
  tax_mode: z.literal("excluded"),
  expenses_complete: z.literal(false),
});
export const customerOptions = z.object({
  items: z.array(z.object({ id: z.uuid(), name: z.string() })),
  pagination: paginationSchema,
});
export const calendarView = z.object({
  today: date,
  through: date,
  opening_minor: minor,
  baseline_minor: minor,
  scenario_minor: minor,
  planned_in_minor: minor,
  planned_out_minor: minor,
  delay_days: z.number().int(),
  expense_percent: z.string(),
  complete: z.literal(false),
  days: z.array(
    z.object({ date, baseline_minor: minor, scenario_minor: minor }),
  ),
  documents: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(["order", "supplier"]),
      name: z.string(),
      due_date: date,
      amount_minor: minor,
      overdue: z.boolean(),
    }),
  ),
});
export type CalendarView = z.infer<typeof calendarView>;
export const commerceResult = z.object({ id: z.uuid(), reused: z.boolean() });
export function discountedTotal(
  price: string,
  quantity: string,
  discount: string,
) {
  return BigInt(
    new D(price)
      .times(quantity)
      .times(new D(100).minus(discount))
      .toDecimalPlaces(0)
      .toFixed(0),
  );
}
export function commerceContract() {
  return {
    version: "1.3",
    schemas: Object.fromEntries(
      Object.entries({
        OrderInput: orderInput,
        OrderCommand: orderCommand,
        MoneyCommand: moneyCommand,
        AccountInput: accountInput,
        ObligationInput: obligationInput,
        Orders: ordersView,
        Order: orderView,
        Accounts: accountsView,
        Ledger: ledgerView,
        Obligations: obligationsView,
        Summary: financeSummary,
        Customers: customerOptions,
        Result: commerceResult,
        CalendarQuery: calendarQuery,
        Calendar: calendarView,
      }).map(([k, v]) => [k, z.toJSONSchema(v)]),
    ),
  };
}
export type Order = z.infer<typeof orderSchema>;
export type OrderView = z.infer<typeof orderView>;
export type OrdersView = z.infer<typeof ordersView>;
export type Account = z.infer<typeof accountSchema>;
export type Ledger = z.infer<typeof ledgerView>;
export type Obligations = z.infer<typeof obligationsView>;
export type Summary = z.infer<typeof financeSummary>;
