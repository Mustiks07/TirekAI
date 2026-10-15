import type { ZodType } from "zod";
import { AppError } from "../../domain/errors";
import type { Database } from "../db/database";
import { TaskService } from "../tasks/service";
import { KnowledgeService } from "../knowledge/service";
import { InsightService } from "../decisions/insights";
import { ProposalService } from "../decisions/proposals";
import { TodayService } from "../decisions/today";
import { AutomationService } from "../automations/service";
import { AssistantService } from "../assistant/service";
import { IntegrationService } from "../integrations/service";
import { Bitrix24Service } from "../integrations/bitrix24-service";
import { OneCService } from "../integrations/onec-service";
import {
  askResult,
  assistantStatus,
  conversationList,
  conversationView,
} from "../../domain/assistant";
import {
  ruleList,
  ruleDetail,
  testResult,
  executionList,
  automationTemplates,
  draftResult,
} from "../../domain/automations";
import {
  insightList,
  insightRow,
  proposalList,
  proposalDetail,
  policyView,
  todayView,
} from "../../domain/decisions";
import {
  knowledgeList,
  knowledgeDetail,
  knowledgeSearch,
} from "../../domain/knowledge";
import { commerceResult } from "../../domain/commerce";
import {
  taskList,
  taskDetail,
  templateList,
  scheduleView,
  workloadView,
} from "../../domain/tasks";
import { z } from "zod";

