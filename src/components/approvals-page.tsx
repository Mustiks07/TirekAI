"use client";
import { useEffect, useState } from "react";
import type { Locale, Workspace } from "@/domain/contracts";
import type { ProposalRow } from "@/domain/decisions";
import { api } from "@/lib/client";
import { useRevision } from "@/lib/live";
import { errorText, roleNames } from "@/lib/i18n";
import { moneyText } from "@/lib/inventory-i18n";
import { businessDate } from "@/lib/dates";
import { can } from "@/domain/permissions";
import { executionError, stateText } from "@/lib/execution-i18n";
import { ActionForm, Field } from "./purchasing-page";

const f = (d: FormData, n: string) => String(d.get(n) || "").trim();
type Detail = {
  proposal: ProposalRow;
  approvals: {
    id: string;
    param_version: number;
    decision: string;
    actor_name: string;
    delegated: boolean;
    note: string;
    created_at: string;
  }[];
  canApprove: boolean;
  canExecute: boolean;
  offers: {
    offerId: string;
    supplier: string;
    sku: string;
    name_ru: string;
    name_kk: string;
    packQuantity: string;
    packPrice: string;
    currency: string;
  }[];
};
type Purchase = {
  supplierId: string;
  warehouseId: string;
  date: string;
  dueDate: string;
  budget: string;
  note: string;
  lines: { offerId: string; quantity: string }[];
  followUp: { assigneeId: string; due: { date: string; time: string } } | null;
};
export function ApprovalsPage({
  workspace,
  locale,
}: {
  workspace: Workspace;
  locale: Locale;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const base = `organizations/${workspace.organization.id}`,
    tz = workspace.organization.timezone,
    role = workspace.organization.role;
  const [filter, setFilter] = useState("awaiting_me"),
    [list, setList] = useState<{ items: ProposalRow[] } | null>(null),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<Detail | null>(null),
    [assignees, setAssignees] = useState<{ id: string; name: string }[]>([]),
    [revision, setRevision] = useRevision(),
    [error, setError] = useState("");
  const refresh = () => setRevision((v) => v + 1);
  useEffect(() => {
    let live = true;
    api<{ items: ProposalRow[] }>(
      `${base}/proposals${filter ? `?state=${filter}` : ""}`,
    )
      .then((v) => live && (setList(v), setError("")))
      .catch((e) => live && setError(e.code || "INTERNAL_ERROR"));
    if (can(role, "tasks:write"))
      api<{ items: { id: string; name: string }[] }>(`${base}/tasks/assignees`)
        .then((v) => live && setAssignees(v.items))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [base, filter, revision, role]);
  useEffect(() => {
    let live = true;
    if (!selected) return;
    api<Detail>(`${base}/proposals/${selected}`)
      .then((v) => live && setDetail(v))
      .catch((e) => live && setError(e.code || "INTERNAL_ERROR"));
    return () => {
      live = false;
    };
  }, [base, selected, revision]);
  const d = detail?.proposal.id === selected ? detail : null;
  const cmd = (kind: string, extra: Record<string, unknown> = {}) =>
    api(`${base}/proposals/${d!.proposal.id}/commands`, "POST", {
      key: crypto.randomUUID(),
      version: d!.proposal.version,
      kind,
      ...extra,
    }).then(refresh);
  const purchase =
    d?.proposal.kind === "purchase_order"
      ? (d.proposal.params as unknown as Purchase)
      : null;
  return (
    <div className="commerce-page approvals-page">
      {error && (
        <p role="alert" className="commerce-alert">
          {executionError(error, locale) || errorText(error, locale)}
        </p>
      )}
      <section className="panel">
        <p>
          {t(
            "Согласование привязано к конкретной версии параметров. Любое изменение суммы или состава возвращает предложение на повторное согласование. Перед исполнением права проверяются снова.",
            "Келісу параметрлердің нақты нұсқасына байланған. Сома немесе құрам өзгерсе, ұсыныс қайта келісуге оралады. Орындау алдында құқықтар қайта тексеріледі.",
          )}
        </p>
        <Field label={t("Показать", "Көрсету")}>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="awaiting_me">
              {t("Ждут моего решения", "Менің шешімімді күтеді")}
            </option>
            <option value="draft">{t("Черновики", "Жобалар")}</option>
            <option value="pending">{t("На согласовании", "Келісуде")}</option>
            <option value="approved">
              {t("Согласованы, не выполнены", "Келісілген, орындалмаған")}
            </option>
            <option value="executed">{t("Выполнены", "Орындалды")}</option>
            <option value="failed">
              {t("Ошибки исполнения", "Орындау қателері")}
            </option>
            <option value="">{t("Все", "Барлығы")}</option>
          </select>
        </Field>
        {!list ? (
          <p aria-busy="true">{t("Загрузка…", "Жүктелуде…")}</p>
        ) : list.items.length === 0 ? (
          <p>{t("Предложений нет.", "Ұсыныс жоқ.")}</p>
        ) : (
          <div className="task-list">
            {list.items.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`commerce-order ${selected === p.id ? "active" : ""}`}
                onClick={() => setSelected(p.id)}
              >
                <strong>
                  {p.kind === "purchase_order"
                    ? t("Закупка", "Сатып алу")
                    : t("Задача", "Тапсырма")}
                  {p.amount_minor && ` · ${moneyText(p.amount_minor)} KZT`}
                </strong>
                <span>
                  {stateText(p.state, locale)} · v{p.param_version} ·{" "}
                  {p.created_by_name} ·{" "}
                  {businessDate(new Date(p.created_at), locale, tz, true)}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      {d && (
        <section className="panel">
          <h2>
            {d.proposal.kind === "purchase_order"
              ? t("Предложение закупки", "Сатып алу ұсынысы")
              : t("Предложение задачи", "Тапсырма ұсынысы")}{" "}
            · {stateText(d.proposal.state, locale)}
          </h2>
          <p>
            {t("Версия параметров", "Параметрлер нұсқасы")}{" "}
            {d.proposal.param_version} · {t("риск", "тәуекел")}{" "}
            {d.proposal.risk} · {t("источник", "дереккөз")} {d.proposal.origin}
            {` · ${t("действует до", "жарамды")} ${businessDate(new Date(d.proposal.expires_at), locale, tz, true)}`}
          </p>
          {d.proposal.amount_minor && (
            <p>
              <strong>{moneyText(d.proposal.amount_minor)} KZT</strong> ·{" "}
              {t(
                "по прайсам поставщика с целыми упаковками и одной доставкой",
                "жеткізуші прайстары бойынша, бүтін қаптамамен және бір жеткізумен",
              )}
            </p>
          )}
          {purchase && (
            <ul className="today-list">
              {purchase.lines.map((l) => {
                const o = d.offers.find((x) => x.offerId === l.offerId);
                return (
                  <li key={l.offerId}>
                    {o
                      ? `${o.sku} · ${locale === "kk" && o.name_kk ? o.name_kk : o.name_ru} · ${o.supplier} · ${t("упаковка", "қаптама")} ${o.packQuantity} × ${o.packPrice} ${o.currency}`
                      : `${t("Предложение", "Ұсыныс")} ${l.offerId.slice(0, 8)}`}{" "}
                    · {t("количество", "саны")} {l.quantity}
                  </li>
                );
              })}
              <li>
                {t("Бюджет", "Бюджет")} {purchase.budget} KZT ·{" "}
                {t("срок", "мерзім")} {purchase.dueDate}
              </li>
              <li>
                {purchase.followUp
                  ? t(
                      "После исполнения будет создана задача на отправку и приёмку.",
                      "Орындалғаннан кейін жіберу және қабылдау тапсырмасы құрылады.",
                    )
                  : t(
                      "Задача после исполнения не задана.",
                      "Орындалғаннан кейінгі тапсырма берілмеген.",
                    )}
              </li>
            </ul>
          )}
          {d.proposal.kind === "task" && (
            <p>
              {String((d.proposal.params as { title?: string }).title || "")}
            </p>
          )}
          {d.proposal.error_code && (
            <p className="commerce-alert">
              {t("Исполнение не выполнено", "Орындалмады")}:{" "}
              {executionError(d.proposal.error_code, locale) ||
                errorText(d.proposal.error_code, locale)}
            </p>
          )}
          {d.proposal.result_id && (
            <p className="commerce-success">
              {t("Результат", "Нәтиже")}: {d.proposal.result_type}{" "}
              {d.proposal.result_id.slice(0, 8)}
              {d.proposal.follow_up_task_id &&
                ` · ${t("задача", "тапсырма")} ${d.proposal.follow_up_task_id.slice(0, 8)}`}
            </p>
          )}
          {d.proposal.outcome && (
            <p>
              {t("Проверка эффекта", "Әсерді тексеру")}:{" "}
              {String(d.proposal.outcome.status)}
              {d.proposal.outcome.available_now !== undefined &&
                ` · ${t("доступно сейчас", "қазір қолжетімді")} ${String(d.proposal.outcome.available_now)}`}
            </p>
          )}
          <div className="commerce-actions">
            {d.proposal.state === "draft" && (
              <button
                type="button"
                className="primary-button"
                onClick={() => cmd("submit").catch((x) => setError(x.code))}
              >
                {t("Отправить на согласование", "Келісуге жіберу")}
              </button>
            )}
            {d.canExecute && (
              <button
                type="button"
                className="primary-button"
                onClick={() => cmd("execute").catch((x) => setError(x.code))}
              >
                {t("Выполнить согласованное", "Келісілгенді орындау")}
              </button>
            )}
          </div>
          {d.canApprove && (
            <ActionForm
              key={`decide-${d.proposal.version}`}
              locale={locale}
              label={t("Записать решение", "Шешімді жазу")}
              submit={async (fd) =>
                cmd(f(fd, "decision"), {
                  paramVersion: d.proposal.param_version,
                  note: f(fd, "note"),
                })
              }
            >
              <Field
                label={
                  t("Решение по версии", "Нұсқа бойынша шешім") +
                  ` ${d.proposal.param_version}`
                }
              >
                <select name="decision">
                  <option value="approve">{t("Согласовать", "Келісу")}</option>
                  <option value="reject">{t("Отклонить", "Қабылдамау")}</option>
                </select>
              </Field>
              <Field label={t("Основание", "Негізі")}>
                <input name="note" required minLength={3} maxLength={500} />
              </Field>
            </ActionForm>
          )}
          {purchase &&
            ["draft", "pending", "approved"].includes(d.proposal.state) &&
            can(role, "purchasing:write") && (
              <details>
                <summary>
                  {t(
                    "Изменить количество, бюджет или задачу после исполнения",
                    "Санын, бюджетті немесе тапсырманы өзгерту",
                  )}
                </summary>
                <ActionForm
                  key={`rev-${d.proposal.version}`}
                  locale={locale}
                  label={t(
                    "Сохранить новую версию параметров",
                    "Параметрлердің жаңа нұсқасын сақтау",
                  )}
                  submit={async (fd, key) => {
                    await api(
                      `${base}/proposals/${d.proposal.id}/revisions`,
                      "POST",
                      {
                        key,
                        version: d.proposal.version,
                        note: f(fd, "note"),
                        params: {
                          ...d.proposal.params,
                          budget: f(fd, "budget"),
                          lines: purchase.lines.map((l) => ({
                            ...l,
                            quantity: f(fd, `qty-${l.offerId}`),
                          })),
                          followUp: f(fd, "assigneeId")
                            ? {
                                assigneeId: f(fd, "assigneeId"),
                                due: { date: f(fd, "dueDate"), time: "18:00" },
                              }
                            : null,
                        },
                      },
                    );
                    refresh();
                  }}
                >
                  {purchase.lines.map((l) => (
                    <Field
                      key={l.offerId}
                      label={`${t("Количество", "Саны")} · ${l.offerId.slice(0, 8)}`}
                    >
                      <input
                        name={`qty-${l.offerId}`}
                        defaultValue={l.quantity}
                        inputMode="decimal"
                        required
                        pattern="[0-9]+([.][0-9]+)?"
                      />
                    </Field>
                  ))}
                  <Field label={t("Бюджет, KZT", "Бюджет, KZT")}>
                    <input
                      name="budget"
                      defaultValue={purchase.budget}
                      inputMode="decimal"
                      required
                      pattern="[0-9]+([.][0-9]{1,2})?"
                    />
                  </Field>
                  <Field
                    label={t(
                      "Закупщик для задачи после исполнения",
                      "Орындалғаннан кейінгі тапсырма үшін сатып алушы",
                    )}
                  >
                    <select
                      name="assigneeId"
                      defaultValue={purchase.followUp?.assigneeId || ""}
                    >
                      <option value="">{t("Без задачи", "Тапсырмасыз")}</option>
                      {assignees.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t("Срок задачи", "Тапсырма мерзімі")}>
                    <input
                      type="date"
                      name="dueDate"
                      defaultValue={
                        purchase.followUp?.due.date || purchase.dueDate
                      }
                    />
                  </Field>
                  <Field label={t("Причина изменения", "Өзгерту себебі")}>
                    <input name="note" required minLength={3} maxLength={500} />
                  </Field>
                </ActionForm>
              </details>
            )}
          {["draft", "pending", "approved", "failed"].includes(
            d.proposal.state,
          ) && (
            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                cmd("cancel", {
                  note: t("Отменено пользователем", "Пайдаланушы бас тартты"),
                }).catch((x) => setError(x.code))
              }
            >
              {t("Отменить предложение", "Ұсыныстан бас тарту")}
            </button>
          )}
          <h3>{t("История решений", "Шешімдер тарихы")}</h3>
          {d.approvals.length === 0 ? (
            <p>{t("Решений ещё нет.", "Шешім әлі жоқ.")}</p>
          ) : (
            <ul className="today-list">
              {d.approvals.map((a) => (
                <li key={a.id}>
                  v{a.param_version} · {stateText(a.decision, locale)} ·{" "}
                  {a.actor_name}
                  {a.delegated &&
                    ` · ${t("по делегированию", "өкілеттік бойынша")}`}{" "}
                  · {a.note}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <Policy
        base={base}
        locale={locale}
        owner={role === "owner"}
        approver={can(role, "purchasing:approve")}
        assignees={assignees}
      />
    </div>
  );
}
function Policy({
  base,
  locale,
  owner,
  approver,
  assignees,
}: {
  base: string;
  locale: Locale;
  owner: boolean;
  approver: boolean;
  assignees: { id: string; name: string }[];
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const [p, setP] = useState<{
      limits: { role: string; kind: string; limit_minor: string }[];
      delegations: {
        id: string;
        from_name: string;
        to_name: string;
        kind: string;
        max_amount_minor: string;
        valid_until: string;
        revoked_at: string | null;
      }[];
    } | null>(null),
    [revision, setRevision] = useRevision();
  useEffect(() => {
    api<typeof p>(`${base}/proposals/policy`)
      .then(setP)
      .catch(() => undefined);
  }, [base, revision]);
  if (!p) return null;
  return (
    <section className="panel">
      <h2>
        {t(
          "Лимиты и делегирование согласований",
          "Келісу лимиттері мен өкілеттік беру",
        )}
      </h2>
      <ul className="today-list">
        {p.limits.length === 0 && (
          <li>
            {t(
              "Лимиты не заданы: управляющий согласует без ограничения суммы.",
              "Лимит берілмеген: басқарушы сомаға шектеусіз келіседі.",
            )}
          </li>
        )}
        {p.limits.map((l) => (
          <li key={`${l.role}-${l.kind}`}>
            {roleNames[locale][l.role as keyof (typeof roleNames)["ru"]]} ·{" "}
            {l.kind} · {t("до", "дейін")} {moneyText(l.limit_minor)} KZT
          </li>
        ))}
        {p.delegations.map((d) => (
          <li key={d.id}>
            {d.from_name} → {d.to_name} · {d.kind} · {t("до", "дейін")}{" "}
            {moneyText(d.max_amount_minor)} KZT ·{" "}
            {d.revoked_at
              ? t("отозвано", "қайтарылды")
              : d.valid_until.slice(0, 16)}
            {!d.revoked_at && (
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  api(
                    `${base}/proposals/policy/delegations/${d.id}/revoke`,
                    "POST",
                    {},
                  ).then(() => setRevision((v) => v + 1))
                }
              >
                {t("Отозвать", "Қайтарып алу")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {owner && (
        <ActionForm
          locale={locale}
          label={t("Сохранить лимит", "Лимитті сақтау")}
          submit={async (fd) => {
            await api(`${base}/proposals/policy/limits`, "POST", {
              role: f(fd, "role"),
              kind: "purchase_order",
              limit: f(fd, "limit") || null,
            });
            setRevision((v) => v + 1);
          }}
        >
          <Field label={t("Роль", "Рөл")}>
            <select name="role">
              {(["manager", "purchasing", "finance", "sales"] as const).map(
                (r) => (
                  <option key={r} value={r}>
                    {roleNames[locale][r]}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field
            label={t(
              "Лимит закупки, KZT (пусто: без лимита)",
              "Сатып алу лимиті, KZT (бос: шектеусіз)",
            )}
          >
            <input
              name="limit"
              inputMode="decimal"
              pattern="[0-9]+([.][0-9]{1,2})?"
            />
          </Field>
        </ActionForm>
      )}
      {approver && (
        <ActionForm
          locale={locale}
          label={t("Делегировать согласование", "Келісуді тапсыру")}
          submit={async (fd, key) => {
            await api(`${base}/proposals/policy/delegations`, "POST", {
              key,
              toUser: f(fd, "toUser"),
              kind: "purchase_order",
              maxAmount: f(fd, "maxAmount"),
              validUntil: new Date(`${f(fd, "until")}T23:59:00`).toISOString(),
            });
            setRevision((v) => v + 1);
          }}
        >
          <Field label={t("Кому", "Кімге")}>
            <select name="toUser" required>
              {assignees.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("До суммы, KZT", "Сомаға дейін, KZT")}>
            <input
              name="maxAmount"
              inputMode="decimal"
              required
              pattern="[0-9]+([.][0-9]{1,2})?"
            />
          </Field>
          <Field label={t("Действует до", "Жарамды мерзімі")}>
            <input type="date" name="until" required />
          </Field>
        </ActionForm>
      )}
    </section>
  );
}
