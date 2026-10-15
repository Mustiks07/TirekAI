import { mkdir, writeFile } from "node:fs/promises";
import { createPostgresDatabase } from "../src/server/db/database";
import { comparePilot, pilotMetrics } from "../src/server/ops/pilot";

// T058: `npm run pilot:metrics -- --org <id> --from YYYY-MM-DD --to YYYY-MM-DD
//   [--baseline-from YYYY-MM-DD --baseline-to YYYY-MM-DD] [--branch <id>]`.
// Measures the same metrics for the baseline (before the change) and the pilot period from the
// organization's operations and writes docs/evidence/pilot-<from>-<to>.json.
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
async function main() {
  if (!process.env.DATABASE_URL) throw Error("DATABASE_URL_REQUIRED");
  const org = arg("org");
  if (!org || !/^[0-9a-f-]{36}$/.test(org)) throw Error("ORG_REQUIRED");
  const branchId = arg("branch") ?? null;
  const db = createPostgresDatabase(process.env.DATABASE_URL);
  try {
    const result = await db.transaction(async (tx) => {
      const pilot = await pilotMetrics(tx, org, {
        from: arg("from")!,
        to: arg("to")!,
        branchId,
      });
      if (!arg("baseline-from")) return { pilot };
      const baseline = await pilotMetrics(tx, org, {
        from: arg("baseline-from")!,
        to: arg("baseline-to")!,
        branchId,
      });
      return comparePilot(baseline, pilot);
    });
    await mkdir("docs/evidence", { recursive: true });
    const out = `docs/evidence/pilot-${arg("from")}-${arg("to")}.json`;
    await writeFile(
      out,
      JSON.stringify(
        { task: "T058", organizationId: org, ...result },
        null,
        2,
      ) + "\n",
    );
    console.log(JSON.stringify(result, null, 2));
    console.log(`Report: ${out}`);
  } finally {
    await db.close();
  }
}
main().catch((e) => {
  console.error(
    `PILOT_METRICS_FAILED: ${e instanceof Error ? e.message.split(" ")[0] : "unknown"}`,
  );
  process.exitCode = 1;
});
