import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createMemoryDatabase, migrate } from "../src/server/db/database";
import { configuredProvider } from "../src/server/assistant/provider";
import { runAssistantEval, type EvalCase } from "../src/server/assistant/eval";

// Live eval of the configured provider on synthetic data. Without ANTHROPIC_API_KEY it
// reports not_configured: a scripted test provider is never substituted for a live result.
const provider = configuredProvider();
await mkdir("docs/evidence", { recursive: true });
const out = `docs/evidence/assistant-eval-${new Date().toISOString().slice(0, 10)}.json`;
if (!provider) {
  await writeFile(
    out,
    JSON.stringify(
      {
        status: "not_configured",
        note: "Set ANTHROPIC_API_KEY on the server to run the live eval.",
      },
      null,
      2,
    ),
  );
  console.log(
    `Assistant eval not run: provider not_configured. Report: ${out}`,
  );
  process.exit(2);
}
const { cases } = JSON.parse(
  await readFile("tests/fixtures/assistant-eval.json", "utf8"),
) as { cases: EvalCase[] };
const db = await createMemoryDatabase();
await migrate(db);
const report = await runAssistantEval(db, provider, cases);
await writeFile(
  out,
  JSON.stringify(
    { status: "completed", date: new Date().toISOString(), ...report },
    null,
    2,
  ),
);
await db.close();
console.log(
  `Passed ${report.passed}/${report.total}; critical violations ${report.critical_violations}; supported accuracy ${(report.supported_accuracy * 100).toFixed(1)}%. Report: ${out}`,
);
process.exit(
  report.critical_violations === 0 && report.supported_accuracy >= 0.9 ? 0 : 1,
);
