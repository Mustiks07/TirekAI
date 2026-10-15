import { createPostgresDatabase } from "../src/server/db/database";
import { policyFromEnv, retention } from "../src/server/ops/retention";

// `npm run ops:retention` lists what the policy would trim; `-- --apply` trims it (T053).
// Business history is never touched; see src/server/ops/retention.ts.
async function main() {
  if (!process.env.DATABASE_URL) throw Error("DATABASE_URL_REQUIRED");
  const apply = process.argv.includes("--apply");
  const policy = policyFromEnv();
  const db = createPostgresDatabase(process.env.DATABASE_URL);
  try {
    const result = await retention(db, policy, apply);
    console.log(
      JSON.stringify(
        { mode: apply ? "applied" : "dry-run", policy, rows: result },
        null,
        2,
      ),
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(
    `RETENTION_FAILED: ${e instanceof Error ? e.message.split(" ")[0] : "unknown"}`,
  );
  process.exitCode = 1;
});
