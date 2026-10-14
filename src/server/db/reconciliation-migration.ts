// T020: line decisions for extra/unknown/substituted invoice lines, split purchases and
// adjustments of approved supplier documents. Migrations 1–6 are released; never edit them.
export const reconciliationMigration = {
  version: 7,
  sql: `
ALTER TABLE purchase_documents ADD COLUMN parent_document_id uuid;
ALTER TABLE purchase_documents ADD CONSTRAINT document_parent_fk FOREIGN KEY(organization_id,parent_document_id) REFERENCES purchase_documents(organization_id,id);
ALTER TABLE purchase_documents DROP CONSTRAINT purchase_documents_organization_id_sha256_key;
ALTER TABLE purchase_documents DROP CONSTRAINT purchase_documents_organization_id_supplier_id_number_date_key;
CREATE UNIQUE INDEX documents_sha_idx ON purchase_documents(organization_id,sha256) WHERE parent_document_id IS NULL;
CREATE UNIQUE INDEX documents_identity_idx ON purchase_documents(organization_id,supplier_id,number,date) WHERE parent_document_id IS NULL;
CREATE UNIQUE INDEX documents_child_idx ON purchase_documents(organization_id,parent_document_id,order_id) WHERE parent_document_id IS NOT NULL;
ALTER TABLE purchase_document_lines ADD COLUMN purchase_line_id uuid;
ALTER TABLE purchase_document_lines ADD CONSTRAINT document_line_purchase_fk FOREIGN KEY(organization_id,purchase_line_id) REFERENCES purchase_lines(organization_id,id);
CREATE UNIQUE INDEX document_lines_purchase_idx ON purchase_document_lines(organization_id,document_id,purchase_line_id) WHERE purchase_line_id IS NOT NULL;
CREATE TABLE document_line_decisions (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, document_id uuid NOT NULL, position integer NOT NULL CHECK(position>=0),
 item_id uuid, name text NOT NULL, unit text NOT NULL, quantity numeric(21,6) NOT NULL CHECK(quantity>0), total_minor numeric(38,0) NOT NULL CHECK(total_minor>=0),
 decision text NOT NULL CHECK(decision IN ('substitute','reject','separate')), replaces_line_id uuid, split_order_id uuid, split_document_id uuid,
 actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,document_id,position),
 CHECK(decision<>'substitute' OR (item_id IS NOT NULL AND replaces_line_id IS NOT NULL)),
 CHECK(decision<>'separate' OR (item_id IS NOT NULL AND split_order_id IS NOT NULL AND split_document_id IS NOT NULL)),
 FOREIGN KEY(organization_id,document_id) REFERENCES purchase_documents(organization_id,id),
 FOREIGN KEY(organization_id,item_id) REFERENCES catalog_items(organization_id,id),
 FOREIGN KEY(organization_id,replaces_line_id) REFERENCES purchase_lines(organization_id,id),
 FOREIGN KEY(organization_id,split_order_id) REFERENCES purchase_orders(organization_id,id),
 FOREIGN KEY(organization_id,split_document_id) REFERENCES purchase_documents(organization_id,id)
);
CREATE INDEX decisions_item_idx ON document_line_decisions(organization_id,item_id);
CREATE INDEX decisions_replaces_idx ON document_line_decisions(organization_id,replaces_line_id);
CREATE INDEX decisions_split_order_idx ON document_line_decisions(organization_id,split_order_id);
CREATE INDEX decisions_split_document_idx ON document_line_decisions(organization_id,split_document_id);
CREATE TABLE purchase_document_adjustments (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, document_id uuid NOT NULL, obligation_id uuid NOT NULL, document_version integer NOT NULL,
 delta_minor numeric(38,0) NOT NULL, before jsonb NOT NULL, after jsonb NOT NULL, warnings jsonb NOT NULL DEFAULT '[]', reason text NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,document_id,document_version),
 FOREIGN KEY(organization_id,document_id) REFERENCES purchase_documents(organization_id,id),
 FOREIGN KEY(organization_id,obligation_id) REFERENCES supplier_obligations(organization_id,id)
);
CREATE INDEX adjustments_obligation_idx ON purchase_document_adjustments(organization_id,obligation_id);
`,
};
