// Test double of scripts/speech-worker.mjs for protocol tests only: it does not recognize speech.
// It answers with words encoded in the WAV's first sample count, or with the requested failure.
import { createInterface } from "node:readline";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
send({ ready: false });
setTimeout(() => send({ ready: true }), 50);
for await (const line of createInterface({ input: process.stdin })) {
  const r = JSON.parse(line);
  const size = Buffer.from(r.wav, "base64").length;
  if (size === 44 + 2 * 1) send({ id: r.id, error: "VOICE_FORMAT" });
  else if (size === 44 + 2 * 3) await new Promise((ok) => setTimeout(ok, 5000));
  else
    send({
      id: r.id,
      words:
        r.locale === "kk"
          ? [
              { w: "Төлемді", p: 0.97 },
              { w: "жүргізбе", p: 0.72 },
              { w: "жиырма", p: 0.95 },
              { w: "бес", p: 0.98 },
              { w: "қорап", p: 0.42 },
            ]
          : [
              { w: "Спиши", p: 0.99 },
              { w: "25", p: 0.97 },
              { w: "штук", p: 0.98 },
            ],
      seconds: 1,
      ms: 5,
    });
}
