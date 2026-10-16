import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { Database } from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { InventoryService } from "../src/server/inventory/service";
import { AssistantService } from "../src/server/assistant/service";
import { MAX_COUNTED_INPUT } from "../src/server/assistant/budget";
import { GemmaFreeProvider } from "../src/server/assistant/gemma";
import { OpenRouterFreeProvider } from "../src/server/assistant/openrouter";
import type {
  AssistantProvider,
  ProviderRequest,
} from "../src/server/assistant/provider";

// T056 regression: on a populated business account (the same fixture as `npm run
// db:seed:business`: 3 branches, 36 products, 72 orders, 24 tasks, situations) every request the
// assistant sends — including the follow-up after each tool call — stays within the admission
// limit, counted exactly as the free providers count it. No network: the model is scripted.
const dir = resolve(`.data/assistant-context-${randomUUID().slice(0, 8)}`),
  state = `${dir}-state.json`;
let db: Database, token: string, org: string, warehouse: string;
let items: { id: string }[];
const counters = [
  new GemmaFreeProvider("test-key-not-used"),
  new OpenRouterFreeProvider("test-key-not-used", "test/model:free"),
];
beforeAll(async () => {
  await promisify(execFile)(
    process.execPath,
    [resolve("node_modules/tsx/dist/cli.mjs"), "scripts/seed-business.ts"],
    {
      env: {
        ...process.env,
        PGLITE_DATA_DIR: dir,
        BUSINESS_FIXTURE_STATE: state,
        DATABASE_URL: "",
      },
      timeout: 240_000,
    },
  );
  process.env.PGLITE_DATA_DIR = dir;
  process.env.LOCAL_DATABASE = "1";
  process.env.LOCAL_PREVIEW = "1";
  delete process.env.DATABASE_URL;
  const { getDatabase } = await import("../src/server/db/database");
  db = await getDatabase();
  const f = JSON.parse(readFileSync(state, "utf8"));
  const p = new Platform(db);
  token = (await p.login({ email: f.email, password: f.password })).token;
  org = (await p.session(token)).organizations.find((o) =>
    o.name.startsWith("Tirek Market"),
  )!.id;
  const inv = new InventoryService(db);
  warehouse = (await inv.warehouses(token, org, {})).items[0].id;
  items = (await inv.catalog(token, org, {})).items as { id: string }[];
}, 300_000);
afterAll(async () => {
  await db?.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(state, { force: true });
  rmSync(state.replace(/\.json$/, "-report.json"), { force: true });
});
// Scripted model: calls the given tools one per turn, then answers. Records every request size.
function scripted(calls: [string, unknown][]) {
  const sizes: number[] = [];
  const seen: ProviderRequest[] = [];
  let step = 0;
  const provider: AssistantProvider = {
    name: "scripted",
    model: "scripted",
    async countInputTokens(r) {
      const counts = await Promise.all(
        counters.map((c) => c.countInputTokens(r)),
      );
      return Math.max(...counts);
    },
    async complete(r) {
      sizes.push(await this.countInputTokens(r));
      seen.push(structuredClone({ ...r, signal: undefined }) as never);
      const next = calls[step++];
      return next
        ? {
            content: [
              {
                type: "tool_use",
                id: `call_${step}`,
                name: next[0],
                input: next[1],
              },
            ],
            stopReason: "tool_use",
            inputTokens: 100,
            outputTokens: 10,
            model: "scripted",
          }
        : {
            content: [{ type: "text", text: "Готово.", citations: null }],
            stopReason: "end_turn",
            inputTokens: 100,
            outputTokens: 10,
            model: "scripted",
          };
    },
  } as AssistantProvider;
  return { provider, sizes, seen };
}
const tools = (): [string, unknown][] => [
  ["list_situations", {}],
  ["finance_summary", {}],
  ["list_warehouses", {}],
  ["stock_balances", { warehouseId: warehouse }],
  ["my_tasks", {}],
  ["search_knowledge", { query: "возврат" }],
  [
    "purchase_need",
    {
      warehouseId: warehouse,
      itemId: items[0].id,
      minimum: "20",
      safety: "5",
      leadDays: 3,
    },
  ],
  [
    "purchase_budget",
    {
      budget: "500000",
      date: "2026-10-20",
      lines: items
        .slice(0, 10)
        .map((x, i) => ({ itemId: x.id, quantity: "10", priority: i + 1 })),
    },
  ],
];
describe("assistant context on a populated account", () => {
  it.each([
    "list_situations",
    "finance_summary",
    "list_warehouses",
    "stock_balances",
    "my_tasks",
    "search_knowledge",
    "purchase_need",
    "purchase_budget",
  ])("%s: the follow-up after the tool call fits", async (name) => {
    const call = tools().find((t) => t[0] === name)!;
    const m = scripted([call]);
    const r = await new AssistantService(db, m.provider, null).ask(token, org, {
      key: randomUUID(),
      locale: "ru",
      text: "Что заканчивается на складе и что закупить?",
    });
    expect(r.message).toMatchObject({ status: "ok", error_code: null });
    expect(m.sizes).toHaveLength(2);
    for (const size of m.sizes)
      expect(size).toBeLessThanOrEqual(MAX_COUNTED_INPUT);
    // One tool result alone stays well below the limit (room for several in a chain).
    expect(m.sizes[1] - m.sizes[0]).toBeLessThan(4000);
  });
  it("a chain of five tools fits and keeps the latest result", async () => {
    const m = scripted(tools().slice(0, 5));
    const r = await new AssistantService(db, m.provider, null).ask(token, org, {
      key: randomUUID(),
      locale: "kk",
      text: "Бүгін не маңызды?",
    });
    expect(r.message).toMatchObject({ status: "ok", error_code: null });
    expect(m.sizes).toHaveLength(6);
    for (const size of m.sizes)
      expect(size).toBeLessThanOrEqual(MAX_COUNTED_INPUT);
    const last = m.seen.at(-1)!.messages.at(-1)!;
    expect(JSON.stringify(last.content)).not.toContain('"omitted"');
    expect(JSON.stringify(last.content)).toContain("items");
  });
  it("a follow-up question with history fits", async () => {
    const first = scripted([["list_situations", {}]]);
    const svc = new AssistantService(db, first.provider, null);
    const a = await svc.ask(token, org, {
      key: randomUUID(),
      locale: "ru",
      text: "Какие ситуации открыты?",
    });
    const second = scripted([["my_tasks", {}]]);
    const b = await new AssistantService(db, second.provider, null).ask(
      token,
      org,
      {
        key: randomUUID(),
        conversationId: a.conversationId,
        locale: "ru",
        text: "А какие задачи у меня?",
        voice: { uncertain: ["задачи"] },
      },
    );
    expect(b.message).toMatchObject({ status: "ok", error_code: null });
    for (const size of second.sizes)
      expect(size).toBeLessThanOrEqual(MAX_COUNTED_INPUT);
    // The model is told the question came from speech; the stored question stays as spoken.
    const question = second.seen[0].messages.at(-1)!;
    expect(String(question.content)).toContain("[Voice input");
    const conv = await svc.conversation(token, org, a.conversationId);
    expect(
      (conv.messages as { role: string; content: string }[]).filter(
        (x) => x.role === "user",
      )[1].content,
    ).toBe("А какие задачи у меня?");
  });
});
