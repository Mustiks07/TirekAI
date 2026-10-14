// Isolated local parser. stdin contains bytes, stdout one JSON result; no remote URLs.
import { mkdir, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";
const require = createRequire(import.meta.url);
const parts = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 5 * 1024 * 1024) throw new Error("TOO_LARGE");
  parts.push(chunk);
}
const bytes = Buffer.concat(parts),
  extension = process.argv[2];
let worker;
const checkDimensions = (w, h) => {
  if (w < 1 || h < 1 || w > 10000 || h > 10000 || w * h > 16000000)
    throw new Error("IMAGE_TOO_LARGE");
};
async function ocr(image) {
  if (!worker) {
    const langPath = join(process.cwd(), ".data", "ocr-languages-v1");
    await mkdir(langPath, { recursive: true });
    for (const code of ["rus", "kaz", "eng"])
      await copyFile(
        join(
          dirname(require.resolve(`@tesseract.js-data/${code}`)),
          "4.0.0_best_int",
          `${code}.traineddata.gz`,
        ),
        join(langPath, `${code}.traineddata.gz`),
      );
    worker = await createWorker("rus+kaz+eng", 1, {
      langPath,
      cacheMethod: "none",
      gzip: true,
    });
  }
  const { data } = await worker.recognize(image);
  return { text: data.text, confidence: data.confidence / 100 };
}
function dimensions(data) {
  if (extension === "png") {
    if (
      data.length < 24 ||
      data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    )
      throw new Error("DOCUMENT_PARSE_FAILED");
    return [data.readUInt32BE(16), data.readUInt32BE(20)];
  }
  if (data[0] !== 255 || data[1] !== 216)
    throw new Error("DOCUMENT_PARSE_FAILED");
  let at = 2;
  while (at + 9 < data.length) {
    if (data[at++] !== 255) continue;
    while (data[at] === 255) at++;
    const marker = data[at++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = data.readUInt16BE(at);
    if (length < 2 || at + length > data.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker))
      return [data.readUInt16BE(at + 5), data.readUInt16BE(at + 3)];
    at += length;
  }
  throw new Error("DOCUMENT_PARSE_FAILED");
}
try {
  let text = "",
    confidence = null,
    engine = "tesseract-rus-kaz-eng";
  const warnings = [
    "manual_item_and_pack_mapping_required",
    "check_every_quantity_price_and_total",
  ];
  if (extension === "pdf") {
    if (bytes.subarray(0, 5).toString() !== "%PDF-")
      throw new Error("DOCUMENT_PARSE_FAILED");
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: true,
      verbosity: 0,
      stopAtErrors: true,
    });
    const pdf = await loading.promise;
    if (pdf.numPages > 5) throw new Error("DOCUMENT_PAGE_LIMIT");
    engine = "pdfjs-text";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i),
        content = await page.getTextContent();
      let pageText = "";
      for (const item of content.items)
        if ("str" in item) pageText += item.str + (item.hasEOL ? "\n" : " ");
      if (pageText.trim().length < 20) {
        const viewport = page.getViewport({ scale: 2 });
        checkDimensions(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const canvas = createCanvas(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height),
        );
        await page.render({
          canvasContext: canvas.getContext("2d"),
          viewport,
          canvas,
        }).promise;
        const result = await ocr(canvas.toBuffer("image/png"));
        pageText = result.text;
        confidence =
          confidence === null
            ? result.confidence
            : Math.min(confidence, result.confidence);
        engine = "pdfjs+tesseract-rus-kaz-eng";
      }
      text += `\n[${i}]\n${pageText}`;
      if (text.length > 250000) throw new Error("TOO_LARGE");
      page.cleanup();
    }
    await loading.destroy();
  } else {
    checkDimensions(...dimensions(bytes));
    const img = await loadImage(bytes);
    checkDimensions(img.width, img.height);
    const result = await ocr(bytes);
    text = result.text;
    confidence = result.confidence;
  }
  if (!text.trim()) warnings.push("no_text_recognized");
  if (confidence !== null && confidence < 0.85)
    warnings.push("low_ocr_confidence");
  if (text.length > 250000) throw new Error("TOO_LARGE");
  const rows = text
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter(Boolean)
    .slice(0, 1000)
    .map((r) => r.split(/\t| {2,}/).slice(0, 30));
  process.stdout.write(
    JSON.stringify({ text, rows, engine, warnings, confidence }),
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      error: ["TOO_LARGE", "IMAGE_TOO_LARGE", "DOCUMENT_PAGE_LIMIT"].includes(
        error.message,
      )
        ? error.message
        : "DOCUMENT_PARSE_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  await worker?.terminate();
}
