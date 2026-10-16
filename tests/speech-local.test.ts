import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isCritical, reviewTranscript } from "../src/domain/speech-review";
import { LocalWhisperSpeech } from "../src/server/assistant/local-speech";
import { wordErrorRate } from "../src/server/ops/speech-check";
import { decodeWav, encodeWav } from "../scripts/speech-audio.mjs";

it("T056: amounts, quantities and negations are critical in Russian and Kazakh", () => {
  for (const w of ["25", "1 300,00", "двадцать", "пяти", "не", "нет"])
    expect(isCritical(w, "ru"), w).toBe(true);
  for (const w of ["стол", "стоимость", "чай", "склад"])
    expect(isCritical(w, "ru"), w).toBe(false);
  for (const w of [
    "жиырма",
    "жиырмасы",
    "мыңнан",
    "жоқ",
    "емес",
    "жүргізбе",
    "төлеме",
    "бермеңіз",
  ])
    expect(isCritical(w, "kk"), w).toBe(true);
  for (const w of ["шай", "қойма", "клиент"])
    expect(isCritical(w, "kk"), w).toBe(false);
});
it("T056: unsure words and less than certain critical words must be checked", () => {
  const r = reviewTranscript(
    [
      { w: "Төлемді", p: 0.97 },
      { w: "жүргізбе", p: 0.72 }, // negation, not certain enough
      { w: "жиырма", p: 0.95 }, // number, certain
      { w: "қорап", p: 0.42 }, // ordinary word, unsure
      { w: "сүт", p: 0.8 }, // ordinary word, sure enough
    ],
    "kk",
  );
  expect(r).toEqual({
    text: "Төлемді жүргізбе жиырма қорап сүт",
    confidence: 0.772,
    uncertain: ["жүргізбе", "қорап"],
  });
  expect(reviewTranscript([], "ru")).toEqual({
    text: "",
    confidence: null,
    uncertain: [],
  });
});
it("T056: WAV input is normalized to 16 kHz mono; other formats are refused", () => {
  const tone = Float32Array.from(
    { length: 16000 },
    (_, i) => Math.sin(i / 10) * 0.5,
  );
  const back = decodeWav(encodeWav(tone)) as Float32Array;
  expect(back.length).toBe(16000);
  // Peak-normalized to 0.9 before 16-bit quantization (gain 1.8 for a 0.5 peak).
  expect(Math.abs(back[123] - tone[123] * 1.8)).toBeLessThan(1e-3);
  // 44.1 kHz stereo float32 → 16 kHz mono
  const n = 44100,
    b = Buffer.alloc(44 + n * 8);
  b.write("RIFFxxxxWAVEfmt ", 0, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(3, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(44100, 24);
  b.writeUInt16LE(32, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(n * 8, 40);
  for (let i = 0; i < n; i++) {
    b.writeFloatLE(0.25, 44 + i * 8);
    b.writeFloatLE(0.75, 48 + i * 8);
  }
  const mono = decodeWav(b) as Float32Array;
  expect(mono.length).toBe(16000);
  expect(mono[100]).toBeCloseTo(0.5, 5);
  expect(() =>
    decodeWav(Buffer.from("OggS not a wav file at all, definitely not")),
  ).toThrow("VOICE_FORMAT");
});
describe("T056 local speech process protocol (test double, not recognition)", () => {
  const fake = resolve("tests/fixtures/fake-speech-worker.mjs");
  const wav = (samples: number) =>
    encodeWav(new Float32Array(samples)) as Buffer;
  it("returns an editable transcript with unsure words, refuses non-WAV, keeps order", async () => {
    const s = new LocalWhisperSpeech("test", fake);
    await expect(
      s.transcribe({
        audio: wav(100),
        mime: "audio/webm",
        locale: "ru",
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toMatchObject({ code: "VOICE_FORMAT" });
    const [kk, ru] = await Promise.all([
      s.transcribe({
        audio: wav(100),
        mime: "audio/wav",
        locale: "kk",
        signal: AbortSignal.timeout(5000),
      }),
      s.transcribe({
        audio: wav(100),
        mime: "audio/wav",
        locale: "ru",
        signal: AbortSignal.timeout(5000),
      }),
    ]);
    expect(kk).toMatchObject({
      text: "Төлемді жүргізбе жиырма бес қорап",
      locale: "kk",
      uncertain: ["жүргізбе", "қорап"],
    });
    expect(ru).toMatchObject({ text: "Спиши 25 штук", uncertain: [] });
    await expect(
      s.transcribe({
        audio: wav(1),
        mime: "audio/wav",
        locale: "ru",
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toMatchObject({ code: "VOICE_FORMAT" });
    s.stop();
  });
  it("a finished request's deadline does not stop the process later", async () => {
    const s = new LocalWhisperSpeech("test", fake);
    await s.transcribe({
      audio: wav(100),
      mime: "audio/wav",
      locale: "ru",
      signal: AbortSignal.timeout(300),
    });
    await new Promise((ok) => setTimeout(ok, 500));
    // The process (and its loaded model) is still the same one: no restart happened.
    expect((s as unknown as { child: unknown }).child).not.toBeNull();
    s.stop();
  });
  it("a deadline stops the process and the next request starts a new one", async () => {
    const s = new LocalWhisperSpeech("test", fake);
    await expect(
      s.transcribe({
        audio: wav(3),
        mime: "audio/wav",
        locale: "ru",
        signal: AbortSignal.timeout(500),
      }),
    ).rejects.toMatchObject({ code: "VOICE_TIMEOUT" });
    await expect(
      s.transcribe({
        audio: wav(100),
        mime: "audio/wav",
        locale: "ru",
        signal: AbortSignal.timeout(5000),
      }),
    ).resolves.toMatchObject({ text: "Спиши 25 штук" });
    s.stop();
  });
  it("more than three waiting recordings are refused as busy", async () => {
    const s = new LocalWhisperSpeech("test", fake);
    const slow = () =>
      s
        .transcribe({
          audio: wav(3),
          mime: "audio/wav",
          locale: "ru",
          signal: AbortSignal.timeout(1500),
        })
        .catch((e) => e.code);
    const results = await Promise.all([slow(), slow(), slow(), slow()]);
    expect(results).toContain("VOICE_BUSY");
    s.stop();
  });
});
// Real recognition, only where the model was downloaded (npm run speech:model) and a FLEURS
// clip is present (npm run speech:eval downloads them). Skipped otherwise, never mocked.
const modelDir = ".data/models/onnx-community/whisper-large-v3-turbo";
const clips = ".data/eval/fleurs/kk_kz";
describe.skipIf(!existsSync(modelDir) || !existsSync(clips))(
  "T056 real local Whisper",
  () => {
    it("transcribes a Kazakh FLEURS recording on this CPU", async () => {
      const s = new LocalWhisperSpeech();
      const file = (await readdir(clips)).find((f) => f.endsWith(".wav"))!;
      const tsv = (await readFile(`${clips}/dev.tsv`, "utf8"))
        .split("\n")
        .map((l) => l.split("\t"));
      const ref = tsv.find((r) => r[1] === file)![2];
      const r = await s.transcribe({
        audio: encodeWav(decodeWav(await readFile(`${clips}/${file}`))),
        mime: "audio/wav",
        locale: "kk",
        signal: AbortSignal.timeout(180_000),
      });
      const w = wordErrorRate(ref, r.text);
      expect(w.errors / w.words).toBeLessThan(0.6);
      expect(r.confidence).toBeGreaterThan(0);
      s.stop();
    }, 240_000);
  },
);
it("T056: the transcription route accepts a full minute of WAV (the general 16 KB body limit refused every real recording)", async () => {
  const { uploadLimit } = await import("../src/server/routes/execution");
  expect(uploadLimit("POST", ["assistant", "transcriptions"])).toBe(2_900_000);
});
