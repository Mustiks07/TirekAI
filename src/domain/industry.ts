import { extendedIndustryCommands } from "./extended-industry";
import { z } from "zod";
import { decimalInput } from "./inventory";
import Decimal from "decimal.js";
const qty = decimalInput.refine((v) => new Decimal(v).gt(0));
const text = z.string().trim().min(2).max(120);
const note = z.string().trim().min(3).max(250);
const version = z.number().int().positive();
const day = z.iso.date();
const base = { key: z.uuid(), branchId: z.uuid() };
const change = { key: z.uuid(), id: z.uuid(), version, note };
export const industryKinds = [
  "recipe",
  "production",
  "resource",
  "appointment",
  "course",
  "group",
  "enrollment",
  "project",
  "waste",
  "construction",
  "clinic",
] as const;
export const material = z
  .object({ itemId: z.uuid(), quantity: qty, unit: z.string().min(1).max(20) })
  .strict();
const materials = z.array(material).max(30);
const slot = {
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  resources: z.array(z.uuid()).min(1).max(8),
};
export const industryCommand = z.discriminatedUnion("kind", [
  ...extendedIndustryCommands,
  z
    .object({
      ...base,
      kind: z.literal("recipe"),
      id: z.uuid().optional(),
      version: version.optional(),
      title: text,
      mode: z.enum(["food", "production"]),
      outputItemId: z.uuid(),
      outputQuantity: qty,
      ingredients: z
        .array(
          material.extend({
            lossPercent: decimalInput
              .refine((v) => new Decimal(v).lt(100))
              .default("0"),
          }),
        )
        .min(1)
        .max(30),
      stages: z.array(text).min(1).max(20),
      note,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("lot_receipt"),
      warehouseId: z.uuid(),
      itemId: z.uuid(),
      quantity: qty,
      unit: z.string().min(1).max(20),
      unitCost: decimalInput,
      lotCode: text,
      expiresOn: day.nullable(),
      note,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("production_plan"),
      recipeId: z.uuid(),
      warehouseId: z.uuid(),
      quantity: qty,
      salesOrderId: z.uuid().nullable().default(null),
      equipmentId: z.uuid().nullable().default(null),
      startsAt: z.iso.datetime({ offset: true }).nullable().default(null),
      endsAt: z.iso.datetime({ offset: true }).nullable().default(null),
      note,
    })
    .strict(),
  z
    .object({ ...change, kind: z.literal("production_issue"), materials })
    .strict(),
  z
    .object({
      ...change,
      kind: z.literal("production_stage"),
      stage: z.number().int().min(0),
      defects: decimalInput.default("0"),
      reworked: decimalInput.default("0"),
    })
    .strict(),
  z
    .object({
      ...change,
      kind: z.literal("production_finish"),
      goodQuantity: decimalInput,
      scrapQuantity: decimalInput,
      lotCode: text,
      expiresOn: day.nullable(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("waste"),
      warehouseId: z.uuid(),
      itemId: z.uuid(),
      lotId: z.uuid(),
      quantity: qty,
      note,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("resource"),
      title: text,
      resourceKind: z.enum([
        "specialist",
        "workplace",
        "teacher",
        "room",
        "equipment",
      ]),
      capacity: z.number().int().min(1).max(200),
      bufferMinutes: z.number().int().min(0).max(180),
      days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
      opens: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      closes: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    })
    .strict(),
  z
    .object({
      ...base,
      ...slot,
      kind: z.literal("appointment"),
      customerId: z.uuid(),
      inquiryId: z.uuid().nullable().default(null),
      serviceItemId: z.uuid(),
      price: decimalInput,
      warehouseId: z.uuid(),
      materials,
      note,
    })
    .strict(),
  z.object({ ...change, ...slot, kind: z.literal("reschedule") }).strict(),
  z
    .object({
      ...change,
      kind: z.literal("appointment_end"),
      outcome: z.enum(["completed", "cancelled", "no_show"]),
    })
    .strict(),
  z
    .object({
      ...change,
      kind: z.literal("reminder"),
      connectionId: z.uuid(),
      text: z.string().trim().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("course"),
      title: text,
      serviceItemId: z.uuid(),
      warehouseId: z.uuid(),
      lessonPrice: decimalInput,
      lessons: z.number().int().min(1).max(500),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("group"),
      title: text,
      courseId: z.uuid(),
      capacity: z.number().int().min(1).max(200),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("enroll"),
      groupId: z.uuid(),
      customerId: z.uuid(),
      guardianId: z.uuid().nullable(),
      inquiryId: z.uuid().nullable().default(null),
      endsOn: day,
      note,
    })
    .strict(),
  z
    .object({
      ...change,
      kind: z.literal("enrollment_change"),
      action: z.enum(["freeze", "resume", "extend", "withdraw"]),
      until: day.nullable(),
      additionalLessons: z.number().int().min(0).max(500).default(0),
    })
    .strict(),
  z
    .object({
      ...base,
      ...slot,
      kind: z.literal("lesson"),
      groupId: z.uuid(),
      note,
    })
    .strict(),
  z
    .object({
      ...change,
      kind: z.literal("lesson_complete"),
      attendance: z
        .array(
          z.object({ enrollmentId: z.uuid(), present: z.boolean() }).strict(),
        )
        .max(200),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("project"),
      title: text,
      quoteId: z.uuid(),
      warehouseId: z.uuid(),
      budget: decimalInput,
      team: z.array(z.uuid()).min(1).max(30),
      stages: z.array(text).min(1).max(20),
      estimatedHours: decimalInput.nullable().default(null),
      note,
    })
    .strict(),
  z
    .object({
      ...change,
      kind: z.literal("project_task"),
      title: text,
      memberId: z.uuid(),
      stage: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      ...change,
      kind: z.literal("time"),
      memberId: z.uuid(),
      stage: z.number().int().min(0),
      hours: qty,
      hourlyRate: decimalInput,
      workedOn: day,
    })
    .strict(),
  z
    .object({
      ...change,
      kind: z.literal("scope_change"),
      budget: decimalInput,
      extraPrice: decimalInput,
      description: note,
    })
    .strict(),
  z.object({ ...change, kind: z.literal("scope_approve") }).strict(),
  z
    .object({
      ...change,
      kind: z.literal("project_stage"),
      stage: z.number().int().min(0),
    })
    .strict(),
  z.object({ ...change, kind: z.literal("project_deliver") }).strict(),
]);
export type IndustryCommand = z.infer<typeof industryCommand>;
export const industryRecord = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  kind: z.enum(industryKinds),
  title: z.string(),
  state: z.string(),
  version,
  data: z.record(z.string(), z.json()),
  created_at: z.string(),
  updated_at: z.string(),
});
export type IndustryRecord = z.infer<typeof industryRecord>;
export const industryLots = z.array(
  z.object({
    id: z.uuid(),
    code: z.string(),
    item_id: z.uuid(),
    warehouse_id: z.uuid(),
    quantity: z.string(),
    expires_on: z.string().nullable(),
  }),
);
export const industryView = z.object({
  items: z.array(industryRecord),
  lots: industryLots,
  profile: z.string(),
  timezone: z.string(),
});
export const industryDetail = z.object({
  document: industryRecord,
  history: z.array(
    z.object({
      version,
      action: z.string(),
      note: z.string(),
      actor_id: z.uuid(),
      created_at: z.string(),
      data: z.record(z.string(), z.json()),
    }),
  ),
  lots: z.array(
    z.object({
      id: z.uuid(),
      code: z.string(),
      item_id: z.uuid(),
      warehouse_id: z.uuid(),
      quantity: z.string(),
      expires_on: z.string().nullable(),
    }),
  ),
});
