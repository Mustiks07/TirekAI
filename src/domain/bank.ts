import { createHash } from "node:crypto";
import { z } from "zod";
import { minorUnits } from "./decimal";

// 1C:Enterprise "Client bank" exchange format (1CClientBankExchange, versions 1.02/1.03),
// published at v8.1c.ru/edi/edi_stnd/100/101.htm (checked 2026-10-15). Kazakhstan banks export
// the same layout with IBAN accounts and 12-digit BIN/IIN in the "ИНН" fields.
export type StatementSection = {
  account: string;
  start: string | null;
  end: string | null;
  opening: bigint | null;
  incoming: bigint | null;
  outgoing: bigint | null;
  closing: bigint | null;
};
export type StatementDoc = {
  kind: string;
  number: string;
  date: string;
  amount: bigint;
  payerAccount: string;
  payer: string;
  payerBin: string;
  receiverAccount: string;
  receiver: string;
  receiverBin: string;
  debited: string | null;
  credited: string | null;
  purpose: string;
};
export type ParsedStatement = {
  version: string;
  encoding: string;
  start: string;
  end: string;
  accounts: string[];
  sections: StatementSection[];
  documents: StatementDoc[];
};
export class StatementError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
const ddmmyyyy = (v: string | undefined, field: string) => {
  if (!v) return null;
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(v.trim());
  if (!m) throw new StatementError(`STATEMENT_DATE_INVALID:${field}`);
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso)
    throw new StatementError(`STATEMENT_DATE_INVALID:${field}`);
  return iso;
};
// "руб[.коп]": integer part and up to two fraction digits; a comma is tolerated.
const amount = (v: string | undefined, field: string) => {
  if (v === undefined || v.trim() === "") return null;
  const s = v.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d{1,30}(\.\d{1,2})?$/.test(s))
    throw new StatementError(`STATEMENT_AMOUNT_INVALID:${field}`);
  return minorUnits(s);
};
// The file declares Windows (cp1251) or DOS (cp866); some banks send UTF-8. The decoding that
// yields the format's own Cyrillic keywords is the right one.
export function decodeStatement(bytes: Uint8Array) {
  for (const enc of ["utf-8", "windows-1251", "ibm866"]) {
    let text: string;
    try {
      text = new TextDecoder(enc, { fatal: enc === "utf-8" }).decode(bytes);
    } catch {
      continue;
    }
    if (text.startsWith("﻿")) text = text.slice(1);
    if (/^1CClientBankExchange\s*$/m.test(text) && /КонецФайла/.test(text))
      return text;
  }
  throw new StatementError("STATEMENT_FORMAT_INVALID");
}
export function parseStatement(text: string): ParsedStatement {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== "1CClientBankExchange")
    throw new StatementError("STATEMENT_FORMAT_INVALID");
  if (!lines.includes("КонецФайла"))
    throw new StatementError("STATEMENT_TRUNCATED");
  const header: Record<string, string> = {},
    accounts: string[] = [],
    sections: StatementSection[] = [],
    documents: StatementDoc[] = [];
  let block: Record<string, string> | null = null,
    kind: "account" | "doc" | null = null,
    docKind = "";
  for (const line of lines.slice(1)) {
    if (!line) continue;
    if (line === "КонецФайла") break;
    const eq = line.indexOf("=");
    const k = eq < 0 ? line : line.slice(0, eq),
      v = eq < 0 ? "" : line.slice(eq + 1);
    if (k === "СекцияРасчСчет") {
      block = {};
      kind = "account";
      continue;
    }
    if (k === "СекцияДокумент") {
      block = {};
      kind = "doc";
      docKind = v.trim();
      continue;
    }
    if (k === "КонецРасчСчет" && kind === "account" && block) {
      if (!block.РасчСчет)
        throw new StatementError("STATEMENT_ACCOUNT_MISSING");
      sections.push({
        account: block.РасчСчет.trim(),
        start: ddmmyyyy(block.ДатаНачала, "ДатаНачала"),
        end: ddmmyyyy(block.ДатаКонца, "ДатаКонца"),
        opening: amount(block.НачальныйОстаток, "НачальныйОстаток"),
        incoming: amount(block.ВсегоПоступило, "ВсегоПоступило"),
        outgoing: amount(block.ВсегоСписано, "ВсегоСписано"),
        closing: amount(block.КонечныйОстаток, "КонечныйОстаток"),
      });
      block = null;
      kind = null;
      continue;
    }
    if (k === "КонецДокумента" && kind === "doc" && block) {
      const b = block;
      const sum = amount(b.Сумма, "Сумма");
      if (!b.Номер || !b.Дата || sum === null || sum <= 0n)
        throw new StatementError("STATEMENT_DOCUMENT_INVALID");
      const purpose =
        b.НазначениеПлатежа ||
        [1, 2, 3, 4, 5, 6]
          .map((i) => b[`НазначениеПлатежа${i}`] || "")
          .filter(Boolean)
          .join(" ");
      documents.push({
        kind: docKind,
        number: b.Номер.trim(),
        date: ddmmyyyy(b.Дата, "Дата")!,
        amount: sum,
        payerAccount: (b.ПлательщикСчет || b.ПлательщикРасчСчет || "").trim(),
        payer: (b.Плательщик1 || b.Плательщик || "").trim(),
        payerBin: (b.ПлательщикИНН || "").trim(),
        receiverAccount: (
          b.ПолучательСчет ||
          b.ПолучательРасчСчет ||
          ""
        ).trim(),
        receiver: (b.Получатель1 || b.Получатель || "").trim(),
        receiverBin: (b.ПолучательИНН || "").trim(),
        debited: ddmmyyyy(b.ДатаСписано, "ДатаСписано"),
        credited: ddmmyyyy(b.ДатаПоступило, "ДатаПоступило"),
        purpose: purpose.trim(),
      });
      block = null;
      kind = null;
      continue;
    }
    if (block) block[k] = v;
    else if (k === "РасчСчет") accounts.push(v.trim());
    else header[k] = v;
  }
  if (block) throw new StatementError("STATEMENT_TRUNCATED");
  const start = ddmmyyyy(header.ДатаНачала, "ДатаНачала"),
    end = ddmmyyyy(header.ДатаКонца, "ДатаКонца");
  if (!header.ВерсияФормата || !start || !end || end < start)
    throw new StatementError("STATEMENT_HEADER_INVALID");
  return {
    version: header.ВерсияФормата.trim(),
    encoding: (header.Кодировка || "").trim(),
    start,
    end,
    accounts,
    sections,
    documents,
  };
}
export type StatementLine = {
  direction: "in" | "out";
  doc: StatementDoc;
  booked: string;
  counterparty: string;
  counterpartyBin: string;
  counterpartyAccount: string;
  key: string;
};
// Lines for one account of the organization: the account decides the direction; the key is
// stable across re-exports, so overlapping statements do not duplicate movements.
export function linesFor(statement: ParsedStatement, account: string) {
  const out: StatementLine[] = [];
  for (const doc of statement.documents) {
    const outgoing = doc.payerAccount === account && doc.debited,
      incoming = doc.receiverAccount === account && doc.credited;
    for (const [direction, booked] of [
      ["out", outgoing ? doc.debited : null],
      ["in", incoming ? doc.credited : null],
    ] as const) {
      if (!booked) continue;
      const counterparty = direction === "out" ? doc.receiver : doc.payer,
        counterpartyAccount =
          direction === "out" ? doc.receiverAccount : doc.payerAccount;
      out.push({
        direction,
        doc,
        booked,
        counterparty,
        counterpartyBin: direction === "out" ? doc.receiverBin : doc.payerBin,
        counterpartyAccount,
        key: createHash("sha256")
          .update(
            [
              direction,
              doc.number,
              doc.date,
              doc.amount.toString(),
              counterpartyAccount,
              booked,
            ].join("|"),
          )
          .digest("hex"),
      });
    }
  }
  return out;
}
// Statement arithmetic: opening + incoming − outgoing = closing, and the documents add up to
// the stated turnovers. Any mismatch keeps the statement from being posted.
export function checkStatement(
  statement: ParsedStatement,
  account: string,
  lines: StatementLine[],
) {
  const issues: string[] = [];
  const sections = statement.sections.filter((s) => s.account === account);
  if (!sections.length) issues.push("no_balance_section");
  const sum = (d: "in" | "out") =>
    lines
      .filter((l) => l.direction === d)
      .reduce((a, l) => a + l.doc.amount, 0n);
  const totals = { in: sum("in"), out: sum("out") };
  const first = sections[0],
    last = sections[sections.length - 1];
  const stated = {
    in: sections.reduce<bigint | null>(
      (a, s) => (a === null || s.incoming === null ? null : a + s.incoming),
      0n,
    ),
    out: sections.reduce<bigint | null>(
      (a, s) => (a === null || s.outgoing === null ? null : a + s.outgoing),
      0n,
    ),
  };
  if (first && last) {
    if (first.opening === null || last.closing === null)
      issues.push("balance_missing");
    else if (first.opening + totals.in - totals.out !== last.closing)
      issues.push("balance_mismatch");
    if (stated.in !== null && stated.in !== totals.in)
      issues.push("incoming_mismatch");
    if (stated.out !== null && stated.out !== totals.out)
      issues.push("outgoing_mismatch");
  }
  return {
    issues,
    opening: first?.opening ?? null,
    closing: last?.closing ?? null,
    incoming: totals.in,
    outgoing: totals.out,
  };
}
export const statementUpload = z
  .object({
    key: z.uuid(),
    accountId: z.uuid(),
    filename: z.string().trim().min(1).max(120),
    content: z.string().min(1).max(2_800_000),
  })
  .strict();
