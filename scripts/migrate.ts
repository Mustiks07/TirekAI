import { createPostgresDatabase, migrate } from "../src/server/db/database";
async function main() {
  if (!process.env.DATABASE_URL)
    throw new Error(
      "Set DATABASE_URL. Local preview applies migrations on startup.",
    );
  const db = createPostgresDatabase(process.env.DATABASE_URL);
  try {
    await migrate(db);
    console.log("Migrations applied.");
  } finally {
    await db.close();
  }
}
main().catch(() => {
  console.error(
    "Migration failed. Check database access and migration history.",
  );
  process.exitCode = 1;
});
