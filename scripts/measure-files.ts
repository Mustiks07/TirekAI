import { readFile, writeFile, mkdir } from "node:fs/promises";
import { cpus, platform, release } from "node:os";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { extractDocument } from "../src/server/purchasing/extract";

// T051: file processing is measured separately from API latency (SPECIFICATION §21). OCR runs in
// a child process; the event-loop delay of this process during OCR shows whether the server would
// stay responsive. Runs: sequential and 2 in parallel; a third concurrent request must be refused (429).
GlobalFonts.registerFromPath("assets/fonts/NotoSans.ttf", "MeasureNoto");
function png() {
  const canvas = createCanvas(1200, 360),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1200, 360);
  ctx.fillStyle = "black";
  ctx.font = "44px MeasureNoto";
  ctx.fillText("ШОТ-ФАКТУРА 456", 40, 80);
  ctx.fillText("ТОВАР   КОЛ   ЦЕНА   СУММА", 40, 160);
  ctx.fillText("Чай        12     10      120", 40, 240);
  return canvas.toBuffer("image/png");
}
const csv = Buffer.from(
  "sku;name;qty;price\n" +
    Array.from(
      { length: 500 },
      (_, i) => `S${i};Товар ${i};${(i % 7) + 1};${100 + i}`,
    ).join("\n"),
);
async function main() {
  const files: [string, string, Buffer][] = [
    [
      "scanned_pdf",
      "invoice.pdf",
      await readFile("tests/fixtures/purchase-invoice.pdf"),
    ],
    ["png_ocr", "invoice.png", png()],
    ["csv_500_rows", "invoice.csv", csv],
  ];
  const results: Record<string, unknown> = {};
  for (const [name, filename, bytes] of files) {
    const runs: number[] = [];
    let lagMax = 0;
    for (let i = 0; i < 3; i++) {
      const lag = monitorEventLoopDelay({ resolution: 10 });
      lag.enable();
      const t0 = performance.now();
      const r = await extractDocument(filename, bytes);
      runs.push(Math.round(performance.now() - t0));
      lag.disable();
      lagMax = Math.max(lagMax, lag.max / 1e6);
      if (!r.text) throw Error(`EMPTY_${name}`);
    }
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    const t0 = performance.now();
    // Two extractions per process run at once; a third is refused at once (backpressure).
    const pair = Promise.all(
      [0, 1].map(() => extractDocument(filename, bytes)),
    );
    const third = await extractDocument(filename, bytes).then(
      () => "accepted",
      (e: { code?: string }) => e.code ?? "error",
    );
    await pair;
    const parallel = Math.round(performance.now() - t0);
    lag.disable();
    results[name] = {
      bytes: bytes.length,
      sequentialMs: runs,
      parallel2Ms: parallel,
      thirdConcurrent: third,
      eventLoopMaxDelayMs: Math.round(Math.max(lagMax, lag.max / 1e6)),
    };
    console.log(name, results[name]);
  }
  const report = {
    task: "T051",
    date: new Date().toISOString(),
    environment: {
      os: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      node: process.version,
    },
    engine:
      "local tesseract.js rus+kaz+eng in a child process (no external service)",
    results,
    note: "Upload of a purchase document waits for this extraction in the request; the form shows a busy state while other screens keep working (child process, measured event-loop delay).",
  };
  await mkdir("docs/evidence", { recursive: true });
  const file = `docs/evidence/files-${new Date().toISOString().slice(0, 10)}.json`;
  await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  console.log(`Report: ${file}`);
}
main().catch((e) => {
  console.error("MEASURE_FAILED:", e instanceof Error ? e.message : "unknown");
  process.exitCode = 1;
});
