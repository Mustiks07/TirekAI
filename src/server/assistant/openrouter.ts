import { z } from "zod";
import { AppError } from "../../domain/errors";
import type {
  AssistantProvider,
  ProviderRequest,
  ProviderResponse,
} from "./provider";

export const DEFAULT_FREE_MODEL = "nvidia/nemotron-3.5-super-vl:free";
const zeroPrice = z.string().regex(/^0(?:\.0+)?$/);
const catalogSchema = z.object({
  data: z.array(z.object({ id: z.string() }).passthrough()),
});
const modelSchema = z.object({
  pricing: z.record(z.string(), z.unknown()),
  supported_parameters: z.array(z.string()),
});
const tokens = z.number().int().nonnegative().safe();
const responseSchema = z.object({
  model: z.string(),
  stop_reason: z.enum(["end_turn", "tool_use", "max_tokens", "stop_sequence"]),
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("tool_use"),
        id: z.string().min(1),
        name: z.string().min(1),
        input: z.record(z.string(), z.unknown()),
      }),
      // Never persist or expose reasoning; only text and tool calls enter the application loop.
      z.object({ type: z.literal("thinking") }),
      z.object({ type: z.literal("redacted_thinking") }),
    ]),
  ),
  usage: z.object({
    input_tokens: tokens,
    output_tokens: tokens,
    cache_creation_input_tokens: tokens.nullish(),
    cache_read_input_tokens: tokens.nullish(),
    cost: z.literal(0),
  }),
});

// Fixed official endpoint, no paid fallback, no SDK retries, no configurable proxy URL.
export class OpenRouterFreeProvider implements AssistantProvider {
  readonly name = "openrouter";
  constructor(
    private readonly apiKey: string,
    readonly model = DEFAULT_FREE_MODEL,
    private readonly syntheticData = false,
  ) {}

  async countInputTokens(r: ProviderRequest): Promise<number> {
    // No token-count endpoint: conservative UTF-8 byte estimate plus template allowance.
    // This is admission accounting, not an exact tokenizer; actual usage is reconciled by budget.ts.
    return (
      Buffer.byteLength(
        JSON.stringify({
          system: r.system,
          messages: r.messages,
          tools: r.tools,
        }),
        "utf8",
      ) + 1024
    );
  }

  async complete(r: ProviderRequest): Promise<ProviderResponse> {
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+:free$/i.test(this.model))
      throw new AppError("ASSISTANT_REQUEST_REJECTED", 502);
    const signal = AbortSignal.any([r.signal, AbortSignal.timeout(25_000)]);
    try {
      // Recheck before each generation. A removed model or changed price fails closed.
      const catalog = catalogSchema.parse(await this.request("models", signal));
      const model = modelSchema.parse(
        catalog.data.find((m) => m.id === this.model),
      );
      if (
        !model ||
        !model.supported_parameters?.includes("tools") ||
        !zeroPrice.safeParse(model.pricing.prompt).success ||
        !zeroPrice.safeParse(model.pricing.completion).success ||
        Object.values(model.pricing).some(
          (price) => !zeroPrice.safeParse(price).success,
        )
      )
        throw new AppError("ASSISTANT_REQUEST_REJECTED", 502);
      const response = responseSchema.parse(
        await this.request("messages", signal, {
          model: this.model,
          max_tokens: r.maxTokens,
          system: r.system,
          messages: r.messages,
          tools: r.tools,
          provider: {
            max_price: { prompt: 0, completion: 0, request: 0 },
            allow_fallbacks: false,
            require_parameters: true,
            data_collection: this.syntheticData ? "allow" : "deny",
          },
        }),
      );
      const content = response.content.flatMap<
        ProviderResponse["content"][number]
      >((block) => {
        if (block.type === "text") return [{ ...block, citations: null }];
        if (block.type === "tool_use") return [block];
        return [];
      });
      if (
        !content.length ||
        (response.stop_reason === "tool_use" &&
          !content.some((b) => b.type === "tool_use"))
      )
        throw new AppError("ASSISTANT_REQUEST_REJECTED", 502);
      return {
        content,
        stopReason: response.stop_reason,
        inputTokens:
          response.usage.input_tokens +
          (response.usage.cache_creation_input_tokens ?? 0) +
          (response.usage.cache_read_input_tokens ?? 0),
        outputTokens: response.usage.output_tokens,
        model: response.model,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (signal.aborted) throw new AppError("ASSISTANT_TIMEOUT", 504);
      if (error instanceof z.ZodError)
        throw new AppError("ASSISTANT_REQUEST_REJECTED", 502);
      // Do not propagate remote bodies, credentials, user content or transport diagnostics.
      throw new AppError("ASSISTANT_UNAVAILABLE", 503);
    }
  }

  private async request(
    path: "models" | "messages",
    signal: AbortSignal,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetch(`https://openrouter.ai/api/v1/${path}`, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(body ? { "anthropic-version": "2023-06-01" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429)
        throw new AppError("ASSISTANT_RATE_LIMITED", 429);
      if (response.status === 401 || response.status === 403)
        throw new AppError("ASSISTANT_NOT_CONFIGURED", 503);
      if (response.status === 400)
        throw new AppError("ASSISTANT_REQUEST_REJECTED", 502);
      throw new AppError("ASSISTANT_UNAVAILABLE", 503);
    }
    return response.json();
  }
}
