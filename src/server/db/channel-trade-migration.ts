// T040: a Kaspi order becomes an internal sales order by explicit actions; acceptance in Kaspi is
// logged with its uncertain outcome; commission and payout come from the settlement report and are
// posted through the money service, never estimated.
export const channelTradeMigration = {
  version: 20,
  sql: `
ALTER TABLE channel_orders ADD COLUMN accept_state text CHECK(accept_state IN ('sent','unknown','failed'));
ALTER TABLE channel_orders ADD COLUMN accept_error text;
ALTER TABLE channel_orders ADD COLUMN accepted_at timestamptz;
ALTER TABLE channel_orders ADD COLUMN imported_by uuid REFERENCES users(id);
CREATE INDEX channel_orders_importer_idx ON channel_orders(imported_by);
CREATE TABLE channel_settlements (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, connection_id uuid NOT NULL, channel_order_id uuid NOT NULL, account_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('payout','return')), document text NOT NULL, report_date date NOT NULL,
 gross_minor numeric(38,0) NOT NULL CHECK(gross_minor>0 AND gross_minor<1e38),
 commission_minor numeric(38,0) NOT NULL CHECK(commission_minor>=0 AND commission_minor<=gross_minor),
 net_minor numeric(38,0) NOT NULL CHECK(net_minor=gross_minor-commission_minor),
 order_entry_id uuid, commission_entry_id uuid, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(connection_id,kind,document,channel_order_id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES integration_connections(organization_id,id),
 FOREIGN KEY(organization_id,channel_order_id) REFERENCES channel_orders(organization_id,id),
 FOREIGN KEY(organization_id,account_id) REFERENCES money_accounts(organization_id,id),
 FOREIGN KEY(organization_id,order_entry_id) REFERENCES money_entries(organization_id,id),
 FOREIGN KEY(organization_id,commission_entry_id) REFERENCES money_entries(organization_id,id)
);
CREATE INDEX channel_settlements_order_idx ON channel_settlements(organization_id,channel_order_id);
CREATE INDEX channel_settlements_account_idx ON channel_settlements(organization_id,account_id);
CREATE INDEX channel_settlements_creator_idx ON channel_settlements(created_by);
CREATE INDEX channel_settlements_entry_idx ON channel_settlements(organization_id,order_entry_id);
CREATE INDEX channel_settlements_commission_idx ON channel_settlements(organization_id,commission_entry_id);
`,
};
