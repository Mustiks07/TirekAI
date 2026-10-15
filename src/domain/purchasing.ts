import { z } from "zod";
import Decimal from "decimal.js";
import { amount, positive } from "./commerce";
import { pageQuery, paginationSchema } from "./import-contracts";
export const D = Decimal.clone({
  precision: 80,
  rounding: Decimal.ROUND_HALF_UP,
});
const name = z.string().trim().min(2).max(120);
const note = z.string().trim().min(3).max(250);
const money = z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/);
export const supplierInput = z
  .object({
    key: z.uuid(),
    name,
    contact: z.string().trim().max(200),
    paymentTerms: z.string().trim().max(250),
    reliability: z.number().int().min(1).max(5).nullable(),
    quality: z.number().int().min(1).max(5).nullable(),
  })
  .strict();
export const offerInput = z
  .object({
    key: z.uuid(),
    supplierId: z.uuid(),
    itemId: z.uuid(),
    supplierSku: name,
    packQuantity: positive,
    baseUnit: z.enum(["pc", "kg", "l", "m", "hour"]),
    packPrice: amount,
    minimumPacks: z.number().int().min(1).max(1000000),
    delivery: money.nullable(),
    leadDays: z.number().int().min(0).max(365).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    rate: positive.nullable(),
    rateDate: z.iso.date().nullable(),
    rateSource: z.string().trim().max(160),
    tax: z.enum(["included", "excluded", "unknown"]),
    taxPercent: amount.refine((v) => new D(v).lte(100)).nullable(),
    dated: z.iso.date(),
    validUntil: z.iso.date(),
    characteristicsConfirmed: z.boolean(),
    note,
  })
  .strict()
  .refine((v) => v.validUntil >= v.dated, { message: "Offer date range" });
export const procurementQuery = pageQuery.extend({
  q: z.string().trim().max(80).default(""),
});
export const compareInput = z
  .object({ itemId: z.uuid(), quantity: positive, date: z.iso.date() })
  .strict();
export type OfferData = z.infer<typeof offerInput>;
export type SupplierData = z.infer<typeof supplierInput>;
export function priceOffer(o: OfferData, quantity: string, date: string) {
  const reasons: string[] = [];
  if (!o.characteristicsConfirmed) reasons.push("characteristics");
  if (o.delivery === null) reasons.push("delivery");
  if (o.tax === "unknown" || (o.tax === "excluded" && o.taxPercent === null))
    reasons.push("tax");
  if (
    o.currency !== "KZT" &&
    (!o.rate || !o.rateDate || !o.rateSource || o.rateDate > date)
  )
    reasons.push("exchange_rate");
  if (date < o.dated || date > o.validUntil) reasons.push("expired");
  const packs = D.max(
    new D(quantity).div(o.packQuantity).ceil(),
    o.minimumPacks,
  );
  const baseQuantity = packs.mul(o.packQuantity);
  if (baseQuantity.gte("1e15") || baseQuantity.decimalPlaces() > 6)
    reasons.push("quantity_limit");
  const rate = o.currency === "KZT" ? new D(1) : new D(o.rate || 1);
  const tax =
    o.tax === "excluded"
      ? new D(1).plus(new D(o.taxPercent || 0).div(100))
      : new D(1);
  const goods = packs
    .mul(o.packPrice)
    .mul(rate)
    .mul(tax)
    .mul(100)
    .toDecimalPlaces(0);
  const delivery = new D(o.delivery || 0).mul(rate).mul(100).toDecimalPlaces(0);
  const total = goods.plus(delivery);
  return {
    comparable: reasons.length === 0,
    reasons,
    packs: packs.toFixed(),
    quantity: baseQuantity.toFixed(),
    goods_minor: reasons.length ? null : goods.toFixed(),
    delivery_minor: reasons.length ? null : delivery.toFixed(),
    total_minor: reasons.length ? null : total.toFixed(),
    unit_cost: reasons.length
      ? null
      : total.div(baseQuantity).div(100).toFixed(6),
  };
}
export const purchaseInput = z
  .object({
    key: z.uuid(),
    branchId: z.uuid(),
    warehouseId: z.uuid(),
    supplierId: z.uuid(),
    date: z.iso.date(),
    dueDate: z.iso.date(),
    budget: money,
    note,
    lines: z
      .array(z.object({ offerId: z.uuid(), quantity: positive }).strict())
      .min(1)
      .max(30),
  })
  .strict();
