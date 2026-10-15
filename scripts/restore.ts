import { encryptionKey, restore } from "./backup-lib";

// `RESTORE_DATABASE_URL=<empty database> npm run db:restore -- --file <backup> --confirm`.
// Restores only into an empty database and verifies every table against the manifest. The
// target URL is read from the environment so it does not appear in the process list.
async function main() {
  const url = process.env.RESTORE_DATABASE_URL;
  const i = process.argv.indexOf("--file");
  if (!url || i < 0) throw Error("USAGE_RESTORE_DATABASE_URL_AND_FILE");
  if (!process.argv.includes("--confirm")) throw Error("CONFIRM_REQUIRED");
  const started = Date.now();
  const r = await restore(process.argv[i + 1], url, {
    bin: process.env.PG_BIN,
    key: encryptionKey(),
  });
  console.log(
    `Restored and verified ${r.tables} tables, ${r.rows} rows, ${r.migrations} migrations in ${Math.round((Date.now() - started) / 100) / 10} s. Point the application at the restored database after checks.`,
  );
}
main().catch((e) => {
  console.error(
    `RESTORE_FAILED: ${e instanceof Error ? e.message.split(" ")[0] : "unknown"}`,
  );
  process.exitCode = 1;
});
