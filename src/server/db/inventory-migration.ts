export const inventoryMigration = {
  version: 3,
  sql: `
CREATE TABLE catalog_items (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
 sku text NOT NULL, name_ru text NOT NULL, name_kk text NOT NULL, category text NOT NULL, variant text NOT NULL, barcode text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('goods','service')), base_unit text NOT NULL, conversions jsonb NOT NULL,
 purchase_price numeric(21,6) NOT NULL CHECK(purchase_price>=0 AND purchase_price<1e15), sale_price numeric(21,6) NOT NULL CHECK(sale_price>=0 AND sale_price<1e15),
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,sku)
);
CREATE UNIQUE INDEX catalog_barcode_idx ON catalog_items(organization_id,barcode) WHERE barcode<>'';
CREATE TABLE warehouses (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), branch_id uuid NOT NULL, name text NOT NULL,
 UNIQUE(organization_id,id), UNIQUE(organization_id,branch_id,name), FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id)
);
CREATE TABLE stock_balances (
 organization_id uuid NOT NULL, warehouse_id uuid NOT NULL, item_id uuid NOT NULL,
 quantity numeric(21,6) NOT NULL DEFAULT 0 CHECK(quantity>=0 AND quantity<1e15),
 reserved numeric(21,6) NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=quantity),
 value_minor numeric(38,0) NOT NULL DEFAULT 0 CHECK(value_minor>=0 AND value_minor<1e38), version integer NOT NULL DEFAULT 0,
 PRIMARY KEY(organization_id,warehouse_id,item_id), FOREIGN KEY(organization_id,warehouse_id) REFERENCES warehouses(organization_id,id),
 FOREIGN KEY(organization_id,item_id) REFERENCES catalog_items(organization_id,id), CHECK(quantity<>0 OR value_minor=0)
);
CREATE INDEX stock_item_idx ON stock_balances(organization_id,item_id);
CREATE TABLE stock_commands (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), warehouse_id uuid NOT NULL, item_id uuid NOT NULL,
 request_key uuid NOT NULL, payload_hash text NOT NULL, kind text NOT NULL, result jsonb,
 UNIQUE(organization_id,request_key), UNIQUE(organization_id,id), FOREIGN KEY(organization_id,warehouse_id) REFERENCES warehouses(organization_id,id),
 FOREIGN KEY(organization_id,item_id) REFERENCES catalog_items(organization_id,id)
);
CREATE INDEX commands_warehouse_idx ON stock_commands(organization_id,warehouse_id);
CREATE INDEX commands_item_idx ON stock_commands(organization_id,item_id);
CREATE TABLE stock_movements (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, warehouse_id uuid NOT NULL, item_id uuid NOT NULL, command_id uuid NOT NULL,
 kind text NOT NULL, quantity numeric(21,6) NOT NULL, value_minor numeric(38,0) NOT NULL, source_id uuid,
 note text NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(command_id), FOREIGN KEY(organization_id,warehouse_id) REFERENCES warehouses(organization_id,id),
 FOREIGN KEY(organization_id,item_id) REFERENCES catalog_items(organization_id,id), FOREIGN KEY(organization_id,command_id) REFERENCES stock_commands(organization_id,id),
 FOREIGN KEY(organization_id,source_id) REFERENCES stock_movements(organization_id,id)
);
CREATE INDEX movements_warehouse_idx ON stock_movements(organization_id,warehouse_id,created_at DESC,id);
CREATE INDEX movements_item_idx ON stock_movements(organization_id,item_id);
CREATE INDEX movements_source_idx ON stock_movements(organization_id,source_id);
CREATE TABLE stock_reservations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, warehouse_id uuid NOT NULL, item_id uuid NOT NULL,
 quantity numeric(21,6) NOT NULL CHECK(quantity>0 AND quantity<1e15), status text NOT NULL CHECK(status IN ('active','released','fulfilled')),
 note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,warehouse_id) REFERENCES warehouses(organization_id,id), FOREIGN KEY(organization_id,item_id) REFERENCES catalog_items(organization_id,id)
);
CREATE INDEX reservations_warehouse_idx ON stock_reservations(organization_id,warehouse_id,status,created_at DESC);
CREATE INDEX reservations_item_idx ON stock_reservations(organization_id,item_id);
CREATE TABLE stock_transfers (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, item_id uuid NOT NULL, source_id uuid NOT NULL, destination_id uuid NOT NULL,
 quantity numeric(21,6) NOT NULL CHECK(quantity>0 AND quantity<1e15), value_minor numeric(38,0) NOT NULL CHECK(value_minor>=0 AND value_minor<1e38),
 state text NOT NULL CHECK(state IN ('in_transit','received')), note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), CHECK(source_id<>destination_id),
 FOREIGN KEY(organization_id,source_id) REFERENCES warehouses(organization_id,id), FOREIGN KEY(organization_id,destination_id) REFERENCES warehouses(organization_id,id),
 FOREIGN KEY(organization_id,item_id) REFERENCES catalog_items(organization_id,id)
);
CREATE INDEX transfers_source_idx ON stock_transfers(organization_id,source_id,created_at DESC);
CREATE INDEX transfers_destination_idx ON stock_transfers(organization_id,destination_id,created_at DESC);
CREATE INDEX transfers_item_idx ON stock_transfers(organization_id,item_id);
ALTER TABLE stock_movements ADD COLUMN transfer_id uuid;
ALTER TABLE stock_movements ADD FOREIGN KEY(organization_id,transfer_id) REFERENCES stock_transfers(organization_id,id);
CREATE INDEX movements_transfer_idx ON stock_movements(organization_id,transfer_id);
`,
};
