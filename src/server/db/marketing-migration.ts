// T039: promotion campaigns. Content is versioned; a decision is bound to the version the approver
// saw; materials are exported or queued through a channel, never marked "published" without a
// channel confirmation. Images are uploaded manually (a generator is not configured).
export const marketingMigration = {
  version: 19,
  sql: `
CREATE TABLE marketing_campaigns (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), branch_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('draft','pending','approved','rejected','archived')),
 version integer NOT NULL DEFAULT 1, approved_version integer, data jsonb NOT NULL,
 spend_minor numeric(38,0) CHECK(spend_minor IS NULL OR (spend_minor>=0 AND spend_minor<1e38)), spend_note text NOT NULL DEFAULT '',
 spend_version integer NOT NULL DEFAULT 0,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id),
 CHECK(state<>'approved' OR approved_version=version)
);
CREATE INDEX marketing_campaigns_branch_idx ON marketing_campaigns(organization_id,branch_id,updated_at DESC);
CREATE INDEX marketing_campaigns_creator_idx ON marketing_campaigns(created_by);
CREATE TABLE marketing_campaign_versions (
 organization_id uuid NOT NULL, campaign_id uuid NOT NULL, version integer NOT NULL CHECK(version>0), data jsonb NOT NULL, evaluation jsonb NOT NULL,
 note text NOT NULL, author_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,campaign_id,version), FOREIGN KEY(organization_id,campaign_id) REFERENCES marketing_campaigns(organization_id,id)
);
CREATE INDEX marketing_versions_author_idx ON marketing_campaign_versions(author_id);
CREATE TABLE marketing_decisions (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, campaign_id uuid NOT NULL, version integer NOT NULL,
 decision text NOT NULL CHECK(decision IN ('submitted','approved','rejected','archived')), override boolean NOT NULL DEFAULT false,
 evaluation jsonb, note text NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,campaign_id,version) REFERENCES marketing_campaign_versions(organization_id,campaign_id,version)
);
CREATE INDEX marketing_decisions_campaign_idx ON marketing_decisions(organization_id,campaign_id,created_at);
CREATE INDEX marketing_decisions_actor_idx ON marketing_decisions(actor_id);
CREATE TABLE marketing_images (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, campaign_id uuid NOT NULL, source text NOT NULL CHECK(source IN ('manual','generator')),
 mime text NOT NULL CHECK(mime IN ('image/png','image/jpeg')), size integer NOT NULL CHECK(size>0 AND size<=2097152), sha256 text NOT NULL,
 bytes bytea NOT NULL, alt_ru text NOT NULL, alt_kk text NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), FOREIGN KEY(organization_id,campaign_id) REFERENCES marketing_campaigns(organization_id,id)
);
CREATE INDEX marketing_images_campaign_idx ON marketing_images(organization_id,campaign_id);
CREATE INDEX marketing_images_creator_idx ON marketing_images(created_by);
CREATE TABLE marketing_publications (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, campaign_id uuid NOT NULL, version integer NOT NULL,
 channel text NOT NULL CHECK(channel IN ('export','telegram')), material text NOT NULL CHECK(material IN ('poster','price_tag','card','message')),
 locale text NOT NULL CHECK(locale IN ('ru','kk')), state text NOT NULL CHECK(state IN ('exported','queued','not_configured','blocked')),
 reason text, recipients integer NOT NULL DEFAULT 0, skipped jsonb NOT NULL DEFAULT '{}', sha256 text, connection_id uuid,
 actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), FOREIGN KEY(organization_id,campaign_id,version) REFERENCES marketing_campaign_versions(organization_id,campaign_id,version),
 FOREIGN KEY(organization_id,connection_id) REFERENCES integration_connections(organization_id,id)
);
CREATE INDEX marketing_publications_campaign_idx ON marketing_publications(organization_id,campaign_id,created_at DESC);
CREATE INDEX marketing_publications_actor_idx ON marketing_publications(actor_id);
CREATE INDEX marketing_publications_connection_idx ON marketing_publications(organization_id,connection_id);
ALTER TABLE messaging_messages ADD COLUMN publication_id uuid;
ALTER TABLE messaging_messages ADD FOREIGN KEY(organization_id,publication_id) REFERENCES marketing_publications(organization_id,id);
CREATE INDEX messaging_publication_idx ON messaging_messages(organization_id,publication_id) WHERE publication_id IS NOT NULL;
`,
};
