"use client";
import { useEffect, useState } from "react";
import type { Locale, Workspace } from "@/domain/contracts";
import { api } from "@/lib/client";
import { useRevision } from "@/lib/live";
import { errorText } from "@/lib/i18n";
import { executionError } from "@/lib/execution-i18n";
import { moneyText } from "@/lib/inventory-i18n";
import { ActionForm, Field } from "./purchasing-page";

const f = (d: FormData, n: string) => String(d.get(n) || "").trim();
type Account = {
  id: string;
  name: string;
  bank_account: string | null;
  balance_minor: string;
};
type Statement = {
  id: string;
  account_name: string;
  filename: string;
  period_start: string;
  period_end: string;
  opening_minor: string | null;
  incoming_minor: string;
  outgoing_minor: string;
  closing_minor: string | null;
  consistent: boolean;
  issues: string[];
  lines: number;
  duplicates: number;
  open_lines: number;
};
type Line = {
  id: string;
  direction: "in" | "out";
  doc_number: string;
  booked_date: string;
  amount_minor: string;
  counterparty: string;
  counterparty_bin: string;
  purpose: string;
  state: string;
  suggestions: {
    type: "entry" | "order" | "obligation";
    id: string;
    label: string;
  }[];
  version: number;
};
async function base64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
// T033: bank statements are evidence; each line is posted, matched or ignored by a person.
export function BankStatements({
  workspace,
  locale,
}: {
  workspace: Workspace;
  locale: Locale;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const base = `organizations/${workspace.organization.id}`;
  const [data, setData] = useState<{
      accounts: Account[];
      items: Statement[];
      canWrite: boolean;
    } | null>(null),
    [open, setOpen] = useState<{
      statement: Statement & { book_balance_minor: string };
      lines: Line[];
    } | null>(null),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [revision, setRevision] = useRevision();
  const refresh = () => setRevision((v) => v + 1);
  const msg = (code: string) =>
    executionError(code, locale) || errorText(code, locale);
  useEffect(() => {
    let live = true;
    api<typeof data>(`${base}/bank/statements`)
      .then((v) => live && (setData(v), setError("")))
      .catch((e) => live && setError(e.code || "INTERNAL_ERROR"));
    if (selected)
      api<typeof open>(`${base}/bank/statements/${selected}`)
        .then((v) => live && setOpen(v))
        .catch((e) => live && setError(e.code || "INTERNAL_ERROR"));
    return () => {
      live = false;
    };
  }, [base, revision, selected]);
  const issueText: Record<string, [string, string]> = {
    balance_mismatch: [
      "остатки и обороты не сходятся",
      "қалдықтар мен айналымдар сәйкес емес",
    ],
    incoming_mismatch: [
      "сумма поступлений не равна итогу",
      "түсімдер сомасы қорытындыға тең емес",
    ],
    outgoing_mismatch: [
      "сумма списаний не равна итогу",
      "шығыстар сомасы қорытындыға тең емес",
    ],
    balance_missing: [
      "нет начального или конечного остатка",
      "бастапқы не соңғы қалдық жоқ",
    ],
    no_balance_section: [
      "нет секции остатков по счёту",
      "шот бойынша қалдық бөлімі жоқ",
    ],
  };
  const decide = async (line: Line, body: Record<string, unknown>) => {
    try {
      await api(`${base}/bank/lines/${line.id}`, "POST", {
        key: crypto.randomUUID(),
        version: line.version,
        ...body,
      });
      refresh();
    } catch (e) {
      setError((e as { code?: string }).code || "INTERNAL_ERROR");
    }
  };
  return (
    <section className="panel" aria-labelledby="bank-statements">
      <h2 id="bank-statements">{t("Банковские выписки", "Банк үзінділері")}</h2>
      <p>
        {t(
          "Формат «1С:Предприятие: Клиент банка» (1CClientBankExchange). Выписка не меняет деньги сама: каждую строку нужно провести, сопоставить с уже внесённой операцией или пропустить. Повторные строки из пересекающихся выписок не дублируются. Онлайн-касса (ОФД) не подключена: проверенного официального контракта нет.",
          "«1С:Кәсіпорын: Банк клиенті» форматы (1CClientBankExchange). Үзінді ақшаны өзі өзгертпейді: әр жолды жүргізу, бұрын енгізілген операциямен сәйкестендіру немесе өткізіп жіберу керек. Қиылысатын үзінділердің қайталанатын жолдары көбеймейді. Онлайн-касса (ОФД) қосылмаған: тексерілген ресми келісімшарт жоқ.",
        )}
      </p>
      {error && (
        <p role="alert" className="commerce-alert">
          {msg(error)}
        </p>
      )}
      {!data ? (
        <p aria-busy="true">{t("Загрузка…", "Жүктелуде…")}</p>
      ) : (
        <>
          {data.canWrite && data.accounts.length > 0 && (
            <>
              <ActionForm
                locale={locale}
                label={t(
                  "Привязать банковский счёт",
                  "Банк шотын байланыстыру",
                )}
                submit={async (d) => {
                  await api(`${base}/bank/accounts`, "POST", {
                    accountId: f(d, "accountId"),
                    bankAccount: f(d, "bankAccount").toUpperCase(),
                  });
                  refresh();
                }}
              >
                <Field label={t("Счёт в учёте", "Есептегі шот")}>
                  <select name="accountId">
                    {data.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                        {a.bank_account ? ` · ${a.bank_account}` : ""}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={t("IBAN (как в выписке)", "IBAN (үзіндідегідей)")}
                >
                  <input
                    name="bankAccount"
                    required
                    pattern="[A-Za-z0-9]{10,34}"
                    maxLength={34}
                  />
                </Field>
              </ActionForm>
              <ActionForm
                locale={locale}
                label={t("Загрузить выписку", "Үзіндіні жүктеу")}
                submit={async (d, key) => {
                  const file = d.get("file") as File;
                  if (!file || !file.size) throw new Error("INVALID_INPUT");
                  const r = await api<{ id: string }>(
                    `${base}/bank/statements`,
                    "POST",
                    {
                      key,
                      accountId: f(d, "accountId"),
                      filename: file.name.slice(0, 120),
                      content: await base64(file),
                    },
                  );
                  setSelected(r.id);
                  refresh();
                }}
              >
                <Field label={t("Счёт", "Шот")}>
                  <select name="accountId">
                    {data.accounts
                      .filter((a) => a.bank_account)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} · {a.bank_account}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label={t("Файл выписки (.txt)", "Үзінді файлы (.txt)")}>
                  <input
                    name="file"
                    type="file"
                    accept=".txt,text/plain"
                    required
                  />
                </Field>
              </ActionForm>
            </>
          )}
          {data.items.length === 0 ? (
            <p>{t("Выписок нет.", "Үзінділер жоқ.")}</p>
          ) : (
            <ul className="today-list">
              {data.items.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setSelected(s.id)}
                  >
                    {s.account_name} · {s.period_start} – {s.period_end} ·{" "}
                    {s.filename}
                  </button>{" "}
                  {s.consistent
                    ? t("сходится", "сәйкес")
                    : `${t("не сходится", "сәйкес емес")}: ${s.issues
                        .map(
                          (i) => issueText[i]?.[locale === "ru" ? 0 : 1] || i,
                        )
                        .join(", ")}`}{" "}
                  · {t("строк", "жол")} {s.lines}
                  {s.duplicates > 0 &&
                    ` · ${t("повторов пропущено", "қайталау өткізілді")} ${s.duplicates}`}
                  {s.open_lines > 0 &&
                    ` · ${t("ждут решения", "шешім күтеді")} ${s.open_lines}`}
                </li>
              ))}
            </ul>
          )}
          {open && (
            <>
              <h3>
                {open.statement.account_name} · {open.statement.period_start} –{" "}
                {open.statement.period_end}
              </h3>
              <p>
                {t("Остаток банка на начало", "Банктің бастапқы қалдығы")}:{" "}
                {open.statement.opening_minor === null
                  ? "–"
                  : `${moneyText(open.statement.opening_minor)} ₸`}{" "}
                · {t("на конец", "соңында")}:{" "}
                {open.statement.closing_minor === null
                  ? "–"
                  : `${moneyText(open.statement.closing_minor)} ₸`}{" "}
                ·{" "}
                {t(
                  "остаток счёта в учёте сейчас",
                  "есептегі шот қалдығы қазір",
                )}
                : {moneyText(open.statement.book_balance_minor)} ₸
              </p>
              <ul className="today-list">
                {open.lines.map((l) => (
                  <li key={l.id} className="today-situation">
                    <strong>
                      {l.direction === "in" ? "+" : "−"}
                      {moneyText(l.amount_minor)} ₸ · №{l.doc_number} ·{" "}
                      {l.booked_date}
                    </strong>
                    <span>
                      {l.counterparty}
                      {l.counterparty_bin &&
                        ` · БИН ${l.counterparty_bin}`} · {l.purpose}
                    </span>
                    <span>
                      {
                        {
                          new: t("ждёт решения", "шешім күтеді"),
                          posted: t("проведено", "жүргізілді"),
                          matched: t(
                            "сопоставлено с операцией",
                            "операциямен сәйкестендірілді",
                          ),
                          ignored: t("пропущено", "өткізілді"),
                        }[l.state]
                      }
                    </span>
                    {data.canWrite && l.state === "new" && (
                      <div className="commerce-actions">
                        {l.suggestions.map((sg) => (
                          <button
                            key={sg.id}
                            type="button"
                            className="secondary-button"
                            onClick={() =>
                              decide(
                                l,
                                sg.type === "entry"
                                  ? { action: "match", entryId: sg.id }
                                  : sg.type === "order"
                                    ? { action: "payment", orderId: sg.id }
                                    : {
                                        action: "supplier_payment",
                                        obligationId: sg.id,
                                      },
                              )
                            }
                          >
                            {sg.type === "entry"
                              ? t("Это уже внесено: ", "Бұл енгізілген: ")
                              : sg.type === "order"
                                ? t("Оплата заказа ", "Тапсырыс төлемі ")
                                : t("Оплата долга ", "Қарызды төлеу ")}
                            {sg.label}
                          </button>
                        ))}
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() =>
                            decide(
                              l,
                              l.direction === "in"
                                ? {
                                    action: "income",
                                    category: t(
                                      "Прочие поступления",
                                      "Басқа түсімдер",
                                    ),
                                  }
                                : {
                                    action: "expense",
                                    category: t(
                                      "Прочие расходы",
                                      "Басқа шығыстар",
                                    ),
                                    operating: true,
                                  },
                            )
                          }
                        >
                          {l.direction === "in"
                            ? t(
                                "Провести как прочее поступление",
                                "Басқа түсім ретінде жүргізу",
                              )
                            : t(
                                "Провести как операционный расход",
                                "Операциялық шығыс ретінде жүргізу",
                              )}
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() =>
                            decide(l, {
                              action: "ignore",
                              note: t(
                                "Пропущено при сверке",
                                "Салыстыруда өткізілді",
                              ),
                            })
                          }
                        >
                          {t("Пропустить", "Өткізу")}
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
