import { createHash, randomUUID } from "node:crypto";
import type { Database, Sql } from "../db/database";
import {
  sessionAccess,
  actorAccess,
  audit,
  InternalActor,
  type Credential,
} from "../access";
import { AppError } from "../../domain/errors";
import { idSchema, type Role } from "../../domain/contracts";
import { can, type Permission } from "../../domain/permissions";
import { pagination } from "../../domain/import-contracts";
import { minorUnits } from "../../domain/decimal";
import { D, priceOffer, type OfferData } from "../../domain/purchasing";
import {
  proposalInput,
  proposalCommand,
  proposalRevision,
  proposalQuery,
  purchaseProposalParams,
  taskProposalParams,
  limitInput,
  delegationInput,
  type InsightRow,
} from "../../domain/decisions";
import {
  idempotent,
  emit,
  notify,
  organizationClock,
  type Chain,
} from "../execution/core";
import { PurchasingService } from "../purchasing/service";
import { TaskService, stableUuid } from "../tasks/service";
import { InsightService } from "./insights";

type Kind = "purchase_order" | "task";
// Approving a kind requires the same authority as the underlying business action.
const approvePermission: Record<Kind, Permission> = {
  purchase_order: "purchasing:approve",
  task: "tasks:manage",
};
const writePermission: Record<Kind, Permission> = {
  purchase_order: "purchasing:write",
  task: "tasks:write",
};
type Proposal = {
  id: string;
  branch_id: string;
  insight_id: string | null;
  kind: Kind;
  params: Record<string, unknown>;
  params_hash: string;
  param_version: number;
  amount_minor: string | null;
  risk: string;
  requires_approval: boolean;
  state: string;
  origin: string;
  created_by: string;
  expires_at: string;
  version: number;
};
const columns =
  "p.id,p.branch_id,p.insight_id,p.kind,p.params,p.params_hash,p.param_version,p.amount_minor::text,p.risk,p.requires_approval,p.state,p.origin,p.explanation,p.created_by,u.name created_by_name,p.executed_at,p.result_type,p.result_id,p.follow_up_task_id,p.error_code,p.outcome,p.expires_at,p.version,p.created_at";
// jsonb does not preserve key order, so the approval hash uses a canonical form.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  return value;
}
export const paramsHash = (params: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(params)))
    .digest("hex");
