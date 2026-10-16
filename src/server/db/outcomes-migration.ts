export const outcomesMigration = {
  version: 23,
  sql: `
CREATE TABLE outcome_measurements (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, branch_id uuid NOT NULL,
 source_type text NOT NULL CHECK(source_type IN ('order','purchase')), source_id uuid NOT NULL,
 forecast_minor numeric(38,0), baseline_minor numeric(38,0), baseline jsonb NOT NULL,
 limitations text NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,source_type,source_id),
 FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id),
 CHECK(forecast_minor IS NULL OR forecast_minor>=0), CHECK(baseline_minor IS NULL OR baseline_minor>=0)
);
CREATE INDEX outcome_branch_idx ON outcome_measurements(organization_id,branch_id,created_at);
CREATE INDEX outcome_creator_idx ON outcome_measurements(created_by);
`,
};
