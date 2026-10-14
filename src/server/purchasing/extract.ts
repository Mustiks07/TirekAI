import { parse } from "csv-parse/sync";
import { AppError } from "../../domain/errors";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
let running = 0;
export type Extraction = {
  text: string;
  rows: string[][];
  engine: string;
  warnings: string[];
  confidence: number | null;
  candidates: {
    name: string;
    quantity: string | null;
    unit: string | null;
    unitPrice: string | null;
    total: string | null;
    confidence: number | null;
  }[];
};
function candidates(rows: string[][], confidence: number | null) {
  const headers = rows[0]?.map((x) => x.trim().toLowerCase()) || [];
  const index = (names: string[]) =>
    headers.findIndex((x) => names.includes(x));
  const n = index(["name", "product", "наименование", "товар", "атауы"]),
    q = index(["qty", "quantity", "количество", "кол-во", "саны"]),
    p = index(["price", "unit_price", "цена", "баға"]),
    u = index(["unit", "ед", "единица", "бірлік"]),
    s = index(["total", "sum", "сумма", "сомасы"]);
  const numeric = (v: string | undefined) => {
    const x = v?.trim().replace(",", ".");
    return x && /^\d+(\.\d{1,6})?$/.test(x) ? x : null;
  };
  if (n >= 0 && q >= 0 && p >= 0)
    return rows
      .slice(1)
      .filter((r) => r[n]?.trim())
      .slice(0, 100)
      .map((r) => ({
        name: r[n].trim(),
        quantity: numeric(r[q]),
        unit: r[u]?.trim() || null,
        unitPrice: numeric(r[p]),
        total: numeric(r[s]),
        confidence,
      }));
  return rows
    .flatMap((r) => {
      const tokens = r.join(" ").trim().split(/\s+/);
      if (tokens.length < 4) return [];
      const total = numeric(tokens.at(-1)),
        unitPrice = numeric(tokens.at(-2)),
        quantity = numeric(tokens.at(-3));
      return total && unitPrice && quantity
        ? [
            {
              name: tokens.slice(0, -3).join(" "),
              quantity,
              unit: null,
              unitPrice,
              total,
              confidence:
                confidence === null ? null : Math.min(confidence, 0.6),
            },
          ]
        : [];
    })
    .slice(0, 100);
}
export async function extractDocument(
  filename: string,
  bytes: Buffer,
): Promise<Extraction> {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension === "csv" || extension === "tsv") {
    if (bytes.length > 256 * 1024) throw new AppError("TOO_LARGE", 413);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new AppError("INVALID_ENCODING", 422);
    }
    let rows: string[][];
    try {
      rows = parse(text, {
        bom: true,
        delimiter: extension === "tsv" ? "\t" : ",",
        skip_empty_lines: true,
        relax_column_count: true,
        max_record_size: 8192,
      });
    } catch {
      throw new AppError("DOCUMENT_PARSE_FAILED", 422);
    }
    if (rows.length > 1001 || rows.some((r) => r.length > 30))
      throw new AppError("TOO_LARGE", 413);
    return {
      text,
      rows,
      engine: "csv-parse",
      confidence: 1,
      warnings: ["manual_item_and_pack_mapping_required"],
      candidates: candidates(rows, 1),
    };
  }
  if (!["pdf", "png", "jpg", "jpeg"].includes(extension || ""))
    throw new AppError("DOCUMENT_FORMAT_UNSUPPORTED", 422);
  if (running >= 2) throw new AppError("DOCUMENT_PROCESSOR_BUSY", 429);
  running++;
  try {
    return await new Promise<Extraction>((resolveResult, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--max-old-space-size=512",
          resolve(process.cwd(), "scripts/extract-document.mjs"),
          extension!,
        ],
        {
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
          timeout: 90000,
          env: {
            NODE_ENV: process.env.NODE_ENV,
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
          },
        },
      );
      let output = "",
        settled = false;
      const fail = (code: string) => {
        if (!settled) {
          settled = true;
          reject(new AppError(code, 422));
        }
      };
      child.stdout.on("data", (b) => {
        output += b.toString();
        if (output.length > 2_000_000) {
          child.kill();
          fail("TOO_LARGE");
        }
      });
      child.on("error", () => fail("DOCUMENT_PROCESSOR_UNAVAILABLE"));
      child.stdin.on("error", () => fail("DOCUMENT_PARSE_FAILED"));
      child.on("close", () => {
        if (settled) return;
        try {
          const result = JSON.parse(output);
          if (result.error) fail(result.error);
          else {
            settled = true;
            resolveResult({
              ...result,
              candidates: candidates(result.rows, result.confidence),
            });
          }
        } catch {
          fail("DOCUMENT_PARSE_FAILED");
        }
      });
      child.stdin.end(bytes);
    });
  } finally {
    running--;
  }
}