const hash = paramsHash;
export class ProposalService {
  constructor(private db: Database) {}
  // Price the exact parameters now; incomparable or unknown conditions are refused, not zeroed.
  private async evaluate(
    tx: Sql,
    org: string,
    kind: Kind,
    params: Record<string, unknown>,
  ) {
    if (kind === "task") {
      const p = taskProposalParams.parse(params);
      return {
        params: p,
        amount: null as bigint | null,
        risk: "low",
        requiresApproval: false,
        branch: p.branchId,
      };
    }
    const p = purchaseProposalParams.parse(params);
    let goods = 0n,
      delivery: bigint | null = null;
    for (const line of p.lines) {
      const [offer] = await tx.query<{ data: OfferData }>(
        "SELECT data FROM supplier_offers WHERE organization_id=$1 AND id=$2 AND supplier_id=$3",
        [org, line.offerId, p.supplierId],
      );
      if (!offer) throw new AppError("ITEM_MISMATCH", 422);
      const priced = priceOffer(offer.data, line.quantity, p.date);
      if (!priced.comparable) throw new AppError("OFFER_INCOMPARABLE", 422);
      goods += BigInt(priced.goods_minor!);
      if (delivery !== null && delivery !== BigInt(priced.delivery_minor!))
        throw new AppError("DELIVERY_CONFLICT", 422);
      delivery = BigInt(priced.delivery_minor!);
    }
    const amount = goods + (delivery || 0n);
    if (amount > minorUnits(p.budget))
      throw new AppError("BUDGET_EXCEEDED", 422);
    return {
      params: p,
      amount,
      risk: amount >= 100_000_000n ? "high" : "medium",
      requiresApproval: true,
      branch: p.branchId,
    };
  }
  async create(
    secret: Credential,
    org: string,
    input: unknown,
    origin: "user" | "assistant" | "automation" = "user",
    chain?: Chain,
  ) {
    return this.db.transaction((tx) =>
      this.createInTransaction(tx, secret, org, input, origin, chain),
    );
  }
  async createInTransaction(
    tx: Sql,
    secret: Credential,
    org: string,
    input: unknown,
    origin: "user" | "situation" | "assistant" | "automation" = "user",
    chain?: Chain,
  ) {
    const c = proposalInput.parse(input);
    const s = await sessionAccess(tx, secret, org, "proposals:write");
    const e = await this.evaluate(
      tx,
      org,
      c.kind,
      c.params as Record<string, unknown>,
    );
    // The proposer must be allowed to prepare this kind of action in this branch.
    await sessionAccess(tx, secret, org, writePermission[c.kind], e.branch);
    const r = await idempotent(tx, org, c.key, {
      operation: "proposal.create",
      ...c,
      origin,
    });
    if (r.reused) return r;
    if (c.insightId) {
      const [i] = await tx.query<{ branch_id: string | null }>(
        "SELECT branch_id FROM insights WHERE organization_id=$1 AND id=$2",
        [org, c.insightId],
      );
      if (!i || (i.branch_id && i.branch_id !== e.branch))
        throw new AppError("LINK_NOT_FOUND", 422);
    }
    const state = !c.submit
      ? "draft"
      : e.requiresApproval
        ? "pending"
        : "approved";
    await tx.query(
      "INSERT INTO action_proposals(id,organization_id,branch_id,insight_id,kind,params,params_hash,amount_minor,risk,requires_approval,state,origin,explanation,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now()+interval '72 hours')",
      [
        r.id,
        org,
        e.branch,
        c.insightId,
        c.kind,
        JSON.stringify(e.params),
        hash(e.params),
        e.amount?.toString() ?? null,
        e.risk,
        e.requiresApproval,
        state,
        c.insightId && origin === "user" ? "situation" : origin,
        JSON.stringify({
          priced_at: new Date().toISOString(),
          method:
            c.kind === "purchase_order"
              ? "supplier offers, whole packs, delivery once"
              : "none",
        }),
        s.actorId,
      ],
    );
    await emit(tx, {
      org,
      branch: e.branch,
      topic: "proposal.created",
      entityType: "proposal",
      entityId: r.id,
      payload: { kind: c.kind, state, origin },
      actorId: s.actorId,
      chain,
      dedupeKey: `proposal.created:${r.id}`,
    });
    if (state === "pending")
      await this.notifyApprovers(tx, org, r.id, c.kind, e.branch);
    await audit(tx, org, s.actorId, "proposal.created", e.branch, {
      proposalId: r.id,
      kind: c.kind,
    });
    return r;
  }
  private async notifyApprovers(
    tx: Sql,
    org: string,
    id: string,
    kind: Kind,
    branch: string,
  ) {
    const roles = (["owner", "manager"] as Role[]).filter((r) =>
      can(r, approvePermission[kind]),
    );
    const users = await tx.query<{ user_id: string }>(
      "SELECT user_id FROM memberships WHERE organization_id=$1 AND role=ANY($2::text[]) AND (branch_id IS NULL OR branch_id=$3) LIMIT 20",
      [org, roles, branch],
    );
    for (const u of users)
      await notify(
        tx,
        org,
        u.user_id,
        "proposal.pending",
        "proposal",
        id,
        `proposal:${id}:pending`,
      );
  }
  // A low-stock situation becomes a draft purchase with the cheapest comparable offer; the user reviews it.
  async fromInsight(
    secret: Credential,
    org: string,
    insightId: string,
    input: unknown,
  ) {
    idSchema.parse(insightId);
    const key = idSchema.parse((input as { key?: unknown })?.key);
    return this.db.transaction((tx) =>
      this.fromInsightInTransaction(tx, secret, org, insightId, key),
    );
  }
  async fromInsightInTransaction(
    tx: Sql,
    secret: Credential,
    org: string,
    insightId: string,
    key: string,
    origin: "situation" | "automation" | "assistant" = "situation",
    submit = false,
    chain?: Chain,
  ) {
    const s = await sessionAccess(tx, secret, org, "insights:read");
    const insight = await new InsightService(this.db).load(
      tx,
      org,
      insightId,
      s,
    );
    const draft = await this.suggest(tx, org, insight);
    return this.createInTransaction(
      tx,
      secret,
      org,
      { key, insightId, submit, ...draft },
      origin,
      chain,
    );
  }
  private async suggest(tx: Sql, org: string, insight: InsightRow) {
    const f = insight.evidence.facts;
    const clock = await organizationClock(tx, org);
    if (insight.rule === "low_stock") {
      if (!f.suggested_offer_id) throw new AppError("NO_COMPARABLE_OFFER", 422);
      const [w] = await tx.query<{ branch_id: string }>(
        "SELECT branch_id FROM warehouses WHERE organization_id=$1 AND id=$2",
        [org, f.warehouse_id],
      );
      const [offer] = await tx.query<{ supplier_id: string; data: OfferData }>(
        "SELECT supplier_id,data FROM supplier_offers WHERE organization_id=$1 AND id=$2",
        [org, f.suggested_offer_id],
      );
      const total = new D(String(f.suggested_total_minor)).div(100).toFixed(2);
      const due = new Date(`${clock.today}T00:00:00Z`);
      due.setUTCDate(due.getUTCDate() + Number(offer.data.leadDays || 0));
      return {
        kind: "purchase_order" as const,
        params: {
          branchId: w.branch_id,
          warehouseId: String(f.warehouse_id),
          supplierId: offer.supplier_id,
          date: clock.today,
          dueDate: due.toISOString().slice(0, 10),
          budget: total,
          note: `Нехватка / Тапшылық: ${insight.evidence.title}`.slice(0, 250),
          lines: [
            {
              offerId: String(f.suggested_offer_id),
              quantity: String(f.shortage),
            },
          ],
          followUp: null,
        },
      };
    }
    return {
      kind: "task" as const,
      params: {
        branchId: insight.branch_id!,
        title: insight.evidence.title.slice(0, 160),
        description: `${insight.rule}: ${insight.evidence.calculation}`,
        kind: "general",
        priority: insight.severity >= 3 ? "high" : "normal",
        assigneeId: null,
        deputyId: null,
        due: null,
        requiresVerification: true,
        evidence: "comment",
        checklist: [],
        links: [{ type: "insight", id: insight.id }],
      },
    };
  }
  private async load(
    tx: Sql,
    org: string,
    id: string,
    s: { branchId: string | null },
    lock = false,
  ) {
    idSchema.parse(id);
    const [p] = await tx.query<Proposal>(
      `SELECT ${columns} FROM action_proposals p JOIN users u ON u.id=p.created_by WHERE p.organization_id=$1 AND p.id=$2 AND ($3::uuid IS NULL OR p.branch_id=$3) ${lock ? "FOR UPDATE OF p" : ""}`,
      [org, id, s.branchId],
    );
    if (!p) throw new AppError("NOT_FOUND", 404);
    return p;
  }
  // Authority to approve: own role within its limit, or an active delegation whose author still has it.
  private async authority(tx: Sql, org: string, actorId: string, p: Proposal) {
    const amount = BigInt(p.amount_minor || "0");
    const [m] = await tx.query<{ role: Role; branch_id: string | null }>(
      "SELECT role,branch_id FROM memberships WHERE organization_id=$1 AND user_id=$2",
      [org, actorId],
    );
    if (!m || (m.branch_id && m.branch_id !== p.branch_id)) return null;
    if (can(m.role, approvePermission[p.kind])) {
      if (m.role === "owner") return { delegationId: null };
      const [limit] = await tx.query<{ limit_minor: string }>(
        "SELECT limit_minor::text FROM approval_limits WHERE organization_id=$1 AND role=$2 AND kind=$3",
        [org, m.role, p.kind],
      );
      if (!limit || amount <= BigInt(limit.limit_minor))
        return { delegationId: null };
    }
    const delegations = await tx.query<{
      id: string;
      from_user: string;
      max_amount_minor: string;
    }>(
      "SELECT id,from_user,max_amount_minor::text FROM approval_delegations WHERE organization_id=$1 AND to_user=$2 AND kind=$3 AND revoked_at IS NULL AND valid_until>now() ORDER BY created_at",
      [org, actorId, p.kind],
    );
    for (const d of delegations) {
      if (amount > BigInt(d.max_amount_minor) || d.from_user === p.created_by)
        continue;
      // The delegator's own authority is re-checked now; delegation never exceeds it.
      if (
        await this.authority(tx, org, d.from_user, {
          ...p,
          created_by: actorId,
        }).then((a) => a && a.delegationId === null)
      )
        return { delegationId: d.id };
    }
    return null;
  }
  async command(secret: Credential, org: string, id: string, input: unknown) {
    const c = proposalCommand.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "proposals:write").catch(
        async (e) => {
          // Approvers by delegation may hold a role without proposals:write.
          if (c.kind === "approve" || c.kind === "reject")
            return sessionAccess(tx, secret, org, "organization:read");
          throw e;
        },
      );
      const p = await this.load(tx, org, id, s, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "proposal.command",
        id,
        ...c,
      });
      if (r.reused) return r;
      if (p.version !== c.version) throw new AppError("VERSION_CONFLICT", 409);
      if (
        ["pending", "approved", "draft"].includes(p.state) &&
        new Date(p.expires_at) < new Date() &&
        c.kind !== "cancel"
      )
        throw new AppError("PROPOSAL_EXPIRED", 409);
      switch (c.kind) {
        case "submit":
          if (p.state !== "draft") throw new AppError("PROPOSAL_STATE", 409);
          if (
            p.created_by !== s.actorId &&
            !can(s.role, approvePermission[p.kind])
          )
            throw new AppError("FORBIDDEN", 403);
          await this.evaluate(tx, org, p.kind, p.params);
          await this.update(
            tx,
            org,
            id,
            p.requires_approval ? "pending" : "approved",
            "expires_at=now()+interval '72 hours'",
          );
          if (p.requires_approval)
            await this.notifyApprovers(tx, org, id, p.kind, p.branch_id);
          break;
        case "approve":
        case "reject": {
          if (p.state !== "pending") throw new AppError("PROPOSAL_STATE", 409);
          // The decision is bound to the parameter version the approver actually saw.
          if (c.paramVersion !== p.param_version)
            throw new AppError("PARAMS_CHANGED", 409);
          if (p.created_by === s.actorId)
            throw new AppError("SELF_APPROVAL", 403);
          const a = await this.authority(tx, org, s.actorId, p);
          if (!a) throw new AppError("APPROVAL_LIMIT", 403);
          await tx.query(
            "INSERT INTO approvals(id,organization_id,proposal_id,param_version,params_hash,decision,actor_id,delegation_id,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              randomUUID(),
              org,
              id,
              p.param_version,
              p.params_hash,
              c.kind === "approve" ? "approved" : "rejected",
              s.actorId,
              a.delegationId,
              c.note,
            ],
          );
          await this.update(
            tx,
            org,
            id,
            c.kind === "approve" ? "approved" : "rejected",
          );
          await notify(
            tx,
            org,
            p.created_by,
            `proposal.${c.kind}d`,
            "proposal",
            id,
            `proposal:${id}:${c.kind}:${p.param_version}`,
          );
          break;
        }
        case "execute":
          await this.execute(tx, s, org, p);
          break;
        case "cancel":
          if (!["draft", "pending", "approved", "failed"].includes(p.state))
            throw new AppError("PROPOSAL_STATE", 409);
          if (
            p.created_by !== s.actorId &&
            !can(s.role, approvePermission[p.kind])
          )
            throw new AppError("FORBIDDEN", 403);
          await this.update(tx, org, id, "cancelled");
          break;
      }
      await emit(tx, {
        org,
        branch: p.branch_id,
        topic: `proposal.${c.kind}`,
        entityType: "proposal",
        entityId: id,
        payload: { kind: p.kind, paramVersion: p.param_version },
        actorId: s.actorId,
        dedupeKey: `proposal.${c.kind}:${id}:${p.version}`,
      });
      await audit(tx, org, s.actorId, `proposal.${c.kind}`, p.branch_id, {
        proposalId: id,
      });
      return r;
    });
  }
  private async update(
    tx: Sql,
    org: string,
    id: string,
    state: string,
    extra = "",
  ) {
    await tx.query(
      `UPDATE action_proposals SET state=$3,version=version+1,updated_at=now()${extra ? "," + extra : ""} WHERE organization_id=$1 AND id=$2`,
      [org, id, state],
    );
  }
  // Execution re-checks the approval, its author's current authority, the executor's rights and
  // the parameters hash; the business command reuses the proposal id as its idempotency key.
  private async execute(
    tx: Sql,
    s: { actorId: string; role: Role },
    org: string,
    p: Proposal,
  ) {
    if (p.state !== "approved") throw new AppError("PROPOSAL_STATE", 409);
    if (hash(p.params) !== p.params_hash)
      throw new AppError("PARAMS_CHANGED", 409);
    let approver = p.created_by;
    if (p.requires_approval) {
      const [a] = await tx.query<{ actor_id: string; params_hash: string }>(
        "SELECT actor_id,params_hash FROM approvals WHERE organization_id=$1 AND proposal_id=$2 AND param_version=$3 AND decision='approved'",
        [org, p.id, p.param_version],
      );
      if (!a || a.params_hash !== p.params_hash)
        throw new AppError("APPROVAL_REQUIRED", 409);
      if (!(await this.authority(tx, org, a.actor_id, p)))
        throw new AppError("APPROVAL_REVOKED", 409);
      approver = a.actor_id;
    }
    const executor = new InternalActor(s.actorId, "approval");
    await actorAccess(tx, s.actorId, org, writePermission[p.kind], p.branch_id);
    let resultId: string,
      followUp: string | null = null;
    const savepoint = `proposal_${p.id.replace(/-/g, "")}`;
    await tx.query(`SAVEPOINT ${savepoint}`);
    try {
      if (p.kind === "purchase_order") {
        const params = purchaseProposalParams.parse(p.params);
        const { followUp: task, ...purchase } = params;
        const purchasing = new PurchasingService(this.db);
        resultId = (
          await purchasing.createInTransaction(tx, executor, org, {
            ...purchase,
            key: p.id,
          })
        ).id;
        for (const kind of ["submit", "approve"] as const)
          await purchasing.transitionInTransaction(
            tx,
            executor,
            org,
            resultId,
            {
              key: stableUuid(`${p.id}:${kind}`),
              version: kind === "submit" ? 1 : 2,
              kind,
              note: `Proposal ${p.id.slice(0, 8)} approved`,
            },
            kind === "approve"
              ? { proposalId: p.id, approverId: approver }
              : undefined,
          );
        if (task)
          followUp = (
            await new TaskService(this.db).createInTransaction(
              tx,
              executor,
              org,
              {
                key: stableUuid(`${p.id}:follow-up`),
                branchId: params.branchId,
                title: `Отправить и принять закупку / Сатып алуды жіберу және қабылдау`,
                description: params.note,
                kind: "purchase",
                priority: "high",
                assigneeId: task.assigneeId,
                due: task.due,
                requiresVerification: true,
                evidence: "operation",
                links: [
                  { type: "purchase_order", id: resultId },
                  { type: "proposal", id: p.id },
                  ...(p.insight_id
                    ? [{ type: "insight" as const, id: p.insight_id }]
                    : []),
                ],
              },
              { source: "proposal", sourceId: p.id },
            )
          ).id;
      } else {
        resultId = (
          await new TaskService(this.db).createInTransaction(
            tx,
            executor,
            org,
            { ...taskProposalParams.parse(p.params), key: p.id },
            { source: "proposal", sourceId: p.id },
          )
        ).id;
      }
      await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) throw error;
      // Business refusal: roll back partial work and record a visible failure, never a success.
      await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await tx.query(
        "UPDATE action_proposals SET state='failed',error_code=$3,executed_by=$4,version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2",
        [org, p.id, error.code, s.actorId],
      );
      return;
    }
    await tx.query(
      "UPDATE action_proposals SET state='executed',executed_by=$3,executed_at=now(),result_type=$4,result_id=$5,follow_up_task_id=$6,outcome=$7,version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2",
      [
        org,
        p.id,
        s.actorId,
        p.kind,
        resultId,
        followUp,
        JSON.stringify({
          status: p.insight_id ? "pending_effect" : "not_applicable",
          checked_at: new Date().toISOString(),
        }),
      ],
    );
  }
  async revise(secret: Credential, org: string, id: string, input: unknown) {
    const c = proposalRevision.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "proposals:write");
      const p = await this.load(tx, org, id, s, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "proposal.revise",
        id,
        ...c,
      });
      if (r.reused) return r;
      if (p.version !== c.version) throw new AppError("VERSION_CONFLICT", 409);
      if (!["draft", "pending", "approved"].includes(p.state))
        throw new AppError("PROPOSAL_STATE", 409);
      if (p.created_by !== s.actorId && !can(s.role, writePermission[p.kind]))
        throw new AppError("FORBIDDEN", 403);
      const e = await this.evaluate(tx, org, p.kind, c.params);
      if (e.branch !== p.branch_id) throw new AppError("BRANCH_CHANGE", 422);
      // Any change of amount or composition invalidates earlier approvals: back to pending.
      const next =
        p.state === "draft"
          ? "draft"
          : e.requiresApproval
            ? "pending"
            : "approved";
      await tx.query(
        "UPDATE action_proposals SET params=$3,params_hash=$4,amount_minor=$5,risk=$6,param_version=param_version+1,state=$7,version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2",
        [
          org,
          id,
          JSON.stringify(e.params),
          hash(e.params),
          e.amount?.toString() ?? null,
          e.risk,
          next,
        ],
      );
      if (next === "pending" && p.state === "approved")
        await this.notifyApprovers(tx, org, id, p.kind, p.branch_id);
      await audit(tx, org, s.actorId, "proposal.revised", p.branch_id, {
        proposalId: id,
        note: c.note,
      });
      return r;
    });
  }
  async list(secret: Credential, org: string, input: unknown) {
    const q = proposalQuery.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(
        tx,
        secret,
        org,
        "organization:read",
        q.branchId,
      );
      const kinds = (["purchase_order", "task"] as Kind[]).filter(
        (k) =>
          can(s.role, writePermission[k]) || can(s.role, approvePermission[k]),
      );
      const delegated = await tx.query<{ kind: string }>(
        "SELECT DISTINCT kind FROM approval_delegations WHERE organization_id=$1 AND to_user=$2 AND revoked_at IS NULL AND valid_until>now()",
        [org, s.actorId],
      );
      for (const d of delegated)
        if (!kinds.includes(d.kind as Kind)) kinds.push(d.kind as Kind);
      if (!kinds.length) throw new AppError("FORBIDDEN", 403);
      const where =
        "p.organization_id=$1 AND ($2::uuid IS NULL OR p.branch_id=$2) AND p.kind=ANY($3::text[]) AND (CASE $4::text WHEN '' THEN true WHEN 'awaiting_me' THEN p.state='pending' AND p.created_by<>$5 ELSE p.state=$4 END) AND ($6::uuid IS NULL OR p.insight_id=$6)";
      const params = [
        org,
        s.branchId,
        kinds,
        q.state || "",
        s.actorId,
        q.insightId || null,
      ];
      const [c] = await tx.query<{ total: number }>(
        `SELECT count(*)::int total FROM action_proposals p WHERE ${where}`,
        params,
      );
      return {
        items: await tx.query(
          `SELECT ${columns} FROM action_proposals p JOIN users u ON u.id=p.created_by WHERE ${where} ORDER BY p.created_at DESC,p.id LIMIT $7 OFFSET $8`,
          [...params, q.limit, (q.page - 1) * q.limit],
        ),
        pagination: pagination(q.page, q.limit, c.total),
      };
    });
  }
  async get(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "organization:read");
      const p = await this.load(tx, org, id, s);
      const approve =
        p.state === "pending" &&
        p.created_by !== s.actorId &&
        !!(await this.authority(tx, org, s.actorId, p));
      if (
        !approve &&
        !can(s.role, writePermission[p.kind]) &&
        !can(s.role, approvePermission[p.kind])
      )
        throw new AppError("NOT_FOUND", 404);
      return {
        proposal: p,
        approvals: await tx.query(
          "SELECT a.id,a.param_version,a.decision,u.name actor_name,(a.delegation_id IS NOT NULL) delegated,a.note,a.created_at FROM approvals a JOIN users u ON u.id=a.actor_id WHERE a.organization_id=$1 AND a.proposal_id=$2 ORDER BY a.created_at",
          [org, id],
        ),
        canApprove: approve,
        canExecute:
          p.state === "approved" && can(s.role, writePermission[p.kind]),
      };
    });
  }
  async policy(secret: Credential, org: string) {
    return this.db.transaction(async (tx) => {
      await sessionAccess(tx, secret, org, "proposals:write");
      return {
        limits: await tx.query(
          "SELECT role,kind,limit_minor::text FROM approval_limits WHERE organization_id=$1 ORDER BY role,kind",
          [org],
        ),
        delegations: await tx.query(
          "SELECT d.id,f.name from_name,t.name to_name,d.kind,d.max_amount_minor::text,d.valid_until,d.revoked_at FROM approval_delegations d JOIN users f ON f.id=d.from_user JOIN users t ON t.id=d.to_user WHERE d.organization_id=$1 ORDER BY d.created_at DESC LIMIT 100",
          [org],
        ),
      };
    });
  }
  async setLimit(secret: Credential, org: string, input: unknown) {
    const c = limitInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "organization:write");
      if (c.limit === null)
        await tx.query(
          "DELETE FROM approval_limits WHERE organization_id=$1 AND role=$2 AND kind=$3",
          [org, c.role, c.kind],
        );
      else
        await tx.query(
          "INSERT INTO approval_limits(organization_id,role,kind,limit_minor) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,role,kind) DO UPDATE SET limit_minor=$4,version=approval_limits.version+1",
          [org, c.role, c.kind, minorUnits(c.limit).toString()],
        );
      await audit(tx, org, s.actorId, "approval.limit_saved", null, {
        role: c.role,
        kind: c.kind,
      });
      return { ok: true };
    });
  }
  async delegate(secret: Credential, org: string, input: unknown) {
    const c = delegationInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, approvePermission[c.kind]);
      const r = await idempotent(tx, org, c.key, {
        operation: "approval.delegate",
        ...c,
      });
      if (r.reused) return r;
      if (c.toUser === s.actorId) throw new AppError("DELEGATE_SELF", 422);
      const [m] = await tx.query(
        "SELECT id FROM memberships WHERE organization_id=$1 AND user_id=$2",
        [org, c.toUser],
      );
      if (!m) throw new AppError("ASSIGNEE_SCOPE", 422);
      if (new Date(c.validUntil) <= new Date())
        throw new AppError("INVALID_INPUT", 422);
      await tx.query(
        "INSERT INTO approval_delegations(id,organization_id,from_user,to_user,kind,max_amount_minor,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          r.id,
          org,
          s.actorId,
          c.toUser,
          c.kind,
          minorUnits(c.maxAmount).toString(),
          c.validUntil,
        ],
      );
      await audit(tx, org, s.actorId, "approval.delegated", null, {
        delegationId: r.id,
      });
      return r;
    });
  }
  async revokeDelegation(secret: Credential, org: string, id: string) {
    idSchema.parse(id);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "organization:read");
      const rows = await tx.query(
        "UPDATE approval_delegations SET revoked_at=now() WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL AND (from_user=$3 OR $4::boolean) RETURNING id",
        [org, id, s.actorId, s.role === "owner"],
      );
      if (!rows.length) throw new AppError("NOT_FOUND", 404);
      await audit(tx, org, s.actorId, "approval.delegation_revoked", null, {
        delegationId: id,
      });
      return { ok: true };
    });
  }
  // Worker: pending/approved proposals past their deadline become expired, never executed late.
  async expire() {
    const rows = await this.db.query<{ id: string }>(
      "UPDATE action_proposals SET state='expired',version=version+1,updated_at=now() WHERE state IN ('draft','pending','approved') AND expires_at<now() RETURNING id",
    );
    return rows.length;
  }
}
