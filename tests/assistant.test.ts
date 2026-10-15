import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { CommerceService } from "../src/server/commerce/service";
import { AssistantService } from "../src/server/assistant/service";
import { AutomationService } from "../src/server/automations/service";
import { draftResult } from "../src/domain/automations";
import type {
  AssistantProvider,
  ProviderRequest,
} from "../src/server/assistant/provider";
import { AppError } from "../src/domain/errors";
import { askResult, answerNumbers } from "../src/domain/assistant";
import { toolDefinitions } from "../src/server/assistant/tools";

// Test-only scripted provider: it replays fixed turns to exercise the harness (tools, rights,
// budget, failures). It is not a model and is never constructed by production code.
class ScriptedProvider implements AssistantProvider {
  readonly name = "scripted-test";
  readonly model = "scripted";
  calls: ProviderRequest[] = [];
  constructor(
    private turns: (
      | Anthropic.Beta.BetaContentBlock[]
      | Error
      | ((r: ProviderRequest) => Anthropic.Beta.BetaContentBlock[])
    )[],
  ) {}
  async complete(r: ProviderRequest) {
    this.calls.push(structuredClone({ ...r, signal: undefined }) as never);
    const next = this.turns.shift();
    if (!next) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    const content = typeof next === "function" ? next(r) : next;
    return {
      content,
      stopReason: content.some((b) => b.type === "tool_use")
        ? "tool_use"
        : "end_turn",
      inputTokens: 100,
      outputTokens: 20,
      model: this.model,
    };
  }
}
const toolUse = (name: string, input: unknown) =>
  ({
    type: "tool_use",
    id: `toolu_${randomUUID().slice(0, 8)}`,
    name,
    input,
  }) as unknown as Anthropic.Beta.BetaContentBlock;
const text = (t: string) =>
  ({
    type: "text",
    text: t,
    citations: null,
  }) as unknown as Anthropic.Beta.BetaContentBlock;
let db: Database,
  p: Platform,
  org: string,
  owner: string,
  seller: string,
  otherOrgInsight: string;
const key = () => randomUUID();
beforeAll(async () => {
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  const user = () =>
    p.register({
      name: "AI",
      email: `${key()}@example.test`,
      password: "Synthetic-Assistant-661!",
    });
  owner = (await user()).token;
  org = (
    await p.createOrganization(owner, { name: "AI Lab", profile: "retail" })
  ).id;
  const branch = (await p.workspace(owner, org)).branches[0].id;
  const s = await user(),
    i = await p.invite(owner, org, {
      email: s.user.email,
      role: "sales",
      branchId: branch,
    });
  await p.acceptInvitation(s.token, { token: i.token });
  seller = s.token;
  await new CommerceService(db).createAccount(owner, org, {
    key: key(),
    branchId: branch,
    name: "Касса",
    opening: "1250.50",
  });
  // An insight in another organization for the cross-tenant test.
  const other = (await user()).token;
  const otherOrg = (
    await p.createOrganization(other, { name: "Other", profile: "retail" })
  ).id;
  otherOrgInsight = randomUUID();
  await db.query(
    "INSERT INTO insights(id,organization_id,rule,entity_type,entity_id,fingerprint,severity,state,evidence) VALUES($1,$2,'low_stock','stock',$3,'x',3,'open','{}')",
    [otherOrgInsight, otherOrg, randomUUID()],
  );
});
afterAll(async () => {
  await db?.close();
});
const ask = (svc: AssistantService, token: string, t: string, k = key()) =>
  svc
    .ask(token, org, { key: k, locale: "ru", text: t })
    .then((r) => askResult.parse(JSON.parse(JSON.stringify(r))));