export const bankAccountInput = z
  .object({
    accountId: z.uuid(),
    // IBAN (KZ: 20 characters) or a domestic account number.
    bankAccount: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{10,34}$/),
  })
  .strict();
const decisionNote = z.string().trim().min(3).max(200);
export const lineDecision = z.discriminatedUnion("action", [
  z
    .object({
      key: z.uuid(),
      version: z.number().int().positive(),
      action: z.literal("match"),
      entryId: z.uuid(),
    })
    .strict(),
  z
    .object({
      key: z.uuid(),
      version: z.number().int().positive(),
      action: z.literal("payment"),
      orderId: z.uuid(),
    })
    .strict(),
  z
    .object({
      key: z.uuid(),
      version: z.number().int().positive(),
      action: z.literal("refund"),
      orderId: z.uuid(),
    })
    .strict(),
  z
    .object({
      key: z.uuid(),
      version: z.number().int().positive(),
      action: z.literal("supplier_payment"),
      obligationId: z.uuid(),
    })
    .strict(),
  z
    .object({
      key: z.uuid(),
      version: z.number().int().positive(),
      action: z.literal("income"),
      category: z.string().trim().min(2).max(80),
    })
    .strict(),
  z
    .object({
      key: z.uuid(),
      version: z.number().int().positive(),
      action: z.literal("expense"),
      category: z.string().trim().min(2).max(80),
      operating: z.boolean(),
    })
    .strict(),
  z
    .object({
      key: z.uuid(),
      version: z.number().int().positive(),
      action: z.literal("ignore"),
      note: decisionNote,
    })
    .strict(),
]);
export type LineDecision = z.infer<typeof lineDecision>;
