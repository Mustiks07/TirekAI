import { z } from "zod";
import { pageQuery, paginationSchema } from "./import-contracts";

export const taskKinds = [
  "general",
  "shift_open",
  "shift_close",
  "receiving",
  "return",
  "purchase",
  "verification",
] as const;
export const taskStates = [
  "new",
  "assigned",
  "in_progress",
  "blocked",
  "done",
  "verified",
  "cancelled",
] as const;
export const taskPriorities = ["low", "normal", "high", "urgent"] as const;
export const evidenceRules = ["none", "comment", "photo", "operation"] as const;
export const linkTypes = [
  "purchase_order",
  "purchase_document",
  "sales_order",
  "item",
  "customer",
  "insight",
  "proposal",
  "knowledge",
] as const;
export const entityLink = z
  .object({ type: z.enum(linkTypes), id: z.uuid() })
  .strict();
export type EntityLink = z.infer<typeof entityLink>;
const note = z.string().trim().min(3).max(500);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const dueInput = z
  .object({ date: z.iso.date(), time })
  .strict()
  .nullable();
export const taskInput = z
  .object({
    key: z.uuid(),
    branchId: z.uuid(),
    title: z.string().trim().min(3).max(160),
    description: z.string().trim().max(2000).default(""),
    kind: z.enum(taskKinds).default("general"),
    priority: z.enum(taskPriorities).default("normal"),
    assigneeId: z.uuid().nullable().default(null),
    deputyId: z.uuid().nullable().default(null),
    due: dueInput.default(null),
    requiresVerification: z.boolean().default(false),
    evidence: z.enum(evidenceRules).default("comment"),
    checklist: z.array(z.string().trim().min(2).max(200)).max(30).default([]),
    links: z.array(entityLink).max(10).default([]),
  })
  .strict();
export type TaskInput = z.infer<typeof taskInput>;
const versioned = { key: z.uuid(), version: z.number().int().positive() };
export const taskCommand = z.discriminatedUnion("kind", [
  z
    .object({
      ...versioned,
      kind: z.literal("assign"),
      assigneeId: z.uuid(),
      deputyId: z.uuid().nullable().default(null),
      note,
    })
    .strict(),
  z
    .object({ ...versioned, kind: z.literal("start"), note: note.optional() })
    .strict(),
  z.object({ ...versioned, kind: z.literal("block"), note }).strict(),
  z.object({ ...versioned, kind: z.literal("unblock"), note }).strict(),
  z
    .object({
      ...versioned,
      kind: z.literal("check"),
      position: z.number().int().min(0).max(29),
      done: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...versioned,
      kind: z.literal("complete"),
      note,
      operation: entityLink.nullable().default(null),
    })
    .strict(),
  z.object({ ...versioned, kind: z.literal("verify"), note }).strict(),
  z.object({ ...versioned, kind: z.literal("return"), note }).strict(),
  z.object({ ...versioned, kind: z.literal("cancel"), note }).strict(),
]);
export type TaskCommand = z.infer<typeof taskCommand>;
export const taskComment = z
  .object({ key: z.uuid(), body: z.string().trim().min(1).max(2000) })
  .strict();
export const taskAttachment = z
  .object({
    key: z.uuid(),
    filename: z
      .string()
      .min(1)
      .max(160)
      .refine(
        (v) => !/[\\/]/.test(v) && [...v].every((c) => c.charCodeAt(0) >= 32),
      ),
    content: z.string().min(1).max(2_800_000),
  })
  .strict();
export const templateInput = z
  .object({
    key: z.uuid(),
    branchId: z.uuid(),
    name: z.string().trim().min(3).max(120),
    kind: z.enum(taskKinds),
    checklist: z.array(z.string().trim().min(2).max(200)).max(30),
    requiresVerification: z.boolean(),
    evidence: z.enum(evidenceRules),
    priority: z.enum(taskPriorities),
    assigneeId: z.uuid().nullable(),
    deputyId: z.uuid().nullable(),
    recurrence: z.enum(["none", "daily", "weekdays", "weekly"]),
    dueTime: time,
    weekday: z.number().int().min(1).max(7).nullable(),
  })
  .strict()
  .refine((t) => t.recurrence !== "weekly" || t.weekday !== null, {
    message: "Weekly templates need a weekday",
  });
