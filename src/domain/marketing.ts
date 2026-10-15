import { z } from "zod";
import Decimal from "decimal.js";

// T039 contracts. Money is a decimal string in KZT (≤ 2 places), quantities ≤ 6 places,
// percentages ≤ 2 places. Nothing here is computed with JS numbers.
const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
const money = z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/);
const qty = z
  .string()
  .regex(/^(0|[1-9]\d{0,14})(\.\d{1,6})?$/)
  .refine((v) => new D(v).gt(0));
const percent = z.string().regex(/^(0|[1-9]\d?|100)(\.\d{1,2})?$/);
const date = z.iso.date();
const note = z.string().trim().min(3).max(250);
const text = (max: number) => z.string().trim().max(max);
export const offerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("discount"),
      lines: z
        .array(
          z
            .object({
              itemId: z.uuid(),
              discount: percent.refine(
                (v) => new D(v).gt(0) && new D(v).lt(100),
              ),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal("bundle"),
      lines: z
        .array(z.object({ itemId: z.uuid(), quantity: qty }).strict())
        .min(2)
        .max(10),
      price: money.refine((v) => new D(v).gt(0)),
    })
    .strict(),
]);
export const segmentSchema = z
  .object({
    kind: z.enum(["all", "bought_items", "inactive"]),
    itemIds: z.array(z.uuid()).max(20).default([]),
    days: z.number().int().min(1).max(730).default(90),
    channel: z.enum(["none", "messenger", "email", "sms"]),
    excluded: z.array(z.uuid()).max(500).default([]),
  })
  .strict()
  .refine((s) => s.kind !== "bought_items" || s.itemIds.length > 0, {
    path: ["itemIds"],
  });
const localeText = z
  .object({
    title: z.string().trim().min(2).max(80),
    body: text(600),
    terms: text(300),
  })
  .strict();
export const campaignData = z
  .object({
    name: z.string().trim().min(2).max(100),
    branchId: z.uuid(),
    // Availability and average cost are taken from this warehouse, or from every warehouse
    // of the branch when it is null.
    warehouseId: z.uuid().nullable(),
    startsOn: date,
    endsOn: date,
    // Planning budget only: no advertising spend is made by the system.
    budget: money.nullable(),
    minMargin: percent.refine((v) => new D(v).lt(100)),
    offer: offerSchema,
    segment: segmentSchema,
    materials: z
      .object({ ru: localeText, kk: localeText, imageId: z.uuid().nullable() })
      .strict(),
  })
  .strict()
  .refine((c) => c.endsOn >= c.startsOn, { path: ["endsOn"] })
  .refine(
    (c) =>
      new Set(c.offer.lines.map((l) => l.itemId)).size === c.offer.lines.length,
    { path: ["offer"], message: "duplicate items" },
  );
export type CampaignData = z.infer<typeof campaignData>;
export const campaignCreate = z
  .object({ key: z.uuid(), data: campaignData })
  .strict();
export const campaignUpdate = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    data: campaignData,
    note,
  })
  .strict();
const decisionBase = {
  key: z.uuid(),
  version: z.number().int().positive(),
};
export const campaignDecision = z.discriminatedUnion("kind", [
  z
    .object({
      ...decisionBase,
      kind: z.literal("submit"),
      note: note.default("На согласование"),
    })
    .strict(),
  z
    .object({
      ...decisionBase,
      kind: z.literal("approve"),
      note,
      // A margin below the threshold (or unknown) needs a separate owner permission with a reason.
      override: z.boolean().default(false),
    })
    .strict(),
  z.object({ ...decisionBase, kind: z.literal("reject"), note }).strict(),
  z.object({ ...decisionBase, kind: z.literal("archive"), note }).strict(),
]);
export const imageUpload = z
  .object({
    key: z.uuid(),
    mime: z.enum(["image/png", "image/jpeg"]),
    content: z.string().min(4).max(2_800_000),
    altRu: z.string().trim().min(3).max(200),
    altKk: z.string().trim().min(3).max(200),
  })
  .strict();
export const exportInput = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    material: z.enum(["poster", "price_tag", "card"]),
    locale: z.enum(["ru", "kk"]),
  })
  .strict();
