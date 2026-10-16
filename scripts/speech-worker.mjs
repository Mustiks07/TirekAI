// T056 local speech recognition process: OpenAI Whisper weights (MIT) in ONNX, run on this
// machine's CPU by @huggingface/transformers + onnxruntime-node. One JSON request per stdin line,
// one JSON answer per stdout line. Audio stays in memory; nothing is written or sent anywhere.
// Model files come from SPEECH_MODEL_DIR (downloaded once by `npm run speech:model`).
import { createInterface } from "node:readline";
import { decodeWav, RATE } from "./speech-audio.mjs";
import {
  AutoProcessor,
  AutoTokenizer,
  WhisperForConditionalGeneration,
  LogitsProcessor,
  env,
} from "@huggingface/transformers";

const model =
  process.env.SPEECH_MODEL || "onnx-community/whisper-large-v3-turbo";
const dtype = process.env.SPEECH_DTYPE || "q8";
env.cacheDir = process.env.SPEECH_MODEL_DIR || ".data/models";
env.allowRemoteModels = process.env.SPEECH_ALLOW_DOWNLOAD === "1";
const WINDOW = 30 * RATE;
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");

// Records the probability the greedy decoder gave to each chosen token.
class TokenProbabilities extends LogitsProcessor {
  probs = [];
  _call(_ids, logits) {
    const row = logits.data;
    let max = -Infinity;
    for (let i = 0; i < row.length; i++) if (row[i] > max) max = row[i];
    let sum = 0;
    for (let i = 0; i < row.length; i++) sum += Math.exp(row[i] - max);
    this.probs.push(1 / sum);
    return logits;
  }
}
let loaded;
async function load() {
  loaded ??= (async () => {
    const [processor, tokenizer, whisper] = await Promise.all([
      AutoProcessor.from_pretrained(model),
      AutoTokenizer.from_pretrained(model),
      WhisperForConditionalGeneration.from_pretrained(model, { dtype }),
    ]);
    return { processor, tokenizer, whisper };
  })();
  return loaded;
}
async function transcribe(samples, locale) {
  const { processor, tokenizer, whisper } = await load();
  const words = [];
  for (let start = 0; start < samples.length; start += WINDOW) {
    // A copy, not a view: the feature extractor reads the whole underlying buffer of a view.
    const inputs = await processor(samples.slice(start, start + WINDOW));
    const probe = new TokenProbabilities();
    const seq = await whisper.generate({
      ...inputs,
      language: locale === "kk" ? "kk" : "ru",
      task: "transcribe",
      max_new_tokens: 440,
      logits_processor: [probe],
    });
    const ids = seq.tolist()[0],
      generated = ids.slice(ids.length - probe.probs.length);
    // Group generated tokens into words (a token starting with a space opens a word); a word's
    // confidence is its least confident token. Special tokens are dropped.
    let group = [];
    const flush = () => {
      if (!group.length) return;
      const w = tokenizer
        .decode(
          group.map((g) => g.id),
          { skip_special_tokens: true },
        )
        .trim();
      if (w) words.push({ w, p: Math.min(...group.map((g) => g.p)) });
      group = [];
    };
    generated.forEach((id, i) => {
      const piece = tokenizer.decode([id], { skip_special_tokens: true });
      if (!piece) return;
      if (/^\s/.test(piece)) flush();
      group.push({ id, p: probe.probs[i] });
    });
    flush();
  }
  return words;
}
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
send({ ready: false, model, dtype });
load()
  .then(() => send({ ready: true }))
  .catch(() => send({ ready: false, error: "VOICE_MODEL_MISSING" }));
for await (const line of rl) {
  let request;
  try {
    request = JSON.parse(line);
    const started = Date.now();
    const samples = decodeWav(Buffer.from(request.wav, "base64"));
    if (samples.length < RATE / 4) throw new Error("VOICE_EMPTY");
    const words = await transcribe(samples, request.locale);
    send({
      id: request.id,
      words,
      seconds: samples.length / RATE,
      ms: Date.now() - started,
    });
  } catch (e) {
    const code = /^VOICE_[A-Z_]+$/.test(e?.message)
      ? e.message
      : loaded
        ? "VOICE_UNAVAILABLE"
        : "VOICE_MODEL_MISSING";
    send({ id: request?.id ?? null, error: code });
  }
}