export type RouteContext = {
  db: Database;
  secret: string;
  org: string;
  body: unknown;
  query: Record<string, string>;
  params: string[];
};
type Handler = (c: RouteContext) => Promise<unknown>;
type Route = {
  method: "GET" | "POST" | "PATCH";
  path: string;
  schema?: ZodType;
  run: Handler;
};
function checked(schema: ZodType | undefined, data: unknown) {
  if (!schema) return data;
  const result = schema.safeParse(JSON.parse(JSON.stringify(data)));
  if (!result.success) throw new AppError("RESPONSE_CONTRACT_ERROR", 500);
  return result.data;
}
const ok = z.object({ ok: z.boolean() });
const tasks = (c: RouteContext) => new TaskService(c.db);
const knowledge = (c: RouteContext) => new KnowledgeService(c.db);
const insights = (c: RouteContext) => new InsightService(c.db);
const proposals = (c: RouteContext) => new ProposalService(c.db);
const automations = (c: RouteContext) => new AutomationService(c.db);
// Organization-scoped routes for T021–T030. Paths are relative to organizations/:id.
export const executionRoutes: Route[] = [
  {
    method: "GET",
    path: "tasks",
    schema: taskList,
    run: (c) => tasks(c).list(c.secret, c.org, c.query),
  },
  {
    method: "POST",
    path: "tasks",
    schema: commerceResult,
    run: (c) => tasks(c).create(c.secret, c.org, c.body),
  },
  {
    method: "GET",
    path: "tasks/assignees",
    schema: z.object({
      items: z.array(
        z.object({ id: z.uuid(), name: z.string(), role: z.string() }),
      ),
    }),
    run: (c) => tasks(c).assignees(c.secret, c.org, c.query),
  },
  {
    method: "GET",
    path: "tasks/templates",
    schema: templateList,
    run: (c) => tasks(c).templates(c.secret, c.org, c.query),
  },
  {
    method: "POST",
    path: "tasks/templates",
    schema: commerceResult,
    run: (c) => tasks(c).createTemplate(c.secret, c.org, c.body),
  },
  {
    method: "POST",
    path: "tasks/templates/:id/tasks",
    schema: commerceResult,
    run: (c) => tasks(c).fromTemplate(c.secret, c.org, c.params[0], c.body),
  },
  {
    method: "GET",
    path: "tasks/schedule",
    schema: scheduleView,
    run: (c) => tasks(c).schedule(c.secret, c.org),
  },
  {
    method: "POST",
    path: "tasks/schedule",
    schema: ok,
    run: (c) => tasks(c).saveSchedule(c.secret, c.org, c.body),
  },
  {
    method: "GET",
    path: "tasks/workload",
    schema: workloadView,
    run: (c) => tasks(c).workload(c.secret, c.org, c.query),
  },
  {
    method: "GET",
    path: "tasks/:id",
    schema: taskDetail,
    run: (c) => tasks(c).get(c.secret, c.org, c.params[0]),
  },
  {
    method: "POST",
    path: "tasks/:id/commands",
    schema: commerceResult,
    run: (c) => tasks(c).command(c.secret, c.org, c.params[0], c.body),
  },
  {
    method: "POST",
    path: "tasks/:id/comments",
    schema: commerceResult,
    run: (c) => tasks(c).comment(c.secret, c.org, c.params[0], c.body),
  },
  {
    method: "POST",
    path: "tasks/:id/attachments",
    schema: commerceResult,
    run: (c) => tasks(c).attach(c.secret, c.org, c.params[0], c.body),
  },
  {
    method: "GET",
    path: "tasks/:id/attachments/:id",
    schema: z.object({
      filename: z.string(),
      mime: z.string(),
      content: z.string(),
    }),
    run: (c) => tasks(c).attachment(c.secret, c.org, c.params[0], c.params[1]),
  },
  {
    method: "GET",
    path: "notifications",
    schema: z.object({
      items: z.array(
        z.object({
          id: z.uuid(),
          kind: z.string(),
          entity_type: z.string(),
          entity_id: z.uuid(),
          read_at: z.string().nullable(),
          created_at: z.string(),
        }),
      ),
    }),
    run: (c) => tasks(c).notifications(c.secret, c.org),
  },
  {
    method: "POST",
    path: "notifications/read",
    schema: ok,
    run: (c) => tasks(c).readNotifications(c.secret, c.org),
  },
  {
    method: "GET",
    path: "knowledge",
    schema: knowledgeList,
    run: (c) => knowledge(c).list(c.secret, c.org, c.query),
  },
  {
    method: "POST",
    path: "knowledge",
    schema: commerceResult,
    run: (c) => knowledge(c).create(c.secret, c.org, c.body),
  },
  {
    method: "POST",
    path: "knowledge/uploads",
    schema: commerceResult,
    run: (c) => knowledge(c).upload(c.secret, c.org, c.body),
  },
  {
    method: "GET",
    path: "knowledge/search",
    schema: knowledgeSearch,
    run: (c) => knowledge(c).search(c.secret, c.org, c.query),
  },
  {
    method: "GET",
    path: "knowledge/:id",
    schema: knowledgeDetail,
    run: (c) =>
      knowledge(c).get(
        c.secret,
        c.org,
        c.params[0],
        c.query.number
          ? z.coerce.number().int().positive().parse(c.query.number)
          : undefined,
      ),
  },
  {
    method: "GET",
    path: "knowledge/:id/original",
    schema: z.object({ filename: z.string(), content: z.string() }),
    run: (c) =>
      knowledge(c).original(
        c.secret,
        c.org,
        c.params[0],
        z.coerce.number().int().positive().parse(c.query.number),
      ),
  },
  {
    method: "POST",
    path: "knowledge/:id/versions",
    schema: commerceResult,
    run: (c) => knowledge(c).revise(c.secret, c.org, c.params[0], c.body),
  },
  {
    method: "POST",
    path: "knowledge/:id/publication",
    schema: commerceResult,
    run: (c) => knowledge(c).publish(c.secret, c.org, c.params[0], c.body),
  },
  {
    method: "GET",
    path: "today",
    schema: todayView,
    run: (c) => new TodayService(c.db).today(c.secret, c.org),
  },
  {
    method: "GET",
    path: "insights",
    schema: insightList,
    run: (c) => insights(c).list(c.secret, c.org, c.query),
  },
  {
    method: "POST",
    path: "insights/refresh",
    schema: z.object({
      opened: z.number(),
      resolved: z.number(),
      seen: z.number(),
    }),
    run: (c) => insights(c).refresh(c.secret, c.org),
  },
  {
    method: "GET",
    path: "insights/reorder-points",
    schema: z.object({
      items: z.array(
        z.object({
          warehouse_id: z.uuid(),
          warehouse_name: z.string(),
          item_id: z.uuid(),
          sku: z.string(),
          name_ru: z.string(),
          name_kk: z.string(),
          base_unit: z.string(),
          minimum: z.string(),
          safety: z.string(),
          lead_days: z.number(),
          version: z.number(),
        }),
      ),
    }),
    run: (c) => insights(c).reorderPoints(c.secret, c.org, c.query),
  },
  {
    method: "POST",
    path: "insights/reorder-points",
    schema: ok,
    run: (c) => insights(c).setReorderPoint(c.secret, c.org, c.body),
  },
  {
    method: "GET",
    path: "insights/:id",
    schema: insightRow,
    run: (c) => insights(c).get(c.secret, c.org, c.params[0]),
  },
  {
    method: "POST",
    path: "insights/:id/commands",
    schema: commerceResult,
    run: (c) => insights(c).command(c.secret, c.org, c.params[0], c.body),
  },
  {
    method: "POST",
    path: "insights/:id/proposal",
    schema: commerceResult,
    run: (c) => proposals(c).fromInsight(c.secret, c.org, c.params[0], c.body),
  },
  {
    method: "GET",
    path: "proposals",
    schema: proposalList,
    run: (c) => proposals(c).list(c.secret, c.org, c.query),
  },
  {
    method: "POST",
    path: "proposals",
    schema: commerceResult,
    run: (c) => proposals(c).create(c.secret, c.org, c.body),
  },
  {
    method: "GET",
    path: "proposals/policy",
    schema: policyView,
    run: (c) => proposals(c).policy(c.secret, c.org),
  },
  {
    method: "POST",
    path: "proposals/policy/limits",
    schema: ok,
    run: (c) => proposals(c).setLimit(c.secret, c.org, c.body),
  },
  {
    method: "POST",
    path: "proposals/policy/delegations",
    schema: commerceResult,
    run: (c) => proposals(c).delegate(c.secret, c.org, c.body),
  },
  {
    method: "POST",
    path: "proposals/policy/delegations/:id/revoke",
    schema: ok,
    run: (c) => proposals(c).revokeDelegation(c.secret, c.org, c.params[0]),
  },
  {
    method: "GET",
    path: "proposals/:id",
    schema: proposalDetail,
    run: (c) => proposals(c).get(c.secret, c.org, c.params[0]),
  },
  {
    method: "POST",
    path: "proposals/:id/commands",
    schema: commerceResult,
    run: (c) => proposals(c).command(c.secret, c.org, c.params[0], c.body),
  },
  {
    method: "POST",
    path: "proposals/:id/revisions",
    schema: commerceResult,
    run: (c) => proposals(c).revise(c.secret, c.org, c.params[0], c.body),
  },
  {
    method: "GET",
    path: "automations",
    schema: ruleList,
    run: (c) => automations(c).list(c.secret, c.org),
  },
  {
    method: "POST",
    path: "automations",
    schema: commerceResult,
    run: (c) => automations(c).create(c.secret, c.org, c.body),
  },
  {
    method: "GET",
    path: "automations/templates",
    run: async () => ({ items: automationTemplates }),
  },
  {
    method: "GET",
    path: "automations/executions",
    schema: executionList,
    run: (c) => automations(c).executions(c.secret, c.org, c.query),
  },
  {
    method: "POST",
    path: "automations/executions/:id/retry",
    schema: commerceResult,
    run: (c) => automations(c).retry(c.secret, c.org, c.params[0], c.body),
  },
  {
    method: "GET",
    path: "automations/:id",
    schema: ruleDetail,
    run: (c) => automations(c).get(c.secret, c.org, c.params[0]),
  },
  {
    method: "POST",
    path: "automations/:id/versions",
    schema: commerceResult,
    run: (c) => automations(c).revise(c.secret, c.org, c.params[0], c.body),
  },
  {
    method: "POST",
    path: "automations/:id/tests",
    schema: testResult,
    run: (c) => automations(c).test(c.secret, c.org, c.params[0], c.body),
  },
  {
    method: "POST",
    path: "automations/:id/commands",
    schema: commerceResult,
    run: (c) => automations(c).command(c.secret, c.org, c.params[0], c.body),
  },
  {
    method: "GET",
    path: "assistant",
    schema: assistantStatus,
    run: (c) => new AssistantService(c.db).status(c.secret, c.org),
  },
  {
    method: "POST",
    path: "assistant/settings",
    schema: ok,
    run: (c) =>
      new AssistantService(c.db).saveSettings(c.secret, c.org, c.body),
  },
  {
    method: "GET",
    path: "assistant/conversations",
    schema: conversationList,
    run: (c) => new AssistantService(c.db).conversations(c.secret, c.org),
  },
  {
    method: "GET",
    path: "assistant/conversations/:id",
    schema: conversationView,
    run: (c) =>
      new AssistantService(c.db).conversation(c.secret, c.org, c.params[0]),
  },
  {
    method: "POST",
    path: "assistant/messages",
    schema: askResult,
    run: (c) => new AssistantService(c.db).ask(c.secret, c.org, c.body),
  },
  {
    method: "POST",
    path: "automations/draft",
    schema: draftResult,
    run: (c) =>
      new AssistantService(c.db).draftAutomation(c.secret, c.org, c.body),
  },
  {
    method: "POST",
    path: "assistant/transcriptions",
    run: (c) => new AssistantService(c.db).transcribe(c.secret, c.org, c.body),
  },
  {
    method: "GET",
    path: "integrations",
    run: (c) => new IntegrationService(c.db).overview(c.secret, c.org),
  },
  {
    method: "POST",
    path: "integrations",
    schema: z.object({
      id: z.uuid(),
      reused: z.boolean(),
      webhookToken: z.string().nullable(),
    }),
    run: (c) => new IntegrationService(c.db).configure(c.secret, c.org, c.body),
  },
  {
    method: "POST",
    path: "integrations/conflicts/:id",
    schema: commerceResult,
    run: (c) =>
      new IntegrationService(c.db).resolve(
        c.secret,
        c.org,
        c.params[0],
        c.body,
      ),
  },
  {
    method: "POST",
    path: "integrations/:id/check",
    schema: ok,
    run: (c) =>
      new IntegrationService(c.db).check(c.secret, c.org, c.params[0]),
  },
  {
    method: "GET",
    path: "integrations/:id/stores",
    run: (c) =>
      new IntegrationService(c.db).stores(c.secret, c.org, c.params[0]),
  },
  {
    method: "POST",
    path: "integrations/:id/links",
    schema: ok,
    run: (c) =>
      new IntegrationService(c.db).link(c.secret, c.org, c.params[0], c.body),
  },
  {
    method: "POST",
    path: "integrations/:id/links/:id/remove",
    schema: ok,
    run: (c) =>
      new IntegrationService(c.db).unlink(
        c.secret,
        c.org,
        c.params[0],
        c.params[1],
      ),
  },
  {
    method: "POST",
    path: "integrations/:id/sync",
    run: (c) =>
      new IntegrationService(c.db).syncNow(c.secret, c.org, c.params[0]),
  },
  {
    method: "GET",
    path: "integrations/:id/parties",
    run: (c) =>
      new IntegrationService(c.db).parties(
        c.secret,
        c.org,
        c.params[0],
        c.query,
      ),
  },
  {
    method: "POST",
    path: "integrations/:id/supply",
    schema: commerceResult,
    run: (c) =>
      new IntegrationService(c.db).configureSupply(
        c.secret,
        c.org,
        c.params[0],
        c.body,
      ),
  },
  {
    method: "POST",
    path: "integrations/:id/counterparties",
    schema: commerceResult,
    run: (c) =>
      new IntegrationService(c.db).mapCounterparty(
        c.secret,
        c.org,
        c.params[0],
        c.body,
      ),
  },
  {
    method: "POST",
    path: "integrations/exports/:id/retry",
    schema: commerceResult,
    run: (c) =>
      new IntegrationService(c.db).retryExport(
        c.secret,
        c.org,
        c.params[0],
        c.body,
      ),
  },
  {
    method: "POST",
    path: "integrations/onec",
    schema: z.object({
      id: z.uuid(),
      reused: z.boolean(),
      webhookToken: z.string().nullable(),
    }),
    run: (c) => new OneCService(c.db).configure(c.secret, c.org, c.body),
  },
  {
    method: "POST",
    path: "integrations/onec/:id/check",
    schema: ok,
    run: (c) => new OneCService(c.db).check(c.secret, c.org, c.params[0]),
  },
  {
    method: "POST",
    path: "integrations/onec/:id/sync",
    run: (c) => new OneCService(c.db).syncNow(c.secret, c.org, c.params[0]),
  },
  {
    method: "POST",
    path: "integrations/onec/:id/disconnect",
    schema: ok,
    run: (c) => new OneCService(c.db).disconnect(c.secret, c.org, c.params[0]),
  },
  {
    method: "POST",
    path: "integrations/onec/conflicts/:id",
    schema: ok,
    run: (c) =>
      new OneCService(c.db).resolve(c.secret, c.org, c.params[0], c.body),
  },
  {
    method: "POST",
    path: "integrations/bitrix24",
    schema: z.object({
      id: z.uuid(),
      reused: z.boolean(),
      webhookToken: z.string().nullable(),
    }),
    run: (c) => new Bitrix24Service(c.db).configure(c.secret, c.org, c.body),
  },
  {
    method: "POST",
    path: "integrations/bitrix24/:id/check",
    schema: ok,
    run: (c) => new Bitrix24Service(c.db).check(c.secret, c.org, c.params[0]),
  },
  {
    method: "POST",
    path: "integrations/bitrix24/:id/sync",
    run: (c) => new Bitrix24Service(c.db).syncNow(c.secret, c.org, c.params[0]),
  },
  {
    method: "POST",
    path: "integrations/bitrix24/:id/disconnect",
    schema: ok,
    run: (c) =>
      new Bitrix24Service(c.db).disconnect(c.secret, c.org, c.params[0]),
  },
  {
    method: "POST",
    path: "integrations/bitrix24/conflicts/:id",
    schema: ok,
    run: (c) =>
      new Bitrix24Service(c.db).resolve(c.secret, c.org, c.params[0], c.body),
  },
  {
    method: "POST",
    path: "integrations/:id/disconnect",
    schema: ok,
    run: (c) =>
      new IntegrationService(c.db).disconnect(c.secret, c.org, c.params[0]),
  },
];
// Body size limits for routes that accept uploads (bytes, before base64 decoding checks).
export const uploadLimits: { method: string; path: string; limit: number }[] = [
  { method: "POST", path: "tasks/:id/attachments", limit: 2_900_000 },
];
function match(pattern: string, path: string[]) {
  const parts = pattern.split("/");
  if (parts.length !== path.length) return null;
  const params: string[] = [];
  for (let i = 0; i < parts.length; i++)
    if (parts[i] === ":id") params.push(path[i]);
    else if (parts[i] !== path[i]) return null;
  return params;
}
export function uploadLimit(method: string, rest: string[]) {
  return uploadLimits.find((u) => u.method === method && match(u.path, rest))
    ?.limit;
}
export async function dispatchExecution(
  method: string,
  rest: string[],
  context: Omit<RouteContext, "params">,
) {
  for (const route of executionRoutes) {
    if (route.method !== method) continue;
    const params = match(route.path, rest);
    if (!params) continue;
    return {
      matched: true as const,
      data: checked(route.schema, await route.run({ ...context, params })),
    };
  }
  return { matched: false as const };
}
