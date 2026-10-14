import { z } from "zod";
import { roles } from "./contracts";
import { pageQuery, paginationSchema } from "./import-contracts";

const title = z.string().trim().min(3).max(160);
const body = z.string().trim().min(1).max(100_000);
const changeNote = z.string().trim().min(3).max(250);
export const knowledgeInput = z
  .object({
    key: z.uuid(),
    branchId: z.uuid().nullable(),
    title,
    category: z.string().trim().min(2).max(60),
    audience: z.array(z.enum(roles)).max(7).default([]),
    body,
    reviewDue: z.iso.date().nullable().default(null),
    changeNote,
  })
  .strict();
export const knowledgeUpload = z
  .object({
    key: z.uuid(),
    branchId: z.uuid().nullable(),
    title,
    category: z.string().trim().min(2).max(60),
    audience: z.array(z.enum(roles)).max(7).default([]),
    reviewDue: z.iso.date().nullable().default(null),
    changeNote,
    filename: z
      .string()
      .min(1)
      .max(160)
      .refine(
        (v) => !/[\\/]/.test(v) && [...v].every((c) => c.charCodeAt(0) >= 32),
      ),
    content: z.string().min(1).max(4_000_000),
  })
  .strict();
export const knowledgeRevision = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    title,
    body,
    changeNote,
    reviewDue: z.iso.date().nullable(),
  })
  .strict();
export const knowledgePublish = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    number: z.number().int().positive(),
    action: z.enum(["publish", "archive"]).default("publish"),
  })
  .strict();
export const knowledgeQuery = pageQuery.extend({
  q: z.string().trim().max(120).default(""),
  state: z.enum(["draft", "published", "archived"]).optional(),
});
export const knowledgeRow = z.object({
  id: z.uuid(),
  branch_id: z.uuid().nullable(),
  title: z.string(),
  category: z.string(),
  audience: z.array(z.enum(roles)),
  state: z.enum(["draft", "published", "archived"]),
  latest_version: z.number(),
  published_version: z.number().nullable(),
  review_due: z.string().nullable(),
  stale: z.boolean(),
  version: z.number(),
  updated_at: z.string(),
});
export const knowledgeList = z.object({
  items: z.array(knowledgeRow),
  pagination: paginationSchema,
});
export const knowledgeVersion = z.object({
  id: z.uuid(),
  number: z.number(),
  title: z.string(),
  body: z.string(),
  filename: z.string().nullable(),
  change_note: z.string(),
  author_name: z.string(),
  created_at: z.string(),
  published_at: z.string().nullable(),
});
export const knowledgeDetail = z.object({
  document: knowledgeRow,
  current: knowledgeVersion.nullable(),
  versions: z.array(knowledgeVersion.omit({ body: true })),
  canEdit: z.boolean(),
});
export const knowledgeHit = z.object({
  document_id: z.uuid(),
  version: z.number(),
  title: z.string(),
  category: z.string(),
  excerpt: z.string(),
  stale: z.boolean(),
  review_due: z.string().nullable(),
  published_at: z.string(),
});
export const knowledgeSearch = z.object({
  query: z.string(),
  items: z.array(knowledgeHit),
});
export type KnowledgeHit = z.infer<typeof knowledgeHit>;
export type KnowledgeDetail = z.infer<typeof knowledgeDetail>;
