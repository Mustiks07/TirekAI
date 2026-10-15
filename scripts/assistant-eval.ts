import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createMemoryDatabase, migrate } from "../src/server/db/database";
import { configuredProvider } from "../src/server/assistant/provider";
import {
  evalBudget,
  runAssistantEval,
  type EvalCase,
} from "../src/server/assistant/eval";

// Live eval of the configured provider on synthetic data. Without ANTHROPIC_API_KEY it
// reports not_configured: a scripted test provider is never substituted for a live result.
// With a key it is a paid run: it starts only with --confirm-budget <tokens> at or above the
// printed upper bound, and that number becomes the eval organization's hard token cap.
const provider = configuredProvider();
await mkdir("docs/evidence", { recursive: true });
const out = `docs/evidence/assistant-eval-${new Date().toISOString().slice(0, 10)}.json`;
const { cases } = JSON.parse(
  await readFile("tests/fixtures/assistant-eval.json", "utf8"),
) as { cases: EvalCase[] };
const budget = evalBudget(cases.length);
if (!provider) {
  await writeFile(
    out,
    JSON.stringify(
      {
        status: "not_configured",
        note: "Set ANTHROPIC_API_KEY on the server to run the live eval.",
        budget,
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
const flag = process.argv.indexOf("--confirm-budget");
const confirmed = flag >= 0 ? Number(process.argv[flag + 1]) : NaN;
console.log(
  `Paid eval: ${budget.cases} cases, at most ${budget.maxCalls} model calls, upper bound ${budget.upperBoundTokens} tokens (model ${provider.model}).`,
);
if (
  !Number.isSafeInteger(confirmed) ||
  confirmed < budget.upperBoundTokens ||
  confirmed > 1_000_000_000
) {
  console.log(
    `Not started. Re-run with --confirm-budget ${budget.upperBoundTokens} (or more) after approving the cost.`,
  );
  process.exit(3);
}
const db = await createMemoryDatabase();
await migrate(db);
const report = await runAssistantEval(db, provider, cases, {
  tokenBudget: confirmed,
});
await writeFile(
  out,
  JSON.stringify(
    {
      status: "completed",
      date: new Date().toISOString(),
      budget: { ...budget, confirmedTokens: confirmed },
      ...report,
    },
    null,
    2,
  ),
);
await db.close();
console.log(
  `Passed ${report.passed}/${report.total}; critical violations ${report.critical_violations}; supported accuracy ${(report.supported_accuracy * 100).toFixed(1)}%. Tokens used ${report.tokens_used}. Report: ${out}`,
);
process.exit(
  report.critical_violations === 0 && report.supported_accuracy >= 0.9 ? 0 : 1,
);
