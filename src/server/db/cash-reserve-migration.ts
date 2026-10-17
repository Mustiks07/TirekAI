// T005/T052 dashboard: the minimum cash reserve the owner wants to keep, for the whole
// organization (branch_id NULL) or one branch. Used to warn when planned payments would take the
// cash below it; it never blocks or moves money.
export const cashReserveMigration = {
  version: 27,
  sql: `
CREATE TABLE cash_reserves (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id uuid,
  minimum_minor numeric(38,0) NOT NULL CHECK(minimum_minor>=0 AND minimum_minor<1e38),
  version integer NOT NULL DEFAULT 1,
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id)
);
CREATE UNIQUE INDEX cash_reserves_scope_idx ON cash_reserves(organization_id,coalesce(branch_id,'00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX cash_reserves_user_idx ON cash_reserves(updated_by);
`,
};
