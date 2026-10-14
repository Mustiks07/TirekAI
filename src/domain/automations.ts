import { z } from "zod";
import { pageQuery, paginationSchema } from "./import-contracts";
import { taskKinds, taskPriorities, evidenceRules } from "./tasks";

export const automationTopics = [
  "insight.opened",
  "insight.resolved",
  "task.created",
  "task.assigned",
  "task.completed",
  "task.verified",
  "task.returned",
  "task.overdue",
  "task.escalated",
  "proposal.created",
  "proposal.approve",
  "proposal.reject",
  "proposal.execute",
  "knowledge.published",
  "schedule.tick",
] as const;
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const condition = z
  .object({
    field: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.]{0,60}$/),
    op: z.enum(["eq", "neq", "gte", "lte", "in", "exists"]),
    value: z.union([
      z.string().max(120),
      z.number(),
      z.boolean(),
      z.array(z.union([z.string().max(120), z.number()])).max(20),
      z.null(),
    ]),
  })
  .strict();
export const automationAction = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("create_task"),
      title: z.string().trim().min(3).max(160),
      description: z.string().trim().max(1000).default(""),
      kind: z.enum(taskKinds).default("general"),
      priority: z.enum(taskPriorities).default("normal"),
      assigneeId: z.uuid().nullable().default(null),
      deputyId: z.uuid().nullable().default(null),
      dueInHours: z.number().int().min(1).max(720).nullable().default(null),
      requiresVerification: z.boolean().default(false),
      evidence: z.enum(evidenceRules).default("comment"),
      checklist: z.array(z.string().trim().min(2).max(200)).max(20).default([]),
    })
    .strict(),
  // Only proposes: the purchase still needs a human approval of the exact parameters.
  z.object({ type: z.literal("propose_purchase") }).strict(),
  z.object({ type: z.literal("notify"), userId: z.uuid() }).strict(),
]);
export const automationDefinition = z
  .object({
    trigger: z.discriminatedUnion("type", [
      z
        .object({ type: z.literal("event"), topic: z.enum(automationTopics) })
        .strict(),
      z
        .object({
          type: z.literal("schedule"),
          recurrence: z.enum(["daily", "weekdays", "weekly"]),
          time,
          weekday: z.number().int().min(1).max(7).nullable().default(null),
        })
        .strict(),
    ]),
    conditions: z.array(condition).max(10).default([]),
    actions: z.array(automationAction).min(1).max(5),
    limits: z
      .object({
        maxPerHour: z.number().int().min(1).max(1000).default(20),
        maxDepth: z.number().int().min(1).max(5).default(2),
      })
      .strict()
      .default({ maxPerHour: 20, maxDepth: 2 }),
    workingHoursOnly: z.boolean().default(false),
  })
  .strict();
export type AutomationDefinition = z.infer<typeof automationDefinition>;
export const ruleInput = z
  .object({
    key: z.uuid(),
    branchId: z.uuid().nullable(),
    name: z.string().trim().min(3).max(120),
    definition: automationDefinition,
    note: z.string().trim().min(3).max(250),
  })
  .strict();
export const ruleRevision = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    definition: automationDefinition,
    note: z.string().trim().min(3).max(250),
  })
  .strict();
export const ruleCommand = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    kind: z.enum(["activate", "pause", "disable"]),
    note: z.string().trim().min(3).max(250),
  })
  .strict();
export const ruleTest = z
  .object({
    eventId: z.uuid().nullable().default(null),
    sample: z
      .object({
        topic: z.enum(automationTopics),
        payload: z.record(z.string(), z.unknown()),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict()
  .refine((t) => (t.eventId === null) !== (t.sample === null), {
    message: "Exactly one test event",
  });
export const executionCommand = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    kind: z.literal("retry"),
  })
  .strict();
export const automationQuery = pageQuery.extend({
  state: z
    .enum(["queued", "running", "succeeded", "skipped", "failed", "dead"])
    .optional(),
  ruleId: z.uuid().optional(),
});
export const ruleRow = z.object({
  id: z.uuid(),
  branch_id: z.uuid().nullable(),
  name: z.string(),
  state: z.enum(["draft", "active", "paused", "disabled"]),
  current_version: z.number(),
  tested_version: z.number().nullable(),
  paused_reason: z.string().nullable(),
  definition: automationDefinition,
  version: z.number(),
  created_by_name: z.string(),
  updated_at: z.string(),
});
export const ruleList = z.object({ items: z.array(ruleRow) });
export const testResult = z.object({
  id: z.uuid(),
  passed: z.boolean(),
  matched: z.boolean(),
  conditions: z.array(
    z.object({
      field: z.string(),
      op: z.string(),
      actual: z.unknown(),
      result: z.boolean(),
    }),
  ),
  actions: z.array(
    z.object({
      type: z.string(),
      effect: z.string(),
      data: z.record(z.string(), z.unknown()),
    }),
  ),
  warnings: z.array(z.string()),
});
export const ruleDetail = z.object({
  rule: ruleRow,
  versions: z.array(
    z.object({
      number: z.number(),
      note: z.string(),
      author_name: z.string(),
      created_at: z.string(),
    }),
  ),
  tests: z.array(
    z.object({
      id: z.uuid(),
      rule_version: z.number(),
      passed: z.boolean(),
      result: testResult.omit({ id: true }),
      created_at: z.string(),
    }),
  ),
});
export const executionRow = z.object({
  id: z.uuid(),
  rule_id: z.uuid(),
  rule_name: z.string(),
  rule_version: z.number(),
  event_id: z.uuid(),
  topic: z.string(),
  depth: z.number(),
  state: z.enum([
    "queued",
    "running",
    "succeeded",
    "skipped",
    "failed",
    "dead",
  ]),
  skip_reason: z.string().nullable(),
  attempts: z.number(),
  error_code: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
  version: z.number(),
});
export const executionList = z.object({
  items: z.array(executionRow),
  pagination: paginationSchema,
});
export const automationTemplates = [
  {
    id: "low_stock_task",
    definition: {
      trigger: { type: "event", topic: "insight.opened" },
      conditions: [{ field: "rule", op: "eq", value: "low_stock" }],
      actions: [
        {
          type: "create_task",
          title: "Проверить нехватку товара / Тауар тапшылығын тексеру",
          kind: "purchase",
          priority: "high",
          requiresVerification: true,
          evidence: "comment",
        },
      ],
    },
  },
  {
    id: "low_stock_proposal",
    definition: {
      trigger: { type: "event", topic: "insight.opened" },
      conditions: [{ field: "rule", op: "eq", value: "low_stock" }],
      actions: [{ type: "propose_purchase" }],
    },
  },
  {
    id: "daily_shift_check",
    definition: {
      trigger: { type: "schedule", recurrence: "weekdays", time: "09:00" },
      conditions: [],
      actions: [
        {
          type: "create_task",
          title: "Проверить открытие смены / Ауысымның ашылуын тексеру",
          kind: "shift_open",
          dueInHours: 2,
        },
      ],
      workingHoursOnly: true,
    },
  },
] as const;
