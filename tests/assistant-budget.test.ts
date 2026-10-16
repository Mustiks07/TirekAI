import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { AssistantService } from "../src/server/assistant/service";
import { budgetedComplete, budgetState } from "../src/server/assistant/budget";
import type {
  AssistantProvider,
  ProviderRequest,
  ProviderResponse,
} from "../src/server/assistant/provider";
import { AppError } from "../src/domain/errors";

let db: Database;
beforeAll(async () => {
  db = await createMemoryDatabase();
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});
const request = (): ProviderRequest => ({
  system: "test",
  messages: [{ role: "user", content: "test" }],
  tools: [],
  maxTokens: 4000,
  signal: AbortSignal.timeout(10000),
});
const response = (): ProviderResponse => ({
  content: [],
  stopReason: "end_turn",
  inputTokens: 100,
  outputTokens: 20,
  model: "test",
});
async function setup(budget = 16000) {
  const p = new Platform(db);
  const owner = await p.register({
    name: "Budget test",
    email: `${randomUUID()}@example.test`,
    password: "Synthetic-Budget-661!",
  });
  const org = (
    await p.createOrganization(owner.token, {
      name: "Budget",
      profile: "retail",
    })
  ).id;
  await new AssistantService(db, null).saveSettings(owner.token, org, {
    version: 0,
    enabled: true,
    voiceEnabled: false,
    monthlyTokenBudget: budget,
    maxOutputTokens: 4000,
  });
  return {
    secret: owner.token,
    org,
    user: owner.user.id,
    conversation: null,
    feature: "chat" as const,
  };
}
const provider = (
  complete: AssistantProvider["complete"],
  count = 100,
): AssistantProvider => ({
  name: "test",
  model: "test",
  countInputTokens: async () => count,
  complete,
});

it("T056: simultaneous chat and automation requests cannot reserve the same remaining budget", async () => {
  const ctx = await setup();
  let release!: (r: ProviderResponse) => void, entered!: () => void;
  const pending = new Promise<ProviderResponse>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const p = provider(async () => {
    calls++;
    entered();
    return pending;
  });
  const first = budgetedComplete(db, p, ctx, request());
  await started;
  try {
    expect((await budgetState(db, ctx.org)).committed).toBe(16000);
    const draft = await new AssistantService(db, p).draftAutomation(
      ctx.secret,
      ctx.org,
      { locale: "ru", text: "Создай задачу проверить остаток" },
    );
    expect(draft.status).toBe("budget_exceeded");
    expect(calls).toBe(1);
  } finally {
    release(response());
    await first;
  }
  expect((await budgetState(db, ctx.org)).committed).toBe(120);
  const status = await new AssistantService(db, p).status(ctx.secret, ctx.org);
  expect(status.usage.month_tokens).toBe(120);
  // A further full request cannot fit in the remaining 15,880 tokens.
  await expect(budgetedComplete(db, p, ctx, request())).rejects.toMatchObject({
    code: "ASSISTANT_BUDGET_EXCEEDED",
  });
});
it("T056: ambiguous provider errors keep their reservation, including across a month boundary", async () => {
  const ctx = await setup();
  const p = provider(async () => {
    throw new AppError("ASSISTANT_TIMEOUT", 504);
  });
  await expect(budgetedComplete(db, p, ctx, request())).rejects.toMatchObject({
    code: "ASSISTANT_TIMEOUT",
  });
  await db.query(
    "UPDATE assistant_budget_reservations SET created_at=now()-interval '2 months' WHERE organization_id=$1",
    [ctx.org],
  );
  expect((await budgetState(db, ctx.org)).committed).toBe(16000);
  await expect(budgetedComplete(db, p, ctx, request())).rejects.toMatchObject({
    code: "ASSISTANT_BUDGET_EXCEEDED",
  });
});
it("T056: missing/oversized counts fail before inference; unexpected provider usage stops later requests", async () => {
  const ctx = await setup(100000);
  let calls = 0;
  for (const count of [11001, NaN, -1, 1.5]) {
    await expect(
      budgetedComplete(
        db,
        provider(async () => {
          calls++;
          return response();
        }, count),
        ctx,
        request(),
      ),
    ).rejects.toMatchObject({ code: "ASSISTANT_INPUT_TOO_LARGE" });
  }
  expect(calls).toBe(0);
  expect((await budgetState(db, ctx.org)).committed).toBe(0);
  await expect(
    budgetedComplete(
      db,
      provider(async () => ({ ...response(), inputTokens: 12001 })),
      ctx,
      request(),
    ),
  ).rejects.toMatchObject({ code: "ASSISTANT_BUDGET_MISMATCH" });
  expect((await budgetState(db, ctx.org)).breached).toBe(true);
  await expect(
    budgetedComplete(
      db,
      provider(async () => {
        calls++;
        return response();
      }),
      ctx,
      request(),
    ),
  ).rejects.toMatchObject({ code: "ASSISTANT_BUDGET_EXCEEDED" });
  expect(calls).toBe(0);
});
it("T056: every tool iteration counts the full accumulated input before making another paid call", async () => {
  const ctx = await setup(100000);
  let calls = 0;
  const p: AssistantProvider = {
    name: "test",
    model: "test",
    countInputTokens: async (r) => (r.messages.length > 1 ? 12000 : 100),
    complete: async () => {
      calls++;
      return {
        ...response(),
        stopReason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool_test",
            name: "list_situations",
            input: {},
          } as never,
        ],
      };
    },
  };
  const result = await new AssistantService(db, p).ask(ctx.secret, ctx.org, {
    key: randomUUID(),
    locale: "ru",
    text: "Ситуации",
  });
  expect(result.message).toMatchObject({
    status: "error",
    error_code: "ASSISTANT_INPUT_TOO_LARGE",
  });
  expect(calls).toBe(1);
});