export const publishInput = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    channel: z.literal("telegram"),
    locale: z.enum(["ru", "kk"]),
  })
  .strict();
export const spendInput = z
  .object({
    key: z.uuid(),
    spendVersion: z.number().int().nonnegative(),
    spend: money.nullable(),
    note,
  })
  .strict();
export const segmentPreview = z
  .object({ branchId: z.uuid(), segment: segmentSchema })
  .strict();
export const recommendQuery = z
  .object({
    itemId: z.uuid(),
    days: z.coerce.number().int().min(30).max(730).default(180),
  })
  .strict();
export const MIN_ANCHOR_ORDERS = 30;
export const MIN_PAIR_ORDERS = 5;
export const MAX_RECIPIENTS = 500;

// Shapes returned by the evaluation. Cost and margin are null when unknown or not visible to the
// caller (no inventory:cost), never zero.
export type LineEvaluation = {
  itemId: string;
  sku: string | null;
  nameRu: string | null;
  nameKk: string | null;
  kind: "goods" | "service" | null;
  unit: string | null;
  quantity: string;
  discount: string | null;
  priceMinor: string | null;
  promoMinor: string | null;
  costMinor: string | null;
  costSource: "stock_average" | "purchase_price" | "unknown";
  margin: string | null;
  regularMargin: string | null;
  available: string | null;
};
export type Evaluation = {
  offer: "discount" | "bundle";
  lines: LineEvaluation[];
  bundle: {
    priceMinor: string;
    regularMinor: string | null;
    costMinor: string | null;
    margin: string | null;
    sets: string | null;
  } | null;
  minMargin: string;
  lowestMargin: string | null;
  status: "ok" | "below_threshold" | "unknown_margin" | "invalid";
  issues: { code: string; itemId?: string }[];
  costVisible: boolean;
};
const kzt = (minor: string) => {
  const v = new D(minor).div(100);
  return `${v.isInteger() ? v.toFixed(0) : v.toFixed(2)} ₸`;
};
const ruDate = (iso: string) => iso.split("-").reverse().join(".");
// Template text from the evaluated facts; the author edits it before saving. KK wording needs a
// native-speaker review before external use.
export function templateText(
  e: Evaluation,
  data: Pick<CampaignData, "startsOn" | "endsOn" | "name">,
) {
  const period = {
    ru: `Акция действует с ${ruDate(data.startsOn)} по ${ruDate(data.endsOn)}.`,
    kk: `Акция ${ruDate(data.startsOn)} бастап ${ruDate(data.endsOn)} дейін жарамды.`,
  };
  if (e.offer === "discount") {
    const lines = e.lines.filter((l) => l.priceMinor && l.promoMinor);
    return {
      ru: {
        title: data.name,
        body: lines
          .map(
            (l) =>
              `${l.nameRu}: скидка ${l.discount}%, ${kzt(l.promoMinor!)} вместо ${kzt(l.priceMinor!)}.`,
          )
          .join("\n"),
        terms: `${period.ru} Пока товар есть в наличии.`,
      },
      kk: {
        title: data.name,
        body: lines
          .map(
            (l) =>
              `${l.nameKk || l.nameRu}: ${l.discount}% жеңілдік, ${kzt(l.priceMinor!)} орнына ${kzt(l.promoMinor!)}.`,
          )
          .join("\n"),
        terms: `${period.kk} Тауар қоймада бар кезде.`,
      },
    };
  }
  const list = (k: "nameRu" | "nameKk") =>
    e.lines
      .map((l) => `${(k === "nameKk" && l.nameKk) || l.nameRu} × ${l.quantity}`)
      .join(", ");
  const regular = e.bundle?.regularMinor;
  return {
    ru: {
      title: data.name,
      body: `Комплект: ${list("nameRu")} за ${kzt(e.bundle!.priceMinor)}${regular ? ` вместо ${kzt(regular)}` : ""}.`,
      terms: `${period.ru} Пока товар есть в наличии.`,
    },
    kk: {
      title: data.name,
      body: `Жиынтық: ${list("nameKk")}, ${regular ? `${kzt(regular)} орнына ` : ""}${kzt(e.bundle!.priceMinor)}.`,
      terms: `${period.kk} Тауар қоймада бар кезде.`,
    },
  };
}
export { kzt as formatKzt };