export const purchaseCommand = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    kind: z.enum(["submit", "approve", "sent", "cancel"]),
    note,
  })
  .strict();
export const documentUpload = z
  .object({
    key: z.uuid(),
    orderId: z.uuid(),
    filename: z
      .string()
      .min(1)
      .max(160)
      .refine(
        (v) => !/[\\/]/.test(v) && [...v].every((c) => c.charCodeAt(0) >= 32),
      ),
    content: z.string().min(1).max(7_000_000),
    externalId: z.string().trim().max(120).default(""),
  })
  .strict();
// accept: matches an ordered line. substitute: a different SKU replaces an ordered line.
// reject: excluded from payable and stock. separate: becomes its own purchase that needs approval.
export const lineDecision = z.enum([
  "accept",
  "substitute",
  "reject",
  "separate",
]);
export const invoiceLine = z
  .object({
    itemId: z.uuid().nullable(),
    name,
    unit: z.string().min(1).max(20),
    quantity: positive,
    unitPrice: amount,
    decision: lineDecision.default("accept"),
    replacesItemId: z.uuid().nullable().default(null),
  })
  .strict()
  .refine(
    (l) => l.itemId !== null || ["accept", "reject"].includes(l.decision),
    { message: "Substitution and separate purchase need a catalogue item" },
  )
  .refine(
    (l) => (l.decision === "substitute") === (l.replacesItemId !== null),
    {
      message: "Substitution names exactly one ordered item",
    },
  );
export const documentReview = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    number: z.string().trim().min(1).max(80),
    date: z.iso.date(),
    dueDate: z.iso.date(),
    delivery: money,
    total: money,
    lines: z.array(invoiceLine).min(1).max(100),
    note,
    acknowledgeDiscrepancies: z.boolean(),
  })
  .strict();
