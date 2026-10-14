// T029–T030: connection registry, encrypted credentials, data ownership, mappings, cursors,
// sync runs, webhook inbox, conflicts and an external stock mirror (no double ledger).
export const integrationsMigration = {
  version: 13,
  sql: `
CREATE TABLE integration_connections (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), provider text NOT NULL CHECK(provider IN ('moysklad')),
 status text NOT NULL CHECK(status IN ('not_configured','configured','sandbox_verified','live_verified','degraded','disconnected')),
 credentials bytea, credentials_hint text, webhook_token_hash text, ownership jsonb NOT NULL, contract_version text NOT NULL,
 last_success_at timestamptz, last_error_code text, last_error_at timestamptz, verification jsonb,
 version integer NOT NULL DEFAULT 1, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), disconnected_at timestamptz,
 UNIQUE(organization_id,id), CHECK(status='not_configured' OR status='disconnected' OR credentials IS NOT NULL)
);
CREATE UNIQUE INDEX integration_active_idx ON integration_connections(organization_id,provider) WHERE disconnected_at IS NULL;
CREATE INDEX integration_creator_idx ON integration_connections(created_by);
CREATE TABLE integration_mappings (
 organization_id uuid NOT NULL, connection_id uuid NOT NULL, entity_type text NOT NULL CHECK(entity_type IN ('product','store')),
 external_id text NOT NULL, internal_id uuid NOT NULL, external_updated text, local_version integer, state text NOT NULL CHECK(state IN ('active','archived','deleted')),
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(connection_id,entity_type,external_id), UNIQUE(connection_id,entity_type,internal_id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES integration_connections(organization_id,id)
);
CREATE INDEX integration_mappings_org_idx ON integration_mappings(organization_id,connection_id);
CREATE TABLE integration_warehouse_links (
 organization_id uuid NOT NULL, warehouse_id uuid NOT NULL, connection_id uuid NOT NULL, external_store_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,warehouse_id), UNIQUE(connection_id,external_store_id),
 FOREIGN KEY(organization_id,warehouse_id) REFERENCES warehouses(organization_id,id), FOREIGN KEY(organization_id,connection_id) REFERENCES integration_connections(organization_id,id)
);
CREATE INDEX integration_links_connection_idx ON integration_warehouse_links(organization_id,connection_id);
CREATE TABLE external_stock (
 organization_id uuid NOT NULL, connection_id uuid NOT NULL, warehouse_id uuid NOT NULL, item_id uuid NOT NULL,
 quantity numeric(21,6) NOT NULL, as_of timestamptz NOT NULL, PRIMARY KEY(connection_id,warehouse_id,item_id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES integration_connections(organization_id,id),
 FOREIGN KEY(organization_id,warehouse_id) REFERENCES warehouses(organization_id,id), FOREIGN KEY(organization_id,item_id) REFERENCES catalog_items(organization_id,id)
);
CREATE INDEX external_stock_item_idx ON external_stock(organization_id,item_id);
CREATE INDEX external_stock_warehouse_idx ON external_stock(organization_id,warehouse_id);
CREATE TABLE sync_cursors (
 connection_id uuid NOT NULL, entity_type text NOT NULL, cursor text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(connection_id,entity_type)
);
CREATE TABLE sync_runs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, connection_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('check','initial','incremental','stock','webhook')),
 state text NOT NULL CHECK(state IN ('running','succeeded','partial','failed')), stats jsonb NOT NULL DEFAULT '{}', error_code text,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 FOREIGN KEY(organization_id,connection_id) REFERENCES integration_connections(organization_id,id)
);
CREATE INDEX sync_runs_connection_idx ON sync_runs(organization_id,connection_id,started_at DESC);
CREATE TABLE integration_inbox (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, connection_id uuid NOT NULL, external_event_id text NOT NULL, payload jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('received','processed','failed','ignored')), attempts integer NOT NULL DEFAULT 0, error_code text,
 received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, UNIQUE(connection_id,external_event_id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES integration_connections(organization_id,id)
);
CREATE INDEX integration_inbox_pending_idx ON integration_inbox(state,received_at);
CREATE INDEX integration_inbox_org_idx ON integration_inbox(organization_id,connection_id);
CREATE TABLE sync_conflicts (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, connection_id uuid NOT NULL, entity_type text NOT NULL, external_id text NOT NULL, internal_id uuid,
 reason text NOT NULL, local jsonb, remote jsonb NOT NULL, state text NOT NULL CHECK(state IN ('open','kept_local','took_remote')),
 created_at timestamptz NOT NULL DEFAULT now(), resolved_by uuid REFERENCES users(id), resolved_at timestamptz,
 FOREIGN KEY(organization_id,connection_id) REFERENCES integration_connections(organization_id,id)
);
CREATE UNIQUE INDEX sync_conflicts_open_idx ON sync_conflicts(connection_id,entity_type,external_id) WHERE state='open';
CREATE INDEX sync_conflicts_org_idx ON sync_conflicts(organization_id,connection_id,state);
CREATE INDEX sync_conflicts_resolver_idx ON sync_conflicts(resolved_by);
`,
};
