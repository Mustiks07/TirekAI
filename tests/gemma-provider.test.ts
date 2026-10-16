import { afterEach, expect, it, vi } from "vitest";
import {
  GemmaFreeProvider,
  DEFAULT_GEMMA_MODEL,
} from "../src/server/assistant/gemma";
import {
  configuredProvider,
  type ProviderRequest,
} from "../src/server/assistant/provider";
import { evalBudget } from "../src/server/assistant/eval";

const request = (): ProviderRequest => ({
  system: "Synthetic",
  messages: [{ role: "user", content: "Balance?" }],
  tools: [
    {
      name: "finance_summary",
      input_schema: { type: "object", properties: {} },
    },
  ],
  maxTokens: 500,
  signal: new AbortController().signal,
});
const reply = (parts: unknown[], finishReason = "STOP") =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts }, finishReason }],
      usageMetadata: {
        promptTokenCount: 40,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 80,
        totalTokenCount: 130,
      },
    }),
  );
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("preserves function ids/signatures in memory, maps results, counts hidden output without exposing it", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      reply([
        { text: "private reasoning", thought: true },
        {
          functionCall: { id: "call-1", name: "finance_summary", args: {} },
          thoughtSignature: "opaque-signature",
        },
      ]),
    )
    .mockResolvedValueOnce(reply([{ text: "125,50 ₸" }]));
  vi.stubGlobal("fetch", fetcher);
  const provider = new GemmaFreeProvider("test-key");
  const r = request();
  const first = await provider.complete(r);
  expect(first.outputTokens).toBe(90);
  expect(first.content).toEqual([
    { type: "tool_use", id: "call-1", name: "finance_summary", input: {} },
  ]);
  r.messages.push(
    { role: "assistant", content: first.content },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: '{"balance_tiyn":"12550"}',
        },
      ],
    },
  );
  expect((await provider.complete(r)).stopReason).toBe("end_turn");
  const [url, init] = fetcher.mock.calls[1];
  expect(url).toBe(
    `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMMA_MODEL}:generateContent`,
  );
  expect(url).not.toContain("test-key");
  expect(init.redirect).toBe("error");
  const body = JSON.parse(init.body);
  expect(body.contents[1].parts[0].thoughtSignature).toBe("opaque-signature");
  expect(body.contents[2].parts[0].functionResponse).toMatchObject({
    id: "call-1",
    name: "finance_summary",
    response: { result: '{"balance_tiyn":"12550"}' },
  });
  expect(body.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(
    r.tools[0].input_schema,
  );
  expect(body.generationConfig).toEqual({
    maxOutputTokens: 500,
    candidateCount: 1,
  });
});
it("rejects every model outside the explicit free Gemma allowlist", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    new GemmaFreeProvider("test", "gemini-2.5-pro").complete(request()),
  ).rejects.toMatchObject({ code: "ASSISTANT_REQUEST_REJECTED" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("returns safety refusal without text or tool execution", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        reply(
          [{ functionCall: { name: "finance_summary", args: {} } }],
          "SAFETY",
        ),
      ),
  );
  expect(await new GemmaFreeProvider("test").complete(request())).toMatchObject(
    { stopReason: "refusal", content: [] },
  );
});
it("never returns malformed function calls as a successful answer", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(reply([], "MALFORMED_FUNCTION_CALL")),
  );
  await expect(
    new GemmaFreeProvider("test").complete(request()),
  ).rejects.toMatchObject({ code: "ASSISTANT_REQUEST_REJECTED" });
});
it("free routing uses available keys, never Anthropic, and requires local synthetic opt-in for Google", () => {
  vi.stubEnv("ASSISTANT_PROVIDER", "free");
  vi.stubEnv("GEMINI_API_KEY", "test-google");
  vi.stubEnv("OPENROUTER_API_KEY", "test-router");
  vi.stubEnv("ANTHROPIC_API_KEY", "test-paid");
  vi.stubEnv("ASSISTANT_SYNTHETIC_DATA", "1");
  vi.stubEnv("LOCAL_PREVIEW", "1");
  vi.stubEnv("LOCAL_DATABASE", "1");
  vi.stubEnv("DATABASE_URL", "");
  const provider = configuredProvider()!;
  expect(provider.name).toBe("gemini");
  expect(provider.fallbacks?.map((p) => p.name)).toEqual(["openrouter"]);
  expect(evalBudget(32, undefined, 2).upperBoundTokens).toBe(6144000);
  vi.stubEnv("DATABASE_URL", "shared");
  expect(configuredProvider()!.name).toBe("openrouter");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  expect(configuredProvider()).toBeNull();
});
