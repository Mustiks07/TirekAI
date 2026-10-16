import type { Transcription } from "../assistant/speech";

// T056 live voice acceptance on permitted recordings of the phrase set
// (tests/fixtures/voice-phrases.json). Word error rate is reported as measured; the ТЗ sets no
// WER target, so the customer fixes one before the run. Keys carry the business meaning (amounts,
// quantities, people, a negated action): a missed critical key is acceptable only when the
// provider flagged uncertainty, because the transcript is placed into an editable field and the
// user confirms it before anything is sent (REQ AI 07). The report never contains audio or text.
export type VoicePhrase = {
  id: string;
  locale: "ru" | "kk";
  text: string;
  keys: { any: string[]; critical?: boolean }[];
};
export const normalizeSpeech = (text: string) =>
  text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\uE000\uE001]/g, " ")
    .replace(/(\d)[\s\u00a0](?=\d{3}\b)/g, "$1")
    .replace(/(?<=\d)[.,](?=\d)/g, "\uE000")
    .replace(/[-−](?=\d)/g, "\uE001")
    .replace(/[^\p{L}\p{N}\uE000\uE001]+/gu, " ")
    .replace(/\uE000/g, ".")
    .replace(/\uE001/g, "-")
    .trim();
const words = (text: string) =>
  normalizeSpeech(text).split(" ").filter(Boolean);
export function wordErrorRate(reference: string, hypothesis: string) {
  const r = words(reference),
    h = words(hypothesis);
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const row = [i];
    for (let j = 1; j <= h.length; j++)
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1),
      );
    prev = row;
  }
  return { errors: prev[h.length], words: r.length };
}
export function scoreTranscription(phrase: VoicePhrase, t: Transcription) {
  const heard = ` ${normalizeSpeech(t.text)} `;
  const keys = phrase.keys.map((k) => ({
    critical: !!k.critical,
    found: k.any.some((v) => {
      const normalized = normalizeSpeech(v);
      return normalized.length > 0 && heard.includes(` ${normalized} `);
    }),
  }));
  const flagged =
    t.uncertain.length > 0 || (t.confidence !== null && t.confidence < 0.8);
  const criticalMissed = keys.filter((k) => k.critical && !k.found).length;
  return {
    id: phrase.id,
    locale: phrase.locale,
    localeReturned: t.locale,
    ...wordErrorRate(phrase.text, t.text),
    keysFound: keys.filter((k) => k.found).length,
    keysTotal: keys.length,
    criticalMissed,
    flagged,
    // A wrong amount, person or negation that the user is not asked to check is the failure.
    unflaggedCriticalMiss: criticalMissed > 0 && !flagged,
    confidence: t.confidence,
  };
}
type Scored = ReturnType<typeof scoreTranscription> & { latencyMs: number };
const p95 = (xs: number[]) =>
  xs.length
    ? [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]
    : null;
export function summarizeVoice(results: Scored[], failures: number) {
  const byLocale = (locale: "ru" | "kk") => {
    const xs = results.filter((r) => r.locale === locale);
    const errors = xs.reduce((n, r) => n + r.errors, 0),
      total = xs.reduce((n, r) => n + r.words, 0);
    return {
      recordings: xs.length,
      wer: total ? errors / total : null,
      keyRecall: xs.length
        ? xs.reduce((n, r) => n + r.keysFound, 0) /
          xs.reduce((n, r) => n + r.keysTotal, 0)
        : null,
      criticalMissed: xs.reduce((n, r) => n + r.criticalMissed, 0),
      unflaggedCriticalMisses: xs.filter((r) => r.unflaggedCriticalMiss).length,
      wrongLocale: xs.filter((r) => r.localeReturned !== locale).length,
      latencyP95Ms: p95(xs.map((r) => r.latencyMs)),
    };
  };
  return {
    passed:
      failures === 0 &&
      results.length > 0 &&
      results.some((r) => r.locale === "ru") &&
      results.some((r) => r.locale === "kk") &&
      results.every(
        (r) => !r.unflaggedCriticalMiss && r.localeReturned === r.locale,
      ),
    ru: byLocale("ru"),
    kk: byLocale("kk"),
    providerFailures: failures,
    unflaggedCriticalMisses: results.filter((r) => r.unflaggedCriticalMiss)
      .length,
  };
}
