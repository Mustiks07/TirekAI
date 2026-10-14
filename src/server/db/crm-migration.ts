export const crmMigration = {
  version: 6,
  sql: `
ALTER TABLE customers ALTER COLUMN source_batch_id DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN source_row DROP NOT NULL;
ALTER TABLE customers ADD COLUMN kind text NOT NULL DEFAULT 'person' CHECK(kind IN ('person','company'));
ALTER TABLE customers ADD COLUMN responsible_id uuid REFERENCES users(id);
ALTER TABLE customers ADD COLUMN consents jsonb NOT NULL DEFAULT '{"email":false,"sms":false,"messenger":false}';
CREATE INDEX customer_responsible_idx ON customers(responsible_id);
CREATE TABLE crm_commands(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),request_key uuid NOT NULL,payload_hash text NOT NULL,result_id uuid NOT NULL,UNIQUE(organization_id,request_key));
CREATE TABLE crm_pipelines(organization_id uuid PRIMARY KEY REFERENCES organizations(id),version integer NOT NULL,data jsonb NOT NULL);
CREATE TABLE inquiries(id uuid PRIMARY KEY,organization_id uuid NOT NULL,branch_id uuid NOT NULL,customer_id uuid NOT NULL,source text NOT NULL,external_id text NOT NULL,title text NOT NULL,message text NOT NULL,responsible_id uuid REFERENCES users(id),stage_id text NOT NULL,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(organization_id,id),FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id),FOREIGN KEY(organization_id,customer_id) REFERENCES customers(organization_id,id));
CREATE UNIQUE INDEX inquiry_external_idx ON inquiries(organization_id,branch_id,source,external_id) WHERE external_id<>'';
CREATE INDEX inquiry_scope_idx ON inquiries(organization_id,branch_id,created_at DESC);
CREATE INDEX inquiry_customer_idx ON inquiries(organization_id,customer_id);
CREATE INDEX inquiry_responsible_idx ON inquiries(responsible_id);
CREATE TABLE quotes(id uuid PRIMARY KEY,organization_id uuid NOT NULL,inquiry_id uuid NOT NULL,number integer GENERATED ALWAYS AS IDENTITY,version integer NOT NULL DEFAULT 1,data jsonb NOT NULL,order_id uuid,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(organization_id,id),FOREIGN KEY(organization_id,inquiry_id) REFERENCES inquiries(organization_id,id),FOREIGN KEY(organization_id,order_id) REFERENCES sales_orders(organization_id,id));
CREATE INDEX quotes_inquiry_idx ON quotes(organization_id,inquiry_id);
CREATE UNIQUE INDEX quotes_order_idx ON quotes(organization_id,order_id) WHERE order_id IS NOT NULL;
CREATE TABLE quote_items(organization_id uuid NOT NULL,quote_id uuid NOT NULL,item_id uuid NOT NULL,PRIMARY KEY(organization_id,quote_id,item_id),FOREIGN KEY(organization_id,quote_id) REFERENCES quotes(organization_id,id),FOREIGN KEY(organization_id,item_id) REFERENCES catalog_items(organization_id,id));
CREATE INDEX quote_items_item_idx ON quote_items(organization_id,item_id);
CREATE TABLE crm_events(id uuid PRIMARY KEY,organization_id uuid NOT NULL,customer_id uuid NOT NULL,inquiry_id uuid,quote_id uuid,kind text NOT NULL,note text NOT NULL,data jsonb NOT NULL DEFAULT '{}',actor_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(organization_id,customer_id) REFERENCES customers(organization_id,id),FOREIGN KEY(organization_id,inquiry_id) REFERENCES inquiries(organization_id,id),FOREIGN KEY(organization_id,quote_id) REFERENCES quotes(organization_id,id));
CREATE INDEX crm_events_customer_idx ON crm_events(organization_id,customer_id,created_at DESC);
CREATE INDEX crm_events_inquiry_idx ON crm_events(organization_id,inquiry_id);
CREATE INDEX crm_events_quote_idx ON crm_events(organization_id,quote_id);
ALTER TABLE sales_orders ADD COLUMN quote_id uuid;
ALTER TABLE sales_orders ADD COLUMN inquiry_id uuid;
ALTER TABLE sales_orders ADD CONSTRAINT order_quote_fk FOREIGN KEY(organization_id,quote_id) REFERENCES quotes(organization_id,id);
ALTER TABLE sales_orders ADD CONSTRAINT order_inquiry_fk FOREIGN KEY(organization_id,inquiry_id) REFERENCES inquiries(organization_id,id);
CREATE INDEX orders_quote_idx ON sales_orders(organization_id,quote_id);
CREATE INDEX orders_inquiry_idx ON sales_orders(organization_id,inquiry_id);
`,
};
