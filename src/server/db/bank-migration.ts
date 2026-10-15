// T033: bank statements in the 1C "Client bank" exchange format. A statement line is evidence of
// a bank movement; it changes money only when a person posts or matches it through the money
// command. Lines are deduplicated across overlapping statements.
export const bankMigration = {
  version: 16,
  sql: `
ALTER TABLE money_accounts ADD COLUMN bank_account text;
CREATE UNIQUE INDEX money_accounts_bank_idx ON money_accounts(organization_id,bank_account) WHERE bank_account IS NOT NULL;
CREATE TABLE bank_statements (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, account_id uuid NOT NULL, filename text NOT NULL, sha256 text NOT NULL,
 format_version text NOT NULL, period_start date NOT NULL, period_end date NOT NULL,
 opening_minor numeric(38,0), incoming_minor numeric(38,0), outgoing_minor numeric(38,0), closing_minor numeric(38,0),
 consistent boolean NOT NULL, issues jsonb NOT NULL DEFAULT '[]', lines integer NOT NULL, duplicates integer NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,account_id,sha256),
 FOREIGN KEY(organization_id,account_id) REFERENCES money_accounts(organization_id,id)
);
CREATE INDEX bank_statements_account_idx ON bank_statements(organization_id,account_id,created_at DESC);
CREATE INDEX bank_statements_creator_idx ON bank_statements(created_by);
CREATE TABLE bank_statement_lines (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, statement_id uuid NOT NULL, account_id uuid NOT NULL, dedupe_key text NOT NULL,
 direction text NOT NULL CHECK(direction IN ('in','out')), doc_kind text NOT NULL, doc_number text NOT NULL, doc_date date NOT NULL, booked_date date NOT NULL,
 amount_minor numeric(38,0) NOT NULL CHECK(amount_minor>0), counterparty text NOT NULL, counterparty_bin text NOT NULL, counterparty_account text NOT NULL,
 purpose text NOT NULL, state text NOT NULL CHECK(state IN ('new','matched','posted','ignored')), money_entry_id uuid, suggestions jsonb NOT NULL DEFAULT '[]',
 decision jsonb, decided_by uuid REFERENCES users(id), decided_at timestamptz, version integer NOT NULL DEFAULT 1,
 UNIQUE(organization_id,id), UNIQUE(organization_id,account_id,dedupe_key),
 FOREIGN KEY(organization_id,statement_id) REFERENCES bank_statements(organization_id,id),
 FOREIGN KEY(organization_id,account_id) REFERENCES money_accounts(organization_id,id),
 FOREIGN KEY(organization_id,money_entry_id) REFERENCES money_entries(organization_id,id)
);
CREATE UNIQUE INDEX bank_lines_entry_idx ON bank_statement_lines(organization_id,money_entry_id) WHERE money_entry_id IS NOT NULL;
CREATE INDEX bank_lines_statement_idx ON bank_statement_lines(organization_id,statement_id);
CREATE INDEX bank_lines_state_idx ON bank_statement_lines(organization_id,account_id,state);
CREATE INDEX bank_lines_decider_idx ON bank_statement_lines(decided_by);
`,
};
