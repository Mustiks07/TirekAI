// T056 local speech evaluation on permitted public recordings: Google FLEURS (CC BY 4.0,
// https://huggingface.co/datasets/google/fleurs), Kazakh and Russian dev splits. Read speech of
// Wikipedia sentences: it measures the engine, not business phrases or real shop conditions.
//   npm run speech:eval [-- --n 30]        (behind a proxy: NODE_USE_ENV_PROXY=1)
// Clips go to .data/eval/fleurs (not committed); the report has metrics and the hardware only.
import { createGunzip } from "node:zlib";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import os from "node:os";
import { LocalWhisperSpeech } from "../src/server/assistant/local-speech";
import { normalizeSpeech } from "../src/server/ops/speech-check";
import { decodeWav, encodeWav } from "./speech-audio.mjs";

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const N = Number(arg("n", "30"));
const root = ".data/eval/fleurs";
const base = "https://huggingface.co/datasets/google/fleurs/resolve/main/data";

// Streams the dev archive and keeps only the first n clips; the rest is never downloaded.
async function fetchClips(lang: string, n: number) {
  const dir = `${root}/${lang}`;
  await mkdir(dir, { recursive: true });
  if (!existsSync(`${dir}/dev.tsv`))
    await writeFile(
      `${dir}/dev.tsv`,
      await (await fetch(`${base}/${lang}/dev.tsv`)).text(),
    );
  const have = (await readdir(dir)).filter((f) => f.endsWith(".wav"));
  if (have.length >= n) return;
  const res = await fetch(`${base}/${lang}/audio/dev.tar.gz`);
  if (!res.ok || !res.body) throw new Error(`FLEURS_DOWNLOAD_${res.status}`);
  const controller = new AbortController();
  const gunzip = Readable.fromWeb(res.body as never, {
    signal: controller.signal,
  }).pipe(createGunzip());
  let buf = Buffer.alloc(0),
    got = have.length;
  try {
    for await (const chunk of gunzip) {
      buf = Buffer.concat([buf, chunk as Buffer]);
      while (buf.length >= 512) {
        const name = buf.toString("utf8", 0, 100).replace(/\0.*$/s, "");
        if (!name) return;
        const size = parseInt(buf.toString("ascii", 124, 136).trim(), 8) || 0;
        const total = 512 + Math.ceil(size / 512) * 512;
        if (buf.length < total) break;
        const file = name.split("/").pop()!;
        if (file.endsWith(".wav") && !have.includes(file)) {
          await writeFile(`${dir}/${file}`, buf.subarray(512, 512 + size));
          if (++got >= n) return;
        }
        buf = buf.subarray(total);
      }
    }
  } finally {
    controller.abort();
  }
}
// Levenshtein alignment that also says which hypothesis words were wrong.
function align(ref: string[], hyp: string[]) {
  const d = Array.from({ length: ref.length + 1 }, (_, i) =>
    Array.from({ length: hyp.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  for (let i = 1; i <= ref.length; i++)
    for (let j = 1; j <= hyp.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
      );
  const wrong = new Set<number>();
  let i = ref.length,
    j = hyp.length;
  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)
    ) {
      if (ref[i - 1] !== hyp[j - 1]) wrong.add(j - 1);
      i--;
      j--;
    } else if (j > 0 && d[i][j] === d[i][j - 1] + 1) {
      wrong.add(j - 1);
      j--;
    } else i--;
  }
  return { errors: d[ref.length][hyp.length], wrong };
}
const words = (s: string) => normalizeSpeech(s).split(" ").filter(Boolean);
async function main() {
  const speech = new LocalWhisperSpeech();
  const t0 = Date.now();
  await speech.warm();
  const loadMs = Date.now() - t0;
  const report: Record<string, unknown> = {};
  for (const [lang, locale] of [
    ["kk_kz", "kk"],
    ["ru_ru", "ru"],
  ] as const) {
    await fetchClips(lang, N);
    const dir = `${root}/${lang}`;
    const tsv = (await readFile(`${dir}/dev.tsv`, "utf8"))
      .split("\n")
      .map((l) => l.split("\t"));
    const files = (await readdir(dir))
      .filter((f) => f.endsWith(".wav"))
      .sort()
      .slice(0, N);
    let errors = 0,
      refWords = 0,
      audio = 0,
      ms = 0,
      hypWords = 0,
      wrongWords = 0,
      flagged = 0,
      flaggedWrong = 0;
    const rows = [];
    for (const f of files) {
      const ref = tsv.find((r) => r[1] === f)?.[2];
      if (!ref) continue;
      // Same path as the browser: 16 kHz mono, peak-normalized, 16-bit WAV.
      const samples = decodeWav(await readFile(`${dir}/${f}`)) as Float32Array;
      const started = Date.now();
      const t = await speech.transcribe({
        audio: encodeWav(samples),
        mime: "audio/wav",
        locale,
        signal: AbortSignal.timeout(300_000),
      });
      const took = Date.now() - started;
      const r = words(ref),
        h = words(t.text),
        a = align(r, h);
      const flags = new Set(t.uncertain.map((w) => normalizeSpeech(w)));
      h.forEach((w, k) => {
        const isFlagged = flags.has(w);
        flagged += isFlagged ? 1 : 0;
        if (a.wrong.has(k)) {
          wrongWords++;
          if (isFlagged) flaggedWrong++;
        }
      });
      errors += a.errors;
      refWords += r.length;
      hypWords += h.length;
      audio += samples.length / 16000;
      ms += took;
      rows.push({
        clip: f,
        seconds: Math.round((samples.length / 16000) * 10) / 10,
        ms: took,
        wer: Math.round((a.errors / r.length) * 1000) / 1000,
        confidence: t.confidence,
        flagged: t.uncertain.length,
      });
    }
    report[locale] = {
      clips: rows.length,
      audioSeconds: Math.round(audio),
      wer: Math.round((errors / refWords) * 1000) / 1000,
      realTimeFactor: Math.round((ms / 1000 / audio) * 100) / 100,
      // How useful the "check these words" flags are on this set.
      flags: {
        hypothesisWords: hypWords,
        wrongWords,
        flaggedWords: flagged,
        wrongWordsFlagged: flaggedWrong,
        shareOfWrongWordsFlagged: wrongWords
          ? Math.round((flaggedWrong / wrongWords) * 1000) / 1000
          : null,
        shareOfFlagsThatWereWrong: flagged
          ? Math.round((flaggedWrong / flagged) * 1000) / 1000
          : null,
      },
      rows,
    };
    console.log(
      locale,
      JSON.stringify({ ...(report[locale] as object), rows: undefined }),
    );
  }
  speech.stop();
  await mkdir("docs/evidence", { recursive: true });
  const out = `docs/evidence/speech-fleurs-${new Date().toISOString().slice(0, 10)}.json`;
  await writeFile(
    out,
    JSON.stringify(
      {
        task: "T056",
        date: new Date().toISOString(),
        engine: "local-whisper (scripts/speech-worker.mjs)",
        model: speech.model,
        dtype: process.env.SPEECH_DTYPE || "q8",
        modelLicense:
          "OpenAI Whisper weights: MIT (github.com/openai/whisper README)",
        dataset:
          "Google FLEURS dev, first clips by name; CC BY 4.0; read Wikipedia sentences, not business requests",
        hardware: {
          cpu: os.cpus()[0]?.model,
          cores: os.cpus().length,
          memoryGb: Math.round(os.totalmem() / 2 ** 30),
        },
        modelLoadMs: loadMs,
        ...report,
      },
      null,
      2,
    ),
  );
  console.log(`Report: ${out}`);
}
main().catch((e) => {
  console.error("SPEECH_EVAL_FAILED", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
