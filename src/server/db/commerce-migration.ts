export const commerceMigration = {
  version: 4,
  sql: `
CREATE TABLE commerce_commands (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), request_key uuid NOT NULL, payload_hash text NOT NULL, result_id uuid NOT NULL,
 UNIQUE(organization_id,request_key), UNIQUE(organization_id,id)
);
CREATE TABLE sales_orders (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), branch_id uuid NOT NULL, customer_id uuid NOT NULL, warehouse_id uuid NOT NULL,
 number integer GENERATED ALWAYS AS IDENTITY, state text NOT NULL CHECK(state IN ('draft','confirmed','partial','fulfilled','cancelled')),
 version integer NOT NULL DEFAULT 1, due_date date NOT NULL, delivery text NOT NULL CHECK(delivery IN ('pickup','delivery')), note text NOT NULL,
 tax_mode text NOT NULL CHECK(tax_mode='excluded'), total_minor numeric(38,0) NOT NULL CHECK(total_minor>=0 AND total_minor<1e38),
 revenue_minor numeric(38,0) NOT NULL DEFAULT 0 CHECK(revenue_minor>=0 AND revenue_minor<=total_minor),
 paid_minor numeric(38,0) NOT NULL DEFAULT 0 CHECK(paid_minor>=0 AND paid_minor<1e38), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id),
 FOREIGN KEY(organization_id,customer_id) REFERENCES customers(organization_id,id), FOREIGN KEY(organization_id,warehouse_id) REFERENCES warehouses(organization_id,id)
);
CREATE INDEX orders_scope_idx ON sales_orders(organization_id,branch_id,created_at DESC,id);
CREATE INDEX orders_customer_idx ON sales_orders(organization_id,customer_id);
CREATE INDEX orders_warehouse_idx ON sales_orders(organization_id,warehouse_id);
CREATE TABLE sales_order_lines (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, order_id uuid NOT NULL, item_id uuid NOT NULL, sku text NOT NULL,name_ru text NOT NULL,name_kk text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('goods','service')),unit text NOT NULL,base_unit text NOT NULL,
 quantity numeric(21,6) NOT NULL CHECK(quantity>0 AND quantity<1e15),base_quantity numeric(21,6) NOT NULL CHECK(base_quantity>0 AND base_quantity<1e15),
 price numeric(21,6) NOT NULL CHECK(price>=0 AND price<1e15),discount numeric(9,6) NOT NULL CHECK(discount>=0 AND discount<=100),
 total_minor numeric(38,0) NOT NULL CHECK(total_minor>=0 AND total_minor<1e38),
 fulfilled numeric(21,6) NOT NULL DEFAULT 0 CHECK(fulfilled>=0 AND fulfilled<=quantity),returned numeric(21,6) NOT NULL DEFAULT 0 CHECK(returned>=0 AND returned<=fulfilled),
 reservation_id uuid, UNIQUE(organization_id,id), FOREIGN KEY(organization_id,order_id) REFERENCES sales_orders(organization_id,id),
 FOREIGN KEY(organization_id,item_id) REFERENCES catalog_items(organization_id,id),FOREIGN KEY(organization_id,reservation_id) REFERENCES stock_reservations(organization_id,id)
);
CREATE INDEX order_lines_order_idx ON sales_order_lines(organization_id,order_id);
CREATE INDEX order_lines_item_idx ON sales_order_lines(organization_id,item_id);
CREATE INDEX order_lines_reservation_idx ON sales_order_lines(organization_id,reservation_id);
CREATE TABLE order_stock_links (
 organization_id uuid NOT NULL,order_id uuid NOT NULL,object_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('movement','reservation')),
 PRIMARY KEY(organization_id,object_id),FOREIGN KEY(organization_id,order_id) REFERENCES sales_orders(organization_id,id)
);
CREATE INDEX order_stock_order_idx ON order_stock_links(organization_id,order_id);
CREATE TABLE sales_events (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL,order_id uuid NOT NULL,line_id uuid,source_id uuid,movement_id uuid,
 kind text NOT NULL,quantity numeric(21,6) NOT NULL DEFAULT 0,revenue_minor numeric(38,0) NOT NULL DEFAULT 0,cost_minor numeric(38,0),
 note text NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,order_id) REFERENCES sales_orders(organization_id,id),FOREIGN KEY(organization_id,line_id) REFERENCES sales_order_lines(organization_id,id),
 FOREIGN KEY(organization_id,source_id) REFERENCES sales_events(organization_id,id),FOREIGN KEY(organization_id,movement_id) REFERENCES stock_movements(organization_id,id)
);
CREATE INDEX sales_events_order_idx ON sales_events(organization_id,order_id,created_at,id);
CREATE INDEX sales_events_source_idx ON sales_events(organization_id,source_id);
CREATE INDEX sales_events_line_idx ON sales_events(organization_id,line_id);
CREATE INDEX sales_events_movement_idx ON sales_events(organization_id,movement_id);
CREATE TABLE money_accounts (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),branch_id uuid NOT NULL,name text NOT NULL,
 balance_minor numeric(38,0) NOT NULL DEFAULT 0 CHECK(balance_minor>=0 AND balance_minor<1e38),UNIQUE(organization_id,id),UNIQUE(organization_id,branch_id,name),
 FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id)
);
CREATE TABLE supplier_obligations (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES organizations(id),branch_id uuid NOT NULL,supplier text NOT NULL,
 amount_minor numeric(38,0) NOT NULL CHECK(amount_minor>0 AND amount_minor<1e38),paid_minor numeric(38,0) NOT NULL DEFAULT 0 CHECK(paid_minor>=0 AND paid_minor<=amount_minor),
 due_date date NOT NULL,note text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id)
);
CREATE INDEX obligations_scope_idx ON supplier_obligations(organization_id,branch_id,due_date,id);
CREATE TABLE money_entries (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,account_id uuid NOT NULL,command_id uuid NOT NULL,kind text NOT NULL,amount_minor numeric(38,0) NOT NULL,
 category text NOT NULL,counterparty text NOT NULL,note text NOT NULL,operating boolean NOT NULL DEFAULT false,order_id uuid,obligation_id uuid,
 actor_id uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(organization_id,id),UNIQUE(command_id,account_id),
 FOREIGN KEY(organization_id,account_id) REFERENCES money_accounts(organization_id,id),FOREIGN KEY(organization_id,command_id) REFERENCES commerce_commands(organization_id,id),
 FOREIGN KEY(organization_id,order_id) REFERENCES sales_orders(organization_id,id),FOREIGN KEY(organization_id,obligation_id) REFERENCES supplier_obligations(organization_id,id)
);
CREATE INDEX money_account_idx ON money_entries(organization_id,account_id,created_at DESC,id);
CREATE INDEX money_order_idx ON money_entries(organization_id,order_id);
CREATE INDEX money_obligation_idx ON money_entries(organization_id,obligation_id);
`,
};
