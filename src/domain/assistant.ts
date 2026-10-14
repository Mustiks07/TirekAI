import { z } from "zod";
import Decimal from "decimal.js";

const D = Decimal.clone({ precision: 60 });
export const askInput = z
  .object({
    key: z.uuid(),
    conversationId: z.uuid().nullable().default(null),
    locale: z.enum(["ru", "kk"]),
    text: z.string().trim().min(1).max(2000),
  })
  .strict();
export const settingsInput = z
  .object({
    version: z.number().int().min(0),
    enabled: z.boolean(),
    voiceEnabled: z.boolean(),
    monthlyTokenBudget: z.number().int().min(0).max(1_000_000_000),
    maxOutputTokens: z.number().int().min(256).max(16000),
  })
  .strict();
export const transcriptionInput = z
  .object({
    key: z.uuid(),
    locale: z.enum(["ru", "kk"]),
    mime: z.enum(["audio/webm", "audio/ogg", "audio/wav", "audio/mp4"]),
    audio: z.string().min(1).max(2_800_000),
  })
  .strict();
const source = z.object({
  type: z.string(),
  id: z.uuid().nullable(),
  label: z.string(),
});
export const assistantMessage = z.object({
  id: z.uuid(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  status: z.enum([
    "ok",
    "refused",
    "error",
    "not_configured",
    "budget_exceeded",
    "incomplete",
  ]),
  sources: z.array(source),
  tool_calls: z.array(
    z.object({
      name: z.string(),
      effect: z.string(),
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
  ),
  unverified_numbers: z.array(z.string()),
  error_code: z.string().nullable(),
  created_at: z.string(),
});
export const askResult = z.object({
  conversationId: z.uuid(),
  message: assistantMessage,
  reused: z.boolean(),
});
export const conversationView = z.object({
  id: z.uuid(),
  locale: z.enum(["ru", "kk"]),
  title: z.string(),
  messages: z.array(assistantMessage),
});
export const conversationList = z.object({
  items: z.array(
    z.object({ id: z.uuid(), title: z.string(), updated_at: z.string() }),
  ),
});
export const assistantStatus = z.object({
  provider: z.object({
    status: z.enum(["not_configured", "configured"]),
    provider: z.string().nullable(),
    model: z.string().nullable(),
  }),
  speech: z.object({
    status: z.enum(["not_configured", "configured"]),
    provider: z.string().nullable(),
  }),
  settings: z.object({
    version: z.number(),
    enabled: z.boolean(),
    voice_enabled: z.boolean(),
    monthly_token_budget: z.number(),
    max_output_tokens: z.number(),
  }),
  usage: z.object({
    month_tokens: z.number(),
    month_calls: z.number(),
    last_error: z.string().nullable(),
  }),
  canConfigure: z.boolean(),
  tools: z.array(z.object({ name: z.string(), effect: z.string() })),
});
export type AssistantMessage = z.infer<typeof assistantMessage>;
export type AssistantStatus = z.infer<typeof assistantStatus>;
const norm = (v: string) => {
  try {
    return new D(v).toFixed();
  } catch {
    return null;
  }
};
// Numbers written in an answer, normalized ("1 234,50" → "1234.5"). Dates and times are skipped.
export function answerNumbers(text: string) {
  const cleaned = text
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      " ",
    );
  const found =
    cleaned.match(
      /\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g,
    ) || [];
  return [
    ...new Set(
      found
        .map((n) => norm(n.replace(/[ \u00a0\u202f]/g, "").replace(",", ".")))
        .filter((n): n is string => n !== null),
    ),
  ];
}
// Every number that the calculation layer actually returned, including KZT forms of *_minor values.
export function sourceNumbers(
  value: unknown,
  into = new Set<string>(),
  key = "",
) {
  if (typeof value === "number" && Number.isFinite(value))
    into.add(norm(String(value)) || "");
  else if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
    into.add(norm(value) || "");
    if (key.endsWith("_minor")) into.add(new D(value).div(100).toFixed());
  } else if (Array.isArray(value))
    value.forEach((v) => sourceNumbers(v, into, key));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) sourceNumbers(v, into, k);
  return into;
}
// Heuristic check: numbers in the answer that are neither in tool results nor in the question.
// Small integers (≤ 10) are ignored to avoid flagging counts and list markers.
export function unverifiedNumbers(
  answer: string,
  question: string,
  tools: unknown[],
) {
  const known = sourceNumbers(tools);
  for (const n of answerNumbers(question)) known.add(n);
  return answerNumbers(answer).filter(
    (n) => !known.has(n) && !(new D(n).isInteger() && new D(n).abs().lte(10)),
  );
}
