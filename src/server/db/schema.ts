import { importMigration } from "./import-migration";
import { inventoryMigration } from "./inventory-migration";
export const migrations = [
  {
    version: 1,
    sql: `
CREATE TABLE users (
  id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
  password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE TABLE organizations (
  id uuid PRIMARY KEY, name text NOT NULL, profile text NOT NULL CHECK(profile IN ('retail','food','services','education','projects','production','construction','clinic')),
  currency text NOT NULL DEFAULT 'KZT' CHECK(currency = 'KZT'), timezone text NOT NULL DEFAULT 'Asia/Qyzylorda',
  data_origin text NOT NULL DEFAULT 'synthetic' CHECK(data_origin = 'synthetic'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE branches (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), name text NOT NULL,
  UNIQUE(organization_id, id), UNIQUE(organization_id, name)
);
CREATE TABLE memberships (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK(role IN ('owner','manager','sales','purchasing','finance','employee','observer')),
  branch_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, user_id), FOREIGN KEY(organization_id, branch_id) REFERENCES branches(organization_id, id),
  CHECK(role != 'owner' OR branch_id IS NULL)
);
CREATE TABLE invitations (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), email text NOT NULL,
  role text NOT NULL CHECK(role IN ('manager','sales','purchasing','finance','employee','observer')), branch_id uuid,
  token_hash text NOT NULL UNIQUE, created_by uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL,
  accepted_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id, branch_id) REFERENCES branches(organization_id, id)
);
CREATE INDEX invitations_org_idx ON invitations(organization_id);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), branch_id uuid,
  actor_id uuid REFERENCES users(id), action text NOT NULL, details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id, branch_id) REFERENCES branches(organization_id, id)
);
CREATE INDEX audit_org_created_idx ON audit_events(organization_id, created_at DESC);
CREATE TABLE auth_limits (
  key_hash text PRIMARY KEY, attempts integer NOT NULL, reset_at timestamptz NOT NULL
);
`,
  },
  importMigration,
  inventoryMigration,
];
