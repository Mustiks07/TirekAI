import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { CommerceService } from "../src/server/commerce/service";
import { BankService } from "../src/server/bank/service";
import { decodeStatement, parseStatement } from "../src/domain/bank";

// Synthetic statements in the 1CClientBankExchange 1.03 layout (v8.1c.ru/edi/edi_stnd/100/101.htm),
// encoded as the format declares (Windows = cp1251). Accounts are KZ IBANs, "ИНН" carries a BIN.
const OWN = "KZ86125KZT5004100100",
  SUPPLIER = "KZ75125KZT2069100100",
  CLIENT = "KZ12601A871000123456";
function cp1251(text: string) {
  const table: Record<string, number> = {};
  const decoder = new TextDecoder("windows-1251");
  for (let b = 128; b < 256; b++)
    table[decoder.decode(new Uint8Array([b]))] = b;
  return Buffer.from(
    [...text].map((ch) =>
      ch.charCodeAt(0) < 128 ? ch.charCodeAt(0) : (table[ch] ?? 63),
    ),
  );
}
type Doc = {
  n: string;
  date: string;
  amount: string;
  out: boolean;
  other: string;
  name: string;
  purpose: string;
};
function statement(
  docs: Doc[],
  opening: string,
  closing: string,
  period = ["01.10.2026", "14.10.2026"],
  totals?: [string, string],
) {
  const sum = (o: boolean) =>
    docs
      .filter((d) => d.out === o)
      .reduce((a, d) => a + Math.round(Number(d.amount) * 100), 0) / 100;
  const [tin, tout] = totals || [sum(false).toFixed(2), sum(true).toFixed(2)];
  const lines = [
    "1CClientBankExchange",
    "ВерсияФормата=1.03",
    "Кодировка=Windows",
    "Отправитель=Банк-клиент",
    "Получатель=Бухгалтерия",
    `ДатаНачала=${period[0]}`,
    `ДатаКонца=${period[1]}`,
    `РасчСчет=${OWN}`,
    "СекцияРасчСчет",
    `ДатаНачала=${period[0]}`,
    `ДатаКонца=${period[1]}`,
    `РасчСчет=${OWN}`,
    `НачальныйОстаток=${opening}`,
    `ВсегоПоступило=${tin}`,
    `ВсегоСписано=${tout}`,
    `КонечныйОстаток=${closing}`,
    "КонецРасчСчет",
  ];
  for (const d of docs)
    lines.push(
      "СекцияДокумент=Платежное поручение",
      `Номер=${d.n}`,
      `Дата=${d.date}`,
      `Сумма=${d.amount}`,
      `ПлательщикСчет=${d.out ? OWN : d.other}`,
      `Плательщик1=${d.out ? "ТОО Тараз Лаб" : d.name}`,
      `ПлательщикИНН=${d.out ? "123456789012" : "987654321098"}`,
      `ПолучательСчет=${d.out ? d.other : OWN}`,
      `Получатель1=${d.out ? d.name : "ТОО Тараз Лаб"}`,
      `ПолучательИНН=${d.out ? "987654321098" : "123456789012"}`,
      ...(d.out ? [`ДатаСписано=${d.date}`] : [`ДатаПоступило=${d.date}`]),
      `НазначениеПлатежа=${d.purpose}`,
      "КонецДокумента",
    );
  lines.push("КонецФайла");
  return cp1251(lines.join("\r\n")).toString("base64");
}
let db: Database,
  p: Platform,
  org: string,
  branch: string,
  owner: string,
  seller: string,
  account: string,
  obligation: string,
  bank: BankService;
