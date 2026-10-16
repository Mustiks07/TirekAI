import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createMemoryDatabase, migrate } from "../src/server/db/database";
import { configuredProvider } from "../src/server/assistant/provider";
import {
  evalBudget,
  runAssistantEval,
  type EvalCase,
} from "../src/server/assistant/eval";

// Live eval on synthetic data; never substitutes a scripted provider for a real result.
// Requires explicit token admission even for free providers, to protect their limited quota.
// The bound includes every configured fallback; each attempt reserves its own budget.
const provider = configuredProvider();
await mkdir("docs/evidence", { recursive: true });
const out = `docs/evidence/assistant-eval-${new Date().toISOString().slice(0, 10)}.json`;
const { cases } = JSON.parse(
  await readFile("tests/fixtures/assistant-eval.json", "utf8"),
) as { cases: EvalCase[] };
const budget = evalBudget(
  cases.length,
  undefined,
  1 + (provider?.fallbacks?.length ?? 0),
);
if (!provider) {
  await writeFile(
    out,
    JSON.stringify(
      {
        status: "not_configured",
        note: "Configure ASSISTANT_PROVIDER and its server credentials to run the live eval.",
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
  `Live eval: ${budget.cases} cases, at most ${budget.maxCalls} model calls, application reservation bound ${budget.upperBoundTokens} tokens (model ${provider.model}).`,
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
