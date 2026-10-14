// T023–T024: reorder points, detected situations with evidence, action proposals bound to a
// parameter version, approvals, limits and delegation.
export const decisionsMigration = {
  version: 10,
  sql: `
CREATE TABLE reorder_points (
 organization_id uuid NOT NULL REFERENCES organizations(id), warehouse_id uuid NOT NULL, item_id uuid NOT NULL,
 minimum numeric(21,6) NOT NULL CHECK(minimum>=0), safety numeric(21,6) NOT NULL CHECK(safety>=0), lead_days integer NOT NULL CHECK(lead_days BETWEEN 0 AND 365),
 version integer NOT NULL DEFAULT 1, updated_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,warehouse_id,item_id),
 FOREIGN KEY(organization_id,warehouse_id) REFERENCES warehouses(organization_id,id), FOREIGN KEY(organization_id,item_id) REFERENCES catalog_items(organization_id,id)
);
CREATE INDEX reorder_item_idx ON reorder_points(organization_id,item_id);
CREATE INDEX reorder_updated_by_idx ON reorder_points(updated_by);
CREATE TABLE insights (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), branch_id uuid, rule text NOT NULL,
 entity_type text NOT NULL, entity_id uuid NOT NULL, fingerprint text NOT NULL, severity integer NOT NULL CHECK(severity BETWEEN 1 AND 4),
 state text NOT NULL CHECK(state IN ('open','acknowledged','resolved','dismissed')), evidence jsonb NOT NULL, resolution jsonb,
 detected_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
 version integer NOT NULL DEFAULT 1, UNIQUE(organization_id,id), FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id)
);
CREATE UNIQUE INDEX insights_active_idx ON insights(organization_id,fingerprint) WHERE state IN ('open','acknowledged');
CREATE INDEX insights_scope_idx ON insights(organization_id,branch_id,state,severity DESC);
CREATE TABLE insight_runs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 opened integer NOT NULL DEFAULT 0, resolved integer NOT NULL DEFAULT 0, seen integer NOT NULL DEFAULT 0, error_code text
);
CREATE INDEX insight_runs_org_idx ON insight_runs(organization_id,started_at DESC);
CREATE TABLE action_proposals (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), branch_id uuid NOT NULL, insight_id uuid,
 kind text NOT NULL CHECK(kind IN ('purchase_order','task')), params jsonb NOT NULL, params_hash text NOT NULL, param_version integer NOT NULL DEFAULT 1,
 amount_minor numeric(38,0), risk text NOT NULL CHECK(risk IN ('low','medium','high')), requires_approval boolean NOT NULL,
 state text NOT NULL CHECK(state IN ('draft','pending','approved','rejected','expired','cancelled','executed','failed')),
 origin text NOT NULL CHECK(origin IN ('user','situation','assistant','automation')), explanation jsonb NOT NULL DEFAULT '{}',
 created_by uuid NOT NULL REFERENCES users(id), executed_by uuid REFERENCES users(id), executed_at timestamptz,
 result_type text, result_id uuid, follow_up_task_id uuid, error_code text, outcome jsonb, expires_at timestamptz NOT NULL,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id),
 FOREIGN KEY(organization_id,insight_id) REFERENCES insights(organization_id,id),
 CHECK(state<>'executed' OR (result_id IS NOT NULL AND executed_at IS NOT NULL))
);
CREATE INDEX proposals_scope_idx ON action_proposals(organization_id,branch_id,state,created_at DESC);
CREATE INDEX proposals_insight_idx ON action_proposals(organization_id,insight_id);
CREATE INDEX proposals_creator_idx ON action_proposals(created_by);
CREATE INDEX proposals_executor_idx ON action_proposals(executed_by);
CREATE TABLE approvals (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, proposal_id uuid NOT NULL, param_version integer NOT NULL, params_hash text NOT NULL,
 decision text NOT NULL CHECK(decision IN ('approved','rejected')), actor_id uuid NOT NULL REFERENCES users(id), delegation_id uuid, note text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,proposal_id,param_version),
 FOREIGN KEY(organization_id,proposal_id) REFERENCES action_proposals(organization_id,id)
);
CREATE INDEX approvals_actor_idx ON approvals(actor_id);
CREATE TABLE approval_limits (
 organization_id uuid NOT NULL REFERENCES organizations(id), role text NOT NULL CHECK(role IN ('manager','purchasing','finance','sales')),
 kind text NOT NULL CHECK(kind IN ('purchase_order','task')), limit_minor numeric(38,0) NOT NULL CHECK(limit_minor>=0),
 version integer NOT NULL DEFAULT 1, PRIMARY KEY(organization_id,role,kind)
);
CREATE TABLE approval_delegations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), from_user uuid NOT NULL REFERENCES users(id), to_user uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('purchase_order','task')), max_amount_minor numeric(38,0) NOT NULL CHECK(max_amount_minor>=0),
 valid_until timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,id),
 CHECK(from_user<>to_user)
);
CREATE INDEX delegations_to_idx ON approval_delegations(organization_id,to_user,kind);
CREATE INDEX delegations_from_idx ON approval_delegations(from_user);
CREATE INDEX delegations_to_user_idx ON approval_delegations(to_user);
ALTER TABLE approvals ADD CONSTRAINT approval_delegation_fk FOREIGN KEY(organization_id,delegation_id) REFERENCES approval_delegations(organization_id,id);
CREATE INDEX approvals_delegation_idx ON approvals(organization_id,delegation_id);
`,
};
