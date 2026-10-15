// T035–T038: camera sources with passports, versioned lines/zones, processor runs, aggregated
// events (no frames), human annotations and evaluation records. Raw video is not stored.
export const videoMigration = {
  version: 18,
  sql: `
CREATE TABLE video_sources (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), branch_id uuid NOT NULL, name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('file','webcam','network')), mode text NOT NULL CHECK(mode IN ('recording','live')),
 passport jsonb NOT NULL DEFAULT '{}', state text NOT NULL DEFAULT 'stopped' CHECK(state IN ('stopped','running','lost','error')),
 device_token_hash text, raw_storage boolean NOT NULL DEFAULT false CHECK(raw_storage=false),
 last_heartbeat_at timestamptz, last_source_time timestamptz, last_metrics jsonb, version integer NOT NULL DEFAULT 1,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id), FOREIGN KEY(organization_id,branch_id) REFERENCES branches(organization_id,id)
);
CREATE INDEX video_sources_branch_idx ON video_sources(organization_id,branch_id);
CREATE INDEX video_sources_creator_idx ON video_sources(created_by);
CREATE UNIQUE INDEX video_sources_token_idx ON video_sources(device_token_hash) WHERE device_token_hash IS NOT NULL;
CREATE TABLE video_configs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, source_id uuid NOT NULL, version integer NOT NULL, lines jsonb NOT NULL, zones jsonb NOT NULL,
 note text NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_id,version), FOREIGN KEY(organization_id,source_id) REFERENCES video_sources(organization_id,id)
);
CREATE INDEX video_configs_org_idx ON video_configs(organization_id,source_id);
CREATE INDEX video_configs_creator_idx ON video_configs(created_by);
CREATE TABLE video_runs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, source_id uuid NOT NULL, config_version integer NOT NULL,
 state text NOT NULL CHECK(state IN ('running','ended','lost','error','aborted')), source_start timestamptz NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz, summary jsonb, passport jsonb NOT NULL DEFAULT '{}',
 UNIQUE(organization_id,id), FOREIGN KEY(organization_id,source_id) REFERENCES video_sources(organization_id,id)
);
CREATE INDEX video_runs_source_idx ON video_runs(organization_id,source_id,started_at DESC);
CREATE TABLE video_events (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, source_id uuid NOT NULL, run_id uuid NOT NULL, config_version integer NOT NULL, seq integer NOT NULL,
 kind text NOT NULL CHECK(kind IN ('line_cross','zone_count','dwell','queue_start','queue_end','gap','signal_lost','shelf_change_suspected','workstation_state')),
 at timestamptz NOT NULL, until timestamptz, line_id text, zone_id text, direction text CHECK(direction IN ('in','out')), value numeric(14,3), reason text,
 task_id uuid, UNIQUE(run_id,seq), UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,run_id) REFERENCES video_runs(organization_id,id),
 FOREIGN KEY(organization_id,source_id) REFERENCES video_sources(organization_id,id)
);
CREATE INDEX video_events_time_idx ON video_events(organization_id,source_id,at);
CREATE INDEX video_events_kind_idx ON video_events(organization_id,kind,at DESC);
CREATE TABLE video_annotations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, run_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('line_cross','queue','shelf_change','workstation_state')),
 at_seconds numeric(10,2) NOT NULL CHECK(at_seconds>=0), until_seconds numeric(10,2), line_id text, zone_id text, direction text CHECK(direction IN ('in','out')),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,run_id) REFERENCES video_runs(organization_id,id)
);
CREATE INDEX video_annotations_run_idx ON video_annotations(organization_id,run_id);
CREATE INDEX video_annotations_creator_idx ON video_annotations(created_by);
CREATE TABLE video_evaluations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), detector text NOT NULL, dataset jsonb NOT NULL, metrics jsonb NOT NULL,
 clips jsonb NOT NULL, passed boolean NOT NULL, status text NOT NULL CHECK(status IN ('experimental','validated')), reason text NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX video_evaluations_org_idx ON video_evaluations(organization_id,detector,created_at DESC);
CREATE INDEX video_evaluations_creator_idx ON video_evaluations(created_by);
`,
};
