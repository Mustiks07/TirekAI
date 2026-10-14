"use client";
import { useEffect, useState } from "react";
import type { Locale, Workspace } from "@/domain/contracts";
import type { TaskDetail, TaskRow } from "@/domain/tasks";
import { api } from "@/lib/client";
import { errorText } from "@/lib/i18n";
import { businessDate } from "@/lib/dates";
import { can } from "@/domain/permissions";
import { executionError, stateText } from "@/lib/execution-i18n";
import { ActionForm, Field } from "./purchasing-page";

const f = (d: FormData, n: string) => String(d.get(n) || "").trim();
const kinds: Record<string, [string, string]> = {
  general: ["Общая", "Жалпы"],
  shift_open: ["Открытие смены", "Ауысымды ашу"],
  shift_close: ["Закрытие смены", "Ауысымды жабу"],
  receiving: ["Приёмка", "Қабылдау"],
  return: ["Возврат", "Қайтару"],
  purchase: ["Закупка", "Сатып алу"],
  verification: ["Проверка", "Тексеру"],
};
const priorities: Record<string, [string, string]> = {
  low: ["Низкий", "Төмен"],
  normal: ["Обычный", "Қалыпты"],
  high: ["Высокий", "Жоғары"],
  urgent: ["Срочно", "Шұғыл"],
};
const evidence: Record<string, [string, string]> = {
  none: ["Без подтверждения", "Растаусыз"],
  comment: ["Комментарий", "Түсініктеме"],
  photo: ["Фото", "Фото"],
  operation: ["Операция в системе", "Жүйедегі операция"],
};
type Assignee = { id: string; name: string; role: string };
export function TasksPage({
  workspace,
  locale,
}: {
  workspace: Workspace;
  locale: Locale;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk),
    w = (m: Record<string, [string, string]>, k: string) =>
      m[k]?.[locale === "ru" ? 0 : 1] || k;
  const base = `organizations/${workspace.organization.id}`,
    role = workspace.organization.role,
    tz = workspace.organization.timezone;
  const [filter, setFilter] = useState("open"),
    [scope, setScope] = useState<"mine" | "all">(
      can(role, "tasks:manage") ? "all" : "mine",
    ),
    [list, setList] = useState<{ items: TaskRow[] } | null>(null),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<TaskDetail | null>(null),
    [assignees, setAssignees] = useState<Assignee[]>([]),
    [templates, setTemplates] = useState<
      { id: string; name: string; recurrence: string; active: boolean }[]
    >([]),
    [revision, setRevision] = useState(0),
    [error, setError] = useState("");
  const refresh = () => setRevision((v) => v + 1);
  const post = (path: string, body: unknown) =>
    api(`${base}/${path}`, "POST", body);
  useEffect(() => {
    let live = true;
    api<{ items: TaskRow[] }>(
      `${base}/tasks?${filter ? `state=${filter}&` : ""}scope=${scope}`,
    )
      .then((v) => live && (setList(v), setError("")))
      .catch((e) => live && setError(e.code || "INTERNAL_ERROR"));
    api<{ items: typeof templates }>(`${base}/tasks/templates`)
      .then((v) => live && setTemplates(v.items))
      .catch(() => undefined);
    if (can(role, "tasks:write"))
      api<{ items: Assignee[] }>(`${base}/tasks/assignees`)
        .then((v) => live && setAssignees(v.items))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [base, filter, scope, revision, role]);
  useEffect(() => {
    let live = true;
    if (!selected) return;
    api<TaskDetail>(`${base}/tasks/${selected}`)
      .then((v) => live && setDetail(v))
      .catch((e) => live && setError(e.code || "INTERNAL_ERROR"));
    return () => {
      live = false;
    };
  }, [base, selected, revision]);
  const d = detail?.task.id === selected ? detail : null;
  const command = (kind: string, extra: Record<string, unknown> = {}) =>
    post(`tasks/${d!.task.id}/commands`, {
      key: crypto.randomUUID(),
      version: d!.task.version,
      kind,
      ...extra,
    }).then(refresh);
  const person = (name: string, label: string, value?: string | null) => (
    <Field label={label}>
      <select name={name} defaultValue={value || ""}>
        <option value="">{t("Не назначен", "Тағайындалмаған")}</option>
        {assignees.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </Field>
  );
  const select = (
    name: string,
    label: string,
    map: Record<string, [string, string]>,
    value: string,
  ) => (
    <Field label={label}>
      <select name={name} defaultValue={value}>
        {Object.keys(map).map((k) => (
          <option key={k} value={k}>
            {w(map, k)}
          </option>
        ))}
      </select>
    </Field>
  );
  const note = (
    label = t("Основание / комментарий", "Негізі / түсініктеме"),
  ) => (
    <Field label={label}>
      <input name="note" required minLength={3} maxLength={500} />
    </Field>
  );
  async function upload(file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    await post(`tasks/${d!.task.id}/attachments`, {
      key: crypto.randomUUID(),
      filename: file.name,
      content: btoa(bin),
    });
    refresh();
  }
  return (
    <div className="commerce-page tasks-page">
      {error && (
        <p role="alert" className="commerce-alert">
          {executionError(error, locale) || errorText(error, locale)}
        </p>
      )}
      <section className="panel">
        <div className="commerce-toolbar">
          <Field label={t("Показать", "Көрсету")}>
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="open">{t("Открытые", "Ашық")}</option>
              <option value="overdue">
                {t("Просроченные", "Мерзімі өткен")}
              </option>
              <option value="done">
                {t("Ждут проверки", "Тексеруді күтеді")}
              </option>
              <option value="verified">
                {t("Проверенные", "Тексерілген")}
              </option>
              <option value="">{t("Все", "Барлығы")}</option>
            </select>
          </Field>
          {can(role, "tasks:manage") && (
            <Field label={t("Область", "Аймақ")}>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as "mine" | "all")}
              >
                <option value="all">
                  {t("Все задачи филиала", "Филиалдың барлық тапсырмалары")}
                </option>
                <option value="mine">{t("Мои", "Менікі")}</option>
              </select>
            </Field>
          )}
        </div>
        {!list ? (
          <p aria-busy="true">
            {t("Загружаем задачи…", "Тапсырмалар жүктелуде…")}
          </p>
        ) : list.items.length === 0 ? (
          <p>{t("Задач нет.", "Тапсырма жоқ.")}</p>
        ) : (
          <div className="task-list">
            {list.items.map((task) => (
              <button
                key={task.id}
                type="button"
                className={`commerce-order ${selected === task.id ? "active" : ""}`}
                onClick={() => setSelected(task.id)}
              >
                <strong>
                  №{task.number} {task.title}
                </strong>
                <span>
                  {stateText(task.state, locale)} ·{" "}
                  {w(priorities, task.priority)}
                  {task.assignee_name && ` · ${task.assignee_name}`}
                  {task.due_at &&
                    ` · ${businessDate(new Date(task.due_at), locale, tz, true)}`}
                  {task.overdue && ` · ${t("просрочена", "мерзімі өтті")}`}
                  {task.escalated_at &&
                    ` · ${t("эскалирована заместителю", "орынбасарға берілді")}`}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      {d && (
        <section className="panel" aria-labelledby="task-title">
          <h2 id="task-title">
            №{d.task.number} {d.task.title}
          </h2>
          <p>
            {stateText(d.task.state, locale)} · {w(kinds, d.task.kind)} ·{" "}
            {w(priorities, d.task.priority)} · {t("подтверждение", "растау")}:{" "}
            {w(evidence, d.task.evidence)}
            {d.task.requires_verification &&
              ` · ${t("нужна проверка руководителя", "басшы тексеруі қажет")}`}
          </p>
          {d.task.description && <p>{d.task.description}</p>}
          <p>
            {t("Источник", "Дереккөз")}: {d.task.source} ·{" "}
            {t("создал", "құрған")} {d.task.created_by_name}
            {d.task.assignee_name &&
              ` · ${t("исполнитель", "орындаушы")} ${d.task.assignee_name}`}
            {d.task.deputy_name &&
              ` · ${t("заместитель", "орынбасар")} ${d.task.deputy_name}`}
          </p>
          {d.task.links.length > 0 && (
            <p>
              {t("Связано", "Байланысты")}:{" "}
              {d.task.links
                .map((l) => `${l.type} ${l.id.slice(0, 8)}`)
                .join(", ")}
            </p>
          )}
          {d.task.blocked_reason && (
            <p className="commerce-alert">
              {t("Блокировка", "Бұғаттау")}: {d.task.blocked_reason}
            </p>
          )}
          {d.checklist.length > 0 && (
            <fieldset>
              <legend>{t("Чеклист", "Чеклист")}</legend>
              {d.checklist.map((c) => (
                <label key={c.position} className="commerce-check">
                  <input
                    type="checkbox"
                    checked={!!c.done_at}
                    disabled={
                      !d.permissions.act ||
                      !["assigned", "in_progress"].includes(d.task.state)
                    }
                    onChange={(e) =>
                      command("check", {
                        position: c.position,
                        done: e.target.checked,
                      }).catch((x) => setError(x.code))
                    }
                  />
                  {c.text}
                  {c.done_by_name && ` · ${c.done_by_name}`}
                </label>
              ))}
            </fieldset>
          )}
          {d.task.completion && (
            <div className="commerce-success">
              <strong>{t("Отчёт об исполнении", "Орындау есебі")}</strong>
              <p>{d.task.completion.note}</p>
              {d.task.completion.operation && (
                <p>
                  {t("Операция", "Операция")}:{" "}
                  {d.task.completion.operation.type} ·{" "}
                  {d.task.completion.operation_state}
                </p>
              )}
              <p>
                {t(
                  "Фото и файлы не доказывают качество автоматически; решение принимает проверяющий.",
                  "Фото мен файлдар сапаны автоматты түрде дәлелдемейді; шешімді тексеруші қабылдайды.",
                )}
              </p>
            </div>
          )}
          <div className="commerce-actions">
            {d.permissions.act && d.task.state === "assigned" && (
              <button
                type="button"
                className="primary-button"
                onClick={() => command("start").catch((x) => setError(x.code))}
              >
                {t("Начать", "Бастау")}
              </button>
            )}
          </div>
          {d.permissions.act && d.task.state === "in_progress" && (
            <ActionForm
              locale={locale}
              label={t("Сообщить о выполнении", "Орындалғанын хабарлау")}
              submit={async (fd) => {
                const op = f(fd, "operation");
                await command("complete", {
                  note: f(fd, "note"),
                  operation: op ? JSON.parse(op) : null,
                });
              }}
            >
              {d.task.evidence === "operation" && (
                <Field
                  label={t("Операция-подтверждение", "Растайтын операция")}
                >
                  <select name="operation" required>
                    <option value="">
                      {t(
                        "Выберите связанную операцию",
                        "Байланысты операцияны таңдаңыз",
                      )}
                    </option>
                    {d.task.links.map((l) => (
                      <option key={l.id} value={JSON.stringify(l)}>
                        {l.type} {l.id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {note(t("Что сделано", "Не істелді"))}
            </ActionForm>
          )}
          {d.permissions.act &&
            ["assigned", "in_progress", "blocked"].includes(d.task.state) && (
              <Field
                label={t(
                  "Приложить фото или PDF (до 2 МБ)",
                  "Фото немесе PDF тіркеу (2 МБ дейін)",
                )}
              >
                <input
                  type="file"
                  accept="image/png,image/jpeg,application/pdf"
                  onChange={(e) =>
                    e.target.files?.[0] &&
                    upload(e.target.files[0]).catch((x) => setError(x.code))
                  }
                />
              </Field>
            )}
          {d.permissions.act &&
            ["in_progress", "blocked"].includes(d.task.state) && (
              <ActionForm
                locale={locale}
                label={
                  d.task.state === "blocked"
                    ? t("Снять блокировку", "Бұғаттауды алу")
                    : t("Отметить блокировку", "Бұғаттауды белгілеу")
                }
                submit={async (fd) =>
                  command(d.task.state === "blocked" ? "unblock" : "block", {
                    note: f(fd, "note"),
                  })
                }
              >
                {note(t("Причина", "Себебі"))}
              </ActionForm>
            )}
          {d.permissions.verify && d.task.state === "done" && (
            <ActionForm
              locale={locale}
              label={t("Записать результат проверки", "Тексеру нәтижесін жазу")}
              submit={async (fd) =>
                command(f(fd, "decision"), { note: f(fd, "note") })
              }
            >
              <Field label={t("Решение", "Шешім")}>
                <select name="decision">
                  <option value="verify">
                    {t("Принять работу", "Жұмысты қабылдау")}
                  </option>
                  <option value="return">
                    {t("Вернуть на доработку", "Пысықтауға қайтару")}
                  </option>
                </select>
              </Field>
              {note()}
            </ActionForm>
          )}
          {d.permissions.manage &&
            ["new", "assigned", "in_progress", "blocked"].includes(
              d.task.state,
            ) && (
              <details>
                <summary>
                  {t("Назначить или отменить", "Тағайындау немесе бас тарту")}
                </summary>
                <ActionForm
                  locale={locale}
                  label={t("Назначить", "Тағайындау")}
                  submit={async (fd) =>
                    command("assign", {
                      assigneeId: f(fd, "assigneeId"),
                      deputyId: f(fd, "deputyId") || null,
                      note: f(fd, "note"),
                    })
                  }
                >
                  {person(
                    "assigneeId",
                    t("Исполнитель", "Орындаушы"),
                    d.task.assignee_id,
                  )}
                  {person(
                    "deputyId",
                    t("Заместитель для эскалации", "Эскалация үшін орынбасар"),
                    d.task.deputy_id,
                  )}
                  {note()}
                </ActionForm>
                <ActionForm
                  locale={locale}
                  label={t("Отменить задачу", "Тапсырмадан бас тарту")}
                  submit={async (fd) =>
                    command("cancel", { note: f(fd, "note") })
                  }
                >
                  {note(t("Причина отмены", "Бас тарту себебі"))}
                </ActionForm>
              </details>
            )}
          <ActionForm
            locale={locale}
            label={t("Добавить комментарий", "Түсініктеме қосу")}
            submit={async (fd, key) => {
              await post(`tasks/${d.task.id}/comments`, {
                key,
                body: f(fd, "body"),
              });
              refresh();
            }}
          >
            <Field label={t("Комментарий", "Түсініктеме")}>
              <textarea name="body" required maxLength={2000} rows={2} />
            </Field>
          </ActionForm>
          {d.attachments.length > 0 && (
            <ul className="today-list">
              {d.attachments.map((a) => (
                <li key={a.id}>
                  {a.filename} · {a.actor_name}
                </li>
              ))}
            </ul>
          )}
          <details open>
            <summary>
              {t("История и комментарии", "Тарих және түсініктемелер")}
            </summary>
            <ul className="today-list">
              {[
                ...d.events.map((e) => ({
                  id: e.id,
                  at: e.created_at,
                  text: `${e.actor_name || t("система", "жүйе")}: ${e.kind}${e.to_state ? ` → ${stateText(e.to_state, locale)}` : ""}${e.note ? ` · ${e.note}` : ""}`,
                })),
                ...d.comments.map((c) => ({
                  id: c.id,
                  at: c.created_at,
                  text: `${c.actor_name}: ${c.body}`,
                })),
              ]
                .sort((a, b) => a.at.localeCompare(b.at))
                .map((e) => (
                  <li key={e.id}>
                    {businessDate(new Date(e.at), locale, tz, true)} · {e.text}
                  </li>
                ))}
            </ul>
          </details>
        </section>
      )}
      {can(role, "tasks:write") && (
        <section className="panel">
          <h2>{t("Новая задача", "Жаңа тапсырма")}</h2>
          <ActionForm
            locale={locale}
            label={t("Создать задачу", "Тапсырма құру")}
            submit={async (fd, key) => {
              const r = await api<{ id: string }>(`${base}/tasks`, "POST", {
                key,
                branchId: f(fd, "branchId"),
                title: f(fd, "title"),
                description: f(fd, "description"),
                kind: f(fd, "kind"),
                priority: f(fd, "priority"),
                assigneeId: f(fd, "assigneeId") || null,
                deputyId: f(fd, "deputyId") || null,
                due: f(fd, "dueDate")
                  ? {
                      date: f(fd, "dueDate"),
                      time: f(fd, "dueTime") || "18:00",
                    }
                  : null,
                requiresVerification: fd.has("requiresVerification"),
                evidence: f(fd, "evidence"),
                checklist: f(fd, "checklist")
                  .split("\n")
                  .map((x) => x.trim())
                  .filter((x) => x.length >= 2)
                  .slice(0, 30),
              });
              setSelected(r.id);
              refresh();
            }}
          >
            <Field label={t("Филиал", "Филиал")}>
              <select name="branchId">
                {workspace.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("Задача", "Тапсырма")}>
              <input name="title" required minLength={3} maxLength={160} />
            </Field>
            <Field label={t("Описание", "Сипаттама")}>
              <textarea name="description" maxLength={2000} rows={2} />
            </Field>
            {select("kind", t("Тип", "Түрі"), kinds, "general")}
            {select(
              "priority",
              t("Приоритет", "Басымдық"),
              priorities,
              "normal",
            )}
            {person("assigneeId", t("Исполнитель", "Орындаушы"))}
            {person("deputyId", t("Заместитель", "Орынбасар"))}
            <Field label={t("Срок, дата", "Мерзім, күн")}>
              <input type="date" name="dueDate" />
            </Field>
            <Field label={t("Срок, время", "Мерзім, уақыт")}>
              <input type="time" name="dueTime" defaultValue="18:00" />
            </Field>
            {select(
              "evidence",
              t("Подтверждение исполнения", "Орындауды растау"),
              evidence,
              "comment",
            )}
            <label className="commerce-check">
              <input type="checkbox" name="requiresVerification" />
              {t("Нужна проверка руководителем", "Басшы тексеруі қажет")}
            </label>
            <Field
              label={t(
                "Чеклист, по пункту в строке",
                "Чеклист, әр тармақ жаңа жолда",
              )}
            >
              <textarea name="checklist" rows={3} />
            </Field>
          </ActionForm>
        </section>
      )}
      <section className="panel">
        <h2>
          {t(
            "Шаблоны и периодические задачи",
            "Үлгілер және мерзімді тапсырмалар",
          )}
        </h2>
        {templates.length === 0 ? (
          <p>{t("Шаблонов нет.", "Үлгілер жоқ.")}</p>
        ) : (
          <ul className="today-list">
            {templates.map((tpl) => (
              <li key={tpl.id}>
                {tpl.name} · {tpl.recurrence} ·{" "}
                {tpl.active
                  ? t("действует", "жұмыс істейді")
                  : t("остановлен", "тоқтатылған")}{" "}
                {can(role, "tasks:write") && tpl.active && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      post(`tasks/templates/${tpl.id}/tasks`, {
                        key: crypto.randomUUID(),
                      })
                        .then(refresh)
                        .catch((x) => setError(x.code))
                    }
                  >
                    {t("Создать по шаблону", "Үлгі бойынша құру")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {can(role, "tasks:manage") && (
          <ActionForm
            locale={locale}
            label={t("Сохранить шаблон", "Үлгіні сақтау")}
            submit={async (fd, key) => {
              await post("tasks/templates", {
                key,
                branchId: f(fd, "branchId"),
                name: f(fd, "name"),
                kind: f(fd, "kind"),
                checklist: f(fd, "checklist")
                  .split("\n")
                  .map((x) => x.trim())
                  .filter((x) => x.length >= 2)
                  .slice(0, 30),
                requiresVerification: fd.has("requiresVerification"),
                evidence: f(fd, "evidence"),
                priority: f(fd, "priority"),
                assigneeId: f(fd, "assigneeId") || null,
                deputyId: f(fd, "deputyId") || null,
                recurrence: f(fd, "recurrence"),
                dueTime: f(fd, "dueTime"),
                weekday:
                  f(fd, "recurrence") === "weekly"
                    ? Number(f(fd, "weekday"))
                    : null,
              });
              refresh();
            }}
          >
            <Field label={t("Филиал", "Филиал")}>
              <select name="branchId">
                {workspace.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("Название шаблона", "Үлгі атауы")}>
              <input name="name" required minLength={3} maxLength={120} />
            </Field>
            {select("kind", t("Тип", "Түрі"), kinds, "shift_open")}
            {select(
              "priority",
              t("Приоритет", "Басымдық"),
              priorities,
              "normal",
            )}
            {select(
              "evidence",
              t("Подтверждение", "Растау"),
              evidence,
              "comment",
            )}
            {person("assigneeId", t("Исполнитель", "Орындаушы"))}
            {person("deputyId", t("Заместитель", "Орынбасар"))}
            <Field label={t("Повтор", "Қайталау")}>
              <select name="recurrence" defaultValue="daily">
                <option value="none">{t("Без повтора", "Қайталаусыз")}</option>
                <option value="daily">{t("Каждый день", "Күн сайын")}</option>
                <option value="weekdays">
                  {t("По будням", "Жұмыс күндері")}
                </option>
                <option value="weekly">
                  {t("Раз в неделю", "Аптасына бір рет")}
                </option>
              </select>
            </Field>
            <Field
              label={t(
                "День недели (1 = понедельник)",
                "Апта күні (1 = дүйсенбі)",
              )}
            >
              <input
                name="weekday"
                type="number"
                min={1}
                max={7}
                defaultValue={1}
              />
            </Field>
            <Field label={t("Срок, время", "Мерзім, уақыт")}>
              <input name="dueTime" type="time" required defaultValue="10:00" />
            </Field>
            <label className="commerce-check">
              <input type="checkbox" name="requiresVerification" />
              {t("Нужна проверка", "Тексеру қажет")}
            </label>
            <Field
              label={t(
                "Чеклист, по пункту в строке",
                "Чеклист, әр тармақ жаңа жолда",
              )}
            >
              <textarea name="checklist" rows={3} />
            </Field>
          </ActionForm>
        )}
      </section>
      {can(role, "tasks:manage") && (
        <WorkSettings base={base} locale={locale} />
      )}
    </div>
  );
}
function WorkSettings({ base, locale }: { base: string; locale: Locale }) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const [s, setS] = useState<{
      version: number;
      start_time: string;
      end_time: string;
      days: number[];
      escalate_after_minutes: number;
      configured: boolean;
    } | null>(null),
    [load, setLoad] = useState<{
      items: {
        user_id: string;
        name: string;
        open: number;
        overdue: number;
        done_30d: number;
        verified_30d: number;
        returned_30d: number;
      }[];
    } | null>(null),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    api<typeof s>(`${base}/tasks/schedule`)
      .then(setS)
      .catch(() => undefined);
    api<typeof load>(`${base}/tasks/workload`)
      .then(setLoad)
      .catch(() => undefined);
  }, [base, revision]);
  return (
    <section className="panel">
      <h2>
        {t(
          "Рабочее время, эскалация и нагрузка",
          "Жұмыс уақыты, эскалация және жүктеме",
        )}
      </h2>
      {s && (
        <ActionForm
          key={s.version}
          locale={locale}
          label={t("Сохранить рабочее время", "Жұмыс уақытын сақтау")}
          submit={async (d) => {
            await api(`${base}/tasks/schedule`, "POST", {
              version: s.configured ? s.version : 0,
              startTime: f(d, "start"),
              endTime: f(d, "end"),
              days: [1, 2, 3, 4, 5, 6, 7].filter((n) => d.has(`day-${n}`)),
              escalateAfterMinutes: Number(f(d, "after")),
            });
            setRevision((v) => v + 1);
          }}
        >
          <Field label={t("Начало", "Басы")}>
            <input
              type="time"
              name="start"
              defaultValue={s.start_time}
              required
            />
          </Field>
          <Field label={t("Окончание", "Соңы")}>
            <input type="time" name="end" defaultValue={s.end_time} required />
          </Field>
          <fieldset>
            <legend>{t("Рабочие дни", "Жұмыс күндері")}</legend>
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <label key={n} className="commerce-check">
                <input
                  type="checkbox"
                  name={`day-${n}`}
                  defaultChecked={s.days.includes(n)}
                />
                {
                  (locale === "ru"
                    ? ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
                    : ["Дс", "Сс", "Ср", "Бс", "Жм", "Сн", "Жк"])[n - 1]
                }
              </label>
            ))}
          </fieldset>
          <Field
            label={t(
              "Эскалация заместителю через, минут",
              "Орынбасарға эскалация, минут",
            )}
          >
            <input
              type="number"
              name="after"
              min={0}
              max={10080}
              defaultValue={s.escalate_after_minutes}
              required
            />
          </Field>
        </ActionForm>
      )}
      {load && (
        <>
          <p>
            {t(
              "Нагрузка и выполнение за 30 дней. Это счётчики задач, а не оценка сотрудника.",
              "30 күндегі жүктеме мен орындау. Бұл тапсырма санауыштары, қызметкерді бағалау емес.",
            )}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("Сотрудник", "Қызметкер")}</th>
                  <th>{t("Открыто", "Ашық")}</th>
                  <th>{t("Просрочено", "Мерзімі өткен")}</th>
                  <th>{t("Выполнено", "Орындалды")}</th>
                  <th>{t("Проверено", "Тексерілді")}</th>
                  <th>{t("Возвращено", "Қайтарылды")}</th>
                </tr>
              </thead>
              <tbody>
                {load.items.map((r) => (
                  <tr key={r.user_id}>
                    <td>{r.name}</td>
                    <td>{r.open}</td>
                    <td>{r.overdue}</td>
                    <td>{r.done_30d}</td>
                    <td>{r.verified_30d}</td>
                    <td>{r.returned_30d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