const key = () => randomUUID();
const docs: Doc[] = [
  {
    n: "101",
    date: "02.10.2026",
    amount: "15000.00",
    out: false,
    other: CLIENT,
    name: "ИП Клиент",
    purpose: "Оплата по счёту 15",
  },
  {
    n: "7",
    date: "03.10.2026",
    amount: "4200.50",
    out: true,
    other: SUPPLIER,
    name: "ТОО Поставщик",
    purpose: "Оплата за товар",
  },
  {
    n: "8",
    date: "05.10.2026",
    amount: "1200.00",
    out: true,
    other: SUPPLIER,
    name: "ТОО Аренда",
    purpose: "Аренда октябрь",
  },
];
beforeAll(async () => {
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  bank = new BankService(db);
  const user = () =>
    p.register({
      name: "Bank",
      email: `${key()}@example.test`,
      password: "Synthetic-Bank-661!",
    });
  owner = (await user()).token;
  org = (
    await p.createOrganization(owner, { name: "Bank Lab", profile: "retail" })
  ).id;
  branch = (await p.workspace(owner, org)).branches[0].id;
  const u = await user(),
    inv = await p.invite(owner, org, {
      email: u.user.email,
      role: "sales",
      branchId: branch,
    });
  await p.acceptInvitation(u.token, { token: inv.token });
  seller = u.token;
  const commerce = new CommerceService(db);
  account = (
    await commerce.createAccount(owner, org, {
      key: key(),
      branchId: branch,
      name: "Kaspi Business",
      opening: "50000",
    })
  ).id;
  obligation = (
    await commerce.createObligation(owner, org, {
      key: key(),
      branchId: branch,
      supplier: "ТОО Поставщик",
      amount: "4200.50",
      dueDate: "2026-10-10",
      note: "Счёт поставщика 7",
    })
  ).id;
});
afterAll(async () => {
  await db?.close();
});
it("T033: parses the cp1251 exchange file, keeps tiyn exact and checks the statement arithmetic", () => {
  const parsed = parseStatement(
    decodeStatement(
      Buffer.from(statement(docs, "50000.00", "59599.50"), "base64"),
    ),
  );
  expect(parsed).toMatchObject({
    version: "1.03",
    encoding: "Windows",
    start: "2026-10-01",
    end: "2026-10-14",
  });
  expect(parsed.documents.map((d) => d.amount)).toEqual([
    1500000n,
    420050n,
    120000n,
  ]);
  expect(parsed.documents[0].purpose).toBe("Оплата по счёту 15");
  expect(() =>
    parseStatement("1CClientBankExchange\r\nВерсияФормата=1.03"),
  ).toThrow("STATEMENT_TRUNCATED");
});
it("T033: the account must be linked, statements of other accounts and duplicates are refused, rights are checked", async () => {
  const content = statement(docs, "50000.00", "59599.50");
  await expect(
    bank.upload(owner, org, {
      key: key(),
      accountId: account,
      filename: "oct.txt",
      content,
    }),
  ).rejects.toMatchObject({
    code: "BANK_ACCOUNT_NOT_SET",
  });
  await expect(
    bank.setBankAccount(seller, org, { accountId: account, bankAccount: OWN }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await bank.setBankAccount(owner, org, {
    accountId: account,
    bankAccount: "KZ00000KZT0000000000",
  });
  await expect(
    bank.upload(owner, org, {
      key: key(),
      accountId: account,
      filename: "oct.txt",
      content,
    }),
  ).rejects.toMatchObject({
    code: "STATEMENT_ACCOUNT_MISMATCH",
  });
  await bank.setBankAccount(owner, org, {
    accountId: account,
    bankAccount: OWN,
  });
  const k = key();
  const up = await bank.upload(owner, org, {
    key: k,
    accountId: account,
    filename: "oct.txt",
    content,
  });
  expect(
    (
      await bank.upload(owner, org, {
        key: k,
        accountId: account,
        filename: "oct.txt",
        content,
      })
    ).reused,
  ).toBe(true);
  await expect(
    bank.upload(owner, org, {
      key: key(),
      accountId: account,
      filename: "oct.txt",
      content,
    }),
  ).rejects.toMatchObject({
    code: "STATEMENT_DUPLICATE",
  });
  const view = await bank.statement(owner, org, up.id);
  expect(view.statement).toMatchObject({
    consistent: true,
    lines: 3,
    incoming_minor: "1500000",
    outgoing_minor: "540050",
  });
  // The supplier debt with exactly this remaining amount is suggested, not paid.
  const out7 = (
    view.lines as {
      doc_number: string;
      suggestions: { type: string; id: string }[];
    }[]
  ).find((l) => l.doc_number === "7")!;
  expect(out7.suggestions).toEqual([
    expect.objectContaining({ type: "obligation", id: obligation }),
  ]);
  const [money] = await db.query<{ balance_minor: string }>(
    "SELECT balance_minor::text FROM money_accounts WHERE id=$1",
    [account],
  );
  expect(money.balance_minor).toBe("5000000");
});
it("T033: posting goes through the money command once; matching links an existing entry; direction and versions are enforced", async () => {
  const [st] = await db.query<{ id: string }>(
    "SELECT id FROM bank_statements WHERE account_id=$1",
    [account],
  );
  const lines = (await bank.statement(owner, org, st.id)).lines as {
    id: string;
    doc_number: string;
    version: number;
  }[];
  const line = (n: string) => lines.find((l) => l.doc_number === n)!;
  await expect(
    bank.decide(owner, org, line("101").id, {
      key: key(),
      version: 1,
      action: "expense",
      category: "Прочее",
      operating: true,
    }),
  ).rejects.toMatchObject({ code: "LINE_DIRECTION" });
  await expect(
    bank.decide(seller, org, line("101").id, {
      key: key(),
      version: 1,
      action: "income",
      category: "Прочие поступления",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  const k = key();
  await bank.decide(owner, org, line("101").id, {
    key: k,
    version: 1,
    action: "income",
    category: "Прочие поступления",
  });
  expect(
    (
      await bank.decide(owner, org, line("101").id, {
        key: k,
        version: 1,
        action: "income",
        category: "Прочие поступления",
      })
    ).reused,
  ).toBe(true);
  await bank.decide(owner, org, line("7").id, {
    key: key(),
    version: 1,
    action: "supplier_payment",
    obligationId: obligation,
  });
  await expect(
    bank.decide(owner, org, line("7").id, {
      key: key(),
      version: 2,
      action: "ignore",
      note: "Повтор",
    }),
  ).rejects.toMatchObject({ code: "LINE_DECIDED" });
  // Rent was already entered by hand: the line is matched to that entry, not posted twice.
  const manual = await new CommerceService(db).money(owner, org, {
    key: key(),
    accountId: account,
    kind: "expense",
    amount: "1200",
    category: "Аренда",
    counterparty: "ТОО Аренда",
    operating: true,
    note: "Аренда октябрь вручную",
  });
  const [entry] = await db.query<{ id: string }>(
    "SELECT id FROM money_entries WHERE id=$1",
    [manual.id],
  );
  await bank.decide(owner, org, line("8").id, {
    key: key(),
    version: 1,
    action: "match",
    entryId: entry.id,
  });
  const [money] = await db.query<{ balance_minor: string }>(
    "SELECT balance_minor::text FROM money_accounts WHERE id=$1",
    [account],
  );
  // 50 000 + 15 000 − 4 200.50 − 1 200 = 59 599.50, equal to the bank closing balance.
  expect(money.balance_minor).toBe("5959950");
  const [ob] = await db.query<{ paid_minor: string }>(
    "SELECT paid_minor::text FROM supplier_obligations WHERE id=$1",
    [obligation],
  );
  expect(ob.paid_minor).toBe("420050");
  const states = await db.query<{ state: string; n: number }>(
    "SELECT state,count(*)::int n FROM bank_statement_lines WHERE statement_id=$1 GROUP BY state ORDER BY state",
    [st.id],
  );
  expect(states).toEqual([
    { state: "matched", n: 1 },
    { state: "posted", n: 2 },
  ]);
});
it("T033: an overlapping statement does not duplicate lines; an inconsistent one cannot be posted", async () => {
  const next = statement(
    [
      ...docs,
      {
        n: "9",
        date: "15.10.2026",
        amount: "300.00",
        out: true,
        other: SUPPLIER,
        name: "ТОО Связь",
        purpose: "Связь",
      },
    ],
    "50000.00",
    "59299.50",
    ["01.10.2026", "15.10.2026"],
  );
  const up = await bank.upload(owner, org, {
    key: key(),
    accountId: account,
    filename: "oct-2.txt",
    content: next,
  });
  const view = await bank.statement(owner, org, up.id);
  expect(view.statement).toMatchObject({
    lines: 1,
    duplicates: 3,
    consistent: true,
  });
  const broken = statement(
    [
      {
        n: "10",
        date: "16.10.2026",
        amount: "100.00",
        out: true,
        other: SUPPLIER,
        name: "ТОО Связь",
        purpose: "Связь",
      },
    ],
    "59299.50",
    "59299.50",
    ["16.10.2026", "16.10.2026"],
  );
  const bad = await bank.upload(owner, org, {
    key: key(),
    accountId: account,
    filename: "bad.txt",
    content: broken,
  });
  const b = await bank.statement(owner, org, bad.id);
  expect(b.statement).toMatchObject({
    consistent: false,
    issues: ["balance_mismatch"],
  });
  const [l] = b.lines as { id: string }[];
  await expect(
    bank.decide(owner, org, l.id, {
      key: key(),
      version: 1,
      action: "expense",
      category: "Связь",
      operating: true,
    }),
  ).rejects.toMatchObject({ code: "STATEMENT_INCONSISTENT" });
  await bank.decide(owner, org, l.id, {
    key: key(),
    version: 1,
    action: "ignore",
    note: "Ждём исправленную выписку",
  });
});
