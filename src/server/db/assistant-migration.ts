// T026–T028: assistant settings and budget, usage journal, conversations with sources.
// Provider credentials are never stored here: they live only in server environment variables.
export const assistantMigration = {
  version: 12,
  sql: `
CREATE TABLE assistant_settings (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id), enabled boolean NOT NULL DEFAULT true, voice_enabled boolean NOT NULL DEFAULT false,
 monthly_token_budget bigint NOT NULL CHECK(monthly_token_budget>=0), max_output_tokens integer NOT NULL CHECK(max_output_tokens BETWEEN 256 AND 16000),
 version integer NOT NULL DEFAULT 1, updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_settings_updated_by_idx ON assistant_settings(updated_by);
CREATE TABLE assistant_conversations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id), locale text NOT NULL CHECK(locale IN ('ru','kk')),
 title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,id)
);
CREATE INDEX assistant_conversations_user_idx ON assistant_conversations(organization_id,user_id,updated_at DESC);
CREATE INDEX assistant_conversations_user_fk_idx ON assistant_conversations(user_id);
CREATE TABLE assistant_messages (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, conversation_id uuid NOT NULL, role text NOT NULL CHECK(role IN ('user','assistant')),
 content text NOT NULL, status text NOT NULL CHECK(status IN ('ok','refused','error','not_configured','budget_exceeded','incomplete')),
 sources jsonb NOT NULL DEFAULT '[]', tool_calls jsonb NOT NULL DEFAULT '[]', unverified_numbers jsonb NOT NULL DEFAULT '[]', error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(organization_id,conversation_id) REFERENCES assistant_conversations(organization_id,id)
);
CREATE INDEX assistant_messages_conversation_idx ON assistant_messages(organization_id,conversation_id,created_at);
CREATE TABLE assistant_usage (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), user_id uuid REFERENCES users(id), conversation_id uuid,
 feature text NOT NULL CHECK(feature IN ('chat','voice','automation_draft')), provider text NOT NULL, model text NOT NULL,
 status text NOT NULL CHECK(status IN ('ok','refused','error','timeout','rate_limited','budget_exceeded','not_configured','disabled')),
 input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0, latency_ms integer NOT NULL DEFAULT 0, error_code text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_usage_org_idx ON assistant_usage(organization_id,created_at DESC);
CREATE INDEX assistant_usage_user_idx ON assistant_usage(user_id);
`,
};
