import { it, expect } from "vitest";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { extractDocument } from "../src/server/purchasing/extract";
import { readFile } from "node:fs/promises";
GlobalFonts.registerFromPath("assets/fonts/NotoSans.ttf", "FixtureNoto");
it("extracts text and OCRs scanned pages of a real PDF", async () => {
  const result = await extractDocument(
    "invoice.pdf",
    await readFile("tests/fixtures/purchase-invoice.pdf"),
  );
  expect(result.text).toContain("789");
  expect(result.text).toContain("790");
  expect(result.engine).toBe("pdfjs+tesseract-rus-kaz-eng");
}, 90000);
it("actually recognizes an image with installed local language models", async () => {
  const canvas = createCanvas(1200, 360),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1200, 360);
  ctx.fillStyle = "black";
  ctx.font = "44px FixtureNoto";
  ctx.fillText("INVOICE 456", 40, 80);
  ctx.fillText("PRODUCT   QTY   PRICE   TOTAL", 40, 160);
  ctx.fillText("APPLE        12       10        120", 40, 240);
  const result = await extractDocument(
    "invoice.png",
    canvas.toBuffer("image/png"),
  );
  expect(result.engine).toBe("tesseract-rus-kaz-eng");
  expect(result.text).toContain("456");
  expect(result.text).toContain("120");
  expect(result.confidence).toBeGreaterThan(0.5);
}, 90000);
it("rejects executables, malformed PDF, huge image dimensions and invalid UTF-8", async () => {
  await expect(
    extractDocument("file.exe", Buffer.from("MZ")),
  ).rejects.toMatchObject({ code: "DOCUMENT_FORMAT_UNSUPPORTED" });
  await expect(
    extractDocument("file.pdf", Buffer.from("not a PDF")),
  ).rejects.toMatchObject({ code: "DOCUMENT_PARSE_FAILED" });
  const fake = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(fake);
  fake.writeUInt32BE(100000, 16);
  fake.writeUInt32BE(100000, 20);
  await expect(extractDocument("huge.png", fake)).rejects.toMatchObject({
    code: "IMAGE_TOO_LARGE",
  });
  await expect(
    extractDocument("file.csv", Buffer.from([0xff, 0xfe])),
  ).rejects.toMatchObject({ code: "INVALID_ENCODING" });
}, 30000);
it("T056: the OCR acceptance score finds fields and line triplets in a real recognition", async () => {
  const { scoreExtraction } = await import("../src/server/ops/ocr-check");
  const canvas = createCanvas(1200, 360),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1200, 360);
  ctx.fillStyle = "black";
  ctx.font = "44px FixtureNoto";
  ctx.fillText("INVOICE 456", 40, 80);
  ctx.fillText("PRODUCT   QTY   PRICE   TOTAL", 40, 160);
  ctx.fillText("APPLE        12       10        120", 40, 240);
  const e = await extractDocument("invoice.png", canvas.toBuffer("image/png"));
  const score = scoreExtraction(e, {
    documentNumber: "456",
    total: "120",
    lines: [{ quantity: "12", unitPrice: "10", total: "120" }],
  });
  expect(score).toMatchObject({
    fieldsFound: 2,
    fieldsTotal: 2,
    linesMatched: 1,
    lineRecall: 1,
  });
  // A wrong truth value is not "found".
  expect(
    scoreExtraction(e, {
      total: "121",
      lines: [{ quantity: "13", unitPrice: "10", total: "130" }],
    }),
  ).toMatchObject({ fieldsFound: 0, linesMatched: 0 });
}, 90000);
