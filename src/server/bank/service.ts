import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Sql } from "../db/database";
import { sessionAccess, audit, type Credential } from "../access";
import { AppError } from "../../domain/errors";
import { idSchema } from "../../domain/contracts";
import { D } from "../../domain/purchasing";
import {
  StatementError,
  bankAccountInput,
  checkStatement,
  decodeStatement,
  lineDecision,
  linesFor,
  parseStatement,
  statementUpload,
} from "../../domain/bank";
import { CommerceService } from "../commerce/service";
import { idempotent } from "../execution/core";
import { stableUuid } from "../tasks/service";

const lineColumns =
  "l.id,l.statement_id,l.account_id,l.direction,l.doc_kind,l.doc_number,l.doc_date::text,l.booked_date::text,l.amount_minor::text,l.counterparty,l.counterparty_bin,l.counterparty_account,l.purpose,l.state,l.money_entry_id,l.suggestions,l.decision,l.version";
const kzt = (minor: bigint | string) =>
  new D(minor.toString()).div(100).toFixed(2);
// T033: statements are evidence; money changes only through the money command a person chooses.
export class BankService {
  constructor(private db: Database) {}
  private async account(
    tx: Sql,
    org: string,
    id: string,
    branch: string | null,
    lock = false,
  ) {
    idSchema.parse(id);
    const [a] = await tx.query<{
      id: string;
      branch_id: string;
      name: string;
      bank_account: string | null;
      balance_minor: string;
    }>(
      `SELECT id,branch_id,name,bank_account,balance_minor::text FROM money_accounts WHERE organization_id=$1 AND id=$2 AND ($3::uuid IS NULL OR branch_id=$3) ${lock ? "FOR UPDATE" : ""}`,
      [org, id, branch],
    );
    if (!a) throw new AppError("NOT_FOUND", 404);
    return a;
  }
  async setBankAccount(secret: Credential, org: string, input: unknown) {
    const c = bankAccountInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "finance:write");
      const a = await this.account(tx, org, c.accountId, s.branchId, true);
      try {
        await tx.query(
          "UPDATE money_accounts SET bank_account=$3 WHERE organization_id=$1 AND id=$2",
          [org, a.id, c.bankAccount],
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23505")
          throw new AppError("BANK_ACCOUNT_TAKEN", 409);
        throw error;
      }
      await audit(tx, org, s.actorId, "bank.account_set", a.branch_id, {
        accountId: a.id,
      });
      return { ok: true };
    });
  }
  async upload(secret: Credential, org: string, input: unknown) {
    const c = statementUpload.parse(input);
    const bytes = Buffer.from(c.content, "base64");
    if (!bytes.length || bytes.length > 2 * 1024 * 1024)
      throw new AppError("TOO_LARGE", 413);
    let parsed;
    try {
      parsed = parseStatement(decodeStatement(bytes));
    } catch (error) {
      if (error instanceof StatementError)
        throw new AppError(error.code.split(":")[0], 422);
      throw error;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "finance:write");
      const a = await this.account(tx, org, c.accountId, s.branchId, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "bank.upload",
        accountId: c.accountId,
        sha256,
      });
      if (r.reused) return { id: r.id, reused: true };
      if (!a.bank_account) throw new AppError("BANK_ACCOUNT_NOT_SET", 409);
      // The file must describe this account; a statement of another account is refused.
      if (
        !parsed.accounts.includes(a.bank_account) &&
        !parsed.sections.some((x) => x.account === a.bank_account)
      )
        throw new AppError("STATEMENT_ACCOUNT_MISMATCH", 422);
      const [same] = await tx.query(
        "SELECT id FROM bank_statements WHERE organization_id=$1 AND account_id=$2 AND sha256=$3",
        [org, a.id, sha256],
      );
      if (same) throw new AppError("STATEMENT_DUPLICATE", 409);
      const lines = linesFor(parsed, a.bank_account),
        check = checkStatement(parsed, a.bank_account, lines);
      await tx.query(
        "INSERT INTO bank_statements(id,organization_id,account_id,filename,sha256,format_version,period_start,period_end,opening_minor,incoming_minor,outgoing_minor,closing_minor,consistent,issues,lines,duplicates,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0,0,$15)",
        [
          r.id,
          org,
          a.id,
          c.filename,
          sha256,
          parsed.version,
          parsed.start,
          parsed.end,
          check.opening?.toString() ?? null,
          check.incoming.toString(),
          check.outgoing.toString(),
          check.closing?.toString() ?? null,
          check.issues.length === 0,
          JSON.stringify(check.issues),
          s.actorId,
        ],
      );
      let added = 0,
        duplicates = 0;
      for (const l of lines) {
        const id = randomUUID();
        const inserted = await tx.query(
          "INSERT INTO bank_statement_lines(id,organization_id,statement_id,account_id,dedupe_key,direction,doc_kind,doc_number,doc_date,booked_date,amount_minor,counterparty,counterparty_bin,counterparty_account,purpose,state,suggestions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'new',$16) ON CONFLICT(organization_id,account_id,dedupe_key) DO NOTHING RETURNING id",
          [
            id,
            org,
            r.id,
            a.id,
            l.key,
            l.direction,
            l.doc.kind.slice(0, 80),
            l.doc.number.slice(0, 40),
            l.doc.date,
            l.booked,
            l.doc.amount.toString(),
            l.counterparty.slice(0, 200),
            l.counterpartyBin.slice(0, 20),
            l.counterpartyAccount.slice(0, 34),
            l.doc.purpose.slice(0, 500),
            JSON.stringify(
              await this.suggest(
                tx,
                org,
                a,
                l.direction,
                l.doc.amount,
                l.booked,
              ),
            ),
          ],
        );
        if (inserted.length) added++;
        else duplicates++;
      }
      await tx.query(
        "UPDATE bank_statements SET lines=$3,duplicates=$4 WHERE organization_id=$1 AND id=$2",
        [org, r.id, added, duplicates],
      );
      await audit(tx, org, s.actorId, "bank.statement_uploaded", a.branch_id, {
        statementId: r.id,
        consistent: String(check.issues.length === 0),
      });
      return { id: r.id, reused: false };
    });
  }
  // Candidates only: existing unlinked entries with the same signed amount within ±3 days, open
  // orders or supplier debts with exactly this remaining amount. Nothing is posted here.
  private async suggest(
    tx: Sql,
    org: string,
    a: { id: string; branch_id: string },
    direction: "in" | "out",
    amount: bigint,
    booked: string,
  ) {
    const signed = direction === "in" ? amount : -amount;
    const entries = await tx.query<{ id: string; kind: string; note: string }>(
      "SELECT e.id,e.kind,e.note FROM money_entries e WHERE e.organization_id=$1 AND e.account_id=$2 AND e.amount_minor=$3 AND e.created_at BETWEEN $4::date-interval '3 days' AND $4::date+interval '4 days' AND NOT EXISTS(SELECT 1 FROM bank_statement_lines l WHERE l.organization_id=e.organization_id AND l.money_entry_id=e.id) ORDER BY e.created_at LIMIT 3",
      [org, a.id, signed.toString(), booked],
    );
    const targets =
      direction === "in"
        ? await tx.query<{ id: string; label: string }>(
            "SELECT o.id,'№'||o.number||' · '||c.name label FROM sales_orders o JOIN customers c ON c.organization_id=o.organization_id AND c.id=o.customer_id WHERE o.organization_id=$1 AND o.branch_id=$2 AND o.state NOT IN ('draft','cancelled') AND o.total_minor-o.paid_minor=$3 ORDER BY o.due_date LIMIT 3",
            [org, a.branch_id, amount.toString()],
          )
        : await tx.query<{ id: string; label: string }>(
            "SELECT id,supplier label FROM supplier_obligations WHERE organization_id=$1 AND branch_id=$2 AND amount_minor-paid_minor=$3 ORDER BY due_date LIMIT 3",
            [org, a.branch_id, amount.toString()],
          );
    return [
      ...entries.map((e) => ({
        type: "entry",
        id: e.id,
        label: `${e.kind}: ${e.note}`.slice(0, 120),
      })),
      ...targets.map((t) => ({
        type: direction === "in" ? "order" : "obligation",
        id: t.id,
        label: t.label.slice(0, 120),
      })),
    ];
  }
  async statements(secret: Credential, org: string, input: unknown) {
    const q = z
      .object({ accountId: z.uuid().optional() })
      .strict()
      .parse(input ?? {});
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "finance:read");
      const accounts = await tx.query(
        "SELECT id,name,branch_id,bank_account,balance_minor::text FROM money_accounts WHERE organization_id=$1 AND ($2::uuid IS NULL OR branch_id=$2) ORDER BY name",
        [org, s.branchId],
      );
      return {
        accounts,
        items: await tx.query(
          "SELECT b.id,b.account_id,a.name account_name,b.filename,b.format_version,b.period_start::text,b.period_end::text,b.opening_minor::text,b.incoming_minor::text,b.outgoing_minor::text,b.closing_minor::text,b.consistent,b.issues,b.lines,b.duplicates,b.created_at,(SELECT count(*)::int FROM bank_statement_lines l WHERE l.organization_id=b.organization_id AND l.statement_id=b.id AND l.state='new') open_lines FROM bank_statements b JOIN money_accounts a ON a.organization_id=b.organization_id AND a.id=b.account_id WHERE b.organization_id=$1 AND ($2::uuid IS NULL OR a.branch_id=$2) AND ($3::uuid IS NULL OR b.account_id=$3) ORDER BY b.created_at DESC LIMIT 50",
          [org, s.branchId, q.accountId ?? null],
        ),
        canWrite: ["owner", "manager", "finance"].includes(s.role),
      };
    });
  }
  async statement(secret: Credential, org: string, id: string) {
    idSchema.parse(id);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "finance:read");
      const [b] = await tx.query<{
        account_id: string;
        closing_minor: string | null;
        consistent: boolean;
      }>(
        "SELECT b.id,b.account_id,a.name account_name,a.balance_minor::text book_balance_minor,b.filename,b.period_start::text,b.period_end::text,b.opening_minor::text,b.incoming_minor::text,b.outgoing_minor::text,b.closing_minor::text,b.consistent,b.issues,b.lines,b.duplicates FROM bank_statements b JOIN money_accounts a ON a.organization_id=b.organization_id AND a.id=b.account_id WHERE b.organization_id=$1 AND b.id=$2 AND ($3::uuid IS NULL OR a.branch_id=$3)",
        [org, id, s.branchId],
      );
      if (!b) throw new AppError("NOT_FOUND", 404);
      return {
        statement: b,
        lines: await tx.query(
          `SELECT ${lineColumns} FROM bank_statement_lines l WHERE l.organization_id=$1 AND l.statement_id=$2 ORDER BY l.booked_date,l.doc_number,l.id`,
          [org, id],
        ),
      };
    });
  }
  async decide(
    secret: Credential,
    org: string,
    lineId: string,
    input: unknown,
  ) {
    idSchema.parse(lineId);
    const c = lineDecision.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "finance:write");
      const [l] = await tx.query<{
        id: string;
        account_id: string;
        statement_id: string;
        direction: "in" | "out";
        doc_number: string;
        booked_date: string;
        amount_minor: string;
        counterparty: string;
        purpose: string;
        state: string;
        version: number;
        consistent: boolean;
      }>(
        "SELECT l.id,l.account_id,l.statement_id,l.direction,l.doc_number,l.booked_date::text,l.amount_minor::text,l.counterparty,l.purpose,l.state,l.version,b.consistent FROM bank_statement_lines l JOIN bank_statements b ON b.organization_id=l.organization_id AND b.id=l.statement_id WHERE l.organization_id=$1 AND l.id=$2 FOR UPDATE OF l",
        [org, lineId],
      );
      if (!l) throw new AppError("NOT_FOUND", 404);
      const a = await this.account(tx, org, l.account_id, s.branchId, true);
      const r = await idempotent(tx, org, c.key, {
        operation: "bank.decide",
        lineId,
        ...c,
      });
      if (r.reused) return r;
      if (l.version !== c.version) throw new AppError("VERSION_CONFLICT", 409);
      if (l.state !== "new") throw new AppError("LINE_DECIDED", 409);
      const allowed: Record<string, "in" | "out"> = {
        payment: "in",
        income: "in",
        refund: "out",
        supplier_payment: "out",
        expense: "out",
      };
      if (allowed[c.action] && allowed[c.action] !== l.direction)
        throw new AppError("LINE_DIRECTION", 422);
      let entryId: string | null = null,
        state = "posted";
      if (c.action === "ignore") state = "ignored";
      else if (c.action === "match") {
        const [e] = await tx.query<{ id: string }>(
          "SELECT e.id FROM money_entries e WHERE e.organization_id=$1 AND e.id=$2 AND e.account_id=$3 AND e.amount_minor=$4 FOR SHARE",
          [
            org,
            c.entryId,
            a.id,
            (l.direction === "in" ? 1n : -1n) * BigInt(l.amount_minor),
          ],
        );
        if (!e) throw new AppError("MATCH_MISMATCH", 422);
        entryId = e.id;
        state = "matched";
      } else {
        // A statement whose arithmetic does not add up is not posted to the books.
        if (!l.consistent) throw new AppError("STATEMENT_INCONSISTENT", 409);
        const note =
          `Выписка №${l.doc_number} ${l.booked_date}: ${l.purpose || l.counterparty}`
            .slice(0, 250)
            .padEnd(3, ".");
        const base = {
          key: stableUuid(`bank-line:${l.id}`),
          accountId: a.id,
          amount: kzt(l.amount_minor),
          note,
        };
        const counterparty = (l.counterparty || "Банк")
          .slice(0, 120)
          .padEnd(2, ".");
        const moneyInput =
          c.action === "payment" || c.action === "refund"
            ? { ...base, kind: c.action, orderId: c.orderId }
            : c.action === "supplier_payment"
              ? {
                  ...base,
                  kind: "supplier_payment",
                  obligationId: c.obligationId,
                }
              : c.action === "income"
                ? {
                    ...base,
                    kind: "income",
                    category: c.category,
                    counterparty,
                  }
                : {
                    ...base,
                    kind: "expense",
                    category: c.category,
                    counterparty,
                    operating: c.operating,
                  };
        const done = await new CommerceService(this.db).moneyInTransaction(
          tx,
          secret,
          org,
          moneyInput,
        );
        const [e] = await tx.query<{ id: string }>(
          "SELECT id FROM money_entries WHERE organization_id=$1 AND id=$2 AND account_id=$3",
          [org, done.id, a.id],
        );
        entryId = e.id;
      }
      try {
        await tx.query(
          "UPDATE bank_statement_lines SET state=$3,money_entry_id=$4,decision=$5,decided_by=$6,decided_at=now(),version=version+1 WHERE organization_id=$1 AND id=$2",
          [org, l.id, state, entryId, JSON.stringify(c), s.actorId],
        );
      } catch (error) {
        // One money entry can explain only one bank line.
        if ((error as { code?: string }).code === "23505")
          throw new AppError("ENTRY_ALREADY_MATCHED", 409);
        throw error;
      }
      await audit(tx, org, s.actorId, `bank.line_${state}`, a.branch_id, {
        lineId: l.id,
        ...(entryId ? { entryId } : {}),
      });
      return r;
    });
  }
}
