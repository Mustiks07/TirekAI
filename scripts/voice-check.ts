import { readFile, writeFile, mkdir } from "node:fs/promises";
import { configuredSpeech } from "../src/server/assistant/speech";
import {
  scoreTranscription,
  summarizeVoice,
  type VoicePhrase,
} from "../src/server/ops/speech-check";

// T056 live voice check: `npm run voice:check -- --manifest <file>`. The manifest lists permitted
// recordings of tests/fixtures/voice-phrases.json (consent noted by the customer) and the
// devices used. Without a configured speech provider the run reports not_configured; a text
// stand-in is never scored as voice. Audio and transcripts stay out of the report.
type Manifest = {
  permission: string;
  recordings: {
    phraseId: string;
    file: string;
    mime: string;
    device: string;
  }[];
};
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
await mkdir("docs/evidence", { recursive: true });
const out = `docs/evidence/voice-check-${new Date().toISOString().slice(0, 10)}.json`;
const speech = configuredSpeech();
const write = (r: object) => writeFile(out, JSON.stringify(r, null, 2));
if (!speech) {
  await write({
    status: "not_configured",
    note: "No speech provider is configured. Choose a provider, set its credentials in the server environment and re-run with permitted recordings.",
  });
  console.log(`Voice check not run: speech not_configured. Report: ${out}`);
  process.exit(2);
}
const file = arg("--manifest");
if (!file) {
  console.error("Usage: npm run voice:check -- --manifest <recordings.json>");
  process.exit(1);
}
const manifest = JSON.parse(await readFile(file, "utf8")) as Manifest;
if (!manifest.permission?.trim()) {
  console.error(
    "The manifest must record the permission for these recordings.",
  );
  process.exit(1);
}
const { phrases } = JSON.parse(
  await readFile("tests/fixtures/voice-phrases.json", "utf8"),
) as { phrases: VoicePhrase[] };
const results = [];
let failures = 0;
const errors: Record<string, number> = {};
for (const rec of manifest.recordings) {
  const phrase = phrases.find((p) => p.id === rec.phraseId);
  if (!phrase) throw new Error(`Unknown phrase ${rec.phraseId}`);
  const started = Date.now();
  try {
    const t = await speech.transcribe({
      audio: await readFile(rec.file),
      mime: rec.mime,
      locale: phrase.locale,
      signal: AbortSignal.timeout(30_000),
    });
    results.push({
      ...scoreTranscription(phrase, t),
      device: rec.device,
      latencyMs: Date.now() - started,
    });
  } catch (e) {
    failures++;
    const code = (e as { code?: string }).code ?? "VOICE_UNAVAILABLE";
    errors[code] = (errors[code] ?? 0) + 1;
  }
}
const summary = summarizeVoice(results, failures);
await write({
  status: "completed",
  date: new Date().toISOString(),
  provider: speech.name,
  permission: manifest.permission,
  devices: [...new Set(manifest.recordings.map((r) => r.device))],
  summary,
  errors,
  results,
});
console.log(
  `RU WER ${summary.ru.wer?.toFixed(3)} · KK WER ${summary.kk.wer?.toFixed(3)} · unflagged critical misses ${summary.unflaggedCriticalMisses} · failures ${failures}. Report: ${out}`,
);
process.exit(summary.passed ? 0 : 1);
