import {
  createPostgresDatabase,
  migrate,
  migrationPlan,
} from "../src/server/db/database";

// `npm run db:migrate` applies pending migrations; `-- --plan` only lists them (T053).
// Rollback plan: migrations are forward-only and atomic per version. Before applying, take a
// backup (`npm run db:backup`); if the release must be rolled back, restore that backup into a
// new database and point the previous release at it (docs/RUNBOOK.md, docs/RELEASE.md).
async function main() {
  if (!process.env.DATABASE_URL)
    throw new Error(
      "Set DATABASE_URL. Local preview applies migrations on startup.",
    );
  const db = createPostgresDatabase(process.env.DATABASE_URL);
  try {
    const plan = await migrationPlan(db);
    console.log(
      `Applied: ${plan.applied.length ? `${plan.applied[0]}–${plan.applied.at(-1)}` : "none"}; pending: ${plan.pending.join(", ") || "none"}.`,
    );
    if (plan.modified.length)
      throw new Error(
        `MIGRATION_MODIFIED ${plan.modified.join(",")}: restore the released SQL.`,
      );
    if (plan.unknown.length)
      throw new Error(
        `DATABASE_NEWER_THAN_CODE ${plan.unknown.join(",")}: deploy the matching release.`,
      );
    if (process.argv.includes("--plan")) return;
    await migrate(db);
    console.log("Migrations applied.");
  } finally {
    await db.close();
  }
}
main().catch((error) => {
  const code =
    error instanceof Error && /^[A-Z_]+/.test(error.message)
      ? error.message
      : "check database access and migration history";
  console.error(`Migration failed: ${code}`);
  process.exitCode = 1;
});
