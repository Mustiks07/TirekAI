import { z } from "zod";

export const MAX_IMPORT_BYTES = 256 * 1024;
export const MAX_IMPORT_ROWS = 1000;
export const pageQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    branchId: z.uuid().optional(),
  })
  .strict();
export type PageQuery = z.infer<typeof pageQuery>;
export const uploadSchema = z
  .object({
    branchId: z.uuid(),
    filename: z
      .string()
      .trim()
      .min(1)
      .max(120)
      // Filenames must not contain path separators or control characters.
      // eslint-disable-next-line no-control-regex
      .regex(/^[^/\\\x00-\x1f]+\.(csv|tsv)$/i),
    content: z.string().min(1).max(MAX_IMPORT_BYTES),
    delimiter: z.enum([",", ";", "\t"]).default(","),
  })
  .strict();
export const versionSchema = z
  .object({ version: z.number().int().positive() })
  .strict();
export const customerFields = z
  .object({
    external_id: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[\p{L}\p{N}_.:-]+$/u),
    name: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .regex(/^[^\r\n\t]+$/),
    email: z.union([z.literal(""), z.email().max(254)]),
    phone: z.union([z.literal(""), z.string().regex(/^\+[1-9]\d{6,14}$/)]),
  })
  .strict();
export const customerUpdate = customerFields
  .omit({ external_id: true })
  .extend({ version: z.number().int().positive() })
  .refine((v) => Boolean(v.email || v.phone), { message: "CONTACT_REQUIRED" });
const isoDate = z.iso.datetime({ offset: true });
export const rowState = z.enum([
  "ready",
  "invalid",
  "duplicate",
  "conflict",
  "imported",
]);
export const importState = z.enum([
  "preview",
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
  "cancelled",
]);
export const importRowSchema = z.object({
  row_number: z.number().int().positive(),
  values: z.object({
    external_id: z.string(),
    name: z.string(),
    email: z.string(),
    phone: z.string(),
  }),
  status: rowState,
  errors: z.array(z.string()),
});
export const batchSchema = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  filename: z.string(),
  state: importState,
  version: z.number().int().positive(),
  created_at: isoDate,
  completed_at: isoDate.nullable(),
  total: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  conflict: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  error_code: z.string().nullable(),
});
export const paginationSchema = z.object({
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
});
export const batchViewSchema = z.object({
  batch: batchSchema,
  rows: z.array(importRowSchema),
  pagination: paginationSchema,
  workerAvailable: z.boolean(),
  reused: z.boolean().optional(),
});
export const batchesViewSchema = z.object({
  items: z.array(batchSchema),
  pagination: paginationSchema,
  workerAvailable: z.boolean(),
});
export const customerSchema = customerFields.extend({
  id: z.uuid(),
  branch_id: z.uuid(),
  version: z.number().int().positive(),
  created_at: isoDate,
  updated_at: isoDate,
  source_file: z.string().nullable(),
  source_row: z.number().int().positive().nullable(),
});
export const customersViewSchema = z.object({
  items: z.array(customerSchema),
  pagination: paginationSchema,
});
export type ImportRow = z.infer<typeof importRowSchema>;
export type ImportBatch = z.infer<typeof batchSchema>;
export type BatchView = z.infer<typeof batchViewSchema>;
export type BatchesView = z.infer<typeof batchesViewSchema>;
export type Customer = z.infer<typeof customerSchema>;
export type CustomersView = z.infer<typeof customersViewSchema>;

export function pagination(page: number, limit: number, total: number) {
  return { page, limit, total, pages: Math.ceil(total / limit) };
}

// Zod is the source of truth for both runtime validation and generated contracts.
export function importApiContract() {
  const entries = {
    Upload: uploadSchema,
    Confirm: versionSchema,
    CustomerUpdate: customerUpdate,
    BatchView: batchViewSchema,
    BatchesView: batchesViewSchema,
    CustomersView: customersViewSchema,
  };
  return {
    version: "1.1",
    schemas: Object.fromEntries(
      Object.entries(entries).map(([name, schema]) => [
        name,
        z.toJSONSchema(schema),
      ]),
    ),
  };
}
