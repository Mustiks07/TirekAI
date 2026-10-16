import { afterEach, expect, it, vi } from "vitest";
import {
  OpenRouterFreeProvider,
  DEFAULT_FREE_MODEL,
} from "../src/server/assistant/openrouter";
import {
  configuredProvider,
  providerStatus,
  type ProviderRequest,
} from "../src/server/assistant/provider";

const request = (): ProviderRequest => ({
  system: "Synthetic test",
  messages: [{ role: "user", content: "Қанша?" }],
  tools: [
    {
      name: "finance_summary",
      description: "Balance",
      input_schema: { type: "object", properties: {} },
    },
  ],
  maxTokens: 300,
  signal: new AbortController().signal,
});
const catalog = (price = "0") => ({
  data: [
    {
      id: DEFAULT_FREE_MODEL,
      supported_parameters: ["tools"],
      pricing: { prompt: price, completion: "0", request: "0" },
    },
  ],
});
const response = () => ({
  model: DEFAULT_FREE_MODEL,
  stop_reason: "tool_use",
  content: [
    { type: "thinking", thinking: "internal reasoning" },
    { type: "tool_use", id: "call-test", name: "finance_summary", input: {} },
  ],
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: 5,
    cost: 0,
  },
});
const reply = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("uses the official endpoint, zero price, no retries/fallbacks, and strips reasoning", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(catalog()))
    .mockResolvedValueOnce(reply(response()));
  vi.stubGlobal("fetch", fetcher);
  const result = await new OpenRouterFreeProvider("test-token").complete(
    request(),
  );
  expect(result.content).toEqual([
    { type: "tool_use", id: "call-test", name: "finance_summary", input: {} },
  ]);
  expect(result.inputTokens).toBe(105);
  expect(result.outputTokens).toBe(20);
  const [url, init] = fetcher.mock.calls[1];
  expect(url).toBe("https://openrouter.ai/api/v1/messages");
  expect(init.redirect).toBe("error");
  // This header makes /models return Anthropic's incompatible paginated model list.
  expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty(
    "anthropic-version",
  );
  expect(JSON.parse(init.body).provider).toEqual({
    max_price: { prompt: 0, completion: 0, request: 0 },
    allow_fallbacks: false,
    require_parameters: true,
    data_collection: "deny",
  });
});
it("ignores unrelated paid model metadata while validating the selected model strictly", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      reply({
        data: [
          {
            id: "unrelated/model",
            pricing: { overrides: [] },
            supported_parameters: null,
          },
          catalog().data[0],
        ],
      }),
    )
    .mockResolvedValueOnce(reply(response()));
  vi.stubGlobal("fetch", fetcher);
  expect(
    (await new OpenRouterFreeProvider("test").complete(request())).stopReason,
  ).toBe("tool_use");
});
it("rejects a paid model before network access", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    new OpenRouterFreeProvider("test", "vendor/paid").complete(request()),
  ).rejects.toMatchObject({ code: "ASSISTANT_REQUEST_REJECTED" });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  catalog("0.001"),
  { data: [] },
  {
    data: [
      {
        ...catalog().data[0],
        pricing: { prompt: "0", completion: "0", image: "0.01" },
      },
    ],
  },
])(
  "fails closed when the catalog no longer guarantees free generation",
  async (data) => {
    const fetcher = vi.fn().mockResolvedValue(reply(data));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      new OpenRouterFreeProvider("test").complete(request()),
    ).rejects.toMatchObject({ code: "ASSISTANT_REQUEST_REJECTED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it("rechecks catalog for every round and forwards tool results", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(catalog()))
    .mockResolvedValueOnce(reply(response()))
    .mockResolvedValueOnce(reply(catalog()))
    .mockResolvedValueOnce(
      reply({
        ...response(),
        stop_reason: "end_turn",
        content: [{ type: "text", text: "125,50 ₸" }],
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  const provider = new OpenRouterFreeProvider("test");
  const r = request();
  const first = await provider.complete(r);
  r.messages.push(
    { role: "assistant", content: first.content },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-test",
          content: '{"balance_tiyn":"12550"}',
        },
      ],
    },
  );
  expect((await provider.complete(r)).content).toEqual([
    { type: "text", text: "125,50 ₸", citations: null },
  ]);
  expect(JSON.parse(fetcher.mock.calls[3][1].body).messages).toEqual(
    r.messages,
  );
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it("sanitizes remote errors and does not retry rate limits", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply(catalog()))
    .mockResolvedValueOnce(
      new Response("sensitive remote body", { status: 429 }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    new OpenRouterFreeProvider("test").complete(request()),
  ).rejects.toMatchObject({
    code: "ASSISTANT_RATE_LIMITED",
    message: "ASSISTANT_RATE_LIMITED",
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("rejects unknown cost, nonzero cost and malformed usage instead of inventing zero", async () => {
  for (const usage of [
    { input_tokens: 1, output_tokens: 2 },
    { input_tokens: 1, output_tokens: 2, cost: 0.1 },
    { input_tokens: -1, output_tokens: 2, cost: 0 },
  ]) {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(reply(catalog()))
        .mockResolvedValueOnce(reply({ ...response(), usage })),
    );
    await expect(
      new OpenRouterFreeProvider("test").complete(request()),
    ).rejects.toMatchObject({ code: "ASSISTANT_REQUEST_REJECTED" });
  }
});
it("estimates the entire UTF-8 input including tool results without using a network token counter", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const provider = new OpenRouterFreeProvider("test");
  const r = request();
  const original = await provider.countInputTokens(r);
  r.messages.push({ role: "user", content: "Ө".repeat(4000) });
  expect(await provider.countInputTokens(r)).toBeGreaterThanOrEqual(
    original + 8000,
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it("disabled or unknown selection cannot activate an available key", () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test");
  vi.stubEnv("ANTHROPIC_API_KEY", "test");
  for (const value of ["disabled", "typo"]) {
    vi.stubEnv("ASSISTANT_PROVIDER", value);
    expect(configuredProvider()).toBeNull();
    expect(providerStatus().status).toBe("not_configured");
  }
});
it("allows collection only for an explicitly opted-in isolated local demo", async () => {
  vi.stubEnv("ASSISTANT_PROVIDER", "openrouter");
  vi.stubEnv("OPENROUTER_API_KEY", "test");
  vi.stubEnv("ASSISTANT_MODEL", "");
  vi.stubEnv("ASSISTANT_SYNTHETIC_DATA", "1");
  vi.stubEnv("LOCAL_PREVIEW", "1");
  vi.stubEnv("LOCAL_DATABASE", "1");
  expect(providerStatus()).toEqual({
    status: "configured",
    provider: "openrouter",
    model: DEFAULT_FREE_MODEL,
  });
  for (const [database, policy] of [
    ["", "allow"],
    ["shared-database", "deny"],
  ]) {
    vi.stubEnv("DATABASE_URL", database);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(reply(catalog()))
      .mockResolvedValueOnce(reply(response()));
    vi.stubGlobal("fetch", fetcher);
    await configuredProvider()!.complete(request());
    expect(
      JSON.parse(fetcher.mock.calls[1][1].body).provider.data_collection,
    ).toBe(policy);
  }
});
