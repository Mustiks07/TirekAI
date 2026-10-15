import type { Database } from "../db/database";
import { TaskService } from "../tasks/service";
import { InsightService } from "../decisions/insights";
import { ProposalService } from "../decisions/proposals";
import { AutomationService } from "../automations/service";
import { IntegrationService } from "../integrations/service";
import { runConnectors } from "../integrations/connectors";

// Background work for T021–T025. Each step is idempotent: repeated ticks, overlapping
// workers and restarts cannot duplicate tasks, situations, proposals or actions.
export class ExecutionWorker {
  constructor(private db: Database) {}
  async runOnce() {
    const tasks = new TaskService(this.db);
    const periodic = await tasks.generatePeriodic();
    const escalated = await tasks.escalate();
    const expired = await new ProposalService(this.db).expire();
    // Situation detection is throttled per organization (at most every 5 minutes).
    const stale = await this.db.query<{ id: string }>(
      "SELECT o.id FROM organizations o WHERE NOT EXISTS(SELECT 1 FROM insight_runs r WHERE r.organization_id=o.id AND r.started_at>now()-interval '5 minutes') ORDER BY o.id LIMIT 20",
    );
    const insights = new InsightService(this.db);
    for (const o of stale) await insights.detect(o.id);
    const automations = await new AutomationService(this.db).runOnce();
    const integrations = await new IntegrationService(this.db).runOnce();
    const connectors = await runConnectors(this.db);
    return {
      periodic,
      escalated,
      expired,
      detected: stale.length,
      automations,
      integrations,
      connectors,
    };
  }
}
