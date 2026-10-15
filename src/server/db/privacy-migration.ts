// T053: personal data erasure (SPECIFICATION §20 "удаление"). Erased subjects keep their row so
// that accounting records stay linked; the personal fields are replaced and the subject is locked.
// privacy_requests records what was erased, by whom and why — without the erased values.
export const privacyMigration = {
  version: 24,
  sql: `
ALTER TABLE customers ADD COLUMN erased_at timestamptz;
ALTER TABLE industry_documents ADD COLUMN erased_at timestamptz;
CREATE TABLE privacy_requests (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), branch_id uuid,
 subject_type text NOT NULL CHECK(subject_type IN ('customer','clinic_request')), subject_id uuid NOT NULL,
 reason text NOT NULL CHECK(reason IN ('subject_request','retention_expired','consent_withdrawn')),
 counts jsonb NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,subject_type,subject_id),
 FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id)
);
CREATE INDEX privacy_requests_actor_idx ON privacy_requests(actor_id);
CREATE INDEX privacy_requests_branch_idx ON privacy_requests(organization_id,branch_id);
`,
};
