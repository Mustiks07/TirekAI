export const reviewMigration = {
  version: 25,
  sql: `
CREATE TABLE privacy_import_tombstones (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  branch_id uuid NOT NULL,
  external_hash text NOT NULL,
  PRIMARY KEY(organization_id,branch_id,external_hash),
  FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id)
);
-- Repair readable history and remove raw files left by the previous erasure implementation.
UPDATE import_batches b SET source_content='' WHERE EXISTS (
  SELECT 1 FROM import_rows r JOIN customers c ON c.organization_id=r.organization_id AND c.id=r.customer_id
  WHERE r.organization_id=b.organization_id AND r.batch_id=b.id AND c.erased_at IS NOT NULL
);
UPDATE import_rows r SET data='{"external_id":"","name":"","email":"","phone":""}'::jsonb,
  errors='["SUBJECT_ERASED"]'::jsonb
WHERE EXISTS (SELECT 1 FROM customers c WHERE c.organization_id=r.organization_id AND c.id=r.customer_id AND c.erased_at IS NOT NULL);
CREATE TABLE assistant_budget_reservations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  reserved_tokens integer NOT NULL CHECK(reserved_tokens>0),
  actual_tokens integer CHECK(actual_tokens>=0),
  breached boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
UPDATE sync_conflicts x SET local=NULL,remote='{}'::jsonb,state='kept_local',resolved_at=now()
WHERE EXISTS(SELECT 1 FROM customers c WHERE c.organization_id=x.organization_id AND c.id=x.internal_id AND c.erased_at IS NOT NULL);
CREATE INDEX assistant_budget_org_idx ON assistant_budget_reservations(organization_id,created_at);
ALTER TABLE assistant_usage ADD COLUMN reservation_id uuid UNIQUE REFERENCES assistant_budget_reservations(id);
`,
};