export const scheduleInput = z
  .object({
    version: z.number().int().min(0),
    startTime: time,
    endTime: time,
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    escalateAfterMinutes: z.number().int().min(0).max(10080),
  })
  .strict()
  .refine((s) => s.startTime < s.endTime, { message: "Working hours" });
export const taskQuery = pageQuery.extend({
  state: z.enum([...taskStates, "open", "overdue"]).optional(),
  scope: z.enum(["mine", "all"]).default("all"),
  q: z.string().trim().max(80).default(""),
});
export const taskRow = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  number: z.number(),
  title: z.string(),
  description: z.string(),
  kind: z.enum(taskKinds),
  source: z.string(),
  source_id: z.uuid().nullable(),
  priority: z.enum(taskPriorities),
  state: z.enum(taskStates),
  assignee_id: z.uuid().nullable(),
  assignee_name: z.string().nullable(),
  deputy_id: z.uuid().nullable(),
  deputy_name: z.string().nullable(),
  due_at: z.string().nullable(),
  overdue: z.boolean(),
  requires_verification: z.boolean(),
  evidence: z.enum(evidenceRules),
  links: z.array(entityLink),
  blocked_reason: z.string().nullable(),
  completion: z
    .object({
      note: z.string(),
      operation: entityLink.nullable(),
      attachments: z.array(z.uuid()),
      operation_state: z.string().nullable(),
    })
    .nullable(),
  escalated_at: z.string().nullable(),
  completed_by_name: z.string().nullable(),
  completed_at: z.string().nullable(),
  verified_by_name: z.string().nullable(),
  verified_at: z.string().nullable(),
  created_by_name: z.string(),
  version: z.number(),
  created_at: z.string(),
});
export type TaskRow = z.infer<typeof taskRow>;
export const taskList = z.object({
  items: z.array(taskRow),
  pagination: paginationSchema,
});
export const taskDetail = z.object({
  task: taskRow,
  checklist: z.array(
    z.object({
      position: z.number(),
      text: z.string(),
      done_at: z.string().nullable(),
      done_by_name: z.string().nullable(),
    }),
  ),
  comments: z.array(
    z.object({
      id: z.uuid(),
      body: z.string(),
      actor_name: z.string(),
      created_at: z.string(),
    }),
  ),
  attachments: z.array(
    z.object({
      id: z.uuid(),
      filename: z.string(),
      mime: z.string(),
      actor_name: z.string(),
      created_at: z.string(),
    }),
  ),
  events: z.array(
    z.object({
      id: z.uuid(),
      kind: z.string(),
      from_state: z.string().nullable(),
      to_state: z.string().nullable(),
      note: z.string(),
      actor_name: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
  permissions: z.object({
    act: z.boolean(),
    manage: z.boolean(),
    verify: z.boolean(),
  }),
});
export type TaskDetail = z.infer<typeof taskDetail>;
export const templateList = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      branch_id: z.uuid(),
      name: z.string(),
      kind: z.enum(taskKinds),
      checklist: z.array(z.string()),
      requires_verification: z.boolean(),
      evidence: z.enum(evidenceRules),
      priority: z.enum(taskPriorities),
      assignee_id: z.uuid().nullable(),
      deputy_id: z.uuid().nullable(),
      recurrence: z.enum(["none", "daily", "weekdays", "weekly"]),
      due_time: z.string(),
      weekday: z.number().nullable(),
      active: z.boolean(),
      version: z.number(),
    }),
  ),
});
export const scheduleView = z.object({
  version: z.number(),
  start_time: z.string(),
  end_time: z.string(),
  days: z.array(z.number()),
  escalate_after_minutes: z.number(),
  configured: z.boolean(),
});
export const workloadView = z.object({
  items: z.array(
    z.object({
      user_id: z.uuid(),
      name: z.string(),
      open: z.number(),
      overdue: z.number(),
      done_30d: z.number(),
      verified_30d: z.number(),
      returned_30d: z.number(),
    }),
  ),
  note: z.string(),
});
