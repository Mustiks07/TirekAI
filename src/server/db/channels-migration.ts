// T034: messaging (Telegram) and Kaspi orders. Inbound messages and channel orders are stored as
// received; outbound messages need owner enablement and the customer's own consent.
export const channelsMigration = {
  version: 17,
  sql: `
CREATE TABLE messaging_links (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, connection_id uuid NOT NULL, customer_id uuid NOT NULL, code_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, used_at timestamptz, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,connection_id) REFERENCES integration_connections(organization_id,id),
 FOREIGN KEY(organization_id,customer_id) REFERENCES customers(organization_id,id)
);
CREATE INDEX messaging_links_customer_idx ON messaging_links(organization_id,customer_id);
CREATE INDEX messaging_links_connection_idx ON messaging_links(organization_id,connection_id);
CREATE INDEX messaging_links_creator_idx ON messaging_links(created_by);
CREATE TABLE messaging_messages (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, connection_id uuid NOT NULL, chat_id text NOT NULL, customer_id uuid,
 direction text NOT NULL CHECK(direction IN ('in','out')), external_id text, text text NOT NULL,
 state text NOT NULL CHECK(state IN ('received','queued','sent','failed','unknown','blocked')), error_code text, attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES integration_connections(organization_id,id),
 FOREIGN KEY(organization_id,customer_id) REFERENCES customers(organization_id,id)
);
CREATE UNIQUE INDEX messaging_inbound_idx ON messaging_messages(connection_id,external_id) WHERE direction='in';
CREATE INDEX messaging_chat_idx ON messaging_messages(organization_id,connection_id,chat_id,created_at DESC);
CREATE INDEX messaging_customer_idx ON messaging_messages(organization_id,customer_id);
CREATE INDEX messaging_outbox_idx ON messaging_messages(state,next_attempt_at) WHERE direction='out';
CREATE INDEX messaging_creator_idx ON messaging_messages(created_by);
CREATE TABLE channel_orders (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, connection_id uuid NOT NULL, channel text NOT NULL CHECK(channel IN ('kaspi')),
 external_id text NOT NULL, code text NOT NULL, status text NOT NULL, state text NOT NULL, delivery_mode text NOT NULL, payment_mode text NOT NULL,
 total_minor numeric(38,0) NOT NULL CHECK(total_minor>=0), delivery_minor numeric(38,0), customer_name text NOT NULL, customer_phone text NOT NULL,
 created_external timestamptz NOT NULL, lines jsonb NOT NULL, history jsonb NOT NULL DEFAULT '[]', sales_order_id uuid,
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(connection_id,external_id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES integration_connections(organization_id,id),
 FOREIGN KEY(organization_id,sales_order_id) REFERENCES sales_orders(organization_id,id)
);
CREATE UNIQUE INDEX channel_orders_sales_idx ON channel_orders(organization_id,sales_order_id) WHERE sales_order_id IS NOT NULL;
CREATE INDEX channel_orders_org_idx ON channel_orders(organization_id,created_external DESC);
`,
};
