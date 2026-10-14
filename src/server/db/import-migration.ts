export const importMigration = {
  version: 2,
  sql: `
CREATE TABLE import_batches (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), branch_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), confirmed_by uuid REFERENCES users(id),
 filename text NOT NULL, file_hash text NOT NULL, source_content text NOT NULL,
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','queued','running','completed','partial','failed','cancelled')),
 version integer NOT NULL DEFAULT 1, error_code text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(organization_id,id), UNIQUE(organization_id,branch_id,file_hash),
 FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id)
);
CREATE TABLE customers (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), branch_id uuid NOT NULL,
 external_id text NOT NULL, name text NOT NULL, email text NOT NULL, phone text NOT NULL,
 source_batch_id uuid NOT NULL, source_row integer NOT NULL, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,branch_id,external_id),
 FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id),
 FOREIGN KEY(organization_id,source_batch_id) REFERENCES import_batches(organization_id,id)
);
CREATE TABLE import_rows (
 organization_id uuid NOT NULL, batch_id uuid NOT NULL, row_number integer NOT NULL,
 data jsonb NOT NULL, status text NOT NULL CHECK(status IN ('ready','invalid','duplicate','conflict','imported')),
 errors jsonb NOT NULL DEFAULT '[]', customer_id uuid,
 PRIMARY KEY(organization_id,batch_id,row_number),
 FOREIGN KEY(organization_id,batch_id) REFERENCES import_batches(organization_id,id),
 FOREIGN KEY(organization_id,customer_id) REFERENCES customers(organization_id,id)
);
CREATE TABLE outbox_events (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, branch_id uuid NOT NULL, batch_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), topic text NOT NULL, event_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz,
 UNIQUE(organization_id,event_key), UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,batch_id) REFERENCES import_batches(organization_id,id),
 FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id)
);
CREATE TABLE jobs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, branch_id uuid NOT NULL, batch_id uuid NOT NULL,
 event_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users(id),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_until timestamptz, error_code text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,batch_id), UNIQUE(event_id),
 FOREIGN KEY(organization_id,batch_id) REFERENCES import_batches(organization_id,id),
 FOREIGN KEY(organization_id,event_id) REFERENCES outbox_events(organization_id,id),
 FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id)
);
CREATE INDEX jobs_ready_idx ON jobs(state,available_at);
CREATE INDEX batches_scope_idx ON import_batches(organization_id,branch_id,created_at DESC);
CREATE INDEX customers_scope_idx ON customers(organization_id,branch_id,created_at DESC,id);
CREATE TABLE worker_heartbeat (id integer PRIMARY KEY CHECK(id=1), seen_at timestamptz NOT NULL);
`,
};
