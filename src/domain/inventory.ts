import { z } from "zod";
import Decimal from "decimal.js";
import { AppError } from "./errors";
import { pageQuery, paginationSchema } from "./import-contracts";
export const decimalInput = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/);
const positive = decimalInput.refine((v) => new Decimal(v).gt(0));
const label = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(/^[^\r\n\t]+$/);
const unit = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[\p{L}\p{N}_.-]+$/u);
export const units = ["pc", "kg", "l", "m", "hour"] as const;
export const itemInput = z
  .object({
    sku: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[\p{L}\p{N}_.:-]+$/u),
    name_ru: label,
    name_kk: z.union([z.literal(""), label]).default(""),
    category: z.string().trim().max(80).default(""),
    variant: z.string().trim().max(80).default(""),
    barcode: z
      .string()
      .trim()
      .max(80)
      .regex(/^[A-Za-z0-9-]*$/)
      .default(""),
    kind: z.enum(["goods", "service"]),
    base_unit: z.enum(units),
    conversions: z
      .array(z.object({ unit, factor: positive }).strict())
      .max(8)
      .default([]),
    purchase_price: decimalInput,
    sale_price: decimalInput,
    active: z.boolean().default(true),
  })
  .strict();
export const itemUpdate = itemInput.extend({
  version: z.number().int().positive(),
});
export const catalogQuery = pageQuery
  .omit({ branchId: true })
  .extend({ q: z.string().trim().max(80).default("") });
export const warehouseInput = z
  .object({ branchId: z.uuid(), name: label })
  .strict();
const commandBase = {
  key: z.uuid(),
  warehouseId: z.uuid(),
  itemId: z.uuid(),
  note: z.string().trim().min(3).max(250),
};
const withQty = { ...commandBase, quantity: positive, unit };
export const stockCommand = z.discriminatedUnion("kind", [
  z
    .object({ ...withQty, kind: z.literal("receipt"), unitCost: decimalInput })
    .strict(),
  z
    .object({
      ...withQty,
      kind: z.literal("issue"),
      reservationId: z.uuid().optional(),
    })
    .strict(),
  z.object({ ...withQty, kind: z.literal("reserve") }).strict(),
  z
    .object({
      ...commandBase,
      kind: z.literal("release"),
      reservationId: z.uuid(),
    })
    .strict(),
  z
    .object({
      ...withQty,
      kind: z.literal("dispatch"),
      destinationId: z.uuid(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      kind: z.literal("receive"),
      transferId: z.uuid(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      kind: z.literal("count"),
      quantity: decimalInput,
      unit,
      version: z.number().int().nonnegative(),
      unitCost: decimalInput.optional(),
    })
    .strict(),
  z
    .object({ ...withQty, kind: z.literal("return"), movementId: z.uuid() })
    .strict(),
]);
export type StockCommand = z.infer<typeof stockCommand>;
export type CatalogInput = z.infer<typeof itemInput>;
export const itemSchema = itemInput.omit({ purchase_price: true }).extend({
  id: z.uuid(),
  version: z.number().int().positive(),
  purchase_price: decimalInput.optional(),
});
export type Item = z.infer<typeof itemSchema>;
export const catalogSchema = z.object({
  items: z.array(itemSchema),
  pagination: paginationSchema,
  canWrite: z.boolean(),
  canReadCost: z.boolean(),
});
export type CatalogView = z.infer<typeof catalogSchema>;
export const warehouseSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  name: z.string(),
});
export type Warehouse = z.infer<typeof warehouseSchema>;
const signed = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const minor = z.string().regex(/^-?\d+$/);
export const stockQuery = pageQuery
  .omit({ branchId: true })
  .extend({ warehouseId: z.uuid() });
