export const purchasingMigration = {
  version: 5,
  sql: `
CREATE TABLE procurement_commands (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), request_key uuid NOT NULL, payload_hash text NOT NULL, result_id uuid NOT NULL,
 UNIQUE(organization_id,request_key)
);
CREATE TABLE suppliers (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,name)
);
CREATE TABLE supplier_offers (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, supplier_id uuid NOT NULL, item_id uuid NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), FOREIGN KEY(organization_id,supplier_id) REFERENCES suppliers(organization_id,id), FOREIGN KEY(organization_id,item_id) REFERENCES catalog_items(organization_id,id)
);
CREATE INDEX offers_supplier_idx ON supplier_offers(organization_id,supplier_id);
CREATE INDEX offers_item_idx ON supplier_offers(organization_id,item_id,created_at DESC);
CREATE TABLE purchase_orders (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, branch_id uuid NOT NULL, warehouse_id uuid NOT NULL, supplier_id uuid NOT NULL,
 number integer GENERATED ALWAYS AS IDENTITY, state text NOT NULL CHECK(state IN ('draft','pending','approved','sent','partial','completed','cancelled')), version integer NOT NULL DEFAULT 1,
 due_date date NOT NULL, total_minor numeric(38,0) NOT NULL CHECK(total_minor>=0), budget_minor numeric(38,0) NOT NULL CHECK(budget_minor>=total_minor), note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id), FOREIGN KEY(organization_id,warehouse_id) REFERENCES warehouses(organization_id,id), FOREIGN KEY(organization_id,supplier_id) REFERENCES suppliers(organization_id,id)
);
CREATE INDEX purchase_scope_idx ON purchase_orders(organization_id,branch_id,created_at DESC,id);
CREATE INDEX purchase_supplier_idx ON purchase_orders(organization_id,supplier_id);
CREATE INDEX purchase_warehouse_idx ON purchase_orders(organization_id,warehouse_id);
CREATE TABLE purchase_lines (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, order_id uuid NOT NULL, item_id uuid NOT NULL, offer_id uuid NOT NULL, name text NOT NULL, base_unit text NOT NULL,
 quantity numeric(21,6) NOT NULL CHECK(quantity>0), received numeric(21,6) NOT NULL DEFAULT 0 CHECK(received>=0 AND received<=quantity), total_minor numeric(38,0) NOT NULL CHECK(total_minor>=0), snapshot jsonb NOT NULL,
 UNIQUE(organization_id,id), UNIQUE(organization_id,order_id,item_id), FOREIGN KEY(organization_id,order_id) REFERENCES purchase_orders(organization_id,id), FOREIGN KEY(organization_id,item_id) REFERENCES catalog_items(organization_id,id), FOREIGN KEY(organization_id,offer_id) REFERENCES supplier_offers(organization_id,id)
);
CREATE INDEX purchase_lines_item_idx ON purchase_lines(organization_id,item_id);
CREATE INDEX purchase_lines_offer_idx ON purchase_lines(organization_id,offer_id);
CREATE TABLE purchase_events (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, order_id uuid NOT NULL, kind text NOT NULL, note text NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,order_id) REFERENCES purchase_orders(organization_id,id)
);
CREATE INDEX purchase_events_order_idx ON purchase_events(organization_id,order_id,created_at DESC);
CREATE TABLE purchase_documents (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, order_id uuid NOT NULL, supplier_id uuid NOT NULL, filename text NOT NULL, sha256 text NOT NULL, original bytea NOT NULL,
 state text NOT NULL DEFAULT 'review' CHECK(state IN ('review','approved')), version integer NOT NULL DEFAULT 1, external_id text NOT NULL,
 number text, date date, extraction jsonb NOT NULL, review jsonb, discrepancies jsonb NOT NULL DEFAULT '[]', obligation_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,sha256), UNIQUE(organization_id,supplier_id,number,date),
 FOREIGN KEY(organization_id,order_id) REFERENCES purchase_orders(organization_id,id), FOREIGN KEY(organization_id,supplier_id) REFERENCES suppliers(organization_id,id), FOREIGN KEY(organization_id,obligation_id) REFERENCES supplier_obligations(organization_id,id)
);
CREATE UNIQUE INDEX documents_external_idx ON purchase_documents(organization_id,supplier_id,external_id) WHERE external_id<>'';
CREATE INDEX documents_order_idx ON purchase_documents(organization_id,order_id);
CREATE INDEX documents_obligation_idx ON purchase_documents(organization_id,obligation_id);
CREATE TABLE purchase_document_lines (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, document_id uuid NOT NULL, item_id uuid NOT NULL, name text NOT NULL, unit text NOT NULL,
 quantity numeric(21,6) NOT NULL CHECK(quantity>0), base_quantity numeric(21,6) NOT NULL CHECK(base_quantity>0), received numeric(21,6) NOT NULL DEFAULT 0 CHECK(received>=0 AND received<=base_quantity), total_minor numeric(38,0) NOT NULL CHECK(total_minor>=0),
 UNIQUE(organization_id,id), UNIQUE(organization_id,document_id,item_id), FOREIGN KEY(organization_id,document_id) REFERENCES purchase_documents(organization_id,id), FOREIGN KEY(organization_id,item_id) REFERENCES catalog_items(organization_id,id)
);
CREATE INDEX document_lines_item_idx ON purchase_document_lines(organization_id,item_id);
CREATE TABLE document_revisions (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, document_id uuid NOT NULL, version integer NOT NULL, data jsonb NOT NULL, note text NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,document_id) REFERENCES purchase_documents(organization_id,id)
);
CREATE INDEX document_revisions_doc_idx ON document_revisions(organization_id,document_id);
CREATE TABLE purchase_receipts (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, document_line_id uuid NOT NULL, purchase_line_id uuid NOT NULL, movement_id uuid NOT NULL, quantity numeric(21,6) NOT NULL CHECK(quantity>0), value_minor numeric(38,0) NOT NULL CHECK(value_minor>=0), note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,document_line_id) REFERENCES purchase_document_lines(organization_id,id), FOREIGN KEY(organization_id,purchase_line_id) REFERENCES purchase_lines(organization_id,id), FOREIGN KEY(organization_id,movement_id) REFERENCES stock_movements(organization_id,id)
);
CREATE INDEX receipts_doc_idx ON purchase_receipts(organization_id,document_line_id);
CREATE INDEX receipts_purchase_idx ON purchase_receipts(organization_id,purchase_line_id);
CREATE INDEX receipts_movement_idx ON purchase_receipts(organization_id,movement_id);
ALTER TABLE supplier_obligations ADD COLUMN purchase_order_id uuid;
ALTER TABLE supplier_obligations ADD CONSTRAINT obligation_purchase_fk FOREIGN KEY(organization_id,purchase_order_id) REFERENCES purchase_orders(organization_id,id);
CREATE INDEX obligations_purchase_idx ON supplier_obligations(organization_id,purchase_order_id);
`,
};
