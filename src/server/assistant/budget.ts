import { randomUUID } from "node:crypto";
import type { Database, Sql } from "../db/database";
import { sessionAccess, type Credential } from "../access";
import { AppError } from "../../domain/errors";
import type { AssistantProvider, ProviderRequest } from "./provider";

// The provider's count is an estimate. Reserve a fixed input envelope with 1,000 tokens of
// headroom and refuse oversized prompts (including tool results) before paid inference.
export const INPUT_TOKEN_ENVELOPE = 12_000;
export const MAX_COUNTED_INPUT = 11_000;
export async function lockAssistantBudget(tx: Sql, org: string) {
  await tx.query("SELECT pg_advisory_xact_lock(56025,hashtext($1))", [org]);
}
export async function budgetState(tx: Sql, org: string) {
  const [state] = await tx.query<{ committed: number; breached: boolean }>(
    `SELECT (
      coalesce((SELECT sum(input_tokens::bigint+output_tokens) FROM assistant_usage u
        WHERE u.organization_id=o.id AND u.reservation_id IS NULL AND
        date_trunc('month',u.created_at AT TIME ZONE o.timezone)=date_trunc('month',now() AT TIME ZONE o.timezone)),0)
      +coalesce((SELECT sum(coalesce(r.actual_tokens,r.reserved_tokens)::bigint) FROM assistant_budget_reservations r
        WHERE r.organization_id=o.id AND (r.actual_tokens IS NULL OR
        date_trunc('month',r.created_at AT TIME ZONE o.timezone)=date_trunc('month',now() AT TIME ZONE o.timezone))),0)
    )::float8 committed,
    EXISTS(SELECT 1 FROM assistant_budget_reservations r WHERE r.organization_id=o.id AND r.breached) breached
    FROM organizations o WHERE o.id=$1`,
    [org],
  );
  return state;
}

type BudgetContext = {
  secret: Credential;
  org: string;
  user: string;
  conversation: string | null;
  feature: "chat" | "automation_draft";
};
export async function budgetedComplete(
  db: Database,
  provider: AssistantProvider,
  ctx: BudgetContext,
  request: ProviderRequest,
) {
  const candidates = [provider, ...(provider.fallbacks ?? [])].slice(0, 3);
  for (let i = 0; i < candidates.length; i++) {
    if (request.signal.aborted) throw new AppError("ASSISTANT_TIMEOUT", 504);
    try {
      return await completeAttempt(db, candidates[i], ctx, request);
    } catch (error) {
      // Refusals, malformed responses, input, authorization and budget failures cannot be bypassed.
      if (
        i === candidates.length - 1 ||
        request.signal.aborted ||
        !(error instanceof AppError) ||
        ![
          "ASSISTANT_RATE_LIMITED",
          "ASSISTANT_UNAVAILABLE",
          "ASSISTANT_NOT_CONFIGURED",
          "ASSISTANT_TIMEOUT",
        ].includes(error.code)
      )
        throw error;
    }
  }
  throw new AppError("ASSISTANT_UNAVAILABLE", 503);
}
async function completeAttempt(
  db: Database,
  provider: AssistantProvider,
  ctx: BudgetContext,
  request: ProviderRequest,
) {
  await db.transaction((tx) =>
    sessionAccess(
      tx,
      ctx.secret,
      ctx.org,
      ctx.feature === "chat" ? "assistant:use" : "automations:write",
    ),
  );
  const counted = await provider.countInputTokens(request);
  if (
    !Number.isSafeInteger(counted) ||
    counted < 0 ||
    counted > MAX_COUNTED_INPUT
  )
    throw new AppError("ASSISTANT_INPUT_TOO_LARGE", 413);
  const reservation = randomUUID();
  const reserve = INPUT_TOKEN_ENVELOPE + request.maxTokens;
  await db.transaction(async (tx) => {
    await sessionAccess(
      tx,
      ctx.secret,
      ctx.org,
      ctx.feature === "chat" ? "assistant:use" : "automations:write",
    );
    await lockAssistantBudget(tx, ctx.org);
    const [settings] = await tx.query<{
      enabled: boolean;
      monthly_token_budget: number;
      max_output_tokens: number;
    }>(
      "SELECT enabled,monthly_token_budget::int monthly_token_budget,max_output_tokens FROM assistant_settings WHERE organization_id=$1",
      [ctx.org],
    );
    if (
      settings &&
      (!settings.enabled || request.maxTokens > settings.max_output_tokens)
    )
      throw new AppError("ASSISTANT_DISABLED", 409);
    const state = await budgetState(tx, ctx.org);
    if (
      state.breached ||
      state.committed + reserve > (settings?.monthly_token_budget ?? 2_000_000)
    )
      throw new AppError("ASSISTANT_BUDGET_EXCEEDED", 409);
    await tx.query(
      "INSERT INTO assistant_budget_reservations(id,organization_id,reserved_tokens) VALUES($1,$2,$3)",
      [reservation, ctx.org, reserve],
    );
  });
  // No transaction across network I/O. A crash, timeout or ambiguous error keeps the full
  // reservation, even next month, until an operator reconciles it against provider billing.
  const started = Date.now();
  const response = await provider.complete(request);
  const valid =
    Number.isSafeInteger(response.inputTokens) &&
    response.inputTokens >= 0 &&
    Number.isSafeInteger(response.outputTokens) &&
    response.outputTokens >= 0;
  const breached =
    !valid ||
    response.inputTokens > INPUT_TOKEN_ENVELOPE ||
    response.outputTokens > request.maxTokens;
  await db.transaction(async (tx) => {
    await lockAssistantBudget(tx, ctx.org);
    await tx.query(
      "UPDATE assistant_budget_reservations SET actual_tokens=$2,breached=$3 WHERE id=$1",
      [
        reservation,
        valid ? response.inputTokens + response.outputTokens : null,
        breached,
      ],
    );
    await tx.query(
      "INSERT INTO assistant_usage(id,organization_id,user_id,conversation_id,feature,provider,model,status,input_tokens,output_tokens,latency_ms,error_code,reservation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [
        randomUUID(),
        ctx.org,
        ctx.user,
        ctx.conversation,
        ctx.feature,
        provider.name,
        response.model,
        breached
          ? "error"
          : response.stopReason === "refusal"
            ? "refused"
            : "ok",
        valid ? response.inputTokens : 0,
        valid ? response.outputTokens : 0,
        Date.now() - started,
        breached ? "ASSISTANT_BUDGET_MISMATCH" : null,
        reservation,
      ],
    );
  });
  if (breached) throw new AppError("ASSISTANT_BUDGET_MISMATCH", 502);
  return response;
}
