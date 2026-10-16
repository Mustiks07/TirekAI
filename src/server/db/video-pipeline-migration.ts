// T057: the people pipeline (detector, tracker, frame rate) is recorded when a run starts, so an
// interrupted run without a summary still says how its counts were made. NULL for older runs:
// shown as "no model data", never assumed to be the motion pipeline.
export const videoPipelineMigration = {
  version: 26,
  sql: `
ALTER TABLE video_runs ADD COLUMN pipeline jsonb;
`,
};