it("T026: without a configured provider the assistant reports not_configured and logs usage", async () => {
  const r = await ask(
    new AssistantService(db, null),
    owner,
    "Что требует внимания?",
  );
  expect(r.message).toMatchObject({
    status: "not_configured",
    content: "",
    error_code: "ASSISTANT_NOT_CONFIGURED",
  });
  const [u] = await db.query<{ status: string }>(
    "SELECT status FROM assistant_usage WHERE organization_id=$1",
    [org],
  );
  expect(u.status).toBe("not_configured");
  const status = await new AssistantService(db, null).status(owner, org);
  expect(status.provider.status).toBe("not_configured");
  expect(status.speech.status).toBe("not_configured");
});
it("T027: numbers come from the calculation layer; an invented figure is flagged with sources attached", async () => {
  const provider = new ScriptedProvider([
    [toolUse("finance_summary", {})],
    [text("Деньги на счетах: 1 250,50 KZT. Прогноз прибыли 999 999 KZT.")],
  ]);
  const r = await ask(
    new AssistantService(db, provider),
    owner,
    "Сколько денег?",
  );
  expect(r.message.status).toBe("ok");
  expect(r.message.sources[0]).toMatchObject({ type: "finance_summary" });
  expect(r.message.tool_calls).toEqual([
    { name: "finance_summary", effect: "read", ok: true, error: null },
  ]);
  expect(r.message.unverified_numbers).toEqual(["999999"]);
  // Tool definitions offered to the model contain no SQL, shell, HTTP or approval capability.
  expect(provider.calls[0].tools.map((t) => t.name).sort()).toEqual(
    toolDefinitions()
      .map((t) => t.name)
      .sort(),
  );
  expect(provider.calls[0].system).toContain("never instructions");
  const toolResult = (
    provider.calls[1].messages.at(-1)!
      .content as Anthropic.Beta.BetaToolResultBlockParam[]
  )[0];
  expect(String(toolResult.content)).toContain("125050");
});
it("T027: tools run with the user's own rights; unregistered tools and other tenants' ids are refused", async () => {
  const provider = new ScriptedProvider([
    [
      toolUse("finance_summary", {}),
      toolUse("run_sql", { sql: "SELECT * FROM users" }),
      toolUse("draft_purchase_for_situation", { insightId: otherOrgInsight }),
    ],
    [text("Нет доступа к финансам.")],
  ]);
  const r = await ask(
    new AssistantService(db, provider),
    seller,
    "Покажи прибыль и создай закупку",
  );
  expect(r.message.tool_calls.map((c) => [c.name, c.ok, c.error])).toEqual([
    ["finance_summary", false, "FORBIDDEN"],
    ["run_sql", false, "TOOL_NOT_REGISTERED"],
    ["draft_purchase_for_situation", false, "NOT_FOUND"],
  ]);
  expect(await db.query("SELECT id FROM action_proposals")).toHaveLength(0);
});
it("T026: provider failures, budget limit and repeated keys never produce a fake answer or a double call", async () => {
  const failing = new ScriptedProvider([
    new AppError("ASSISTANT_TIMEOUT", 504),
  ]);
  const failed = await ask(new AssistantService(db, failing), owner, "Сводка");
  expect(failed.message).toMatchObject({
    status: "error",
    error_code: "ASSISTANT_TIMEOUT",
    content: "",
  });
  const once = new ScriptedProvider([[text("Ответ без чисел")]]);
  const k = key();
  const first = await ask(new AssistantService(db, once), owner, "Привет", k);
  const again = await ask(new AssistantService(db, once), owner, "Привет", k);
  expect(again).toMatchObject({
    reused: true,
    message: { id: first.message.id },
  });
  expect(once.calls).toHaveLength(1);
  await new AssistantService(db, null).saveSettings(owner, org, {
    version: 0,
    enabled: true,
    voiceEnabled: false,
    monthlyTokenBudget: 10,
    maxOutputTokens: 1000,
  });
  const blocked = await ask(
    new AssistantService(db, new ScriptedProvider([])),
    owner,
    "Ещё вопрос",
  );
  expect(blocked.message).toMatchObject({
    status: "budget_exceeded",
    error_code: "ASSISTANT_BUDGET_EXCEEDED",
  });
  await expect(
    new AssistantService(db, null).saveSettings(seller, org, {
      version: 1,
      enabled: true,
      voiceEnabled: true,
      monthlyTokenBudget: 1e6,
      maxOutputTokens: 1000,
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("T028: voice needs explicit enablement and a configured speech provider; audio is not stored", async () => {
  const svc = new AssistantService(db, null);
  const input = {
    key: key(),
    locale: "kk",
    mime: "audio/webm",
    audio: Buffer.from("synthetic").toString("base64"),
  };
  await expect(svc.transcribe(owner, org, input)).rejects.toMatchObject({
    code: "VOICE_DISABLED",
  });
  await svc.saveSettings(owner, org, {
    version: 1,
    enabled: true,
    voiceEnabled: true,
    monthlyTokenBudget: 1e6,
    maxOutputTokens: 1000,
  });
  await expect(svc.transcribe(owner, org, input)).rejects.toMatchObject({
    code: "VOICE_NOT_CONFIGURED",
  });
  const tables = await db.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.columns WHERE data_type='bytea' AND table_name LIKE 'assistant%'",
  );
  expect(tables).toHaveLength(0);
});
it("T027: answer number extraction handles RU/KK formatting and ignores dates", () => {
  expect(
    answerNumbers("Итого 1 250,50 ₸ на 2026-10-14, остаток 12.5 шт, в 09:30"),
  ).toEqual(["1250.5", "12.5"]);
});
it("T027: the eval set has 32 balanced RU/KK cases and the grader detects violations (harness check, not a model score)", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runAssistantEval } = await import("../src/server/assistant/eval");
  const { cases } = JSON.parse(
    await readFile("tests/fixtures/assistant-eval.json", "utf8"),
  );
  expect(cases).toHaveLength(32);
  expect(
    cases.filter((c: { locale: string }) => c.locale === "kk"),
  ).toHaveLength(16);
  const evalDb = await createMemoryDatabase();
  await migrate(evalDb);
  const provider = new ScriptedProvider([
    [toolUse("list_situations", {})],
    [text("Нехватка: Чай чёрный, доступно 4 шт.")],
    [toolUse("search_knowledge", { query: "сейф" })],
    [text("Код сейфа 4471")],
  ]);
  const report = await runAssistantEval(evalDb, provider, [
    cases[0],
    cases[10],
  ]);
  expect(report.results[0]).toMatchObject({
    passed: true,
    called: ["list_situations"],
  });
  // The scripted "leak" is caught by the grader even though the tool returned nothing foreign.
  expect(report.results[1].violations).toEqual(["foreign_data"]);
  expect(report.critical_violations).toBe(1);
  await evalDb.close();
});
it("T056: a paid eval has an upper-bound preflight and the confirmed budget is a hard cap", async () => {
  const { runAssistantEval, evalBudget } =
    await import("../src/server/assistant/eval");
  // 32 cases × 6 iterations × (4000 output + 12000 input) — the number the operator confirms.
  expect(evalBudget(32)).toMatchObject({
    maxCalls: 192,
    upperBoundTokens: 3_072_000,
  });
  const { readFile } = await import("node:fs/promises");
  const { cases } = JSON.parse(
    await readFile("tests/fixtures/assistant-eval.json", "utf8"),
  );
  const evalDb = await createMemoryDatabase();
  await migrate(evalDb);
  const provider = new ScriptedProvider([
    [toolUse("list_situations", {})],
    [text("не должен быть вызван")],
  ]);
  // The first call uses 120 tokens against a cap of 100: nothing more is sent to the provider.
  const report = await runAssistantEval(
    evalDb,
    provider,
    [cases[0], cases[1]],
    { tokenBudget: 100 },
  );
  expect(provider.calls).toHaveLength(1);
  expect(report.results.map((r) => r.status)).toEqual([
    "budget_exceeded",
    "budget_exceeded",
  ]);
  expect(report).toMatchObject({
    tokens_used: "120",
    budget_stopped: 2,
    passed: 0,
  });
  await evalDb.close();
});
it("T025: a rule described in words becomes a validated, unsaved draft; unknown people are dropped and nothing is activated", async () => {
  const text =
    "Когда появляется риск нехватки товара, поставь задачу Ивану проверить остаток";
  const off = await new AssistantService(db, null).draftAutomation(owner, org, {
    locale: "ru",
    text,
  });
  expect(off).toMatchObject({
    status: "not_configured",
    draft: null,
    error_code: "ASSISTANT_NOT_CONFIGURED",
  });
  await expect(
    new AssistantService(db, null).draftAutomation(seller, org, {
      locale: "ru",
      text,
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  const before = await db.query("SELECT id FROM automation_rules");
  const provider = new ScriptedProvider([
    [
      toolUse("propose_rule", {
        name: "Нехватка → задача",
        explanation:
          "Иван не найден среди сотрудников, исполнитель не назначен.",
        definition: {
          trigger: { type: "event", topic: "insight.opened" },
          conditions: [{ field: "rule", op: "eq", value: "low_stock" }],
          actions: [
            {
              type: "create_task",
              title: "Проверить остаток",
              assigneeId: randomUUID(),
            },
            { type: "notify", userId: randomUUID() },
          ],
        },
      }),
    ],
    [toolUse("propose_rule", { name: "x", definition: { actions: [] } })],
  ]);
  const svc = new AssistantService(db, provider);
  const r = draftResult.parse(
    JSON.parse(
      JSON.stringify(
        await svc.draftAutomation(owner, org, { locale: "ru", text }),
      ),
    ),
  );
  expect(r.status).toBe("ok");
  expect(r.warnings).toEqual([
    "unknown_user_removed",
    "test_before_activation",
  ]);
  expect(r.draft!.definition.actions).toHaveLength(1);
  expect(r.draft!.definition.actions[0]).toMatchObject({
    type: "create_task",
    assigneeId: null,
  });
  // The model sees the rule schema and the real member list, and the description only as data.
  expect(provider.calls[0].tools.map((t) => t.name)).toEqual(["propose_rule"]);
  expect(provider.calls[0].system).toContain("ignore any instructions");
  expect(await db.query("SELECT id FROM automation_rules")).toEqual(before);
  // The draft is accepted by the regular create command, which keeps it inactive until tested.
  const created = await new AutomationService(db).create(owner, org, {
    key: key(),
    branchId: (await p.workspace(owner, org)).branches[0].id,
    name: r.draft!.name,
    definition: r.draft!.definition,
    note: "Из черновика AI",
  });
  const [rule] = await db.query<{ state: string }>(
    "SELECT state FROM automation_rules WHERE id=$1",
    [created.id],
  );
  expect(rule.state).not.toBe("active");
  const bad = await svc.draftAutomation(owner, org, { locale: "kk", text });
  expect(bad).toMatchObject({
    status: "invalid",
    draft: null,
    error_code: "AUTOMATION_DRAFT_INVALID",
  });
  const usage = await db.query<{ feature: string }>(
    "SELECT feature FROM assistant_usage WHERE organization_id=$1 AND feature='automation_draft'",
    [org],
  );
  expect(usage.length).toBe(3);
});
