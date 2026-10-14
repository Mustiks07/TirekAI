import { z } from "zod";
import { orderInput } from "./commerce";
import { paginationSchema, pageQuery } from "./import-contracts";
const note = z.string().trim().min(3).max(250),
  label = z.string().trim().min(2).max(120);
export const customerInput = z
  .object({
    key: z.uuid(),
    branchId: z.uuid(),
    name: label,
    email: z.union([z.literal(""), z.email()]),
    phone: z.string().trim().max(50),
    kind: z.enum(["person", "company"]),
    responsibleId: z.uuid().nullable(),
    consents: z
      .object({ email: z.boolean(), sms: z.boolean(), messenger: z.boolean() })
      .strict(),
    consentNote: note,
  })
  .strict();
export const customerProfile = customerInput
  .omit({ key: true, branchId: true })
  .extend({ version: z.number().int().positive() })
  .strict();
export const pipelineInput = z
  .object({
    version: z.number().int().nonnegative(),
    stages: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/),
            name_ru: label,
            name_kk: label,
            terminal: z.enum(["won", "lost"]).nullable(),
          })
          .strict(),
      )
      .min(3)
      .max(12),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.stages.map((s) => s.id)).size === v.stages.length &&
      v.stages.some((s) => s.terminal === "won") &&
      v.stages.some((s) => s.terminal === "lost") &&
      v.stages[0].terminal === null,
  );
export const defaultStages = [
  { id: "new", name_ru: "Новое", name_kk: "Жаңа", terminal: null },
  { id: "progress", name_ru: "В работе", name_kk: "Жұмыста", terminal: null },
  { id: "proposal", name_ru: "Предложение", name_kk: "Ұсыныс", terminal: null },
  {
    id: "agreed",
    name_ru: "Согласовано",
    name_kk: "Келісілді",
    terminal: null,
  },
  { id: "won", name_ru: "Успешно", name_kk: "Сәтті", terminal: "won" },
  { id: "lost", name_ru: "Отказ", name_kk: "Бас тарту", terminal: "lost" },
] satisfies z.infer<typeof pipelineInput>["stages"];
export const inquiryInput = z
  .object({
    key: z.uuid(),
    branchId: z.uuid(),
    customerId: z.uuid(),
    source: z.enum(["manual", "import", "test_incoming"]),
    externalId: z.string().trim().max(120),
    title: label,
    message: z.string().trim().max(4000),
    responsibleId: z.uuid().nullable(),
  })
  .strict()
  .refine((c) => c.source === "manual" || c.externalId.length > 0);
export const inquiryCommand = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    stageId: z.string().min(1).max(31),
    note,
  })
  .strict();
export const quoteInput = z
  .object({
    key: z.uuid(),
    inquiryId: z.uuid(),
    validUntil: z.iso.date(),
    terms: z.string().trim().min(3).max(2000),
    lines: orderInput.shape.lines,
    note,
  })
  .strict();
export const quoteUpdate = quoteInput
  .omit({ inquiryId: true })
  .extend({ version: z.number().int().positive() })
  .strict();
export const quoteConvert = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    warehouseId: z.uuid(),
    dueDate: z.iso.date(),
    delivery: z.enum(["pickup", "delivery"]),
    note,
  })
  .strict();
export const crmQuery = pageQuery.extend({
  q: z.string().trim().max(80).default(""),
});
export const customerRow = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  kind: z.string(),
  responsible_id: z.uuid().nullable(),
  consents: customerInput.shape.consents,
  version: z.number(),
  created_at: z.string(),
});
export const crmCustomers = z.object({
  items: z.array(customerRow),
  pagination: paginationSchema,
});
export const inquiryRow = z.object({
  id: z.uuid(),
  customer_id: z.uuid(),
  customer_name: z.string(),
  branch_id: z.uuid(),
  source: z.string(),
  external_id: z.string(),
  title: z.string(),
  message: z.string(),
  responsible_id: z.uuid().nullable(),
  stage_id: z.string(),
  version: z.number(),
  created_at: z.string(),
});
export const inquiriesView = z.object({
  items: z.array(inquiryRow),
  pagination: paginationSchema,
});
export const quoteLine = orderInput.shape.lines.element.extend({
  name_ru: z.string(),
  name_kk: z.string(),
  sku: z.string(),
  total_minor: z.string(),
});
export const quoteData = z.object({
  validUntil: z.iso.date(),
  terms: z.string(),
  lines: z.array(quoteLine),
  total_minor: z.string(),
});
export const quoteRow = z.object({
  id: z.uuid(),
  inquiry_id: z.uuid(),
  customer_id: z.uuid(),
  customer_name: z.string(),
  branch_id: z.uuid(),
  number: z.number(),
  version: z.number(),
  data: quoteData,
  order_id: z.uuid().nullable(),
  created_at: z.string(),
});
export const quotesView = z.object({
  items: z.array(quoteRow),
  pagination: paginationSchema,
});
export const crmHistory = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      kind: z.string(),
      note: z.string(),
      created_at: z.string(),
      actor_name: z.string(),
      data: z.record(z.string(), z.unknown()),
    }),
  ),
  pagination: paginationSchema,
});
export type Quote = z.infer<typeof quoteRow>;
