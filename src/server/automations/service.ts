import { randomUUID } from "node:crypto";
import type { Database, Sql } from "../db/database";
import {
  sessionAccess,
  actorAccess,
  audit,
  InternalActor,
  type Credential,
} from "../access";
import { AppError } from "../../domain/errors";
import { idSchema } from "../../domain/contracts";
import { pagination } from "../../domain/import-contracts";
import {
  automationDefinition,
  ruleInput,
  ruleRevision,
  ruleCommand,
  ruleTest,
  executionCommand,
  automationQuery,
  type AutomationDefinition,
} from "../../domain/automations";
import {
  idempotent,
  emit,
  notify,
  organizationClock,
  type Chain,
} from "../execution/core";
import { TaskService, stableUuid } from "../tasks/service";
import { ProposalService } from "../decisions/proposals";

type Event = {
  id: string;
  organization_id: string;
  branch_id: string | null;
  topic: string;
  entity_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  origin_chain_id: string;
  depth: number;
};
type Rule = {
  id: string;
  organization_id: string;
  branch_id: string | null;
  name: string;
  state: string;
  current_version: number;
  tested_version: number | null;
  created_by: string;
  version: number;
  definition: AutomationDefinition;
};
const ruleColumns =
  "r.id,r.organization_id,r.branch_id,r.name,r.state,r.current_version,r.tested_version,r.paused_reason,r.version,r.created_by,r.updated_at,v.definition";
const ruleJoin =
  "automation_rules r JOIN automation_rule_versions v ON v.organization_id=r.organization_id AND v.rule_id=r.id AND v.number=r.current_version";
