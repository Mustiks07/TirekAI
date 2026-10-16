"use client";
import { useEffect, useState } from "react";
import type { Locale, Workspace } from "@/domain/contracts";
import type { TodayView, InsightRow } from "@/domain/decisions";
import { api } from "@/lib/client";
import { useRevision } from "@/lib/live";
import { errorText } from "@/lib/i18n";
import { moneyText, quantityText } from "@/lib/inventory-i18n";
import { businessDate } from "@/lib/dates";
import { can } from "@/domain/permissions";
import {
  executionError,
  factLabels,
  rules,
  severityText,
  stateText,
} from "@/lib/execution-i18n";

export type Destination =
  | "tasks"
  | "approvals"
  | "purchasing"
  | "orders"
  | "finance"
  | "inventory"
  | "integrations"
  | "assistant";
// Provider names are proper names and are the same in RU and KK.
const sourceNames: Record<string, string> = {
  bitrix24: "Битрикс24",
  onec: "1С",
  telegram: "Telegram",
  kaspi: "Kaspi",
};
// Situation drill-down goes to the section that holds the source operation.
const sourceTarget: Record<string, Destination> = {
  purchase_order: "purchasing",
  purchase_document: "purchasing",
  supplier_offer: "purchasing",
  sales_order: "orders",
  obligation: "finance",
  stock_balance: "inventory",
  external_stock: "integrations",
  task: "tasks",
};
export function TodayBoard({
  workspace,
  locale,
  onNavigate,
}: {
  workspace: Workspace;
  locale: Locale;
  onNavigate: (d: Destination) => void;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const base = `organizations/${workspace.organization.id}`,
    role = workspace.organization.role;
  const [view, setView] = useState<TodayView | null>(null),
    [error, setError] = useState(""),
    [revision, setRevision] = useRevision(),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState("");
  const message = (code: string) =>
    executionError(code, locale) || errorText(code, locale);
  useEffect(() => {
    let live = true;
    api<TodayView>(`${base}/today`)
      .then((v) => {
        if (live) {
          setView(v);
          setError("");
        }
      })
      .catch((e) => live && setError(e.code || "INTERNAL_ERROR"));
    return () => {
      live = false;
    };
  }, [base, revision, role]);
  async function act(id: string, run: () => Promise<unknown>, done: string) {
    setBusy(id);
    setNotice("");
    setError("");
    try {
      await run();
      setNotice(done);
      setRevision((v) => v + 1);
    } catch (e) {
      setError((e as { code?: string }).code || "INTERNAL_ERROR");
    } finally {
      setBusy("");
    }
  }
  const situation = (i: InsightRow) => (
    <article
      key={i.id}
      className="today-situation"
      aria-labelledby={`s-${i.id}`}
    >
      <div className="today-situation-head">
        <span className={`severity severity-${i.severity}`}>
          {severityText(i.severity, locale)}
        </span>
        <strong id={`s-${i.id}`}>
          {rules[i.rule]?.[locale === "ru" ? 0 : 1]}: {i.evidence.title}
        </strong>
        <small>{stateText(i.state, locale)}</small>
      </div>
      <details className="situation-details">
        <summary>{t("Расчёт и действия", "Есеп пен әрекеттер")}</summary>
        <dl className="today-facts">
          {Object.entries(i.evidence.facts)
            .filter(([k, v]) => factLabels[k] && v !== null && v !== "")
            .map(([k, v]) => (
              <div key={k}>
                <dt>{factLabels[k][locale === "ru" ? 0 : 1]}</dt>
                <dd>
                  {k === "stock_source"
                    ? v === "moysklad"
                      ? "МойСклад"
                      : t("собственный журнал", "өз журналы")
                    : k === "stock_stale"
                      ? v === "yes"
                        ? t("да", "иә")
                        : t("нет", "жоқ")
                      : k.endsWith("_minor")
                        ? `${moneyText(String(v))} KZT`
                        : typeof v === "string" && /^\d+(\.\d+)?$/.test(v)
                          ? quantityText(v)
                          : String(v)}
                </dd>
              </div>
            ))}
        </dl>
        <p>
          {t("Расчёт", "Есеп")}: <code>{i.evidence.calculation}</code> ·{" "}
          {t("данные на", "деректер уақыты")}{" "}
          {businessDate(
            new Date(i.evidence.as_of),
            locale,
            workspace.organization.timezone,
            true,
          )}
        </p>
        <div className="commerce-actions">
          {i.evidence.sources.map((s, n) => (
            <button
              key={`${s.type}-${s.id}-${n}`}
              type="button"
              className="secondary-button"
              onClick={() =>
                sourceTarget[s.type] && onNavigate(sourceTarget[s.type])
              }
              disabled={!sourceTarget[s.type]}
            >
              {t("Источник", "Дереккөз")}: {s.label}
            </button>
          ))}
        </div>
        <div className="commerce-actions">
          {i.rule === "low_stock" && can(role, "purchasing:write") && (
            <button
              type="button"
              className="primary-button"
              disabled={busy === i.id}
              onClick={() =>
                act(
                  i.id,
                  () =>
                    api(`${base}/insights/${i.id}/proposal`, "POST", {
                      key: crypto.randomUUID(),
                    }),
                  t(
                    "Черновик закупки создан. Проверьте и отправьте на согласование.",
                    "Сатып алу жобасы құрылды. Тексеріп, келісуге жіберіңіз.",
                  ),
                )
              }
            >
              {t("Подготовить закупку", "Сатып алуды дайындау")}
            </button>
          )}
          {can(role, "tasks:write") && i.branch_id && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy === i.id}
              onClick={() =>
                act(
                  i.id,
                  () =>
                    api(`${base}/tasks`, "POST", {
                      key: crypto.randomUUID(),
                      branchId: i.branch_id,
                      title:
                        `${rules[i.rule]?.[locale === "ru" ? 0 : 1]}: ${i.evidence.title}`.slice(
                          0,
                          160,
                        ),
                      description: i.evidence.calculation,
                      priority: i.severity >= 3 ? "high" : "normal",
                      requiresVerification: true,
                      links: [{ type: "insight", id: i.id }],
                    }),
                  t(
                    "Задача создана и связана с ситуацией.",
                    "Тапсырма құрылып, жағдаймен байланыстырылды.",
                  ),
                )
              }
            >
              {t("Создать задачу", "Тапсырма құру")}
            </button>
          )}
          {i.state === "open" && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy === i.id}
              onClick={() =>
                act(
                  i.id,
                  () =>
                    api(`${base}/insights/${i.id}/commands`, "POST", {
                      key: crypto.randomUUID(),
                      version: i.version,
                      kind: "acknowledge",
                      note: t("Принято в работу", "Жұмысқа алынды"),
                    }),
                  t("Ситуация принята в работу.", "Жағдай жұмысқа алынды."),
                )
              }
            >
              {t("Принять в работу", "Жұмысқа алу")}
            </button>
          )}
        </div>
      </details>
    </article>
  );
  if (!view && !error)
    return (
      <section className="panel" aria-busy="true">
        <p>{t("Загружаем ситуации…", "Жағдайлар жүктелуде…")}</p>
      </section>
    );
  return (
    <div className="commerce-page today-board">
      {error && (
        <p role="alert" className="commerce-alert">
          {message(error)}{" "}
          <button
            type="button"
            className="secondary-button"
            onClick={() => setRevision((v) => v + 1)}
          >
            {t("Повторить", "Қайталау")}
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className="commerce-success">
          {notice}
        </p>
      )}
      {view && (
        <>
          <section
            className="panel today-summary-panel"
            aria-label={t("Краткая сводка", "Қысқаша жиынтық")}
          >
            {view.metrics ? (
              <dl className="today-summary">
                <div>
                  <dt>{t("Деньги на счетах", "Шоттардағы ақша")}</dt>
                  <dd>{moneyText(view.metrics.cash_minor)} ₸</dd>
                </div>
                <div>
                  <dt>{t("Должны клиенты", "Клиенттердің қарызы")}</dt>
                  <dd>{moneyText(view.metrics.receivable_minor)} ₸</dd>
                </div>
                <div>
                  <dt>{t("Должны поставщикам", "Жеткізушілерге қарыз")}</dt>
                  <dd>{moneyText(view.metrics.payable_minor)} ₸</dd>
                </div>
                <div>
                  <dt>{t("Ожидают решения", "Шешім күтеді")}</dt>
                  <dd>{view.approvals.length}</dd>
                </div>
              </dl>
            ) : (
              <p>
                {t(
                  "Финансовые показатели скрыты для вашей роли.",
                  "Қаржы көрсеткіштері сіздің рөліңізге жасырылған.",
                )}
              </p>
            )}
          </section>
          <div className="today-work-grid">
            <section className="panel today-priorities">
              <div className="commerce-toolbar">
                <div>
                  <h2>{t("Требует внимания", "Назар аударыңыз")}</h2>
                  <p>
                    {t(
                      "Приоритет: срочность, проверенные данные и обязательства. Раскройте ситуацию, чтобы проверить расчёт.",
                      "Басымдық: шұғылдық, тексерілген деректер және міндеттемелер. Есепті тексеру үшін жағдайды ашыңыз.",
                    )}
                  </p>
                  <small>
                    {t(
                      "Последняя проверка правил",
                      "Ережелердің соңғы тексерісі",
                    )}
                    :{" "}
                    {view.last_detection
                      ? businessDate(
                          new Date(view.last_detection),
                          locale,
                          workspace.organization.timezone,
                          true,
                        )
                      : t("ещё не выполнялась", "әлі орындалмаған")}
                  </small>
                </div>
                {can(role, "insights:read") && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy === "refresh"}
                    onClick={() =>
                      act(
                        "refresh",
                        () => api(`${base}/insights/refresh`, "POST", {}),
                        t(
                          "Ситуации пересчитаны.",
                          "Жағдайлар қайта есептелді.",
                        ),
                      )
                    }
                  >
                    {busy === "refresh"
                      ? t("Проверяем…", "Тексерілуде…")
                      : t("Проверить сейчас", "Қазір тексеру")}
                  </button>
                )}
              </div>
              {!can(role, "insights:read") ? (
                <p>
                  {t(
                    "Для вашей роли ситуации не показываются; ниже ваши задачи.",
                    "Сіздің рөліңізге жағдайлар көрсетілмейді; төменде тапсырмаларыңыз.",
                  )}
                </p>
              ) : view.situations.length === 0 ? (
                <p>
                  {t(
                    "Открытых ситуаций нет по проверенным данным.",
                    "Тексерілген деректер бойынша ашық жағдайлар жоқ.",
                  )}
                </p>
              ) : (
                view.situations.map(situation)
              )}
              {view.situations_total > view.situations.length && (
                <p>
                  {t("Всего открытых ситуаций", "Барлық ашық жағдайлар")}:{" "}
                  {view.situations_total}
                </p>
              )}
            </section>
            <section className="panel today-tasks">
              <h2>
                {t(
                  "Мои задачи и проверки",
                  "Менің тапсырмаларым мен тексерулерім",
                )}
              </h2>
              {view.tasks.length === 0 ? (
                <p>
                  {t("Назначенных задач нет.", "Тағайындалған тапсырма жоқ.")}
                </p>
              ) : (
                <ul className="today-list">
                  {view.tasks.map((task) => (
                    <li key={task.id}>
                      <strong>
                        №{task.number} {task.title}
                      </strong>{" "}
                      · {stateText(task.state, locale)}
                      {task.due_at &&
                        ` · ${t("срок", "мерзім")} ${businessDate(new Date(task.due_at), locale, workspace.organization.timezone, true)}`}
                      {task.overdue && ` · ${t("просрочена", "мерзімі өтті")}`}
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                className="secondary-button"
                onClick={() => onNavigate("tasks")}
              >
                {t("Все задачи", "Барлық тапсырмалар")}
              </button>
            </section>
            <section className="panel today-approvals">
              <h2>{t("Ожидают решения", "Шешім күтеді")}</h2>
              {view.approvals.length === 0 ? (
                <p>
                  {t(
                    "Нет предложений, ожидающих вашего решения.",
                    "Сіздің шешіміңізді күтетін ұсыныс жоқ.",
                  )}
                </p>
              ) : (
                <ul className="today-list">
                  {view.approvals.map((p) => (
                    <li key={p.id}>
                      {p.kind === "purchase_order"
                        ? t("Закупка", "Сатып алу")
                        : t("Задача", "Тапсырма")}{" "}
                      · {stateText(p.state, locale)}
                      {p.amount_minor &&
                        ` · ${moneyText(p.amount_minor)} KZT`}{" "}
                      · {p.created_by_name}
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                className="secondary-button"
                onClick={() => onNavigate("approvals")}
              >
                {t("Открыть согласования", "Келісулерді ашу")}
              </button>
            </section>
            <section className="panel today-helper">
              <span className="ai-label">TirekAI</span>
              <h2>
                {t("Помощник для ваших решений", "Шешімдеріңізге көмекші")}
              </h2>
              <p>
                {t(
                  "Разберите остатки, оплаты и задачи на основе данных вашего бизнеса. Ответы можно проверить по источникам.",
                  "Бизнес деректері бойынша қорларды, төлемдер мен тапсырмаларды талдаңыз. Жауаптарды дереккөздер арқылы тексеруге болады.",
                )}
              </p>
              <button
                className="primary-button"
                onClick={() => onNavigate("assistant")}
              >
                {t("Спросить помощника", "Көмекшіден сұрау")}
              </button>
              <small>
                {t(
                  "Действия и платежи остаются под вашим контролем.",
                  "Әрекеттер мен төлемдер сіздің бақылауыңызда.",
                )}
              </small>
            </section>
          </div>
          <details className="panel today-sources">
            <summary>
              {t("Показатели и источники", "Көрсеткіштер мен дереккөздер")}
            </summary>
            <h2>
              {t("Показатели и источники", "Көрсеткіштер мен дереккөздер")}
            </h2>
            {view.metrics && (
              <p>
                {t(
                  "Полнота расходов не подтверждена; прибыль здесь не показывается.",
                  "Шығыстардың толықтығы расталмаған; пайда мұнда көрсетілмейді.",
                )}
                {view.metrics.unknown_cost_events > 0 &&
                  ` ${t("Операций с неизвестной себестоимостью", "Өзіндік құны белгісіз операциялар")}: ${view.metrics.unknown_cost_events}.`}
              </p>
            )}
            <ul className="today-list">
              {view.sources.map((s) => (
                <li key={s.name}>
                  <strong>
                    {s.name === "internal"
                      ? t("Собственный учёт", "Өз есебі")
                      : s.name === "moysklad"
                        ? "МойСклад"
                        : sourceNames[s.name]
                          ? sourceNames[s.name]
                          : s.name === "moysklad_writeback"
                            ? t("Приёмки в МойСклад", "МойСкладқа қабылдаулар")
                            : t("AI-помощник", "AI көмекші")}
                  </strong>{" "}
                  · {stateText(s.status, locale)}
                  {s.checked_at &&
                    ` · ${businessDate(new Date(s.checked_at), locale, workspace.organization.timezone, true)}`}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
