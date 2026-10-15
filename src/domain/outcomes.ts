import { z } from "zod";
const minor = z.string().regex(/^-?\d+$/);
const money = z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/);
export const outcomeInput = z
  .object({
    key: z.uuid(),
    branchId: z.uuid(),
    sourceType: z.enum(["order", "purchase"]),
    sourceId: z.uuid(),
    forecast: money.nullable(),
    alternativeOfferIds: z.array(z.uuid()).max(30),
    limitations: z.string().trim().min(10).max(500),
  })
  .strict();
export const outcomeQuery = z
  .object({
    branchId: z.uuid().optional(),
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .strict()
  .refine(
    (q) =>
      q.from <= q.to && Date.parse(q.to) - Date.parse(q.from) <= 366 * 86400000,
  );
const source = z.object({
  type: z.enum(["industry", "proposal", "channel"]),
  id: z.uuid(),
  state: z.string(),
});
export const outcomeView = z.object({
  from: z.string(),
  to: z.string(),
  asOf: z.string(),
  revenueMinor: minor,
  paidMinor: minor,
  knownCostMinor: minor,
  unknownCostOrders: z.number().int(),
  facts: z.array(
    z.object({
      id: z.uuid(),
      number: z.number().int(),
      branchId: z.uuid(),
      state: z.string(),
      revenueMinor: minor,
      paidMinor: minor,
      costMinor: minor.nullable(),
      sources: z.array(source),
      eventIds: z.array(z.uuid()),
    }),
  ),
  proposals: z.array(
    z.object({
      id: z.uuid(),
      state: z.string(),
      resultType: z.string().nullable(),
      resultId: z.uuid().nullable(),
      amountMinor: minor.nullable(),
    }),
  ),
  actions: z.array(
    z.object({
      id: z.uuid(),
      module: z.enum(["industry", "marketing", "channel"]),
      kind: z.string(),
      state: z.string(),
    }),
  ),
  measurements: z.array(
    z.object({
      id: z.uuid(),
      sourceType: z.enum(["order", "purchase"]),
      sourceId: z.uuid(),
      forecastMinor: minor.nullable(),
      baselineMinor: minor.nullable(),
      actualMinor: minor.nullable(),
      differenceMinor: minor.nullable(),
      status: z.enum(["pending", "measured", "incomparable"]),
      limitations: z.string(),
      createdAt: z.string(),
      evidenceIds: z.array(z.uuid()),
    }),
  ),
});
export type OutcomeView = z.infer<typeof outcomeView>;
