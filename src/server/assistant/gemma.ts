import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../domain/errors";
import type {
  AssistantProvider,
  ProviderRequest,
  ProviderResponse,
} from "./provider";

export const DEFAULT_GEMMA_MODEL = "gemma-4-26b-a4b-it";
// Google pricing, checked 2026-10-16: these Gemma 4 models have no paid tier.
// No Gemini Flash/Pro, grounding, hosted tools, files or paid fallback are enabled here.
const FREE_MODELS = new Set([DEFAULT_GEMMA_MODEL, "gemma-4-31b-it"]);
const tokens = z.number().int().nonnegative().safe();
const resultSchema = z.object({
  modelVersion: z.string().optional(),
  candidates: z
    .array(
      z.object({
        finishReason: z.string(),
        content: z
          .object({
            parts: z.array(
              z.object({
                text: z.string().optional(),
                thought: z.boolean().optional(),
                thoughtSignature: z.string().optional(),
                functionCall: z
                  .object({
                    id: z.string().optional(),
                    name: z.string(),
                    args: z.record(z.string(), z.unknown()),
                  })
                  .optional(),
              }),
            ),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(1),
  usageMetadata: z.object({
    promptTokenCount: tokens,
    candidatesTokenCount: tokens.optional(),
    thoughtsTokenCount: tokens.optional(),
    totalTokenCount: tokens,
  }),
});

export class GemmaFreeProvider implements AssistantProvider {
  readonly name = "gemini";
  // Opaque provider signatures are kept only in memory for the current tool loop.
  private signatures = new Map<string, string>();
  constructor(
    private readonly apiKey: string,
    readonly model = DEFAULT_GEMMA_MODEL,
  ) {}

  async countInputTokens(r: ProviderRequest): Promise<number> {
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
    if (!FREE_MODELS.has(this.model))
      throw new AppError("ASSISTANT_REQUEST_REJECTED", 502);
    const signal = AbortSignal.any([r.signal, AbortSignal.timeout(25_000)]);
    try {
      const names = new Map<string, string>();
      const contents = r.messages.map((message) => ({
        role: message.role === "assistant" ? "model" : "user",
        parts:
          typeof message.content === "string"
            ? [{ text: message.content }]
            : message.content.map((part) => {
                if (part.type === "text") return { text: part.text };
                if (part.type === "tool_use") {
                  names.set(part.id, part.name);
                  return {
                    functionCall: {
                      id: part.id,
                      name: part.name,
                      args: part.input,
                    },
                    ...(this.signatures.has(part.id)
                      ? { thoughtSignature: this.signatures.get(part.id) }
                      : {}),
                  };
                }
                if (part.type === "tool_result") {
                  const name = names.get(part.tool_use_id);
                  if (!name)
                    throw new AppError("ASSISTANT_REQUEST_REJECTED", 502);
                  return {
                    functionResponse: {
                      id: part.tool_use_id,
                      name,
                      response: {
                        result: part.content,
                        is_error: part.is_error ?? false,
                      },
                    },
                  };
                }
                throw new AppError("ASSISTANT_REQUEST_REJECTED", 502);
              }),
      }));
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
        {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "x-goog-api-key": this.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: r.system }] },
            contents,
            ...(r.tools.length
              ? {
                  tools: [
                    {
                      functionDeclarations: r.tools.map((t) => ({
                        name: t.name,
                        description: t.description,
                        parametersJsonSchema: t.input_schema,
                      })),
                    },
                  ],
                }
              : {}),
            generationConfig: {
              maxOutputTokens: r.maxTokens,
              candidateCount: 1,
            },
          }),
        },
      );
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
      const result = resultSchema.parse(await response.json());
      const candidate = result.candidates[0];
      const content: ProviderResponse["content"] = [];
      for (const part of candidate.content?.parts ?? []) {
        if (part.thought) continue;
        if (part.functionCall) {
          const id = part.functionCall.id || `call_${randomUUID()}`;
          if (this.signatures.size > 128) this.signatures.clear();
          if (part.thoughtSignature)
            this.signatures.set(id, part.thoughtSignature);
          content.push({
            type: "tool_use",
            id,
            name: part.functionCall.name,
            input: part.functionCall.args,
          });
        } else if (part.text)
          content.push({ type: "text", text: part.text, citations: null });
      }
      const refusal = [
        "SAFETY",
        "BLOCKLIST",
        "PROHIBITED_CONTENT",
        "RECITATION",
      ].includes(candidate.finishReason);
      if (
        !refusal &&
        candidate.finishReason !== "STOP" &&
        candidate.finishReason !== "MAX_TOKENS"
      )
        throw new AppError("ASSISTANT_REQUEST_REJECTED", 502);
      if (!refusal && !content.length)
        throw new AppError("ASSISTANT_REQUEST_REJECTED", 502);
      const usage = result.usageMetadata;
      if (usage.totalTokenCount < usage.promptTokenCount)
        throw new AppError("ASSISTANT_REQUEST_REJECTED", 502);
      return {
        content: refusal ? [] : content,
        stopReason: refusal
          ? "refusal"
          : candidate.finishReason === "MAX_TOKENS"
            ? "max_tokens"
            : content.some((b) => b.type === "tool_use")
              ? "tool_use"
              : "end_turn",
        inputTokens: usage.promptTokenCount,
        // Total includes thinking: never count only the visible candidate output.
        outputTokens: usage.totalTokenCount - usage.promptTokenCount,
        model: result.modelVersion || this.model,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (signal.aborted) throw new AppError("ASSISTANT_TIMEOUT", 504);
      if (error instanceof z.ZodError)
        throw new AppError("ASSISTANT_REQUEST_REJECTED", 502);
      throw new AppError("ASSISTANT_UNAVAILABLE", 503);
    }
  }
}
