// T030 follow-up: catalogue prices may be unknown (an imported product without a KZT price is not
// priced at zero), MoySklad supply write-back settings, supplier→counterparty mappings and an
// outbound export queue. Receipts into a linked warehouse post no local movement.
export const writebackMigration = {
  version: 14,
  sql: `
ALTER TABLE catalog_items ALTER COLUMN purchase_price DROP NOT NULL;
ALTER TABLE catalog_items ALTER COLUMN sale_price DROP NOT NULL;
ALTER TABLE purchase_receipts ALTER COLUMN movement_id DROP NOT NULL;
ALTER TABLE integration_connections ADD COLUMN settings jsonb NOT NULL DEFAULT '{}';
ALTER TABLE integration_mappings DROP CONSTRAINT integration_mappings_entity_type_check;
ALTER TABLE integration_mappings ADD CONSTRAINT integration_mappings_entity_type_check CHECK(entity_type IN ('product','store','counterparty'));
ALTER TABLE sync_runs DROP CONSTRAINT sync_runs_kind_check;
ALTER TABLE sync_runs ADD CONSTRAINT sync_runs_kind_check CHECK(kind IN ('check','initial','incremental','stock','webhook','export'));
CREATE TABLE integration_exports (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, connection_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('supply')),
 source_type text NOT NULL CHECK(source_type IN ('purchase_receive')), source_id uuid NOT NULL, purchase_order_id uuid NOT NULL,
 warehouse_id uuid NOT NULL, payload jsonb NOT NULL, expected_minor numeric(38,0) NOT NULL CHECK(expected_minor>=0),
 state text NOT NULL CHECK(state IN ('pending','sent','failed','dead')), attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), external_id text, external_sum_minor numeric(38,0), warning text, error_code text,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
 UNIQUE(organization_id,source_type,source_id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES integration_connections(organization_id,id),
 FOREIGN KEY(organization_id,purchase_order_id) REFERENCES purchase_orders(organization_id,id),
 FOREIGN KEY(organization_id,warehouse_id) REFERENCES warehouses(organization_id,id)
);
CREATE INDEX integration_exports_due_idx ON integration_exports(state,next_attempt_at);
CREATE INDEX integration_exports_org_idx ON integration_exports(organization_id,connection_id,created_at DESC);
CREATE INDEX integration_exports_order_idx ON integration_exports(organization_id,purchase_order_id);
CREATE INDEX integration_exports_warehouse_idx ON integration_exports(organization_id,warehouse_id);
CREATE INDEX integration_exports_creator_idx ON integration_exports(created_by);
`,
};
