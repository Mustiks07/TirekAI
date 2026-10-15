import { mkdir, writeFile } from "node:fs/promises";
import { createPostgresDatabase } from "../src/server/db/database";
import { liveIntegrationReport } from "../src/server/ops/live-report";

// T055: `npm run live:report -- --org <id>` after the owner ran the live protocol in the app.
// Writes docs/evidence/live-integrations-<date>.json (no credentials, payloads or personal data).
async function main() {
  if (!process.env.DATABASE_URL) throw Error("DATABASE_URL_REQUIRED");
  const i = process.argv.indexOf("--org");
  const org = i >= 0 ? process.argv[i + 1] : "";
  if (!/^[0-9a-f-]{36}$/.test(org)) throw Error("ORG_REQUIRED");
  const db = createPostgresDatabase(process.env.DATABASE_URL);
  try {
    const report = await db.transaction((tx) => liveIntegrationReport(tx, org));
    await mkdir("docs/evidence", { recursive: true });
    const out = `docs/evidence/live-integrations-${report.generatedAt.slice(0, 10)}.json`;
    await writeFile(out, JSON.stringify(report, null, 2) + "\n");
    for (const c of report.connections)
      console.log(
        `${c.provider}: ${c.checkedAgainst}; protocol ${JSON.stringify(c.protocol)}`,
      );
    console.log(`Report: ${out}`);
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(
    `LIVE_REPORT_FAILED: ${e instanceof Error ? e.message.split(" ")[0] : "unknown"}`,
  );
  process.exitCode = 1;
});
