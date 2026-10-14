// T021: tasks, checklists, comments, evidence, templates, history; domain event outbox
// and in-app notifications used by tasks, situations and automations.
export const tasksMigration = {
  version: 8,
  sql: `
CREATE TABLE execution_commands (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), request_key uuid NOT NULL, payload_hash text NOT NULL, result_id uuid NOT NULL,
 UNIQUE(organization_id,request_key)
);
CREATE TABLE domain_events (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), branch_id uuid, topic text NOT NULL,
 entity_type text NOT NULL, entity_id uuid NOT NULL, payload jsonb NOT NULL DEFAULT '{}', actor_id uuid REFERENCES users(id),
 origin_chain_id uuid NOT NULL, depth integer NOT NULL DEFAULT 0 CHECK(depth>=0), dedupe_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz,
 UNIQUE(organization_id,id), UNIQUE(organization_id,dedupe_key),
 FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id)
);
CREATE INDEX domain_events_pending_idx ON domain_events(dispatched_at,created_at) WHERE dispatched_at IS NULL;
CREATE INDEX domain_events_topic_idx ON domain_events(organization_id,topic,created_at DESC);
CREATE TABLE notifications (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), user_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL, dedupe_key text NOT NULL, read_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,user_id,dedupe_key)
);
CREATE INDEX notifications_user_idx ON notifications(organization_id,user_id,created_at DESC);
CREATE TABLE task_templates (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), branch_id uuid NOT NULL, name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('general','shift_open','shift_close','receiving','return','purchase','verification')),
 checklist jsonb NOT NULL DEFAULT '[]', requires_verification boolean NOT NULL, evidence text NOT NULL CHECK(evidence IN ('none','comment','photo','operation')),
 priority text NOT NULL CHECK(priority IN ('low','normal','high','urgent')), assignee_id uuid REFERENCES users(id), deputy_id uuid REFERENCES users(id),
 recurrence text NOT NULL CHECK(recurrence IN ('none','daily','weekdays','weekly')), due_time text NOT NULL CHECK(due_time ~ '^[0-2][0-9]:[0-5][0-9]$'), weekday integer CHECK(weekday BETWEEN 1 AND 7),
 active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,branch_id,name), FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id)
);
CREATE INDEX task_templates_assignee_idx ON task_templates(assignee_id);
CREATE INDEX task_templates_deputy_idx ON task_templates(deputy_id);
CREATE INDEX task_templates_creator_idx ON task_templates(created_by);
CREATE TABLE tasks (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), branch_id uuid NOT NULL, number integer GENERATED ALWAYS AS IDENTITY,
 title text NOT NULL, description text NOT NULL, kind text NOT NULL CHECK(kind IN ('general','shift_open','shift_close','receiving','return','purchase','verification')),
 source text NOT NULL CHECK(source IN ('manual','template','proposal','automation','situation','assistant')), source_id uuid,
 priority text NOT NULL CHECK(priority IN ('low','normal','high','urgent')),
 state text NOT NULL CHECK(state IN ('new','assigned','in_progress','blocked','done','verified','cancelled')),
 assignee_id uuid REFERENCES users(id), deputy_id uuid REFERENCES users(id), due_at timestamptz,
 requires_verification boolean NOT NULL, evidence text NOT NULL CHECK(evidence IN ('none','comment','photo','operation')),
 links jsonb NOT NULL DEFAULT '[]', blocked_reason text, completion jsonb, template_id uuid, recurrence_key text,
 escalated_at timestamptz, completed_by uuid REFERENCES users(id), completed_at timestamptz, verified_by uuid REFERENCES users(id), verified_at timestamptz,
 version integer NOT NULL DEFAULT 1, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id),
 FOREIGN KEY(organization_id,template_id) REFERENCES task_templates(organization_id,id),
 CHECK(state NOT IN ('assigned','in_progress','blocked','done','verified') OR assignee_id IS NOT NULL),
 CHECK(state<>'verified' OR requires_verification)
);
CREATE UNIQUE INDEX tasks_recurrence_idx ON tasks(organization_id,recurrence_key) WHERE recurrence_key IS NOT NULL;
CREATE UNIQUE INDEX tasks_source_idx ON tasks(organization_id,source,source_id) WHERE source_id IS NOT NULL AND source IN ('proposal','automation');
CREATE INDEX tasks_scope_idx ON tasks(organization_id,branch_id,state,due_at);
CREATE INDEX tasks_assignee_idx ON tasks(assignee_id,state);
CREATE INDEX tasks_deputy_idx ON tasks(deputy_id);
CREATE INDEX tasks_creator_idx ON tasks(created_by);
CREATE INDEX tasks_template_idx ON tasks(organization_id,template_id);
CREATE INDEX tasks_completed_by_idx ON tasks(completed_by);
CREATE INDEX tasks_verified_by_idx ON tasks(verified_by);
CREATE TABLE task_checklist (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, task_id uuid NOT NULL, position integer NOT NULL, text text NOT NULL,
 done_by uuid REFERENCES users(id), done_at timestamptz, UNIQUE(organization_id,task_id,position),
 FOREIGN KEY(organization_id,task_id) REFERENCES tasks(organization_id,id)
);
CREATE INDEX task_checklist_done_by_idx ON task_checklist(done_by);
CREATE TABLE task_comments (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, task_id uuid NOT NULL, body text NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), FOREIGN KEY(organization_id,task_id) REFERENCES tasks(organization_id,id)
);
CREATE INDEX task_comments_task_idx ON task_comments(organization_id,task_id,created_at);
CREATE INDEX task_comments_actor_idx ON task_comments(actor_id);
CREATE TABLE task_attachments (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, task_id uuid NOT NULL, filename text NOT NULL, mime text NOT NULL CHECK(mime IN ('image/png','image/jpeg','application/pdf')),
 sha256 text NOT NULL, content bytea NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,task_id,sha256), FOREIGN KEY(organization_id,task_id) REFERENCES tasks(organization_id,id)
);
CREATE INDEX task_attachments_actor_idx ON task_attachments(actor_id);
CREATE TABLE task_events (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, task_id uuid NOT NULL, kind text NOT NULL, from_state text, to_state text, note text NOT NULL,
 data jsonb NOT NULL DEFAULT '{}', actor_id uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,task_id) REFERENCES tasks(organization_id,id)
);
CREATE INDEX task_events_task_idx ON task_events(organization_id,task_id,created_at);
CREATE INDEX task_events_actor_idx ON task_events(actor_id);
CREATE TABLE work_schedules (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id), start_time text NOT NULL CHECK(start_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
 end_time text NOT NULL CHECK(end_time ~ '^[0-2][0-9]:[0-5][0-9]$'), days jsonb NOT NULL, escalate_after_minutes integer NOT NULL CHECK(escalate_after_minutes BETWEEN 0 AND 10080),
 version integer NOT NULL DEFAULT 1
);
`,
};
