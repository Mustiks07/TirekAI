// Shared documents, capacity bookings and lot traceability for T041–T045.
export const industryMigration = {
  version: 21,
  sql: `
CREATE TABLE industry_documents (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, branch_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('recipe','production','resource','appointment','course','group','enrollment','project','waste')),
 title text NOT NULL, state text NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 data jsonb NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id)
);
CREATE INDEX industry_branch_kind_idx ON industry_documents(organization_id,branch_id,kind,created_at DESC);
CREATE INDEX industry_creator_idx ON industry_documents(created_by);
CREATE TABLE industry_history (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, document_id uuid NOT NULL, version integer NOT NULL, action text NOT NULL,
 data jsonb NOT NULL, note text NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,document_id,version), FOREIGN KEY(organization_id,document_id) REFERENCES industry_documents(organization_id,id)
);
CREATE INDEX industry_history_actor_idx ON industry_history(actor_id);
CREATE TABLE industry_slots (
 organization_id uuid NOT NULL, document_id uuid NOT NULL, resource_id uuid NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 CHECK(ends_at>starts_at), PRIMARY KEY(organization_id,document_id,resource_id),
 FOREIGN KEY(organization_id,document_id) REFERENCES industry_documents(organization_id,id),
 FOREIGN KEY(organization_id,resource_id) REFERENCES industry_documents(organization_id,id)
);
CREATE INDEX industry_slots_resource_idx ON industry_slots(organization_id,resource_id,starts_at,ends_at);
CREATE TABLE industry_item_links (
 organization_id uuid NOT NULL, document_id uuid NOT NULL, item_id uuid NOT NULL,
 PRIMARY KEY(organization_id,document_id,item_id), FOREIGN KEY(organization_id,document_id) REFERENCES industry_documents(organization_id,id),
 FOREIGN KEY(organization_id,item_id) REFERENCES catalog_items(organization_id,id)
);
CREATE INDEX industry_item_idx ON industry_item_links(organization_id,item_id);
CREATE TABLE industry_stock_links (
 organization_id uuid NOT NULL, movement_id uuid NOT NULL, document_id uuid NOT NULL,
 PRIMARY KEY(organization_id,movement_id), FOREIGN KEY(organization_id,movement_id) REFERENCES stock_movements(organization_id,id),
 FOREIGN KEY(organization_id,document_id) REFERENCES industry_documents(organization_id,id)
);
CREATE INDEX industry_stock_doc_idx ON industry_stock_links(organization_id,document_id);
CREATE TABLE stock_lots (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, warehouse_id uuid NOT NULL, item_id uuid NOT NULL, code text NOT NULL,
 expires_on date, quantity numeric(21,6) NOT NULL CHECK(quantity>=0), received numeric(21,6) NOT NULL CHECK(received>0),
 receipt_id uuid NOT NULL, parent_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,warehouse_id,item_id,code),
 FOREIGN KEY(organization_id,warehouse_id) REFERENCES warehouses(organization_id,id),
 FOREIGN KEY(organization_id,item_id) REFERENCES catalog_items(organization_id,id),
 FOREIGN KEY(organization_id,receipt_id) REFERENCES stock_movements(organization_id,id),
 FOREIGN KEY(organization_id,parent_id) REFERENCES stock_lots(organization_id,id)
);
CREATE INDEX stock_lots_item_idx ON stock_lots(organization_id,item_id);
CREATE INDEX stock_lots_receipt_idx ON stock_lots(organization_id,receipt_id);
CREATE INDEX stock_lots_parent_idx ON stock_lots(organization_id,parent_id);
CREATE TABLE stock_lot_allocations (
 organization_id uuid NOT NULL, movement_id uuid NOT NULL, lot_id uuid NOT NULL, quantity numeric(21,6) NOT NULL CHECK(quantity<>0),
 PRIMARY KEY(organization_id,movement_id,lot_id), FOREIGN KEY(organization_id,movement_id) REFERENCES stock_movements(organization_id,id),
 FOREIGN KEY(organization_id,lot_id) REFERENCES stock_lots(organization_id,id)
);
CREATE INDEX stock_lot_allocation_lot_idx ON stock_lot_allocations(organization_id,lot_id);
`,
};
