import { parse } from "csv-parse/sync";
import { AppError } from "../../domain/errors";
import {
  customerFields,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  type ImportRow,
} from "../../domain/import-contracts";

const headers = ["external_id", "name", "email", "phone"];
export function parseCustomers(
  content: string,
  delimiter: string,
): ImportRow[] {
  if (Buffer.byteLength(content, "utf8") > MAX_IMPORT_BYTES)
    throw new AppError("TOO_LARGE", 413);
  // Reject control bytes and decoding replacement characters in user files.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(content))
    throw new AppError("CSV_ENCODING", 422);
  let records: { record: string[]; info: { lines: number } }[];
  // csv-parse's no-columns overload omits the documented info:true wrapper.
  try {
    records = parse(content, {
      bom: true,
      delimiter,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      max_record_size: 4096,
      info: true,
    }) as unknown as typeof records;
  } catch {
    throw new AppError("CSV_SYNTAX", 422);
  }
  const columns = records.shift()?.record;
  if (
    !columns ||
    columns.length !== 4 ||
    new Set(columns).size !== 4 ||
    columns.some((c) => !headers.includes(c))
  )
    throw new AppError("CSV_HEADERS", 422);
  if (!records.length) throw new AppError("CSV_EMPTY", 422);
  if (records.length > MAX_IMPORT_ROWS)
    throw new AppError("CSV_TOO_MANY_ROWS", 422);
  const seen = new Map<string, string>();
  return records.map(({ record, info }) => {
    const values = { external_id: "", name: "", email: "", phone: "" };
    columns.forEach((key, index) => {
      values[key as keyof typeof values] = (record[index] || "").trim();
    });
    values.email = values.email.toLowerCase();
    const errors: string[] = [];
    if (record.length !== columns.length) errors.push("COLUMN_COUNT");
    const valid = customerFields.safeParse(values);
    if (!valid.success)
      for (const issue of valid.error.issues)
        errors.push(`INVALID_${String(issue.path[0]).toUpperCase()}`);
    if (!values.email && !values.phone) errors.push("CONTACT_REQUIRED");
    if (/[\r\n\t]/.test(values.name)) errors.push("INVALID_NAME");
    let status: ImportRow["status"] = errors.length ? "invalid" : "ready";
    if (!errors.length) {
      const normalized = JSON.stringify(values);
      if (seen.has(values.external_id)) {
        status =
          seen.get(values.external_id) === normalized
            ? "duplicate"
            : "conflict";
        errors.push(status === "duplicate" ? "DUPLICATE_ROW" : "CONFLICT_ROW");
      } else seen.set(values.external_id, normalized);
    }
    return { row_number: info.lines, values, status, errors };
  });
}
