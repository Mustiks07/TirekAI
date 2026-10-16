// Prefill for the document review form from local OCR. Every value is only a suggestion in an
// editable field: the person compares it with the original and the server checks the result.
// A value that cannot be read with confidence is left empty, never replaced by zero.
type Candidate = {
  name: string;
  quantity: string | null;
  unitPrice: string | null;
  total: string | null;
};
type OrderLine = { id: string; name: string };
export type ReviewSuggestion = {
  number: string | null;
  date: string | null;
  delivery: string | null;
  total: string | null;
  lines: Record<
    string,
    { quantity: string | null; unitPrice: string | null; source: string }
  >;
  unmatched: string[];
};
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 1 || /\d/.test(w));
// Share of the order line's words found in the document line.
const similarity = (order: string, doc: string) => {
  const a = words(order),
    b = new Set(words(doc));
  return a.length ? a.filter((w) => b.has(w)).length / a.length : 0;
};
// "76 100,00" → "76100.00"; anything that is not a plain amount gives null.
export const amount = (s: string | undefined) => {
  const v = s
    ?.trim()
    .replace(/[ \u00a0]/g, "")
    .replace(",", ".");
  return v && /^\d+(\.\d{1,6})?$/.test(v) ? v : null;
};
const AMOUNT = String.raw`(\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
export function suggestReview(
  extraction: { text: string; candidates: Candidate[] },
  lines: OrderLine[],
): ReviewSuggestion {
  const text = extraction.text;
  const number =
    text
      .match(
        /(?:накладн\S*|счет\S*|шот\S*|жүкқұжат\S*)?\s*№\s*([\p{L}\p{N}][\p{L}\p{N}\-/]{0,30})/iu,
      )?.[1]
      ?.trim() ?? null;
  const d = text.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/);
  const date = d ? `${d[3]}-${d[2]}-${d[1]}` : null;
  const labelled = (labels: string) =>
    amount(
      text.match(
        new RegExp(`(?:${labels})[^\\d\\n]{0,30}${AMOUNT}`, "iu"),
      )?.[1],
    );
  const used = new Set<number>();
  const out: ReviewSuggestion["lines"] = {};
  const unmatched: string[] = [];
  for (const line of lines) {
    let best = -1,
      score = 0;
    extraction.candidates.forEach((c, i) => {
      const s = similarity(line.name, c.name);
      if (!used.has(i) && s > score) {
        best = i;
        score = s;
      }
    });
    if (best < 0 || score < 0.6) {
      unmatched.push(line.id);
      continue;
    }
    used.add(best);
    const c = extraction.candidates[best];
    out[line.id] = {
      quantity: amount(c.quantity ?? undefined),
      unitPrice: amount(c.unitPrice ?? undefined),
      source: c.name,
    };
  }
  return {
    number,
    date,
    delivery: labelled("доставка|жеткізу|delivery"),
    total: labelled("итого к оплате|итого|всего|барлығы|жиыны|total"),
    lines: out,
    unmatched,
  };
}