const MAX_CHAIN_EXECUTIONS = 10;
function read(payload: Record<string, unknown>, path: string) {
  return path
    .split(".")
    .reduce<unknown>(
      (v, k) =>
        v && typeof v === "object"
          ? (v as Record<string, unknown>)[k]
          : undefined,
      payload,
    );
}
export function evaluate(
  def: AutomationDefinition,
  event: { topic: string; payload: Record<string, unknown> },
) {
  const matched =
    def.trigger.type === "event"
      ? def.trigger.topic === event.topic
      : event.topic === "schedule.tick";
  const conditions = def.conditions.map((c) => {
    const actual = read(event.payload, c.field);
    const num = (v: unknown) => (typeof v === "number" ? v : Number(v));
    const result =
      c.op === "exists"
        ? actual !== undefined && actual !== null
        : c.op === "eq"
          ? actual === c.value
          : c.op === "neq"
            ? actual !== c.value
            : c.op === "in"
              ? Array.isArray(c.value) && c.value.includes(actual as never)
              : typeof c.value === "number" &&
                actual !== undefined &&
                actual !== null &&
                !Number.isNaN(num(actual)) &&
                (c.op === "gte"
                  ? num(actual) >= c.value
                  : num(actual) <= c.value);
    return { field: c.field, op: c.op, actual: actual ?? null, result };
  });
  return {
    matched,
    conditions,
    pass: matched && conditions.every((c) => c.result),
  };
}
export class AutomationService {
  constructor(private db: Database) {}
  private async rule(
    tx: Sql,
    org: string,
    id: string,
    branch: string | null,
    lock = false,
  ) {
    idSchema.parse(id);
    const [r] = await tx.query<
      Rule & { paused_reason: string | null; updated_at: string }
    >(
      `SELECT ${ruleColumns} FROM ${ruleJoin} WHERE r.organization_id=$1 AND r.id=$2 AND ($3::uuid IS NULL OR r.branch_id=$3) ${lock ? "FOR UPDATE OF r" : ""}`,
      [org, id, branch],
    );
    if (!r) throw new AppError("NOT_FOUND", 404);
    return r;
  }
  // Actions reference people and data; validate them against the organization now, not at run time only.
  private async validate(
    tx: Sql,
    org: string,
    branch: string | null,
    def: AutomationDefinition,
  ) {
    for (const a of def.actions) {
      const users =
        a.type === "create_task"
          ? [a.assigneeId, a.deputyId]
          : a.type === "notify"
            ? [a.userId]
            : [];
      for (const u of users)
        if (u) {
          const [m] = await tx.query<{ branch_id: string | null }>(
            "SELECT branch_id FROM memberships WHERE organization_id=$1 AND user_id=$2",
            [org, u],
          );
          if (!m || (branch && m.branch_id && m.branch_id !== branch))
            throw new AppError("ASSIGNEE_SCOPE", 422);
        }
      if (a.type === "create_task" && !branch)
        throw new AppError("RULE_BRANCH_REQUIRED", 422);
      if (
        a.type === "propose_purchase" &&
        !(
          def.trigger.type === "event" && def.trigger.topic === "insight.opened"
        )
      )
        throw new AppError("ACTION_TRIGGER_MISMATCH", 422);
    }
  }
  async create(secret: Credential, org: string, input: unknown) {
    const c = ruleInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        "automations:write",
        c.branchId || undefined,
      );
      if (!c.branchId && s.branchId) throw new AppError("FORBIDDEN", 403);
      const r = await idempotent(tx, org, c.key, {
        operation: "automation.create",
        ...c,
      });
      if (r.reused) return r;
      await this.validate(tx, org, c.branchId, c.definition);
      const added = await tx.query(
        "INSERT INTO automation_rules(id,organization_id,branch_id,name,state,current_version,created_by) VALUES($1,$2,$3,$4,'draft',1,$5) ON CONFLICT DO NOTHING RETURNING id",
        [r.id, org, c.branchId, c.name, s.actorId],
      );
      if (!added.length) throw new AppError("RULE_EXISTS", 409);
      await tx.query(
        "INSERT INTO automation_rule_versions(id,organization_id,rule_id,number,definition,note,author_id) VALUES($1,$2,$3,1,$4,$5,$6)",
        [
          randomUUID(),
          org,
          r.id,
          JSON.stringify(c.definition),
          c.note,
          s.actorId,
        ],
      );
      await audit(tx, org, s.actorId, "automation.created", c.branchId, {
        ruleId: r.id,
      });
      return r;
    });
  }
  async revise(secret: Credential, org: string, id: string, input: unknown) {
    const c = ruleRevision.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "automations:write");
      const rule = await this.rule(tx, org, id, s.branchId, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "automation.revise",
        id,
        ...c,
      });
      if (r.reused) return r;
      if (rule.version !== c.version)
        throw new AppError("VERSION_CONFLICT", 409);
      if (rule.state === "disabled") throw new AppError("RULE_STATE", 409);
      await this.validate(tx, org, rule.branch_id, c.definition);
      await tx.query(
        "INSERT INTO automation_rule_versions(id,organization_id,rule_id,number,definition,note,author_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          randomUUID(),
          org,
          id,
          rule.current_version + 1,
          JSON.stringify(c.definition),
          c.note,
          s.actorId,
        ],
      );
      // A changed rule must be tested again before it can run.
      await tx.query(
        "UPDATE automation_rules SET current_version=current_version+1,state=CASE WHEN state='active' THEN 'paused' ELSE state END,paused_reason=CASE WHEN state='active' THEN 'revised_needs_test' ELSE paused_reason END,version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2",
        [org, id],
      );
      await audit(tx, org, s.actorId, "automation.revised", rule.branch_id, {
        ruleId: id,
      });
      return r;
    });
  }
  async command(secret: Credential, org: string, id: string, input: unknown) {
    const c = ruleCommand.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "automations:write");
      const rule = await this.rule(tx, org, id, s.branchId, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "automation.command",
        id,
        ...c,
      });
      if (r.reused) return r;
      if (rule.version !== c.version)
        throw new AppError("VERSION_CONFLICT", 409);
      if (rule.state === "disabled") throw new AppError("RULE_STATE", 409);
      if (c.kind === "activate" && rule.tested_version !== rule.current_version)
        throw new AppError("RULE_NOT_TESTED", 409);
      const state = {
        activate: "active",
        pause: "paused",
        disable: "disabled",
      }[c.kind];
      await tx.query(
        "UPDATE automation_rules SET state=$3,paused_reason=$4,version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2",
        [org, id, state, c.kind === "activate" ? null : c.note],
      );
      await audit(tx, org, s.actorId, `automation.${c.kind}`, rule.branch_id, {
        ruleId: id,
      });
      return r;
    });
  }
  // Dry run on a stored real event or a saved sample: shows matching, conditions and the
  // concrete data each action would create, without creating anything.
  async test(secret: Credential, org: string, id: string, input: unknown) {
    const c = ruleTest.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "automations:write");
      const rule = await this.rule(tx, org, id, s.branchId, true);
      let event: {
        topic: string;
        payload: Record<string, unknown>;
        depth: number;
        branch_id: string | null;
      };
      if (c.eventId) {
        const [e] = await tx.query<Event>(
          "SELECT * FROM domain_events WHERE organization_id=$1 AND id=$2 AND ($3::uuid IS NULL OR branch_id IS NULL OR branch_id=$3)",
          [org, c.eventId, s.branchId],
        );
        if (!e) throw new AppError("NOT_FOUND", 404);
        event = {
          topic: e.topic,
          payload: e.payload,
          depth: e.depth,
          branch_id: e.branch_id,
        };
      } else event = { ...c.sample!, depth: 0, branch_id: rule.branch_id };
      const result = evaluate(rule.definition, event);
      const warnings: string[] = [];
      if (event.depth >= rule.definition.limits.maxDepth)
        warnings.push("depth_limit");
      if (
        rule.branch_id &&
        event.branch_id &&
        event.branch_id !== rule.branch_id
      )
        warnings.push("other_branch");
      const actions = rule.definition.actions.map((a) => ({
        type: a.type,
        effect:
          a.type === "create_task"
            ? "creates one task per event"
            : a.type === "propose_purchase"
              ? "creates a purchase proposal that waits for human approval"
              : "sends an in-app notification",
        data:
          a.type === "create_task"
            ? {
                title: a.title,
                assigneeId: a.assigneeId,
                dueInHours: a.dueInHours,
              }
            : a.type === "notify"
              ? { userId: a.userId }
              : { insightId: event.payload.entityId ?? null },
      }));
      if (
        rule.definition.actions.some((a) => a.type === "propose_purchase") &&
        event.payload.rule !== "low_stock"
      )
        warnings.push("propose_purchase_needs_low_stock");
      const passed =
        result.matched &&
        warnings.filter((w) => w !== "depth_limit").length === 0;
      const testId = randomUUID();
      const stored = {
        matched: result.matched,
        conditions: result.conditions,
        actions,
        warnings,
        passed,
      };
      await tx.query(
        "INSERT INTO automation_test_runs(id,organization_id,rule_id,rule_version,event,result,passed,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          testId,
          org,
          id,
          rule.current_version,
          JSON.stringify(event),
          JSON.stringify(stored),
          passed,
          s.actorId,
        ],
      );
      if (passed)
        await tx.query(
          "UPDATE automation_rules SET tested_version=current_version,version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2",
          [org, id],
        );
      await audit(tx, org, s.actorId, "automation.tested", rule.branch_id, {
        ruleId: id,
        passed: String(passed),
      });
      return { id: testId, ...stored };
    });
  }
  async list(secret: Credential, org: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "automations:read");
      return {
        items: await tx.query(
          `SELECT ${ruleColumns},u.name created_by_name FROM ${ruleJoin} JOIN users u ON u.id=r.created_by WHERE r.organization_id=$1 AND ($2::uuid IS NULL OR r.branch_id=$2) ORDER BY r.name LIMIT 200`,
          [org, s.branchId],
        ),
      };
    });
  }
  async get(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "automations:read");
      await this.rule(tx, org, id, s.branchId);
      const [rule] = await tx.query(
        `SELECT ${ruleColumns},u.name created_by_name FROM ${ruleJoin} JOIN users u ON u.id=r.created_by WHERE r.organization_id=$1 AND r.id=$2`,
        [org, id],
      );
      return {
        rule,
        versions: await tx.query(
          "SELECT v.number,v.note,u.name author_name,v.created_at FROM automation_rule_versions v JOIN users u ON u.id=v.author_id WHERE v.organization_id=$1 AND v.rule_id=$2 ORDER BY v.number DESC LIMIT 50",
          [org, id],
        ),
        tests: await tx.query(
          "SELECT id,rule_version,passed,result,created_at FROM automation_test_runs WHERE organization_id=$1 AND rule_id=$2 ORDER BY created_at DESC LIMIT 20",
          [org, id],
        ),
      };
    });
  }
  async executions(secret: Credential, org: string, input: unknown) {
    const q = automationQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "automations:read");
      const where =
        "x.organization_id=$1 AND ($2::uuid IS NULL OR r.branch_id=$2) AND ($3::text='' OR x.state=$3) AND ($4::uuid IS NULL OR x.rule_id=$4)";
      const join =
        "automation_executions x JOIN automation_rules r ON r.organization_id=x.organization_id AND r.id=x.rule_id JOIN domain_events e ON e.organization_id=x.organization_id AND e.id=x.event_id";
      const params = [org, s.branchId, q.state || "", q.ruleId || null];
      const [c] = await tx.query<{ total: number }>(
        `SELECT count(*)::int total FROM ${join} WHERE ${where}`,
        params,
      );
      return {
        items: await tx.query(
          `SELECT x.id,x.rule_id,r.name rule_name,x.rule_version,x.event_id,e.topic,e.depth,x.state,x.skip_reason,x.attempts,x.error_code,x.result,x.created_at,x.finished_at,x.version FROM ${join} WHERE ${where} ORDER BY x.created_at DESC,x.id LIMIT $5 OFFSET $6`,
          [...params, q.limit, (q.page - 1) * q.limit],
        ),
        pagination: pagination(q.page, q.limit, c.total),
      };
    });
  }
  // Manual review queue: a dead execution can be retried after the cause was fixed.
  async retry(secret: Credential, org: string, id: string, input: unknown) {
    const c = executionCommand.parse(input);
    idSchema.parse(id);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "automations:write");
      const [x] = await tx.query<{
        state: string;
        version: number;
        branch_id: string | null;
      }>(
        "SELECT x.state,x.version,r.branch_id FROM automation_executions x JOIN automation_rules r ON r.organization_id=x.organization_id AND r.id=x.rule_id WHERE x.organization_id=$1 AND x.id=$2 AND ($3::uuid IS NULL OR r.branch_id=$3) FOR UPDATE OF x",
        [org, id, s.branchId],
      );
      if (!x) throw new AppError("NOT_FOUND", 404);
      const r = await idempotent(tx, org, c.key, {
        operation: "automation.retry",
        id,
        ...c,
      });
      if (r.reused) return r;
      if (x.version !== c.version) throw new AppError("VERSION_CONFLICT", 409);
      if (!["dead", "failed"].includes(x.state))
        throw new AppError("EXECUTION_STATE", 409);
      await tx.query(
        "UPDATE automation_executions SET state='queued',attempts=0,error_code=NULL,available_at=now(),version=version+1 WHERE id=$1",
        [id],
      );
      await audit(tx, org, s.actorId, "automation.retry", x.branch_id, {
        executionId: id,
      });
      return r;
    });
  }
  // Scheduler: one schedule.tick event per rule and local day; repeated ticks are deduplicated.
  async scheduleTicks() {
    const rules = await this.db.query<Rule>(
      `SELECT ${ruleColumns} FROM ${ruleJoin} WHERE r.state='active' AND v.definition->'trigger'->>'type'='schedule' LIMIT 500`,
    );
    let ticks = 0;
    for (const r of rules)
      await this.db.transaction(async (tx) => {
        const clock = await organizationClock(tx, r.organization_id);
        const t = r.definition.trigger;
        if (t.type !== "schedule") return;
        const day =
          t.recurrence === "daily" ||
          (t.recurrence === "weekdays" && clock.iso_day <= 5) ||
          (t.recurrence === "weekly" && clock.iso_day === t.weekday);
        if (!day || clock.local_time < t.time) return;
        const id = await emit(tx, {
          org: r.organization_id,
          branch: r.branch_id,
          topic: "schedule.tick",
          entityType: "automation_rule",
          entityId: r.id,
          payload: { ruleId: r.id, date: clock.today },
          actorId: null,
          dedupeKey: `schedule:${r.id}:${clock.today}`,
        });
        if (id) ticks++;
      });
    return ticks;
  }
  // Transactional outbox → executions. UNIQUE(rule,event) makes redelivery harmless.
  async dispatch() {
    return this.db.transaction(async (tx) => {
      const events = await tx.query<Event>(
        "SELECT * FROM domain_events WHERE dispatched_at IS NULL ORDER BY created_at,id LIMIT 50 FOR UPDATE SKIP LOCKED",
      );
      let created = 0;
      for (const e of events) {
        const rules = await tx.query<Rule>(
          `SELECT ${ruleColumns} FROM ${ruleJoin} WHERE r.organization_id=$1 AND r.state='active' AND (r.branch_id IS NULL OR $2::uuid IS NULL OR r.branch_id=$2)`,
          [e.organization_id, e.branch_id],
        );
        for (const r of rules) {
          const t = r.definition.trigger;
          const relevant =
            t.type === "event"
              ? t.topic === e.topic
              : e.topic === "schedule.tick" && e.entity_id === r.id;
          if (!relevant) continue;
          const depthExceeded = e.depth >= r.definition.limits.maxDepth;
          const added = await tx.query(
            "INSERT INTO automation_executions(id,organization_id,rule_id,rule_version,event_id,state,skip_reason,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(rule_id,event_id) DO NOTHING RETURNING id",
            [
              randomUUID(),
              e.organization_id,
              r.id,
              r.current_version,
              e.id,
              depthExceeded ? "skipped" : "queued",
              depthExceeded ? "depth_limit" : null,
              depthExceeded ? new Date().toISOString() : null,
            ],
          );
          created += added.length;
        }
        await tx.query(
          "UPDATE domain_events SET dispatched_at=now() WHERE id=$1",
          [e.id],
        );
      }
      return created;
    });
  }
  async claim() {
    return this.db.transaction(async (tx) => {
      const [x] = await tx.query<{ id: string }>(
        "SELECT id FROM automation_executions WHERE (state='queued' AND available_at<=now()) OR (state='running' AND lease_until<now()) ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
      );
      if (!x) return null;
      const token = randomUUID();
      const [claimed] = await tx.query<{
        id: string;
        lease_token: string;
        attempts: number;
      }>(
        "UPDATE automation_executions SET state='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '30 seconds' WHERE id=$1 RETURNING id,lease_token,attempts",
        [x.id, token],
      );
      return claimed;
    });
  }
  async process(claim: { id: string; lease_token: string }) {
    try {
      return await this.db.transaction(async (tx) => {
        const [x] = await tx.query<{
          id: string;
          organization_id: string;
          rule_id: string;
          rule_version: number;
          event_id: string;
          attempts: number;
        }>(
          "SELECT * FROM automation_executions WHERE id=$1 AND state='running' AND lease_token=$2 AND lease_until>now() FOR UPDATE",
          [claim.id, claim.lease_token],
        );
        // A stale worker whose lease was reclaimed cannot commit anything.
        if (!x) return "fenced";
        const finish = async (
          state: string,
          extra: { skip?: string; result?: unknown } = {},
        ) => {
          await tx.query(
            "UPDATE automation_executions SET state=$2,skip_reason=$3,result=$4,finished_at=now(),lease_token=NULL,lease_until=NULL,version=version+1 WHERE id=$1",
            [
              x.id,
              state,
              extra.skip || null,
              extra.result ? JSON.stringify(extra.result) : null,
            ],
          );
          return state;
        };
        const [rule] = await tx.query<
          Rule & { definition: AutomationDefinition }
        >(
          "SELECT r.id,r.organization_id,r.branch_id,r.name,r.state,r.current_version,r.created_by,v.definition FROM automation_rules r JOIN automation_rule_versions v ON v.organization_id=r.organization_id AND v.rule_id=r.id AND v.number=$2 WHERE r.id=$1 FOR SHARE OF r",
          [x.rule_id, x.rule_version],
        );
        if (rule.state !== "active")
          return finish("skipped", { skip: "rule_inactive" });
        const [e] = await tx.query<Event>(
          "SELECT * FROM domain_events WHERE id=$1",
          [x.event_id],
        );
        const def = automationDefinition.parse(rule.definition);
        // Rights of the rule author are re-checked immediately before acting.
        try {
          await actorAccess(
            tx,
            rule.created_by,
            rule.organization_id,
            "automations:write",
            rule.branch_id || undefined,
          );
        } catch (error) {
          if (error instanceof AppError && error.status === 403) {
            await tx.query(
              "UPDATE automation_rules SET state='paused',paused_reason='ACCESS_REVOKED',version=version+1,updated_at=now() WHERE id=$1",
              [rule.id],
            );
            return finish("skipped", { skip: "access_revoked" });
          }
          throw error;
        }
        if (def.workingHoursOnly) {
          const clock = await organizationClock(tx, rule.organization_id);
          const [hours] = await tx.query<{
            start_time: string;
            end_time: string;
            days: number[];
          }>(
            "SELECT start_time,end_time,days FROM work_schedules WHERE organization_id=$1",
            [rule.organization_id],
          );
          const h = hours || {
            start_time: "09:00",
            end_time: "18:00",
            days: [1, 2, 3, 4, 5],
          };
          if (
            !h.days.includes(clock.iso_day) ||
            clock.local_time < h.start_time ||
            clock.local_time >= h.end_time
          ) {
            await tx.query(
              "UPDATE automation_executions SET state='queued',skip_reason='outside_working_hours',available_at=now()+interval '15 minutes',lease_token=NULL,lease_until=NULL,attempts=attempts-1 WHERE id=$1",
              [x.id],
            );
            return "postponed";
          }
        }
        const [rate] = await tx.query<{ n: number }>(
          "SELECT count(*)::int n FROM automation_executions WHERE rule_id=$1 AND state='succeeded' AND finished_at>now()-interval '1 hour'",
          [rule.id],
        );
        if (rate.n >= def.limits.maxPerHour)
          return finish("skipped", { skip: "rate_limit" });
        const [chain] = await tx.query<{ n: number }>(
          "SELECT count(*)::int n FROM automation_executions a JOIN domain_events d ON d.organization_id=a.organization_id AND d.id=a.event_id WHERE d.origin_chain_id=$1 AND a.state='succeeded'",
          [e.origin_chain_id],
        );
        if (chain.n >= MAX_CHAIN_EXECUTIONS)
          return finish("skipped", { skip: "chain_limit" });
        const check = evaluate(def, e);
        if (!check.pass)
          return finish("skipped", {
            skip: "conditions_not_met",
            result: { conditions: check.conditions },
          });
        const actor = new InternalActor(rule.created_by, "automation");
        const next: Chain = {
          originChainId: e.origin_chain_id,
          depth: e.depth + 1,
        };
        const results: { type: string; id: string | null }[] = [];
        for (let i = 0; i < def.actions.length; i++) {
          const a = def.actions[i];
          const actionKey = stableUuid(`automation:${x.id}:${i}`);
          if (a.type === "create_task") {
            let due = null;
            if (a.dueInHours) {
              const [d] = await tx.query<{ date: string; time: string }>(
                "SELECT to_char((now()+make_interval(hours=>$2)) AT TIME ZONE timezone,'YYYY-MM-DD') date,to_char((now()+make_interval(hours=>$2)) AT TIME ZONE timezone,'HH24:MI') time FROM organizations WHERE id=$1",
                [rule.organization_id, a.dueInHours],
              );
              due = d;
            }
            const links =
              e.entity_type === "insight"
                ? [{ type: "insight" as const, id: e.entity_id }]
                : e.entity_type === "proposal"
                  ? [{ type: "proposal" as const, id: e.entity_id }]
                  : [];
            const task = await new TaskService(this.db).createInTransaction(
              tx,
              actor,
              rule.organization_id,
              {
                key: actionKey,
                branchId: rule.branch_id,
                title: a.title,
                description: a.description,
                kind: a.kind,
                priority: a.priority,
                assigneeId: a.assigneeId,
                deputyId: a.deputyId,
                due,
                requiresVerification: a.requiresVerification,
                evidence: a.evidence,
                checklist: a.checklist,
                links,
              },
              { source: "automation", sourceId: actionKey, chain: next },
            );
            results.push({ type: a.type, id: task.id });
          } else if (a.type === "propose_purchase") {
            if (
              e.topic !== "insight.opened" ||
              e.payload.rule !== "low_stock"
            ) {
              results.push({ type: a.type, id: null });
              continue;
            }
            const proposal = await new ProposalService(
              this.db,
            ).fromInsightInTransaction(
              tx,
              actor,
              rule.organization_id,
              e.entity_id,
              actionKey,
              "automation",
              true,
              next,
            );
            results.push({ type: a.type, id: proposal.id });
          } else {
            await notify(
              tx,
              rule.organization_id,
              a.userId,
              "automation.notice",
              e.entity_type,
              e.entity_id,
              `automation:${x.id}:${i}`,
            );
            results.push({ type: a.type, id: null });
          }
        }
        await audit(
          tx,
          rule.organization_id,
          rule.created_by,
          "automation.executed",
          rule.branch_id,
          {
            ruleId: rule.id,
            executionId: x.id,
          },
        );
        return finish("succeeded", { result: { actions: results } });
      });
    } catch (error) {
      // Isolate the failure: business refusals go to manual review, unexpected errors retry with backoff.
      const business = error instanceof AppError && error.status < 500;
      const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
      await this.db.transaction(async (tx) => {
        await tx.query(
          "UPDATE automation_executions SET state=CASE WHEN $3::boolean OR attempts>=3 THEN 'dead' ELSE 'queued' END,error_code=$2,available_at=now()+make_interval(secs=>least(300,10*power(2,attempts)::int)),finished_at=CASE WHEN $3::boolean OR attempts>=3 THEN now() END,lease_token=NULL,lease_until=NULL,version=version+1 WHERE id=$1 AND lease_token=$4",
          [claim.id, code, business, claim.lease_token],
        );
      });
      return business ? "dead" : "retry";
    }
  }
  async runOnce() {
    await this.scheduleTicks();
    await this.dispatch();
    let processed = 0;
    for (let i = 0; i < 20; i++) {
      const claim = await this.claim();
      if (!claim) break;
      await this.process(claim);
      processed++;
    }
    return processed;
  }
}