export const documentAdjustment = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    reason: note,
    lines: z
      .array(
        z
          .object({ lineId: z.uuid(), baseQuantity: positive, total: money })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const receiptInput = z
  .object({
    key: z.uuid(),
    documentId: z.uuid(),
    version: z.number().int().positive(),
    note,
    lines: z
      .array(
        z
          .object({
            lineId: z.uuid(),
            quantity: positive,
            lot: z
              .object({
                code: z.string().trim().min(2).max(120),
                expiresOn: z.iso.date().nullable(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const needInput = z
  .object({
    warehouseId: z.uuid(),
    itemId: z.uuid(),
    minimum: amount,
    safety: amount,
    leadDays: z.number().int().min(0).max(365),
    historyDays: z.number().int().min(7).max(365).default(30),
  })
  .strict();
export const budgetInput = z
  .object({
    budget: money,
    date: z.iso.date(),
    lines: z
      .array(
        z
          .object({
            itemId: z.uuid(),
            quantity: positive,
            priority: z.number().int().min(1).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();
export const purchaseState = z.enum([
  "draft",
  "pending",
  "approved",
  "sent",
  "partial",
  "completed",
  "cancelled",
]);
const minor = z.string().regex(/^-?\d+$/);
export const purchaseRow = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  warehouse_id: z.uuid(),
  supplier_id: z.uuid(),
  supplier_name: z.string(),
  number: z.number(),
  state: purchaseState,
  version: z.number(),
  due_date: z.string(),
  total_minor: minor,
  budget_minor: minor,
  note: z.string(),
  created_at: z.string(),
});
export const purchaseLineRow = z.object({
  id: z.uuid(),
  item_id: z.uuid(),
  offer_id: z.uuid(),
  name: z.string(),
  base_unit: z.string(),
  quantity: z.string(),
  received: z.string(),
  total_minor: minor,
  snapshot: offerInput,
});
export const purchaseList = z.object({
  items: z.array(purchaseRow),
  pagination: paginationSchema,
});
export const purchaseDetail = z.object({
  order: purchaseRow,
  lines: z.array(purchaseLineRow),
  events: z.array(
    z.object({
      id: z.uuid(),
      kind: z.string(),
      note: z.string(),
      created_at: z.string(),
      actor_name: z.string(),
    }),
  ),
  eventPagination: paginationSchema,
  // Receipts into a MoySklad-mirrored warehouse are handed over as supplies (T030).
  exports: z
    .array(
      z.object({
        id: z.uuid(),
        state: z.enum(["pending", "sent", "failed", "dead"]),
        error_code: z.string().nullable(),
        warning: z.string().nullable(),
        external_id: z.string().nullable(),
        created_at: z.string(),
      }),
    )
    .default([]),
});
export const supplierList = z.object({
  items: z.array(
    z.object({ id: z.uuid(), data: supplierInput, created_at: z.string() }),
  ),
  pagination: paginationSchema,
});
export const comparison = z.object({
  itemId: z.uuid(),
  quantity: z.string(),
  offers: z.array(
    z.object({
      id: z.uuid(),
      supplier_name: z.string(),
      data: offerInput,
      quality: z.number().nullable(),
      reliability: z.number().nullable(),
      comparable: z.boolean(),
      reasons: z.array(z.string()),
      packs: z.string(),
      quantity: z.string(),
      goods_minor: minor.nullable(),
      delivery_minor: minor.nullable(),
      total_minor: minor.nullable(),
      unit_cost: z.string().nullable(),
    }),
  ),
});
export const documentRow = z.object({
  id: z.uuid(),
  order_id: z.uuid(),
  filename: z.string(),
  sha256: z.string(),
  state: z.enum(["review", "approved"]),
  version: z.number(),
  external_id: z.string(),
  number: z.string().nullable(),
  date: z.string().nullable(),
  extraction: z.object({
    text: z.string(),
    rows: z.array(z.array(z.string())),
    engine: z.string(),
    warnings: z.array(z.string()),
    confidence: z.number().nullable(),
    candidates: z.array(
      z.object({
        name: z.string(),
        quantity: z.string().nullable(),
        unit: z.string().nullable(),
        unitPrice: z.string().nullable(),
        total: z.string().nullable(),
        confidence: z.number().nullable(),
      }),
    ),
  }),
  review: documentReview.nullable(),
  discrepancies: z.array(z.string()),
  obligation_id: z.uuid().nullable(),
  parent_document_id: z.uuid().nullable(),
  created_at: z.string(),
});
export const documentView = z.object({
  document: documentRow,
  lines: z.array(
    z.object({
      id: z.uuid(),
      item_id: z.uuid(),
      name: z.string(),
      unit: z.string(),
      quantity: z.string(),
      base_quantity: z.string(),
      received: z.string(),
      total_minor: minor,
      purchase_line_id: z.uuid().nullable(),
      received_value_minor: minor,
    }),
  ),
  decisions: z.array(
    z.object({
      id: z.uuid(),
      position: z.number(),
      item_id: z.uuid().nullable(),
      name: z.string(),
      unit: z.string(),
      quantity: z.string(),
      total_minor: minor,
      decision: z.enum(["substitute", "reject", "separate"]),
      replaces_line_id: z.uuid().nullable(),
      split_order_id: z.uuid().nullable(),
      split_document_id: z.uuid().nullable(),
    }),
  ),
  adjustments: z.array(
    z.object({
      id: z.uuid(),
      document_version: z.number(),
      delta_minor: minor,
      warnings: z.array(z.string()),
      reason: z.string(),
      created_at: z.string(),
      actor_name: z.string(),
    }),
  ),
  obligation: z
    .object({ amount_minor: minor, paid_minor: minor, due_date: z.string() })
    .nullable(),
  revisions: z.array(
    z.object({
      id: z.uuid(),
      version: z.number(),
      note: z.string(),
      created_at: z.string(),
      actor_name: z.string(),
    }),
  ),
});
export const documentList = z.object({
  items: z.array(documentRow),
  pagination: paginationSchema,
});
export type PurchaseDetail = z.infer<typeof purchaseDetail>;
export type PurchaseRow = z.infer<typeof purchaseRow>;
export type PurchaseLine = z.infer<typeof purchaseLineRow>;
export type Comparison = z.infer<typeof comparison>;
export type DocumentView = z.infer<typeof documentView>;
export const needView = z.object({
  quantity: z.string(),
  reserved: z.string(),
  in_transit: z.string(),
  demand: z.string(),
  observed_days: z.number(),
  in_stock_days: z.number(),
  available: z.string(),
  target: z.string(),
  need: z.string(),
  daily_demand: z.string().nullable(),
  method: z.string(),
  warnings: z.array(z.string()),
  inputs: needInput,
});
export const budgetView = z.object({
  budget_minor: minor,
  remaining_minor: minor,
  assumptions: z.array(z.string()),
  lines: z.array(
    z.object({
      itemId: z.uuid(),
      quantity: z.string(),
      priority: z.number(),
      selected_offer_id: z.uuid().nullable(),
      reason: z.string(),
      alternatives: comparison.shape.offers,
    }),
  ),
});
