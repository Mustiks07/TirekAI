import { z } from "zod";
import { amount } from "./commerce";
import { pageQuery, paginationSchema } from "./import-contracts";
import { purchaseInput } from "./purchasing";
import { taskInput, taskRow } from "./tasks";

const minor = z.string().regex(/^-?\d+$/);
const note = z.string().trim().min(3).max(500);
export const insightRules = [
  "low_stock",
  "overdue_receivable",
  "overdue_payable",
  "purchase_pending",
  "document_review",
  "overdue_task",
  "below_cost_sale",
  "unknown_cost",
  "missing_sale_price",
] as const;
export const reorderInput = z
  .object({
    warehouseId: z.uuid(),
    itemId: z.uuid(),
    minimum: amount,
    safety: amount,
    leadDays: z.number().int().min(0).max(365),
    version: z.number().int().min(0),
  })
  .strict();
export const insightQuery = pageQuery.extend({
  state: z
    .enum(["open", "acknowledged", "resolved", "dismissed", "active"])
    .default("active"),
  rule: z.enum(insightRules).optional(),
});
export const insightCommand = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    kind: z.enum(["acknowledge", "dismiss"]),
    note,
  })
  .strict();
export const evidenceSource = z.object({
  type: z.string(),
  id: z.uuid().nullable(),
  label: z.string(),
});
export const insightRow = z.object({
  id: z.uuid(),
  branch_id: z.uuid().nullable(),
  rule: z.enum(insightRules),
  entity_type: z.string(),
  entity_id: z.uuid(),
  severity: z.number(),
  state: z.enum(["open", "acknowledged", "resolved", "dismissed"]),
  evidence: z.object({
    title: z.string(),
    facts: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
    calculation: z.string(),
    sources: z.array(evidenceSource),
    as_of: z.string(),
    suggestion: z.string().nullable(),
  }),
  resolution: z.record(z.string(), z.unknown()).nullable(),
  detected_at: z.string(),
  last_seen_at: z.string(),
  resolved_at: z.string().nullable(),
  version: z.number(),
});
export type InsightRow = z.infer<typeof insightRow>;
export const insightList = z.object({
  items: z.array(insightRow),
  pagination: paginationSchema,
  last_run: z.string().nullable(),
});
export const purchaseProposalParams = purchaseInput.omit({ key: true }).extend({
  followUp: z
    .object({
      assigneeId: z.uuid(),
      due: z
        .object({
          date: z.iso.date(),
          time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        })
        .strict(),
    })
    .strict()
    .nullable()
    .default(null),
});
export const taskProposalParams = taskInput.omit({ key: true });
export const proposalInput = z.discriminatedUnion("kind", [
  z
    .object({
      key: z.uuid(),
      kind: z.literal("purchase_order"),
      insightId: z.uuid().nullable().default(null),
      params: purchaseProposalParams,
      submit: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      key: z.uuid(),
      kind: z.literal("task"),
      insightId: z.uuid().nullable().default(null),
      params: taskProposalParams,
      submit: z.boolean().default(true),
    })
    .strict(),
]);
export type ProposalInput = z.infer<typeof proposalInput>;
export const proposalRevision = z
  .object({
    key: z.uuid(),
    version: z.number().int().positive(),
    params: z.record(z.string(), z.unknown()),
    note,
  })
  .strict();
export const proposalCommand = z.discriminatedUnion("kind", [
  z
    .object({
      key: z.uuid(),
      version: z.number().int().positive(),
      kind: z.literal("submit"),
    })
    .strict(),
  z
    .object({
      key: z.uuid(),
      version: z.number().int().positive(),
      kind: z.enum(["approve", "reject"]),
      paramVersion: z.number().int().positive(),
      note,
    })
    .strict(),
  z
    .object({
      key: z.uuid(),
      version: z.number().int().positive(),
      kind: z.literal("execute"),
    })
    .strict(),
  z
    .object({
      key: z.uuid(),
      version: z.number().int().positive(),
      kind: z.literal("cancel"),
      note,
    })
    .strict(),
]);
export const proposalQuery = pageQuery.extend({
  state: z
    .enum([
      "draft",
      "pending",
      "approved",
      "rejected",
      "expired",
      "cancelled",
      "executed",
      "failed",
      "awaiting_me",
    ])
    .optional(),
  insightId: z.uuid().optional(),
});
export const proposalRow = z.object({
  id: z.uuid(),
  branch_id: z.uuid(),
  insight_id: z.uuid().nullable(),
  kind: z.enum(["purchase_order", "task"]),
  params: z.record(z.string(), z.unknown()),
  param_version: z.number(),
  amount_minor: minor.nullable(),
  risk: z.enum(["low", "medium", "high"]),
  requires_approval: z.boolean(),
  state: z.enum([
    "draft",
    "pending",
    "approved",
    "rejected",
    "expired",
    "cancelled",
    "executed",
    "failed",
  ]),
  origin: z.enum(["user", "situation", "assistant", "automation"]),
  explanation: z.record(z.string(), z.unknown()),
  created_by: z.uuid(),
  created_by_name: z.string(),
  executed_at: z.string().nullable(),
  result_type: z.string().nullable(),
  result_id: z.uuid().nullable(),
  follow_up_task_id: z.uuid().nullable(),
  error_code: z.string().nullable(),
  outcome: z.record(z.string(), z.unknown()).nullable(),
  expires_at: z.string(),
  version: z.number(),
  created_at: z.string(),
});
export const proposalList = z.object({
  items: z.array(proposalRow),
  pagination: paginationSchema,
});
export const proposalDetail = z.object({
  proposal: proposalRow,
  approvals: z.array(
    z.object({
      id: z.uuid(),
      param_version: z.number(),
      decision: z.enum(["approved", "rejected"]),
      actor_name: z.string(),
      delegated: z.boolean(),
      note: z.string(),
      created_at: z.string(),
    }),
  ),
  canApprove: z.boolean(),
  canExecute: z.boolean(),
});
export const limitInput = z
  .object({
    role: z.enum(["manager", "purchasing", "finance", "sales"]),
    kind: z.enum(["purchase_order", "task"]),
    limit: z
      .string()
      .regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/)
      .nullable(),
  })
  .strict();
export const delegationInput = z
  .object({
    key: z.uuid(),
    toUser: z.uuid(),
    kind: z.enum(["purchase_order", "task"]),
    maxAmount: z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/),
    validUntil: z.iso.datetime({ offset: true }),
  })
  .strict();
export const policyView = z.object({
  limits: z.array(
    z.object({ role: z.string(), kind: z.string(), limit_minor: minor }),
  ),
  delegations: z.array(
    z.object({
      id: z.uuid(),
      from_name: z.string(),
      to_name: z.string(),
      kind: z.string(),
      max_amount_minor: minor,
      valid_until: z.string(),
      revoked_at: z.string().nullable(),
    }),
  ),
});
export const todayView = z.object({
  as_of: z.string(),
  last_detection: z.string().nullable(),
  situations: z.array(insightRow),
  situations_total: z.number(),
  tasks: z.array(taskRow),
  approvals: z.array(proposalRow),
  metrics: z
    .object({
      cash_minor: minor,
      receivable_minor: minor,
      payable_minor: minor,
      expenses_complete: z.boolean(),
      unknown_cost_events: z.number(),
    })
    .nullable(),
  sources: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      checked_at: z.string().nullable(),
    }),
  ),
});
export type TodayView = z.infer<typeof todayView>;
export type ProposalRow = z.infer<typeof proposalRow>;
