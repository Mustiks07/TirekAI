export const extendedIndustryMigration = {
  version: 22,
  sql: `
ALTER TABLE industry_documents DROP CONSTRAINT industry_documents_kind_check;
ALTER TABLE industry_documents ADD CONSTRAINT industry_documents_kind_check CHECK(kind IN ('recipe','production','resource','appointment','course','group','enrollment','project','waste','construction','clinic'));
CREATE TABLE construction_purchases (
 organization_id uuid NOT NULL, document_id uuid NOT NULL, purchase_id uuid NOT NULL,
 PRIMARY KEY(organization_id,purchase_id),
 FOREIGN KEY(organization_id,document_id) REFERENCES industry_documents(organization_id,id),
 FOREIGN KEY(organization_id,purchase_id) REFERENCES purchase_orders(organization_id,id)
);
CREATE INDEX construction_purchases_document_idx ON construction_purchases(organization_id,document_id);
-- Patient identity stays in access-controlled industry documents. General billing uses one anonymous customer per branch.
CREATE TABLE clinic_billing_customers (
 organization_id uuid NOT NULL, branch_id uuid NOT NULL, customer_id uuid NOT NULL,
 PRIMARY KEY(organization_id,branch_id),
 FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id),
 FOREIGN KEY(organization_id,customer_id) REFERENCES customers(organization_id,id)
);
CREATE INDEX clinic_billing_customer_idx ON clinic_billing_customers(organization_id,customer_id);
`,
};
