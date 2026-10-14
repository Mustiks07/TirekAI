// T025: automation rules with immutable versions, saved test runs, and an execution journal
// with lease fencing, retry and a manual review (dead letter) state.
export const automationMigration = {
  version: 11,
  sql: `
CREATE TABLE automation_rules (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), branch_id uuid, name text NOT NULL,
 state text NOT NULL CHECK(state IN ('draft','active','paused','disabled')), current_version integer NOT NULL CHECK(current_version>0), tested_version integer,
 paused_reason text, version integer NOT NULL DEFAULT 1, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,name), FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id),
 CHECK(state<>'active' OR tested_version=current_version)
);
CREATE INDEX automation_rules_creator_idx ON automation_rules(created_by);
CREATE INDEX automation_rules_active_idx ON automation_rules(organization_id,state);
CREATE TABLE automation_rule_versions (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, rule_id uuid NOT NULL, number integer NOT NULL, definition jsonb NOT NULL, note text NOT NULL,
 author_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,rule_id,number), FOREIGN KEY(organization_id,rule_id) REFERENCES automation_rules(organization_id,id)
);
CREATE INDEX automation_versions_author_idx ON automation_rule_versions(author_id);
CREATE TABLE automation_test_runs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, rule_id uuid NOT NULL, rule_version integer NOT NULL, event jsonb NOT NULL, result jsonb NOT NULL,
 passed boolean NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,rule_id) REFERENCES automation_rules(organization_id,id)
);
CREATE INDEX automation_tests_rule_idx ON automation_test_runs(organization_id,rule_id,created_at DESC);
CREATE INDEX automation_tests_actor_idx ON automation_test_runs(actor_id);
CREATE TABLE automation_executions (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, rule_id uuid NOT NULL, rule_version integer NOT NULL, event_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','running','succeeded','skipped','failed','dead')), skip_reason text, attempts integer NOT NULL DEFAULT 0,
 error_code text, result jsonb, available_at timestamptz NOT NULL DEFAULT now(), lease_token uuid, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, version integer NOT NULL DEFAULT 1,
 UNIQUE(organization_id,id), UNIQUE(rule_id,event_id),
 FOREIGN KEY(organization_id,rule_id) REFERENCES automation_rules(organization_id,id), FOREIGN KEY(organization_id,event_id) REFERENCES domain_events(organization_id,id)
);
CREATE INDEX automation_executions_ready_idx ON automation_executions(state,available_at);
CREATE INDEX automation_executions_rule_idx ON automation_executions(organization_id,rule_id,created_at DESC);
CREATE INDEX automation_executions_event_idx ON automation_executions(organization_id,event_id);
`,
};
