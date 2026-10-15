import { z } from "zod";
import Decimal from "decimal.js";

// T040 contracts: channel order → internal order → reserve → issue → payout/commission → return.
const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
const money = z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/);
const note = z.string().trim().min(3).max(250);
export const writesInput = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    enabled: z.boolean(),
  })
  .strict();
export const productLinkInput = z
  .object({
    key: z.uuid(),
    productCode: z.string().trim().min(1).max(60),
    itemId: z.uuid(),
  })
  .strict();
export const channelOrderCommand = z
  .object({ key: z.uuid(), version: z.number().int().positive() })
  .strict();
export const channelStep = z.object({ key: z.uuid(), note }).strict();
// Numbers are copied from the channel's settlement report; gross − commission must equal net.
export const settlementInput = z
  .object({
    key: z.uuid(),
    kind: z.enum(["payout", "return"]),
    accountId: z.uuid(),
    document: z.string().trim().min(1).max(80),
    reportDate: z.iso.date(),
    gross: money.refine((v) => new D(v).gt(0)),
    commission: money,
    net: money,
  })
  .strict()
  .refine((s) => new D(s.gross).minus(s.commission).eq(s.net), {
    path: ["net"],
    message: "SETTLEMENT_ARITHMETIC",
  });
// Kaspi statuses that make an order unusable for import.
export const CLOSED_STATUSES = [
  "CANCELLED",
  "CANCELLING",
  "RETURNED",
  "KASPI_DELIVERY_RETURN_REQUESTED",
  "RETURN_ACCEPTED_BY_MERCHANT",
];
