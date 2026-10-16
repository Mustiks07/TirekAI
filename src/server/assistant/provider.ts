import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "../../domain/errors";

// Replaceable provider contract. The assistant loop depends only on this interface; tests inject
// a scripted provider explicitly, production never falls back to one silently.
export type ProviderRequest = {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
  maxTokens: number;
  signal: AbortSignal;
};
export type ProviderResponse = {
  content: Anthropic.Beta.BetaContentBlock[];
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  model: string;
};
export interface AssistantProvider {
  readonly name: string;
  readonly model: string;
  countInputTokens(request: ProviderRequest): Promise<number>;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}
export type ProviderStatus = {
  status: "not_configured" | "configured";
  provider: string | null;
  model: string | null;
};
export const DEFAULT_MODEL = "claude-opus-5-5";
// Credentials come only from the server environment; nothing is exposed to the browser bundle.
export function providerStatus(): ProviderStatus {
  return process.env.ANTHROPIC_API_KEY
    ? {
        status: "configured",
        provider: "anthropic",
        model: process.env.ASSISTANT_MODEL || DEFAULT_MODEL,
      }
    : { status: "not_configured", provider: null, model: null };
}
export class AnthropicProvider implements AssistantProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;
  constructor(apiKey: string, model = DEFAULT_MODEL) {
    this.model = model;
    // An ambiguous failure retains its budget reservation; never repeat a potentially billed call.
    this.client = new Anthropic({ apiKey, maxRetries: 0, timeout: 45_000 });
  }
  async countInputTokens(r: ProviderRequest): Promise<number> {
    const count = await this.client.beta.messages.countTokens(
      {
        model: this.model,
        system: r.system,
        messages: r.messages,
        tools: r.tools,
      },
      { signal: r.signal },
    );
    return count.input_tokens;
  }
  async complete(r: ProviderRequest): Promise<ProviderResponse> {
    try {
      const response = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: r.maxTokens,
          system: r.system,
          messages: r.messages,
          tools: r.tools,
          output_config: { effort: "medium" },
        },
        { signal: r.signal },
      );
      return {
        content: response.content,
        stopReason: response.stop_reason,
        inputTokens:
          response.usage.input_tokens +
          (response.usage.cache_creation_input_tokens ?? 0) +
          (response.usage.cache_read_input_tokens ?? 0),
        outputTokens: response.usage.output_tokens,
        model: response.model,
      };
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError)
        throw new AppError("ASSISTANT_RATE_LIMITED", 429);
      if (error instanceof Anthropic.AuthenticationError)
        throw new AppError("ASSISTANT_NOT_CONFIGURED", 503);
      if (error instanceof Anthropic.APIConnectionTimeoutError)
        throw new AppError("ASSISTANT_TIMEOUT", 504);
      if (error instanceof Anthropic.APIUserAbortError)
        throw new AppError("ASSISTANT_TIMEOUT", 504);
      if (error instanceof Anthropic.BadRequestError)
        throw new AppError("ASSISTANT_REQUEST_REJECTED", 502);
      if (error instanceof Anthropic.APIError)
        throw new AppError("ASSISTANT_UNAVAILABLE", 503);
      throw error;
    }
  }
}
export function configuredProvider(): AssistantProvider | null {
  const key = process.env.ANTHROPIC_API_KEY;
  return key
    ? new AnthropicProvider(key, process.env.ASSISTANT_MODEL || DEFAULT_MODEL)
    : null;
}
