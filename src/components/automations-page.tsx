"use client";
import { useEffect, useState } from "react";
import type { Locale, Workspace } from "@/domain/contracts";
import { automationTopics } from "@/domain/automations";
import { api } from "@/lib/client";
import { useRevision } from "@/lib/live";
import { errorText } from "@/lib/i18n";
import { businessDate } from "@/lib/dates";
import { can } from "@/domain/permissions";
import { executionError, stateText } from "@/lib/execution-i18n";
import { ActionForm, Field } from "./purchasing-page";

const f = (d: FormData, n: string) => String(d.get(n) || "").trim();
type Rule = {
  id: string;
  name: string;
  state: string;
  current_version: number;
  tested_version: number | null;
  paused_reason: string | null;
  definition: Record<string, unknown>;
  version: number;
};
type Execution = {
  id: string;
  rule_name: string;
  topic: string;
  depth: number;
  state: string;
  skip_reason: string | null;
  attempts: number;
  error_code: string | null;
  created_at: string;
  version: number;
};
type Test = {
  passed: boolean;
  matched: boolean;
  conditions: { field: string; op: string; actual: unknown; result: boolean }[];
  actions: { type: string; effect: string; data: Record<string, unknown> }[];
  warnings: string[];
};
const topics: Record<string, [string, string]> = {
  "insight.opened": ["Открыта ситуация", "Жағдай ашылды"],
  "insight.resolved": ["Ситуация разрешена", "Жағдай шешілді"],
  "task.created": ["Создана задача", "Тапсырма құрылды"],
  "task.assigned": ["Задача назначена", "Тапсырма тағайындалды"],
  "task.completed": ["Задача выполнена", "Тапсырма орындалды"],
  "task.verified": ["Задача проверена", "Тапсырма тексерілді"],
  "task.returned": ["Задача возвращена", "Тапсырма қайтарылды"],
  "task.overdue": ["Задача просрочена", "Тапсырма мерзімі өтті"],
  "task.escalated": ["Задача эскалирована", "Тапсырма эскалацияланды"],
  "proposal.created": ["Создано предложение", "Ұсыныс құрылды"],
  "proposal.approve": ["Предложение согласовано", "Ұсыныс келісілді"],
  "proposal.reject": ["Предложение отклонено", "Ұсыныс қабылданбады"],
  "proposal.execute": ["Предложение выполнено", "Ұсыныс орындалды"],
  "knowledge.published": ["Опубликована инструкция", "Нұсқаулық жарияланды"],
  "schedule.tick": ["По расписанию", "Кесте бойынша"],
  "video.signal": ["Сигнал камеры", "Камера сигналы"],
};
export function AutomationsPage({
  workspace,
  locale,
}: {
  workspace: Workspace;
  locale: Locale;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const base = `organizations/${workspace.organization.id}`,
    tz = workspace.organization.timezone,
    write = can(workspace.organization.role, "automations:write");
  const [rules, setRules] = useState<Rule[] | null>(null),
    [executions, setExecutions] = useState<Execution[]>([]),
    [assignees, setAssignees] = useState<{ id: string; name: string }[]>([]),
    [selected, setSelected] = useState(""),
    [test, setTest] = useState<Test | null>(null),
    [revision, setRevision] = useRevision(),
    [aiDraft, setAiDraft] = useState<{
      status: string;
      draft: {
        name: string;
        explanation: string;
        definition: Record<string, unknown>;
      } | null;
      warnings: string[];
      issues: string[];
      error_code: string | null;
    } | null>(null),
    [error, setError] = useState("");
  const refresh = () => setRevision((v) => v + 1);
  useEffect(() => {
    let live = true;
    Promise.all([
      api<{ items: Rule[] }>(`${base}/automations`),
      api<{ items: Execution[] }>(`${base}/automations/executions?limit=30`),
    ])
      .then(
        ([r, x]) =>
          live && (setRules(r.items), setExecutions(x.items), setError("")),
      )
      .catch((e) => live && setError(e.code || "INTERNAL_ERROR"));
    api<{ items: { id: string; name: string }[] }>(`${base}/tasks/assignees`)
      .then((v) => live && setAssignees(v.items))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [base, revision]);
  const rule = rules?.find((r) => r.id === selected);
  const definition = (fd: FormData) => {
    const action = f(fd, "action");
    const value = f(fd, "value");
    return {
      trigger:
        f(fd, "trigger") === "schedule.tick"
          ? {
              type: "schedule",
              recurrence: f(fd, "recurrence"),
              time: f(fd, "time") || "09:00",
              weekday: null,
            }
          : { type: "event", topic: f(fd, "trigger") },
      conditions: f(fd, "field")
        ? [
            {
              field: f(fd, "field"),
              op: f(fd, "op"),
              value: /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value,
            },
          ]
        : [],
      actions: [
        action === "create_task"
          ? {
              type: "create_task",
              title: f(fd, "title"),
              assigneeId: f(fd, "assigneeId") || null,
              dueInHours: f(fd, "dueInHours")
                ? Number(f(fd, "dueInHours"))
                : null,
              requiresVerification: fd.has("verify"),
            }
          : action === "notify"
            ? { type: "notify", userId: f(fd, "assigneeId") }
            : { type: "propose_purchase" },
      ],
      limits: {
        maxPerHour: Number(f(fd, "maxPerHour") || 20),
        maxDepth: Number(f(fd, "maxDepth") || 2),
      },
      workingHoursOnly: fd.has("workingHours"),
    };
  };
  const editor = (
    <>
      <Field label={t("Событие", "Оқиға")}>
        <select name="trigger" defaultValue="insight.opened">
          {automationTopics.map((k) => (
            <option key={k} value={k}>
              {topics[k][locale === "ru" ? 0 : 1]}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label={t(
          "Расписание (для «По расписанию»)",
          "Кесте («Кесте бойынша» үшін)",
        )}
      >
        <select name="recurrence" defaultValue="weekdays">
          <option value="daily">{t("Каждый день", "Күн сайын")}</option>
          <option value="weekdays">{t("По будням", "Жұмыс күндері")}</option>
        </select>
      </Field>
      <Field label={t("Время", "Уақыт")}>
        <input type="time" name="time" defaultValue="09:00" />
      </Field>
      <Field
        label={t(
          "Условие: поле события (необязательно)",
          "Шарт: оқиға өрісі (міндетті емес)",
        )}
      >
        <input
          name="field"
          placeholder="rule"
          pattern="[a-zA-Z_][a-zA-Z0-9_.]*"
        />
      </Field>
      <Field label={t("Оператор", "Оператор")}>
        <select name="op">
          <option value="eq">=</option>
          <option value="neq">≠</option>
          <option value="gte">≥</option>
          <option value="lte">≤</option>
          <option value="exists">{t("существует", "бар")}</option>
        </select>
      </Field>
      <Field label={t("Значение", "Мәні")}>
        <input name="value" placeholder="low_stock" maxLength={120} />
      </Field>
      <Field label={t("Действие", "Әрекет")}>
        <select name="action">
          <option value="create_task">
            {t("Создать задачу", "Тапсырма құру")}
          </option>
          <option value="propose_purchase">
            {t(
              "Подготовить закупку на согласование",
              "Келісуге сатып алуды дайындау",
            )}
          </option>
          <option value="notify">
            {t(
              "Уведомить сотрудника в приложении",
              "Қосымшада қызметкерге хабарлау",
            )}
          </option>
        </select>
      </Field>
      <Field label={t("Название задачи", "Тапсырма атауы")}>
        <input
          name="title"
          defaultValue={t("Проверить ситуацию", "Жағдайды тексеру")}
          minLength={3}
          maxLength={160}
        />
      </Field>
      <Field label={t("Исполнитель / получатель", "Орындаушы / алушы")}>
        <select name="assigneeId">
          <option value="">{t("Не назначен", "Тағайындалмаған")}</option>
          {assignees.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("Срок задачи, часов", "Тапсырма мерзімі, сағат")}>
        <input name="dueInHours" type="number" min={1} max={720} />
      </Field>
      <label className="commerce-check">
        <input type="checkbox" name="verify" />
        {t("Задача требует проверки", "Тапсырма тексеруді қажет етеді")}
      </label>
      <Field label={t("Не чаще раз в час", "Сағатына көп емес")}>
        <input
          name="maxPerHour"
          type="number"
          min={1}
          max={1000}
          defaultValue={20}
        />
      </Field>
      <Field
        label={t("Глубина цепочки правил", "Ережелер тізбегінің тереңдігі")}
      >
        <input name="maxDepth" type="number" min={1} max={5} defaultValue={2} />
      </Field>
      <label className="commerce-check">
        <input type="checkbox" name="workingHours" />
        {t("Только в рабочее время организации", "Тек ұйымның жұмыс уақытында")}
      </label>
      <Field label={t("Основание", "Негізі")}>
        <input name="note" required minLength={3} maxLength={250} />
      </Field>
    </>
  );
  return (
    <div className="commerce-page automations-page">
      {error && (
        <p role="alert" className="commerce-alert">
          {executionError(error, locale) || errorText(error, locale)}
        </p>
      )}
      <section className="panel">
        <h2>{t("Правила", "Ережелер")}</h2>
        <p>
          {t(
            "Правило включается только после успешной проверки текущей версии на тестовом событии. Повтор события не создаёт второй документ; цепочки правил ограничены глубиной; закупки только предлагаются на согласование.",
            "Ереже ағымдағы нұсқасы сынақ оқиғасында сәтті тексерілгеннен кейін ғана қосылады. Оқиғаның қайталануы екінші құжат құрмайды; ережелер тізбегі тереңдікпен шектеледі; сатып алу тек келісуге ұсынылады.",
          )}
        </p>
        {!rules ? (
          <p aria-busy="true">{t("Загрузка…", "Жүктелуде…")}</p>
        ) : rules.length === 0 ? (
          <p>{t("Правил пока нет.", "Әзірге ереже жоқ.")}</p>
        ) : (
          <div className="task-list">
            {rules.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`commerce-order ${selected === r.id ? "active" : ""}`}
                onClick={() => (setSelected(r.id), setTest(null))}
              >
                <strong>{r.name}</strong>
                <span>
                  {stateText(r.state, locale)} · v{r.current_version} ·{" "}
                  {r.tested_version === r.current_version
                    ? t("проверена", "тексерілген")
                    : t("не проверена", "тексерілмеген")}
                  {r.paused_reason && ` · ${r.paused_reason}`}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      {rule && (
        <section className="panel">
          <h2>{rule.name}</h2>
          <pre className="procurement-extraction">
            {JSON.stringify(rule.definition, null, 2)}
          </pre>
          {write && (
            <>
              <ActionForm
                key={`test-${rule.version}`}
                locale={locale}
                label={t(
                  "Проверить на тестовом событии",
                  "Сынақ оқиғасында тексеру",
                )}
                submit={async (fd) => {
                  let payload: Record<string, unknown>;
                  try {
                    payload = JSON.parse(f(fd, "payload") || "{}");
                  } catch {
                    throw new Error("INVALID_INPUT");
                  }
                  setTest(
                    await api<Test>(
                      `${base}/automations/${rule.id}/tests`,
                      "POST",
                      { sample: { topic: f(fd, "topic"), payload } },
                    ),
                  );
                  refresh();
                }}
              >
                <Field label={t("Событие", "Оқиға")}>
                  <select
                    name="topic"
                    defaultValue={
                      (rule.definition.trigger as { topic?: string }).topic ||
                      "schedule.tick"
                    }
                  >
                    {automationTopics.map((k) => (
                      <option key={k} value={k}>
                        {topics[k][locale === "ru" ? 0 : 1]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={t("Данные события (JSON)", "Оқиға деректері (JSON)")}
                >
                  <textarea
                    name="payload"
                    rows={3}
                    defaultValue='{"rule":"low_stock","severity":3}'
                  />
                </Field>
              </ActionForm>
              {test && (
                <div
                  className={
                    test.passed ? "commerce-success" : "commerce-alert"
                  }
                  role="status"
                >
                  <strong>
                    {test.passed
                      ? t("Проверка пройдена", "Тексеру өтті")
                      : t("Проверка не пройдена", "Тексеру өтпеді")}
                  </strong>
                  <p>
                    {t("Событие подходит", "Оқиға сәйкес")}:{" "}
                    {test.matched ? t("да", "иә") : t("нет", "жоқ")}
                  </p>
                  {test.conditions.map((c, i) => (
                    <p key={i}>
                      {c.field} {c.op} → {String(c.actual)} ·{" "}
                      {c.result ? "✓" : "✗"}
                    </p>
                  ))}
                  {test.actions.map((a, i) => (
                    <p key={i}>
                      {a.type}: {a.effect} · {JSON.stringify(a.data)}
                    </p>
                  ))}
                  {test.warnings.length > 0 && (
                    <p>{test.warnings.join(", ")}</p>
                  )}
                </div>
              )}
              <div className="commerce-actions">
                {(["activate", "pause", "disable"] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={
                      kind === "activate"
                        ? "primary-button"
                        : "secondary-button"
                    }
                    disabled={rule.state === "disabled"}
                    onClick={() =>
                      api(`${base}/automations/${rule.id}/commands`, "POST", {
                        key: crypto.randomUUID(),
                        version: rule.version,
                        kind,
                        note: t("Изменено вручную", "Қолмен өзгертілді"),
                      })
                        .then(refresh)
                        .catch((x) => setError(x.code))
                    }
                  >
                    {
                      {
                        activate: t("Включить", "Қосу"),
                        pause: t("Приостановить", "Тоқтата тұру"),
                        disable: t("Отключить навсегда", "Біржола өшіру"),
                      }[kind]
                    }
                  </button>
                ))}
              </div>
              <details>
                <summary>
                  {t("Новая версия правила", "Ереженің жаңа нұсқасы")}
                </summary>
                <ActionForm
                  key={`rev-${rule.version}`}
                  locale={locale}
                  label={t(
                    "Сохранить версию (потребуется новая проверка)",
                    "Нұсқаны сақтау (жаңа тексеру қажет)",
                  )}
                  submit={async (fd, key) => {
                    await api(
                      `${base}/automations/${rule.id}/versions`,
                      "POST",
                      {
                        key,
                        version: rule.version,
                        definition: definition(fd),
                        note: f(fd, "note"),
                      },
                    );
                    refresh();
                  }}
                >
                  {editor}
                </ActionForm>
              </details>
            </>
          )}
        </section>
      )}
      {write && (
        <section className="panel" aria-labelledby="ai-draft">
          <h2 id="ai-draft">
            {t("Описать правило словами (AI)", "Ережені сөзбен сипаттау (AI)")}
          </h2>
          <p>
            {t(
              "AI предлагает только черновик. Он не сохраняется и не включается сам: проверьте, сохраните, протестируйте и только потом включите.",
              "AI тек жобаны ұсынады. Ол өздігінен сақталмайды және қосылмайды: тексеріңіз, сақтаңыз, сынаңыз, содан кейін ғана қосыңыз.",
            )}
          </p>
          <ActionForm
            locale={locale}
            label={t("Предложить черновик", "Жобаны ұсыну")}
            submit={async (fd) => {
              setAiDraft(
                await api(`${base}/automations/draft`, "POST", {
                  locale,
                  text: f(fd, "text"),
                }),
              );
            }}
          >
            <Field label={t("Что должно происходить", "Не болуы керек")}>
              <textarea
                name="text"
                required
                minLength={10}
                maxLength={1000}
                rows={3}
              />
            </Field>
          </ActionForm>
          {aiDraft && (
            <div role="status">
              {aiDraft.status === "not_configured" ? (
                <p>
                  {t(
                    "AI-помощник не настроен: ключ модели не задан на сервере или помощник выключен. Создайте правило формой ниже.",
                    "AI көмекші бапталмаған: серверде модель кілті жоқ немесе көмекші өшірулі. Ережені төмендегі формамен жасаңыз.",
                  )}
                </p>
              ) : aiDraft.draft ? (
                <>
                  <p>
                    <strong>{aiDraft.draft.name}</strong> ·{" "}
                    {aiDraft.draft.explanation}
                  </p>
                  {aiDraft.warnings.includes("unknown_user_removed") && (
                    <p>
                      {t(
                        "Неизвестный сотрудник убран из черновика: выберите исполнителя сами.",
                        "Белгісіз қызметкер жобадан алынды: орындаушыны өзіңіз таңдаңыз.",
                      )}
                    </p>
                  )}
                  {aiDraft.warnings.includes("purchase_needs_approval") && (
                    <p>
                      {t(
                        "Закупка будет только предложением: её согласует человек.",
                        "Сатып алу тек ұсыныс болады: оны адам келіседі.",
                      )}
                    </p>
                  )}
                  <pre className="procurement-extraction">
                    {JSON.stringify(aiDraft.draft.definition, null, 2)}
                  </pre>
                  <ActionForm
                    locale={locale}
                    label={t(
                      "Сохранить как черновик правила",
                      "Ереже жобасы ретінде сақтау",
                    )}
                    submit={async (fd, key) => {
                      const r = await api<{ id: string }>(
                        `${base}/automations`,
                        "POST",
                        {
                          key,
                          branchId: f(fd, "branchId") || null,
                          name: aiDraft.draft!.name,
                          definition: aiDraft.draft!.definition,
                          note: f(fd, "note"),
                        },
                      );
                      setAiDraft(null);
                      setSelected(r.id);
                      refresh();
                    }}
                  >
                    <Field
                      label={t(
                        "Филиал (обязателен для задач)",
                        "Филиал (тапсырма үшін міндетті)",
                      )}
                    >
                      <select name="branchId">
                        {workspace.branches.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                        <option value="">
                          {t("Вся организация", "Бүкіл ұйым")}
                        </option>
                      </select>
                    </Field>
                    <Field label={t("Комментарий", "Түсініктеме")}>
                      <input
                        name="note"
                        required
                        minLength={3}
                        maxLength={250}
                        defaultValue={t("Из черновика AI", "AI жобасынан")}
                      />
                    </Field>
                  </ActionForm>
                </>
              ) : (
                <p className="commerce-alert">
                  {aiDraft.status === "invalid"
                    ? t(
                        "AI не смог составить правило в допустимом виде. Уточните описание или используйте форму.",
                        "AI ережені рұқсат етілген түрде құра алмады. Сипаттаманы нақтылаңыз немесе форманы пайдаланыңыз.",
                      )
                    : (aiDraft.error_code &&
                        executionError(aiDraft.error_code, locale)) ||
                      stateText(aiDraft.status, locale)}
                </p>
              )}
            </div>
          )}
        </section>
      )}
      {write && (
        <section className="panel">
          <h2>{t("Новое правило", "Жаңа ереже")}</h2>
          <ActionForm
            locale={locale}
            label={t("Сохранить черновик правила", "Ереже жобасын сақтау")}
            submit={async (fd, key) => {
              const r = await api<{ id: string }>(
                `${base}/automations`,
                "POST",
                {
                  key,
                  branchId: f(fd, "branchId") || null,
                  name: f(fd, "name"),
                  definition: definition(fd),
                  note: f(fd, "note"),
                },
              );
              setSelected(r.id);
              refresh();
            }}
          >
            <Field label={t("Название", "Атауы")}>
              <input name="name" required minLength={3} maxLength={120} />
            </Field>
            <Field
              label={t(
                "Филиал (обязателен для задач)",
                "Филиал (тапсырма үшін міндетті)",
              )}
            >
              <select name="branchId">
                {workspace.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
                <option value="">{t("Вся организация", "Бүкіл ұйым")}</option>
              </select>
            </Field>
            {editor}
          </ActionForm>
        </section>
      )}
      <section className="panel">
        <h2>{t("Журнал выполнения", "Орындау журналы")}</h2>
        {executions.length === 0 ? (
          <p>{t("Запусков пока нет.", "Әзірге іске қосу жоқ.")}</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("Время", "Уақыт")}</th>
                  <th>{t("Правило", "Ереже")}</th>
                  <th>{t("Событие", "Оқиға")}</th>
                  <th>{t("Состояние", "Күйі")}</th>
                  <th>{t("Причина", "Себебі")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {executions.map((x) => (
                  <tr key={x.id}>
                    <td>
                      {businessDate(new Date(x.created_at), locale, tz, true)}
                    </td>
                    <td>{x.rule_name}</td>
                    <td>
                      {topics[x.topic]?.[locale === "ru" ? 0 : 1] || x.topic} ·{" "}
                      {t("глубина", "тереңдік")} {x.depth}
                    </td>
                    <td>{stateText(x.state, locale)}</td>
                    <td>
                      {x.skip_reason ||
                        (x.error_code &&
                          (executionError(x.error_code, locale) ||
                            x.error_code)) ||
                        ""}
                    </td>
                    <td>
                      {write && ["dead", "failed"].includes(x.state) && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() =>
                            api(
                              `${base}/automations/executions/${x.id}/retry`,
                              "POST",
                              {
                                key: crypto.randomUUID(),
                                version: x.version,
                                kind: "retry",
                              },
                            )
                              .then(refresh)
                              .catch((e) => setError(e.code))
                          }
                        >
                          {t("Повторить", "Қайталау")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
