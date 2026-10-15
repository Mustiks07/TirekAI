import { D } from "../../domain/purchasing";
import type { Extraction } from "../purchasing/extract";

// T056 live OCR acceptance: permitted real documents with hand-checked truth values. Scores are
// field-level (document number, total) and line-level (quantity, unit price, total triplets);
// the report keeps only metrics — never the recognized text.
export type OcrTruth = {
  documentNumber?: string;
  total?: string;
  lines: { quantity: string; unitPrice: string; total: string }[];
};
// "10 120" may be two columns or ten thousand one hundred twenty: both readings are candidates.
const numbers = (text: string) =>
  [
    ...(text.match(/\d+(?:[.,]\d+)?/g) ?? []),
    ...(text.match(/\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d+)?/g) ?? []).map((t) =>
      t.replace(/[ \u00a0]/g, ""),
    ),
  ].map((t) => t.replace(",", "."));
const same = (a: string | null, b: string) => a !== null && new D(a).eq(b);
export function scoreExtraction(e: Extraction, truth: OcrTruth) {
  const text = e.text.replace(/\s+/g, " ");
  const found: Record<string, boolean> = {};
  if (truth.documentNumber)
    found.documentNumber = text.includes(truth.documentNumber.trim());
  if (truth.total)
    found.total = numbers(e.text).some((n) => new D(n).eq(truth.total!));
  const used = new Set<number>();
  let matched = 0;
  for (const line of truth.lines) {
    const i = e.candidates.findIndex(
      (c, k) =>
        !used.has(k) &&
        same(c.quantity, line.quantity) &&
        same(c.unitPrice, line.unitPrice) &&
        same(c.total, line.total),
    );
    if (i >= 0) {
      used.add(i);
      matched++;
    }
  }
  const fields = Object.values(found);
  return {
    fieldsFound: fields.filter(Boolean).length,
    fieldsTotal: fields.length,
    found,
    linesTruth: truth.lines.length,
    linesMatched: matched,
    linesCandidates: e.candidates.length,
    lineRecall: truth.lines.length ? matched / truth.lines.length : null,
    linePrecision: e.candidates.length ? matched / e.candidates.length : null,
    confidence: e.confidence,
    engine: e.engine,
    warnings: e.warnings.length,
  };
}
