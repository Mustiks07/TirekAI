import type { Database, Sql } from "../db/database";
import { sessionAccess, type Credential } from "../access";
import { can } from "../../domain/permissions";
import { visibleRules } from "./insights";
import { CommerceService } from "../commerce/service";
import type { ProposalRow } from "../../domain/decisions";
import { providerStatus } from "../assistant/provider";

// External source statuses are reported honestly; registered providers add their rows here.
export type SourceStatus = {
  name: string;
  status: string;
  checked_at: string | null;
};
export const sourceProviders: ((
  tx: Sql,
  org: string,
) => Promise<SourceStatus[]>)[] = [];
export class TodayService {
  constructor(private db: Database) {}
  async today(secret: Credential, org: string) {
    const base = await this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "organization:read");
      const rules = can(s.role, "insights:read") ? visibleRules(s.role) : [];
      const scope =
        "i.organization_id=$1 AND ($2::uuid IS NULL OR i.branch_id IS NULL OR i.branch_id=$2) AND i.rule=ANY($3::text[]) AND i.state IN ('open','acknowledged')";
      const situations = await tx.query(
        `SELECT i.id,i.branch_id,i.rule,i.entity_type,i.entity_id,i.severity,i.state,i.evidence,i.resolution,i.detected_at,i.last_seen_at,i.resolved_at,i.version FROM insights i WHERE ${scope} ORDER BY i.severity DESC,i.detected_at DESC,i.id LIMIT 5`,
        [org, s.branchId, rules],
      );
      const [count] = await tx.query<{ n: number }>(
        `SELECT count(*)::int n FROM insights i WHERE ${scope}`,
        [org, s.branchId, rules],
      );
      const [run] = await tx.query<{ finished_at: string }>(
        "SELECT finished_at FROM insight_runs WHERE organization_id=$1 AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1",
        [org],
      );
      const tasks = await tx.query(
        "SELECT t.id,t.branch_id,t.number,t.title,t.description,t.kind,t.source,t.source_id,t.priority,t.state,t.assignee_id,a.name assignee_name,t.deputy_id,d.name deputy_name,t.due_at,(t.due_at IS NOT NULL AND t.due_at<now()) overdue,t.requires_verification,t.evidence,t.links,t.blocked_reason,t.completion,t.escalated_at,cb.name completed_by_name,t.completed_at,vb.name verified_by_name,t.verified_at,cr.name created_by_name,t.version,t.created_at FROM tasks t LEFT JOIN users a ON a.id=t.assignee_id LEFT JOIN users d ON d.id=t.deputy_id LEFT JOIN users cb ON cb.id=t.completed_by LEFT JOIN users vb ON vb.id=t.verified_by JOIN users cr ON cr.id=t.created_by WHERE t.organization_id=$1 AND (t.assignee_id=$2 OR (t.deputy_id=$2 AND t.escalated_at IS NOT NULL) OR (t.state='done' AND t.requires_verification AND $3::boolean AND t.completed_by<>$2 AND ($4::uuid IS NULL OR t.branch_id=$4))) AND t.state NOT IN ('verified','cancelled') AND NOT (t.state='done' AND NOT t.requires_verification) ORDER BY t.due_at NULLS LAST,t.created_at LIMIT 5",
        [org, s.actorId, can(s.role, "tasks:verify"), s.branchId],
      );
      const pending = await tx.query<ProposalRow>(
        "SELECT p.id,p.branch_id,p.insight_id,p.kind,p.params,p.param_version,p.amount_minor::text,p.risk,p.requires_approval,p.state,p.origin,p.explanation,p.created_by,u.name created_by_name,p.executed_at,p.result_type,p.result_id,p.follow_up_task_id,p.error_code,p.outcome,p.expires_at,p.version,p.created_at FROM action_proposals p JOIN users u ON u.id=p.created_by WHERE p.organization_id=$1 AND ($2::uuid IS NULL OR p.branch_id=$2) AND ((p.state='pending' AND p.created_by<>$3 AND ((p.kind='purchase_order' AND $4::boolean) OR (p.kind='task' AND $5::boolean) OR EXISTS(SELECT 1 FROM approval_delegations g WHERE g.organization_id=p.organization_id AND g.to_user=$3 AND g.kind=p.kind AND g.revoked_at IS NULL AND g.valid_until>now()))) OR (p.state='approved' AND p.created_by=$3)) AND p.expires_at>now() ORDER BY p.created_at LIMIT 5",
        [
          org,
          s.branchId,
          s.actorId,
          can(s.role, "purchasing:approve"),
          can(s.role, "tasks:manage"),
        ],
      );
      const sources: SourceStatus[] = [
        {
          name: "internal",
          status: "available",
          checked_at: run?.finished_at || null,
        },
      ];
      for (const c of await tx.query<SourceStatus>(
        "SELECT 'moysklad' name,CASE WHEN status IN ('configured','live_verified','sandbox_verified') AND last_success_at<now()-interval '60 minutes' THEN 'degraded' ELSE status END status,last_success_at checked_at FROM integration_connections WHERE organization_id=$1 AND disconnected_at IS NULL",
        [org],
      ))
        sources.push(c);
      if (!sources.some((x) => x.name === "moysklad"))
        sources.push({
          name: "moysklad",
          status: "not_configured",
          checked_at: null,
        });
      sources.push({
        name: "assistant",
        status: providerStatus().status,
        checked_at: null,
      });
      for (const provider of sourceProviders)
        sources.push(...(await provider(tx, org)));
      return {
        as_of: new Date().toISOString(),
        last_detection: run?.finished_at || null,
        situations,
        situations_total: count.n,
        tasks,
        approvals: pending,
        sources,
        finance: can(s.role, "finance:read"),
      };
    });
    const { finance, ...view } = base;
    let metrics = null;
    if (finance) {
      const summary = await new CommerceService(this.db).summary(
        secret,
        org,
        {},
      );
      metrics = {
        cash_minor: summary.cash_minor,
        receivable_minor: summary.receivable_minor,
        payable_minor: summary.payable_minor,
        expenses_complete: summary.expenses_complete,
        unknown_cost_events: summary.unknown_cost_events,
      };
    }
    return { ...view, metrics };
  }
}
