// T022: knowledge documents with immutable versions, explicit publication, audience and review dates.
export const knowledgeMigration = {
  version: 9,
  sql: `
CREATE TABLE knowledge_documents (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), branch_id uuid, title text NOT NULL, category text NOT NULL,
 audience jsonb NOT NULL DEFAULT '[]', state text NOT NULL CHECK(state IN ('draft','published','archived')),
 latest_version integer NOT NULL CHECK(latest_version>0), published_version integer, review_due date,
 version integer NOT NULL DEFAULT 1, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id),
 CHECK(state<>'published' OR published_version IS NOT NULL), CHECK(published_version IS NULL OR published_version<=latest_version)
);
CREATE INDEX knowledge_scope_idx ON knowledge_documents(organization_id,branch_id,state);
CREATE INDEX knowledge_creator_idx ON knowledge_documents(created_by);
CREATE TABLE knowledge_versions (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, document_id uuid NOT NULL, number integer NOT NULL CHECK(number>0), title text NOT NULL, body text NOT NULL,
 filename text, mime text, original bytea, sha256 text, change_note text NOT NULL, author_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 published_at timestamptz, published_by uuid REFERENCES users(id),
 UNIQUE(organization_id,document_id,number), FOREIGN KEY(organization_id,document_id) REFERENCES knowledge_documents(organization_id,id)
);
CREATE INDEX knowledge_versions_author_idx ON knowledge_versions(author_id);
CREATE INDEX knowledge_versions_publisher_idx ON knowledge_versions(published_by);
CREATE INDEX knowledge_versions_text_idx ON knowledge_versions USING gin (to_tsvector('simple', title || ' ' || body));
`,
};
