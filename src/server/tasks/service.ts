import { createHash, randomUUID } from "node:crypto";
import type { Database, Sql } from "../db/database";
import {
  sessionAccess,
  audit,
  InternalActor,
  type Credential,
} from "../access";
import { AppError } from "../../domain/errors";
import { idSchema } from "../../domain/contracts";
import { can } from "../../domain/permissions";
import { pagination } from "../../domain/import-contracts";
import {
  taskInput,
  taskCommand,
  taskComment,
  taskAttachment,
  taskQuery,
  templateInput,
  scheduleInput,
  type EntityLink,
  type TaskRow,
} from "../../domain/tasks";
import {
  idempotent,
  emit,
  notify,
  organizationClock,
  base64File,
  signatures,
  type Chain,
} from "../execution/core";

const taskColumns = `t.id,t.branch_id,t.number,t.title,t.description,t.kind,t.source,t.source_id,t.priority,t.state,t.assignee_id,a.name assignee_name,t.deputy_id,d.name deputy_name,t.due_at,(t.due_at IS NOT NULL AND t.due_at<now() AND t.state NOT IN ('done','verified','cancelled')) overdue,t.requires_verification,t.evidence,t.links,t.blocked_reason,t.completion,t.escalated_at,cb.name completed_by_name,t.completed_at,vb.name verified_by_name,t.verified_at,cr.name created_by_name,t.version,t.created_at`;
const taskJoin = `tasks t LEFT JOIN users a ON a.id=t.assignee_id LEFT JOIN users d ON d.id=t.deputy_id LEFT JOIN users cb ON cb.id=t.completed_by LEFT JOIN users vb ON vb.id=t.verified_by JOIN users cr ON cr.id=t.created_by`;
type Loaded = TaskRow & { created_by: string; completed_by: string | null };
// Deterministic RFC 4122 UUID (version 5 layout) for scheduler idempotency keys.
export function stableUuid(text: string) {
  const h = createHash("sha256").update(text).digest("hex").split("");
  h[12] = "5";
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
// A completed operation is evidence only if it exists in the same organization/branch and reached a result state.
const operationStates: Partial<Record<EntityLink["type"], string[]>> = {
  purchase_order: ["partial", "completed"],
  sales_order: ["partial", "fulfilled"],
  purchase_document: ["approved"],
  proposal: ["executed"],
  insight: ["resolved"],
};
export async function linkState(
  tx: Sql,
  org: string,
  branch: string,
  link: EntityLink,
): Promise<string | null> {
  const sql: Record<EntityLink["type"], string> = {
    purchase_order:
      "SELECT state FROM purchase_orders WHERE organization_id=$1 AND id=$2 AND branch_id=$3",
    sales_order:
      "SELECT state FROM sales_orders WHERE organization_id=$1 AND id=$2 AND branch_id=$3",
    purchase_document:
      "SELECT d.state FROM purchase_documents d JOIN purchase_orders o ON o.organization_id=d.organization_id AND o.id=d.order_id WHERE d.organization_id=$1 AND d.id=$2 AND o.branch_id=$3",
    item: "SELECT CASE WHEN active THEN 'active' ELSE 'archived' END state FROM catalog_items WHERE organization_id=$1 AND id=$2 AND $3::uuid IS NOT NULL",
    customer:
      "SELECT 'active' state FROM customers WHERE organization_id=$1 AND id=$2 AND branch_id=$3",
    insight:
      "SELECT state FROM insights WHERE organization_id=$1 AND id=$2 AND (branch_id IS NULL OR branch_id=$3)",
    proposal:
      "SELECT state FROM action_proposals WHERE organization_id=$1 AND id=$2 AND (branch_id IS NULL OR branch_id=$3)",
    knowledge:
      "SELECT state FROM knowledge_documents WHERE organization_id=$1 AND id=$2 AND (branch_id IS NULL OR branch_id=$3)",
    video_event:
      "SELECT e.kind state FROM video_events e JOIN video_sources s ON s.organization_id=e.organization_id AND s.id=e.source_id WHERE e.organization_id=$1 AND e.id=$2 AND s.branch_id=$3",
  };
  const [row] = await tx.query<{ state: string }>(sql[link.type], [
    org,
    link.id,
    branch,
  ]);
  return row?.state ?? null;
}
export class TaskService {
  constructor(private db: Database) {}
  private async member(tx: Sql, org: string, user: string, branch: string) {
    idSchema.parse(user);
    const [m] = await tx.query<{ branch_id: string | null }>(
      "SELECT branch_id FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR SHARE",
      [org, user],
    );
    if (!m || (m.branch_id && m.branch_id !== branch))
      throw new AppError("ASSIGNEE_SCOPE", 422);
  }
  private async load(
    tx: Sql,
    org: string,
    id: string,
    s: { actorId: string; branchId: string | null; role: string },
    lock = false,
  ) {
    idSchema.parse(id);
    const manage = can(s.role as never, "tasks:manage");
    const [t] = await tx.query<Loaded>(
      `SELECT ${taskColumns},t.created_by,t.completed_by FROM ${taskJoin} WHERE t.organization_id=$1 AND t.id=$2 AND ($3::uuid IS NULL OR t.branch_id=$3) AND ($4::boolean OR t.assignee_id=$5 OR t.created_by=$5 OR t.deputy_id=$5) ${lock ? "FOR UPDATE OF t" : ""}`,
      [org, id, s.branchId, manage, s.actorId],
    );
    if (!t) throw new AppError("NOT_FOUND", 404);
    return t;
  }
  async create(secret: Credential, org: string, input: unknown) {
    return this.db.transaction((tx) =>
      this.createInTransaction(tx, secret, org, input),
    );
  }
  // Internal composition for proposals, automations and the scheduler (no nested transaction).
  async createInTransaction(
    tx: Sql,
    secret: Credential,
    org: string,
    input: unknown,
    origin: {
      source?:
        | "manual"
        | "template"
        | "proposal"
        | "automation"
        | "situation"
        | "assistant";
      sourceId?: string | null;
      templateId?: string;
      recurrenceKey?: string;
      chain?: Chain;
    } = {},
  ) {
    const c = taskInput.parse(input);
    const s = await sessionAccess(tx, secret, org, "tasks:write", c.branchId);
    const source = origin.source || "manual";
    const r = await idempotent(tx, org, c.key, {
      operation: "task.create",
      ...c,
      source,
      sourceId: origin.sourceId || null,
    });
    if (r.reused) return r;
    if (c.assigneeId) await this.member(tx, org, c.assigneeId, c.branchId);
    if (c.deputyId) {
      await this.member(tx, org, c.deputyId, c.branchId);
      if (c.deputyId === c.assigneeId) throw new AppError("DEPUTY_SAME", 422);
    }
    for (const link of c.links)
      if ((await linkState(tx, org, c.branchId, link)) === null)
        throw new AppError("LINK_NOT_FOUND", 422);
    let due: string | null = null;
    if (c.due) {
      const [row] = await tx.query<{ due: string }>(
        "SELECT (($2||' '||$3)::timestamp AT TIME ZONE timezone)::text due FROM organizations WHERE id=$1",
        [org, c.due.date, c.due.time],
      );
      due = row.due;
    }
    const state = c.assigneeId ? "assigned" : "new";
    const inserted = await tx.query(
      "INSERT INTO tasks(id,organization_id,branch_id,title,description,kind,source,source_id,priority,state,assignee_id,deputy_id,due_at,requires_verification,evidence,links,template_id,recurrence_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT DO NOTHING RETURNING id",
      [
        r.id,
        org,
        c.branchId,
        c.title,
        c.description,
        c.kind,
        source,
        origin.sourceId || null,
        c.priority,
        state,
        c.assigneeId,
        c.deputyId,
        due,
        c.requiresVerification,
        c.evidence,
        JSON.stringify(c.links),
        origin.templateId || null,
        origin.recurrenceKey || null,
        s.actorId,
      ],
    );
    // Periodic or source-linked tasks are never duplicated by a repeated schedule tick or event.
    if (!inserted.length) throw new AppError("TASK_EXISTS", 409);
    for (let i = 0; i < c.checklist.length; i++)
      await tx.query(
        "INSERT INTO task_checklist(id,organization_id,task_id,position,text) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), org, r.id, i, c.checklist[i]],
      );
    await tx.query(
      "INSERT INTO task_events(id,organization_id,task_id,kind,to_state,note,data,actor_id) VALUES($1,$2,$3,'created',$4,$5,$6,$7)",
      [
        randomUUID(),
        org,
        r.id,
        state,
        c.title,
        JSON.stringify({ source, sourceId: origin.sourceId || null }),
        s.actorId,
      ],
    );
    await notify(
      tx,
      org,
      c.assigneeId,
      "task.assigned",
      "task",
      r.id,
      `task:${r.id}:assigned:1`,
    );
    await emit(tx, {
      org,
      branch: c.branchId,
      topic: "task.created",
      entityType: "task",
      entityId: r.id,
      payload: {
        kind: c.kind,
        priority: c.priority,
        source,
        assigneeId: c.assigneeId,
      },
      actorId: s.actorId,
      chain: origin.chain,
      dedupeKey: `task.created:${r.id}`,
    });
    await audit(tx, org, s.actorId, "task.created", c.branchId, {
      taskId: r.id,
      source,
    });
    return r;
  }
  async list(secret: Credential, org: string, input: unknown) {
    const q = taskQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "tasks:read", q.branchId);
      const manage = can(s.role, "tasks:manage") && q.scope === "all";
      const where = `t.organization_id=$1 AND ($2::uuid IS NULL OR t.branch_id=$2) AND ($3::boolean OR t.assignee_id=$4 OR t.created_by=$4 OR t.deputy_id=$4) AND position(lower($5) in lower(t.title||' '||t.number::text))>0 AND (CASE $6::text WHEN '' THEN true WHEN 'open' THEN t.state NOT IN ('done','verified','cancelled') WHEN 'overdue' THEN t.due_at<now() AND t.state NOT IN ('done','verified','cancelled') ELSE t.state=$6 END)`;
      const params = [org, s.branchId, manage, s.actorId, q.q, q.state || ""];
      const [c] = await tx.query<{ total: number }>(
        `SELECT count(*)::int total FROM tasks t WHERE ${where}`,
        params,
      );
      return {
        items: await tx.query(
          `SELECT ${taskColumns} FROM ${taskJoin} WHERE ${where} ORDER BY (t.state IN ('done','verified','cancelled')),t.due_at NULLS LAST,t.created_at DESC,t.id LIMIT $7 OFFSET $8`,
          [...params, q.limit, (q.page - 1) * q.limit],
        ),
        pagination: pagination(q.page, q.limit, c.total),
      };
    });
  }
  async get(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "tasks:read");
      const t = await this.load(tx, org, id, s);
      const manage = can(s.role, "tasks:manage");
      const { created_by, completed_by, ...task } = t;
      return {
        task,
        checklist: await tx.query(
          "SELECT c.position,c.text,c.done_at,u.name done_by_name FROM task_checklist c LEFT JOIN users u ON u.id=c.done_by WHERE c.organization_id=$1 AND c.task_id=$2 ORDER BY c.position",
          [org, id],
        ),
        comments: await tx.query(
          "SELECT c.id,c.body,u.name actor_name,c.created_at FROM task_comments c JOIN users u ON u.id=c.actor_id WHERE c.organization_id=$1 AND c.task_id=$2 ORDER BY c.created_at,c.id LIMIT 200",
          [org, id],
        ),
        attachments: await tx.query(
          "SELECT a.id,a.filename,a.mime,u.name actor_name,a.created_at FROM task_attachments a JOIN users u ON u.id=a.actor_id WHERE a.organization_id=$1 AND a.task_id=$2 ORDER BY a.created_at",
          [org, id],
        ),
        events: await tx.query(
          "SELECT e.id,e.kind,e.from_state,e.to_state,e.note,u.name actor_name,e.created_at FROM task_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.organization_id=$1 AND e.task_id=$2 ORDER BY e.created_at,e.id LIMIT 200",
          [org, id],
        ),
        permissions: {
          act:
            manage ||
            t.assignee_id === s.actorId ||
            (t.deputy_id === s.actorId && !!t.escalated_at),
          manage: manage || created_by === s.actorId,
          verify:
            can(s.role, "tasks:verify") &&
            completed_by !== s.actorId &&
            t.requires_verification,
        },
      };
    });
  }
  async command(
    secret: Credential,
    org: string,
    id: string,
    input: unknown,
    chain?: Chain,
  ) {
    const c = taskCommand.parse(input);
    return this.db.transaction((tx) =>
      this.commandInTransaction(tx, secret, org, id, c, chain),
    );
  }
  async commandInTransaction(
    tx: Sql,
    secret: Credential,
    org: string,
    id: string,
    input: unknown,
    chain?: Chain,
  ) {
    const c = taskCommand.parse(input);
    const s = await sessionAccess(tx, secret, org, "tasks:read");
    const t = await this.load(tx, org, id, s, true);
    const r = await idempotent(tx, org, c.key, {
      operation: "task.command",
      id,
      ...c,
    });
    if (r.reused) return r;
    if (t.version !== c.version) throw new AppError("VERSION_CONFLICT", 409);
    const manage = can(s.role, "tasks:manage"),
      creator = t.created_by === s.actorId,
      executor =
        manage ||
        t.assignee_id === s.actorId ||
        (t.deputy_id === s.actorId && !!t.escalated_at);
    const deny = () => {
      throw new AppError("FORBIDDEN", 403);
    };
    const state = (allowed: string[]) => {
      if (!allowed.includes(t.state)) throw new AppError("TASK_STATE", 409);
    };
    let next = t.state as string,
      note = "note" in c && c.note ? c.note : "",
      topic: string | null = null;
    const updates: Record<string, unknown> = {};
    const [{ now }] = await tx.query<{ now: string }>("SELECT now()::text now");
    switch (c.kind) {
      case "assign":
        if (!manage && !creator) deny();
        state(["new", "assigned", "in_progress", "blocked"]);
        await this.member(tx, org, c.assigneeId, t.branch_id);
        if (c.deputyId) {
          await this.member(tx, org, c.deputyId, t.branch_id);
          if (c.deputyId === c.assigneeId)
            throw new AppError("DEPUTY_SAME", 422);
        }
        next = "assigned";
        Object.assign(updates, {
          assignee_id: c.assigneeId,
          deputy_id: c.deputyId,
          escalated_at: null,
        });
        await notify(
          tx,
          org,
          c.assigneeId,
          "task.assigned",
          "task",
          id,
          `task:${id}:assigned:${t.version}`,
        );
        topic = "task.assigned";
        break;
      case "start":
        if (!executor) deny();
        state(["assigned"]);
        next = "in_progress";
        break;
      case "block":
        if (!executor) deny();
        state(["in_progress"]);
        next = "blocked";
        updates.blocked_reason = c.note;
        topic = "task.blocked";
        break;
      case "unblock":
        if (!executor) deny();
        state(["blocked"]);
        next = "in_progress";
        updates.blocked_reason = null;
        break;
      case "check": {
        if (!executor) deny();
        state(["assigned", "in_progress"]);
        const done = await tx.query(
          "UPDATE task_checklist SET done_by=$4,done_at=$5 WHERE organization_id=$1 AND task_id=$2 AND position=$3 RETURNING id",
          [org, id, c.position, c.done ? s.actorId : null, c.done ? now : null],
        );
        if (!done.length) throw new AppError("NOT_FOUND", 404);
        note = `${c.position + 1}: ${c.done ? "done" : "reopened"}`;
        break;
      }
      case "complete": {
        if (!executor) deny();
        state(["in_progress"]);
        const [open] = await tx.query<{ n: number }>(
          "SELECT count(*)::int n FROM task_checklist WHERE organization_id=$1 AND task_id=$2 AND done_at IS NULL",
          [org, id],
        );
        if (open.n) throw new AppError("CHECKLIST_INCOMPLETE", 422);
        const attachments = await tx.query<{ id: string; mime: string }>(
          "SELECT id,mime FROM task_attachments WHERE organization_id=$1 AND task_id=$2 ORDER BY created_at",
          [org, id],
        );
        let operationState: string | null = null;
        if (
          t.evidence === "photo" &&
          !attachments.some((a) => a.mime.startsWith("image/"))
        )
          throw new AppError("EVIDENCE_REQUIRED", 422);
        if (t.evidence === "operation") {
          const op = c.operation;
          if (!op || !operationStates[op.type])
            throw new AppError("EVIDENCE_REQUIRED", 422);
          operationState = await linkState(tx, org, t.branch_id, op);
          if (
            !operationState ||
            !operationStates[op.type]!.includes(operationState)
          )
            throw new AppError("EVIDENCE_NOT_MET", 422);
        }
        next = "done";
        Object.assign(updates, {
          completion: JSON.stringify({
            note: c.note,
            operation: c.operation,
            attachments: attachments.map((a) => a.id),
            operation_state: operationState,
          }),
          completed_by: s.actorId,
          completed_at: now,
        });
        if (t.requires_verification)
          await notify(
            tx,
            org,
            t.created_by,
            "task.review",
            "task",
            id,
            `task:${id}:review:${t.version}`,
          );
        topic = "task.completed";
        break;
      }
      case "verify":
        // The person who completed the work cannot accept it.
        if (!can(s.role, "tasks:verify") || t.completed_by === s.actorId)
          deny();
        if (!t.requires_verification) throw new AppError("TASK_STATE", 409);
        state(["done"]);
        next = "verified";
        Object.assign(updates, {
          verified_by: s.actorId,
          verified_at: now,
        });
        topic = "task.verified";
        break;
      case "return":
        if (!can(s.role, "tasks:verify") || t.completed_by === s.actorId)
          deny();
        if (!t.requires_verification) throw new AppError("TASK_STATE", 409);
        state(["done"]);
        next = "in_progress";
        Object.assign(updates, {
          completion: null,
          completed_by: null,
          completed_at: null,
        });
        await notify(
          tx,
          org,
          t.assignee_id,
          "task.returned",
          "task",
          id,
          `task:${id}:returned:${t.version}`,
        );
        topic = "task.returned";
        break;
      case "cancel":
        if (!manage && !(creator && ["new", "assigned"].includes(t.state)))
          deny();
        state(["new", "assigned", "in_progress", "blocked"]);
        next = "cancelled";
        topic = "task.cancelled";
        break;
    }
    const sets = Object.keys(updates).map((k, i) => `${k}=$${i + 4}`);
    await tx.query(
      `UPDATE tasks SET state=$3,version=version+1,updated_at=now()${sets.length ? "," + sets.join(",") : ""} WHERE organization_id=$1 AND id=$2`,
      [org, id, next, ...Object.values(updates)],
    );
    await tx.query(
      "INSERT INTO task_events(id,organization_id,task_id,kind,from_state,to_state,note,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [randomUUID(), org, id, c.kind, t.state, next, note, s.actorId],
    );
    if (topic)
      await emit(tx, {
        org,
        branch: t.branch_id,
        topic,
        entityType: "task",
        entityId: id,
        payload: { from: t.state, to: next, kind: t.kind },
        actorId: s.actorId,
        chain,
        dedupeKey: `${topic}:${id}:${t.version}`,
      });
    await audit(tx, org, s.actorId, `task.${c.kind}`, t.branch_id, {
      taskId: id,
    });
    return r;
  }
  async comment(secret: Credential, org: string, id: string, input: unknown) {
    const c = taskComment.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "tasks:read");
      const t = await this.load(tx, org, id, s, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "task.comment",
        id,
        ...c,
      });
      if (r.reused) return r;
      await tx.query(
        "INSERT INTO task_comments(id,organization_id,task_id,body,actor_id) VALUES($1,$2,$3,$4,$5)",
        [r.id, org, id, c.body, s.actorId],
      );
      await tx.query(
        "INSERT INTO task_events(id,organization_id,task_id,kind,note,actor_id) VALUES($1,$2,$3,'comment',$4,$5)",
        [randomUUID(), org, id, c.body.slice(0, 120), s.actorId],
      );
      for (const user of [t.assignee_id, t.created_by])
        if (user !== s.actorId)
          await notify(
            tx,
            org,
            user,
            "task.comment",
            "task",
            id,
            `comment:${r.id}`,
          );
      await audit(tx, org, s.actorId, "task.commented", t.branch_id, {
        taskId: id,
      });
      return r;
    });
  }
  async attach(secret: Credential, org: string, id: string, input: unknown) {
    const c = taskAttachment.parse(input);
    const { bytes, mime } = base64File(
      c.content,
      2 * 1024 * 1024,
      {
        "image/png": signatures["image/png"],
        "image/jpeg": signatures["image/jpeg"],
        "application/pdf": signatures["application/pdf"],
      },
      c.filename,
    );
    const sha = createHash("sha256").update(bytes).digest("hex");
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "tasks:read");
      const t = await this.load(tx, org, id, s, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "task.attach",
        id,
        filename: c.filename,
        sha,
      });
      if (r.reused) return r;
      if (!(
        can(s.role, "tasks:manage") ||
        t.assignee_id === s.actorId ||
        t.created_by === s.actorId ||
        (t.deputy_id === s.actorId && t.escalated_at)
      ))
        throw new AppError("FORBIDDEN", 403);
      if (["done", "verified", "cancelled"].includes(t.state))
        throw new AppError("TASK_STATE", 409);
      const added = await tx.query(
        "INSERT INTO task_attachments(id,organization_id,task_id,filename,mime,sha256,content,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id",
        [r.id, org, id, c.filename, mime, sha, bytes, s.actorId],
      );
      if (!added.length) throw new AppError("DUPLICATE_ATTACHMENT", 409);
      await tx.query(
        "INSERT INTO task_events(id,organization_id,task_id,kind,note,actor_id) VALUES($1,$2,$3,'attachment',$4,$5)",
        [randomUUID(), org, id, c.filename, s.actorId],
      );
      await audit(tx, org, s.actorId, "task.attachment_added", t.branch_id, {
        taskId: id,
      });
      return r;
    });
  }
  async attachment(
    secret: Credential,
    org: string,
    id: string,
    attachmentId: string,
  ) {
    idSchema.parse(attachmentId);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "tasks:read");
      await this.load(tx, org, id, s);
      const [a] = await tx.query<{
        filename: string;
        mime: string;
        content: Uint8Array;
      }>(
        "SELECT filename,mime,content FROM task_attachments WHERE organization_id=$1 AND task_id=$2 AND id=$3",
        [org, id, attachmentId],
      );
      if (!a) throw new AppError("NOT_FOUND", 404);
      return {
        filename: a.filename,
        mime: a.mime,
        content: Buffer.from(a.content).toString("base64"),
      };
    });
  }
  async assignees(secret: Credential, org: string, input: unknown) {
    const q = taskQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "tasks:write", q.branchId);
      return {
        items: await tx.query(
          "SELECT u.id,u.name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND ($2::uuid IS NULL OR m.branch_id IS NULL OR m.branch_id=$2) ORDER BY u.name,u.id LIMIT 200",
          [org, s.branchId],
        ),
      };
    });
  }
  async createTemplate(secret: Credential, org: string, input: unknown) {
    const c = templateInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        "tasks:manage",
        c.branchId,
      );
      const r = await idempotent(tx, org, c.key, {
        operation: "task.template",
        ...c,
      });
      if (r.reused) return r;
      for (const user of [c.assigneeId, c.deputyId])
        if (user) await this.member(tx, org, user, c.branchId);
      const added = await tx.query(
        "INSERT INTO task_templates(id,organization_id,branch_id,name,kind,checklist,requires_verification,evidence,priority,assignee_id,deputy_id,recurrence,due_time,weekday,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING RETURNING id",
        [
          r.id,
          org,
          c.branchId,
          c.name,
          c.kind,
          JSON.stringify(c.checklist),
          c.requiresVerification,
          c.evidence,
          c.priority,
          c.assigneeId,
          c.deputyId,
          c.recurrence,
          c.dueTime,
          c.weekday,
          s.actorId,
        ],
      );
      if (!added.length) throw new AppError("TEMPLATE_EXISTS", 409);
      await audit(tx, org, s.actorId, "task.template_created", c.branchId, {
        templateId: r.id,
      });
      return r;
    });
  }
  async templates(secret: Credential, org: string, input: unknown) {
    const q = taskQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "tasks:read", q.branchId);
      return {
        items: await tx.query(
          "SELECT id,branch_id,name,kind,checklist,requires_verification,evidence,priority,assignee_id,deputy_id,recurrence,due_time,weekday,active,version FROM task_templates WHERE organization_id=$1 AND ($2::uuid IS NULL OR branch_id=$2) ORDER BY name LIMIT 100",
          [org, s.branchId],
        ),
      };
    });
  }
  // A template creates a task now (shift opening, receiving, return), with its checklist and rule.
  async fromTemplate(
    secret: Credential,
    org: string,
    templateId: string,
    input: unknown,
  ) {
    idSchema.parse(templateId);
    const key = idSchema.parse((input as { key?: unknown })?.key);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "tasks:write");
      const [tpl] = await tx.query<TemplateRow>(
        "SELECT * FROM task_templates WHERE organization_id=$1 AND id=$2 AND ($3::uuid IS NULL OR branch_id=$3) AND active",
        [org, templateId, s.branchId],
      );
      if (!tpl) throw new AppError("NOT_FOUND", 404);
      return this.createInTransaction(
        tx,
        secret,
        org,
        templateTask(tpl, key, null),
        { source: "template", templateId },
      );
    });
  }
  async schedule(secret: Credential, org: string) {
    return this.db.transaction(async (tx) => {
      await sessionAccess(tx, secret, org, "tasks:read");
      const [row] = await tx.query<{
        version: number;
        start_time: string;
        end_time: string;
        days: number[];
        escalate_after_minutes: number;
      }>("SELECT * FROM work_schedules WHERE organization_id=$1", [org]);
      return row
        ? { ...row, configured: true }
        : {
            version: 0,
            start_time: "09:00",
            end_time: "18:00",
            days: [1, 2, 3, 4, 5],
            escalate_after_minutes: 60,
            configured: false,
          };
    });
  }
  async saveSchedule(secret: Credential, org: string, input: unknown) {
    const c = scheduleInput.parse(input);
    return this.db.transaction(async (tx) => {
      // Organization-wide working hours: only an organization-wide manager or owner.
      const s = await sessionAccess(tx, secret, org, "tasks:manage");
      if (s.branchId) throw new AppError("FORBIDDEN", 403);
      const [row] = await tx.query<{ version: number }>(
        "SELECT version FROM work_schedules WHERE organization_id=$1 FOR UPDATE",
        [org],
      );
      if ((row?.version || 0) !== c.version)
        throw new AppError("VERSION_CONFLICT", 409);
      await tx.query(
        "INSERT INTO work_schedules(organization_id,start_time,end_time,days,escalate_after_minutes,version) VALUES($1,$2,$3,$4,$5,1) ON CONFLICT(organization_id) DO UPDATE SET start_time=$2,end_time=$3,days=$4,escalate_after_minutes=$5,version=work_schedules.version+1",
        [
          org,
          c.startTime,
          c.endTime,
          JSON.stringify([...new Set(c.days)].sort()),
          c.escalateAfterMinutes,
        ],
      );
      await audit(tx, org, s.actorId, "task.schedule_saved", null);
      return { ok: true };
    });
  }
  // Workload counts only: no rating, blame or personnel conclusions are derived here.
  async workload(secret: Credential, org: string, input: unknown) {
    const q = taskQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        "tasks:manage",
        q.branchId,
      );
      return {
        items: await tx.query(
          "SELECT u.id user_id,u.name,count(*) FILTER(WHERE t.state NOT IN ('done','verified','cancelled'))::int open,count(*) FILTER(WHERE t.due_at<now() AND t.state NOT IN ('done','verified','cancelled'))::int overdue,count(*) FILTER(WHERE t.completed_at>now()-interval '30 days')::int done_30d,count(*) FILTER(WHERE t.verified_at>now()-interval '30 days')::int verified_30d,(SELECT count(*)::int FROM task_events e WHERE e.organization_id=$1 AND e.kind='return' AND e.created_at>now()-interval '30 days' AND e.task_id IN (SELECT id FROM tasks x WHERE x.organization_id=$1 AND x.assignee_id=u.id)) returned_30d FROM tasks t JOIN users u ON u.id=t.assignee_id WHERE t.organization_id=$1 AND ($2::uuid IS NULL OR t.branch_id=$2) GROUP BY u.id,u.name ORDER BY u.name LIMIT 200",
          [org, s.branchId],
        ),
        note: "workload_only",
      };
    });
  }
  // Scheduler: periodic tasks are created once per local business day; repeated ticks are no-ops.
  async generatePeriodic() {
    const templates = await this.db.query<TemplateRow>(
      "SELECT * FROM task_templates WHERE active AND recurrence<>'none' ORDER BY organization_id,id LIMIT 500",
    );
    let created = 0;
    for (const tpl of templates)
      try {
        await this.db.transaction(async (tx) => {
          const clock = await organizationClock(tx, tpl.organization_id);
          const due =
            tpl.recurrence === "daily" ||
            (tpl.recurrence === "weekdays" && clock.iso_day <= 5) ||
            (tpl.recurrence === "weekly" && clock.iso_day === tpl.weekday);
          if (!due) return;
          const recurrenceKey = `${tpl.id}:${clock.today}`;
          const [exists] = await tx.query(
            "SELECT id FROM tasks WHERE organization_id=$1 AND recurrence_key=$2",
            [tpl.organization_id, recurrenceKey],
          );
          if (exists) return;
          await this.createInTransaction(
            tx,
            new InternalActor(tpl.created_by, "automation"),
            tpl.organization_id,
            templateTask(tpl, stableUuid(`template:${recurrenceKey}`), {
              date: clock.today,
              time: tpl.due_time,
            }),
            { source: "template", templateId: tpl.id, recurrenceKey },
          );
          created++;
        });
      } catch (error) {
        if (error instanceof AppError && error.status === 403)
          // The template author lost rights: stop the schedule instead of acting on stale authority.
          await this.db.transaction(async (tx) => {
            await tx.query(
              "UPDATE task_templates SET active=false,version=version+1 WHERE id=$1",
              [tpl.id],
            );
            await audit(
              tx,
              tpl.organization_id,
              tpl.created_by,
              "task.template_suspended",
              tpl.branch_id,
              {
                templateId: tpl.id,
                reason: "ACCESS_REVOKED",
              },
            );
          });
        else if (!(error instanceof AppError && error.code === "TASK_EXISTS"))
          throw error;
      }
    return created;
  }
  // Escalation respects organization working hours and only notifies an assigned deputy.
  async escalate() {
    const overdue = await this.db.query<{
      id: string;
      organization_id: string;
      branch_id: string;
      deputy_id: string | null;
      version: number;
    }>(
      "SELECT t.id,t.organization_id,t.branch_id,t.deputy_id,t.version FROM tasks t WHERE t.state IN ('assigned','in_progress','blocked') AND t.due_at<now() AND t.escalated_at IS NULL ORDER BY t.due_at LIMIT 200",
    );
    let escalated = 0;
    for (const t of overdue)
      await this.db.transaction(async (tx) => {
        await emit(tx, {
          org: t.organization_id,
          branch: t.branch_id,
          topic: "task.overdue",
          entityType: "task",
          entityId: t.id,
          actorId: null,
          dedupeKey: `task.overdue:${t.id}`,
        });
        if (!t.deputy_id) return;
        const clock = await organizationClock(tx, t.organization_id);
        const [schedule] = await tx.query<{
          start_time: string;
          end_time: string;
          days: number[];
          escalate_after_minutes: number;
        }>("SELECT * FROM work_schedules WHERE organization_id=$1", [
          t.organization_id,
        ]);
        const hours = schedule || {
          start_time: "09:00",
          end_time: "18:00",
          days: [1, 2, 3, 4, 5],
          escalate_after_minutes: 60,
        };
        if (
          !hours.days.includes(clock.iso_day) ||
          clock.local_time < hours.start_time ||
          clock.local_time >= hours.end_time
        )
          return;
        const updated = await tx.query(
          "UPDATE tasks SET escalated_at=now(),version=version+1,updated_at=now() WHERE id=$1 AND escalated_at IS NULL AND due_at+make_interval(mins=>$2)<now() AND state IN ('assigned','in_progress','blocked') RETURNING id",
          [t.id, hours.escalate_after_minutes],
        );
        if (!updated.length) return;
        await tx.query(
          "INSERT INTO task_events(id,organization_id,task_id,kind,note) VALUES($1,$2,$3,'escalated','deputy')",
          [randomUUID(), t.organization_id, t.id],
        );
        await notify(
          tx,
          t.organization_id,
          t.deputy_id,
          "task.escalated",
          "task",
          t.id,
          `task:${t.id}:escalated`,
        );
        await emit(tx, {
          org: t.organization_id,
          branch: t.branch_id,
          topic: "task.escalated",
          entityType: "task",
          entityId: t.id,
          actorId: null,
          dedupeKey: `task.escalated:${t.id}`,
        });
        escalated++;
      });
    return escalated;
  }
  async notifications(secret: Credential, org: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "organization:read");
      return {
        items: await tx.query(
          "SELECT id,kind,entity_type,entity_id,read_at,created_at FROM notifications WHERE organization_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 50",
          [org, s.actorId],
        ),
      };
    });
  }
  async readNotifications(secret: Credential, org: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "organization:read");
      await tx.query(
        "UPDATE notifications SET read_at=now() WHERE organization_id=$1 AND user_id=$2 AND read_at IS NULL",
        [org, s.actorId],
      );
      return { ok: true };
    });
  }
}
type TemplateRow = {
  id: string;
  organization_id: string;
  branch_id: string;
  name: string;
  kind: string;
  checklist: string[];
  requires_verification: boolean;
  evidence: string;
  priority: string;
  assignee_id: string | null;
  deputy_id: string | null;
  recurrence: string;
  due_time: string;
  weekday: number | null;
  created_by: string;
};
function templateTask(
  tpl: TemplateRow,
  key: string,
  due: { date: string; time: string } | null,
) {
  return {
    key,
    branchId: tpl.branch_id,
    title: tpl.name,
    description: "",
    kind: tpl.kind,
    priority: tpl.priority,
    assigneeId: tpl.assignee_id,
    deputyId: tpl.deputy_id,
    due,
    requiresVerification: tpl.requires_verification,
    evidence: tpl.evidence,
    checklist: tpl.checklist,
    links: [],
  };
}
