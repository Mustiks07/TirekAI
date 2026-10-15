import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  normalizeSpeech,
  scoreTranscription,
  summarizeVoice,
  wordErrorRate,
  type VoicePhrase,
} from "../src/server/ops/speech-check";

const { phrases } = JSON.parse(
  await readFile("tests/fixtures/voice-phrases.json", "utf8"),
) as { phrases: VoicePhrase[] };
const phrase = (id: string) => phrases.find((p) => p.id === id)!;
const heard = (
  text: string,
  locale: "ru" | "kk",
  extra: { confidence?: number | null; uncertain?: string[] } = {},
) => ({
  text,
  locale,
  confidence: extra.confidence ?? null,
  uncertain: extra.uncertain ?? [],
});

it("T056: the voice phrase set is balanced RU/KK and every phrase carries its meaning as keys", () => {
  expect(phrases.filter((p) => p.locale === "ru")).toHaveLength(12);
  expect(phrases.filter((p) => p.locale === "kk")).toHaveLength(12);
  for (const p of phrases) {
    const text = ` ${normalizeSpeech(p.text)} `;
    // The reference text itself must satisfy every key: the set has no unreachable expectation.
    for (const k of p.keys)
      expect(
        k.any.some((v) => text.includes(normalizeSpeech(v))),
        `${p.id} ${k.any}`,
      ).toBe(true);
  }
});
it("T056: WER counts substitutions, deletions and insertions on normalized Kazakh and Russian words", () => {
  expect(normalizeSpeech("Ёлка, ҚАРА шай — 5 000 ₸!")).toBe(
    "елка қара шай 5000",
  );
  expect(wordErrorRate("бүгін қанша тапсырыс", "бүгін қанша тапсырыс")).toEqual(
    { errors: 0, words: 3 },
  );
  // substitution + deletion
  expect(
    wordErrorRate("спиши двадцать пять штук хлеба", "спиши двадцать штук хлеб"),
  ).toEqual({ errors: 2, words: 5 });
  // insertion
  expect(wordErrorRate("покажи платежи", "покажи все платежи")).toEqual({
    errors: 1,
    words: 2,
  });
});
it("T056: a misheard amount or negation fails unless the provider asked for confirmation", () => {
  // Digits are an acceptable spelling of a spoken number.
  const ok = scoreTranscription(
    phrase("kk-12"),
    heard("25 дана нанды есептен шығар", "kk"),
  );
  expect(ok).toMatchObject({ criticalMissed: 0, unflaggedCriticalMiss: false });
  // "Проводи оплату" without "не" is the dangerous error: the key is critical.
  const silent = scoreTranscription(
    phrase("ru-11"),
    heard("Проводи оплату, только подготовь черновик", "ru", {
      confidence: 0.95,
    }),
  );
  expect(silent).toMatchObject({
    criticalMissed: 1,
    unflaggedCriticalMiss: true,
  });
  const flagged = scoreTranscription(
    phrase("ru-11"),
    heard("Проводи оплату, только подготовь черновик", "ru", {
      uncertain: ["проводи"],
    }),
  );
  expect(flagged).toMatchObject({
    criticalMissed: 1,
    unflaggedCriticalMiss: false,
  });
  const summary = summarizeVoice(
    [
      { ...ok, latencyMs: 800 },
      { ...silent, latencyMs: 1200 },
      { ...flagged, latencyMs: 900 },
    ],
    1,
  );
  expect(summary).toMatchObject({
    providerFailures: 1,
    unflaggedCriticalMisses: 1,
    // "Жиырма бес" → "25": WER counts the spelling (2 of 6 words); the key accepts digits.
    kk: { recordings: 1, wer: 2 / 6, criticalMissed: 0 },
    ru: { recordings: 2, criticalMissed: 2, latencyP95Ms: 1200 },
  });
});
