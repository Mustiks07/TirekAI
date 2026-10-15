import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { extractDocument } from "../src/server/purchasing/extract";
import { scoreExtraction, type OcrTruth } from "../src/server/ops/ocr-check";

// T056: `npm run ocr:check -- --manifest <folder>/manifest.json`. The manifest lists permitted
// documents and their hand-checked truth: { name, permission, documents: [{ file, language, truth }] }.
// The report has file hashes and metrics only — no recognized text and no document content.
async function main() {
  const i = process.argv.indexOf("--manifest");
  if (i < 0) throw Error("MANIFEST_REQUIRED");
  const path = resolve(process.argv[i + 1]);
  const m = JSON.parse(await readFile(path, "utf8")) as {
    name: string;
    permission: string;
    documents: {
      file: string;
      language: "ru" | "kk" | "mixed";
      truth: OcrTruth;
    }[];
  };
  if (!m.permission?.trim()) throw Error("PERMISSION_NOTE_REQUIRED");
  const rows: ({ sha256: string; language: string; ms: number } & ReturnType<
    typeof scoreExtraction
  >)[] = [];
  for (const d of m.documents) {
    const bytes = await readFile(resolve(dirname(path), d.file));
    const t0 = performance.now();
    const e = await extractDocument(basename(d.file), bytes);
    rows.push({
      sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
      language: d.language,
      ms: Math.round(performance.now() - t0),
      ...scoreExtraction(e, d.truth),
    });
  }
  const sum = (
    k: "fieldsFound" | "fieldsTotal" | "linesMatched" | "linesTruth",
  ) => rows.reduce((a, r) => a + r[k], 0);
  const report = {
    task: "T056",
    dataset: m.name,
    permission: m.permission,
    date: new Date().toISOString(),
    documents: rows.length,
    fieldAccuracy: sum("fieldsTotal")
      ? sum("fieldsFound") / sum("fieldsTotal")
      : null,
    lineRecall: sum("linesTruth")
      ? sum("linesMatched") / sum("linesTruth")
      : null,
    byLanguage: Object.fromEntries(
      ["ru", "kk", "mixed"].map((l) => [
        l,
        rows.filter((r) => r.language === l).length,
      ]),
    ),
    medianMs:
      rows.map((r) => r.ms).sort((a, b) => a - b)[
        Math.floor(rows.length / 2)
      ] ?? null,
    rows,
  };
  await mkdir("docs/evidence", { recursive: true });
  const out = `docs/evidence/ocr-check-${m.name.replace(/[^a-z0-9-]/gi, "_")}-${report.date.slice(0, 10)}.json`;
  await writeFile(out, JSON.stringify(report, null, 2) + "\n");
  console.log(
    `OCR check: ${rows.length} documents, field accuracy ${report.fieldAccuracy}, line recall ${report.lineRecall}. Report: ${out}`,
  );
}
main().catch((e) => {
  console.error(
    `OCR_CHECK_FAILED: ${e instanceof Error ? e.message.split(" ")[0] : "unknown"}`,
  );
  process.exitCode = 1;
});
