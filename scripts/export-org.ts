import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPostgresDatabase } from "../src/server/db/database";
import { exportOrganization } from "../src/server/ops/export";

// Operator export of one organization: `npm run org:export -- --org <id> [--binaries] [--out dir]`.
// Writes one JSON file (mode 0600) under the ignored .data directory by default.
async function main() {
  if (!process.env.DATABASE_URL) throw Error("DATABASE_URL_REQUIRED");
  const arg = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const org = arg("org");
  if (!org || !/^[0-9a-f-]{36}$/.test(org)) throw Error("ORG_REQUIRED");
  const out = resolve(arg("out") ?? ".data/exports");
  const db = createPostgresDatabase(process.env.DATABASE_URL);
  try {
    const data = await db.transaction((tx) =>
      exportOrganization(tx, org, {
        binaries: process.argv.includes("--binaries"),
      }),
    );
    await mkdir(out, { recursive: true });
    const file = resolve(
      out,
      `organization-${org}-${data.exportedAt.replace(/[:.]/g, "-")}.json`,
    );
    await writeFile(file, JSON.stringify(data), { mode: 0o600 });
    console.log(
      `Exported ${Object.values(data.counts).reduce((a, n) => a + n, 0)} rows from ${Object.keys(data.counts).length} tables to ${file}; omitted columns: ${data.omittedColumns.length}.`,
    );
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(
    `EXPORT_FAILED: ${e instanceof Error ? e.message.split(" ")[0] : "unknown"}`,
  );
  process.exitCode = 1;
});
