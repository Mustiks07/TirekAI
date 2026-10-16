// T056: one-time download of the local speech model into SPEECH_MODEL_DIR (default .data/models).
// Default: OpenAI Whisper large-v3-turbo (weights MIT) converted to ONNX, 8-bit (≈1.3 GB on disk).
// Behind a proxy run with NODE_USE_ENV_PROXY=1. After this, recognition works without network.
import {
  AutoProcessor,
  AutoTokenizer,
  WhisperForConditionalGeneration,
  env,
} from "@huggingface/transformers";

const model =
  process.env.SPEECH_MODEL || "onnx-community/whisper-large-v3-turbo";
const dtype = process.env.SPEECH_DTYPE || "q8";
env.cacheDir = process.env.SPEECH_MODEL_DIR || ".data/models";
env.allowRemoteModels = true;
const started = Date.now();
await AutoProcessor.from_pretrained(model);
await AutoTokenizer.from_pretrained(model);
const whisper = await WhisperForConditionalGeneration.from_pretrained(model, {
  dtype,
});
await whisper.dispose();
console.log(
  `Speech model ${model} (${dtype}) is in ${env.cacheDir} (${Math.round((Date.now() - started) / 1000)} s). Set SPEECH_PROVIDER=local to use it.`,
);