export const balanceSchema = z.object({
  item_id: z.uuid(),
  sku: z.string(),
  name_ru: z.string(),
  name_kk: z.string(),
  base_unit: z.string(),
  quantity: signed,
  reserved: signed,
  available: signed,
  version: z.number().int(),
  value_minor: minor.optional(),
});
export const movementSchema = z.object({
  base_unit: z.string(),
  id: z.uuid(),
  item_id: z.uuid(),
  sku: z.string(),
  kind: z.string(),
  quantity: signed,
  value_minor: minor.optional(),
  note: z.string(),
  created_at: z.iso.datetime(),
  source_id: z.uuid().nullable(),
  transfer_id: z.uuid().nullable(),
});
export const reservationSchema = z.object({
  base_unit: z.string(),
  id: z.uuid(),
  item_id: z.uuid(),
  sku: z.string(),
  quantity: signed,
  status: z.enum(["active", "released", "fulfilled"]),
  note: z.string(),
});
export const transferSchema = z.object({
  base_unit: z.string(),
  id: z.uuid(),
  item_id: z.uuid(),
  sku: z.string(),
  source_id: z.uuid(),
  destination_id: z.uuid(),
  destination_name: z.string(),
  quantity: signed,
  state: z.enum(["in_transit", "received"]),
  note: z.string(),
});
export const stockViewSchema = z.object({
  items: z.array(balanceSchema),
  pagination: paginationSchema,
});
export type StockView = z.infer<typeof stockViewSchema>;
export const movementsViewSchema = z.object({
  items: z.array(movementSchema),
  pagination: paginationSchema,
});
export type MovementsView = z.infer<typeof movementsViewSchema>;
export const reservationsViewSchema = z.object({
  items: z.array(reservationSchema),
  pagination: paginationSchema,
});
export type ReservationsView = z.infer<typeof reservationsViewSchema>;
export const transfersViewSchema = z.object({
  items: z.array(transferSchema),
  pagination: paginationSchema,
});
export type TransfersView = z.infer<typeof transfersViewSchema>;
export const warehouseViewSchema = z.object({
  items: z.array(warehouseSchema),
});
export const commandResult = z.object({
  id: z.uuid(),
  kind: z.string(),
  reused: z.boolean(),
});
export const entityResult = z.object({ id: z.uuid() });
export const balanceSnapshot = z.object({
  quantity: signed,
  version: z.number().int().nonnegative(),
});
const D = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP });
export function toBase(
  amount: string,
  unitName: string,
  item: Pick<CatalogInput, "base_unit" | "conversions">,
) {
  const factor =
    unitName === item.base_unit
      ? "1"
      : item.conversions.find((c) => c.unit === unitName)?.factor;
  if (!factor) throw new AppError("UNIT_NOT_ALLOWED", 422);
  const result = new D(amount).times(factor);
  if (result.decimalPlaces() > 6 || result.gt("999999999999999.999999"))
    throw new AppError("QUANTITY_PRECISION", 422);
  return result.toFixed();
}
export function allocatedValue(total: bigint, take: string, stock: string) {
  if (new D(take).lte(0) || new D(stock).lt(take) || total < 0n)
    throw new AppError("INVALID_ALLOCATION", 422);
  return new D(stock).eq(take)
    ? total
    : BigInt(new D(total.toString()).times(take).div(stock).toFixed(0));
}
export function inventoryContract() {
  return {
    version: "1.2",
    schemas: Object.fromEntries(
      Object.entries({
        ItemCreate: itemInput,
        ItemUpdate: itemUpdate,
        WarehouseCreate: warehouseInput,
        Command: stockCommand,
        Catalog: catalogSchema,
        Stock: stockViewSchema,
        Movements: movementsViewSchema,
        Reservations: reservationsViewSchema,
        Transfers: transfersViewSchema,
        Result: commandResult,
        EntityResult: entityResult,
        Warehouses: warehouseViewSchema,
        BalanceSnapshot: balanceSnapshot,
      }).map(([k, v]) => [k, z.toJSONSchema(v)]),
    ),
  };
}
