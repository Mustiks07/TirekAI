"use client";
import { useEffect, useState, type FormEvent } from "react";
import { Upload, Download, Users, FileCheck2, RefreshCw } from "lucide-react";
import type { Locale, Workspace } from "@/domain/contracts";
import type {
  BatchView,
  BatchesView,
  Customer,
  CustomersView,
  ImportRow,
} from "@/domain/import-contracts";
import { MAX_IMPORT_BYTES } from "@/domain/import-contracts";
import { api, ApiError } from "@/lib/client";
import { errorText, dictionary } from "@/lib/i18n";
import { businessDate } from "@/lib/dates";

const words = {
  ru: {
    title: "База клиентов",
    note: "Контакты, история загрузок и источник каждой записи.",
    branch: "Филиал",
    upload: "Импорт клиентов",
    file: "Файл CSV / TSV",
    delimiter: "Разделитель",
    comma: "Запятая",
    semicolon: "Точка с запятой",
    tab: "Табуляция",
    template: "Скачать образец",
    preview: "Проверить файл",
    guide:
      "UTF-8 · до 256 КБ · до 1 000 строк. Обязательные столбцы: external_id, name, email, phone. Укажите почту или телефон в международном формате.",
    scope:
      "external_id должен быть уникальным в филиале. Совпадающие записи пропускаются, различия показываются как конфликт.",
    empty: "Клиентов пока нет",
    emptyNote: "Загрузите таблицу, проверьте строки и подтвердите импорт.",
    history: "История импортов",
    noHistory: "Здесь появятся проверенные файлы.",
    name: "Имя клиента",
    contact: "Контакты",
    source: "Источник",
    status: "Статус",
    row: "Строка",
    rows: "Строк",
    confirm: "Импортировать корректные строки",
    retry: "Повторить обработку",
    worker:
      "Обработчик недоступен. Импорт сохранён и продолжится после запуска worker.",
    reused:
      "Этот файл уже загружен. Открыт прежний результат — записи не дублируются.",
    partial:
      "Ошибочные и конфликтующие строки не записаны. Исправьте их в файле и загрузите снова.",
    close: "Закрыть результат",
    edit: "Изменить",
    save: "Сохранить клиента",
    cancel: "Отмена",
    phone: "Телефон",
    email: "Электронная почта",
    prev: "Назад",
    next: "Далее",
    page: "Страница",
    refresh: "Обновить",
    saved: "Клиент обновлён",
    editTitle: "Редактирование клиента",
    total: "Всего",
    ready: "Готово",
    invalid: "Ошибки",
    duplicate: "Дубли",
    conflict: "Конфликты",
    imported: "Добавлено",
    previewState: "Предпросмотр",
    queued: "В очереди",
    running: "Обработка",
    completed: "Завершено",
    partialState: "Завершено с ошибками",
    failed: "Ошибка обработки",
    cancelled: "Доступ отозван",
    loading: "Загрузка…",
  },
  kk: {
    title: "Клиенттер базасы",
    note: "Байланыстар, жүктеу тарихы және әр жазбаның дереккөзі.",
    branch: "Филиал",
    upload: "Клиенттерді импорттау",
    file: "CSV / TSV файлы",
    delimiter: "Бөлгіш",
    comma: "Үтір",
    semicolon: "Нүктелі үтір",
    tab: "Табуляция",
    template: "Үлгіні жүктеу",
    preview: "Файлды тексеру",
    guide:
      "UTF-8 · 256 КБ дейін · 1 000 жолға дейін. Міндетті бағандар: external_id, name, email, phone. Поштаны немесе халықаралық форматтағы телефонды көрсетіңіз.",
    scope:
      "external_id филиал ішінде бірегей болуы керек. Бірдей жазбалар өткізіледі, айырмашылықтар қайшылық ретінде көрсетіледі.",
    empty: "Клиенттер әлі жоқ",
    emptyNote: "Кестені жүктеп, жолдарды тексеріңіз және импортты растаңыз.",
    history: "Импорт тарихы",
    noHistory: "Тексерілген файлдар осында көрсетіледі.",
    name: "Клиенттің аты",
    contact: "Байланыстар",
    source: "Дереккөз",
    status: "Күйі",
    row: "Жол",
    rows: "Жолдар",
    confirm: "Дұрыс жолдарды импорттау",
    retry: "Өңдеуді қайталау",
    worker:
      "Өңдеуші қолжетімсіз. Импорт сақталды, worker іске қосылғанда жалғасады.",
    reused:
      "Бұл файл бұрын жүктелген. Алдыңғы нәтиже ашылды — жазбалар қайталанбайды.",
    partial:
      "Қате және қайшы жолдар жазылмады. Оларды файлда түзетіп, қайта жүктеңіз.",
    close: "Нәтижені жабу",
    edit: "Өзгерту",
    save: "Клиентті сақтау",
    cancel: "Бас тарту",
    phone: "Телефон",
    email: "Электрондық пошта",
    prev: "Артқа",
    next: "Келесі",
    page: "Бет",
    refresh: "Жаңарту",
    saved: "Клиент жаңартылды",
    editTitle: "Клиентті өңдеу",
    total: "Барлығы",
    ready: "Дайын",
    invalid: "Қателер",
    duplicate: "Қайталанған",
    conflict: "Қайшылықтар",
    imported: "Қосылды",
    previewState: "Алдын ала қарау",
    queued: "Кезекте",
    running: "Өңделуде",
    completed: "Аяқталды",
    partialState: "Қателермен аяқталды",
    failed: "Өңдеу қатесі",
    cancelled: "Қолжетімділік тоқтатылды",
    loading: "Жүктелуде…",
  },
};
const reasons: Record<string, [string, string]> = {
  INVALID_EXTERNAL_ID: ["Неверный external_id", "external_id қате"],
  INVALID_NAME: [
    "Имя: от 2 до 120 символов, без переносов",
    "Аты: 2–120 таңба, жаңа жолсыз",
  ],
  INVALID_EMAIL: ["Неверная почта", "Пошта қате"],
  INVALID_PHONE: ["Телефон: + и от 7 до 15 цифр", "Телефон: + және 7–15 сан"],
  CONTACT_REQUIRED: ["Нужна почта или телефон", "Пошта немесе телефон қажет"],
  COLUMN_COUNT: ["Неверное число столбцов", "Баған саны қате"],
  DUPLICATE_ROW: ["Повтор строки в файле", "Файлдағы қайталанған жол"],
  CONFLICT_ROW: ["Один ID с разными данными", "Бір ID, әртүрлі деректер"],
  ALREADY_IMPORTED: ["Такая запись уже есть", "Мұндай жазба бар"],
  EXISTING_CONFLICT: [
    "Этот ID уже занят другой записью",
    "Бұл ID басқа жазбада бар",
  ],
};
export function CustomersPage({
  workspace,
  locale,
}: {
  workspace: Workspace;
  locale: Locale;
}) {
  const t = words[locale];
  const org = workspace.organization;
  const base = `organizations/${org.id}`;
  const [branch, setBranch] = useState(
    org.branch_id || workspace.branches[0]?.id || "",
  );
  const [page, setPage] = useState(1),
    [historyPage, setHistoryPage] = useState(1),
    [revision, setRevision] = useState(0);
  const [customers, setCustomers] = useState<CustomersView | null>(null),
    [history, setHistory] = useState<BatchesView | null>(null);
  const [result, setResult] = useState<BatchView | null>(null),
    [editing, setEditing] = useState<Customer | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState("");
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<CustomersView>(`${base}/customers?branchId=${branch}&page=${page}`),
      api<BatchesView>(
        `${base}/imports?branchId=${branch}&page=${historyPage}&limit=5`,
      ),
    ])
      .then(([c, h]) => {
        if (!cancelled) {
          setCustomers(c);
          setHistory(h);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [base, branch, page, historyPage, revision]);
  useEffect(() => {
    if (!result || !["queued", "running"].includes(result.batch.state)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api<BatchView>(
        `${base}/imports/${result.batch.id}?page=${result.pagination.page}`,
      )
        .then((next) => {
          if (!cancelled) {
            setResult(next);
            setRevision((v) => v + 1);
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setError(e);
            setRevision((v) => v + 1);
          }
        });
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [base, result, revision]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  function status(state: string) {
    return state === "preview"
      ? t.previewState
      : state === "partial"
        ? t.partialState
        : t[state as keyof typeof t] || state;
  }
  function reason(code: string) {
    return reasons[code]?.[locale === "ru" ? 0 : 1] || errorText(code, locale);
  }
  function pager(
    current: number,
    pages: number,
    onChange: (page: number) => void,
  ) {
    return (
      pages > 1 && (
        <div className="import-pagination">
          <button
            className="button secondary"
            disabled={busy || current <= 1}
            onClick={() => onChange(current - 1)}
          >
            {t.prev}
          </button>
          <span>
            {t.page} {current} / {pages}
          </span>
          <button
            className="button secondary"
            disabled={busy || current >= pages}
            onClick={() => onChange(current + 1)}
          >
            {t.next}
          </button>
        </div>
      )
    );
  }
  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await act(async () => {
      const file = form.get("file");
      if (!(file instanceof File) || !file.size)
        throw new ApiError("CSV_EMPTY");
      if (file.size > MAX_IMPORT_BYTES) throw new ApiError("TOO_LARGE");
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        );
      } catch {
        throw new ApiError("CSV_ENCODING");
      }
      const view = await api<BatchView>(`${base}/imports`, "POST", {
        branchId: branch,
        filename: file.name,
        content,
        delimiter: form.get("delimiter"),
      });
      setResult(view);
      setRevision((v) => v + 1);
    });
  }
  function template() {
    const url = URL.createObjectURL(
      new Blob(
        [
          "\uFEFFexternal_id,name,email,phone\r\nC-001,Айдана Тест,aidana@example.test,+77010000001\r\nC-002,Данияр Тест,daniyar@example.test,\r\n",
        ],
        { type: "text/csv;charset=utf-8" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "customers-example.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="customers-page">
      {error != null && (
        <div className="error-notice" role="alert">
          <strong>{dictionary(locale).errorTitle}</strong>
          <span>
            {errorText(
              error instanceof ApiError ? error.code : "INTERNAL_ERROR",
              locale,
            )}
          </span>
          {error instanceof ApiError && error.requestId && (
            <small>ID: {error.requestId}</small>
          )}
        </div>
      )}
      {notice && (
        <div className="success-notice" role="status">
          {notice}
        </div>
      )}
      <div className="customer-toolbar">
        <label>
          {t.branch}
          <select
            value={branch}
            disabled={busy}
            onChange={(e) => {
              setBranch(e.target.value);
              setPage(1);
              setHistoryPage(1);
              setCustomers(null);
              setHistory(null);
              setResult(null);
              setEditing(null);
              setError(null);
            }}
          >
            {workspace.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name === "01" ? dictionary(locale).mainBranch : b.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => {
            setError(null);
            setRevision((v) => v + 1);
          }}
        >
          <RefreshCw size={16} />
          {t.refresh}
        </button>
      </div>
      <section className="panel import-upload">
        <div className="panel-heading">
          <h2>
            <Upload size={19} />
            {t.upload}
          </h2>
          <button className="button secondary" onClick={template}>
            <Download size={16} />
            {t.template}
          </button>
        </div>
        <p>{t.guide}</p>
        <p className="muted">{t.scope}</p>
        <form onSubmit={upload}>
          <label>
            {t.file}
            <input
              name="file"
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values"
              required
              disabled={busy}
            />
          </label>
          <label>
            {t.delimiter}
            <select name="delimiter" disabled={busy}>
              <option value=",">{t.comma}</option>
              <option value=";">{t.semicolon}</option>
              <option value={"\t"}>{t.tab}</option>
            </select>
          </label>
          <button className="button primary" disabled={busy || !branch}>
            {busy ? t.loading : t.preview}
          </button>
        </form>
      </section>
      {result && (
        <section className="panel import-preview" aria-label={t.previewState}>
          <div className="panel-heading">
            <h2>
              <FileCheck2 size={20} />
              <span>{result.batch.filename}</span>
            </h2>
            <span className={`import-status ${result.batch.state}`}>
              {status(result.batch.state)}
            </span>
          </div>
          {result.reused && (
            <div className="import-note" role="status">
              {t.reused}
            </div>
          )}
          <div className="import-counts">
            {(
              [
                "total",
                "ready",
                "imported",
                "invalid",
                "duplicate",
                "conflict",
              ] as const
            ).map((k) => (
              <div key={k}>
                <span>{t[k]}</span>
                <strong>{result.batch[k]}</strong>
              </div>
            ))}
          </div>
          {!result.workerAvailable &&
            ["queued", "running"].includes(result.batch.state) && (
              <div className="import-note" role="status">
                {t.worker}
              </div>
            )}
          {(result.batch.invalid > 0 || result.batch.conflict > 0) && (
            <p className="import-note">{t.partial}</p>
          )}
          {result.batch.error_code && (
            <p className="import-note">
              {errorText(result.batch.error_code, locale)}
            </p>
          )}
          {/* Keyboard users must be able to scroll the wide preview table. */}
          <div
            className="import-table-wrap"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label={t.rows}
          >
            <table className="import-table">
              <thead>
                <tr>
                  <th>{t.row}</th>
                  <th>external_id</th>
                  <th>{t.name}</th>
                  <th>{t.contact}</th>
                  <th>{t.status}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r: ImportRow) => (
                  <tr key={r.row_number}>
                    <td>{r.row_number}</td>
                    <td>{r.values.external_id || "—"}</td>
                    <td>{r.values.name || "—"}</td>
                    <td>
                      <div>{r.values.email || "—"}</div>
                      <small>{r.values.phone}</small>
                    </td>
                    <td>
                      <span className={`import-status ${r.status}`}>
                        {status(r.status)}
                      </span>
                      {r.errors.map((code) => (
                        <small className="row-reason" key={code}>
                          {reason(code)}
                        </small>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pager(
            result.pagination.page,
            result.pagination.pages,
            (p) =>
              void act(async () =>
                setResult(
                  await api<BatchView>(
                    `${base}/imports/${result.batch.id}?page=${p}`,
                  ),
                ),
              ),
          )}
          <div className="import-actions">
            {result.batch.state === "preview" && (
              <button
                className="button primary"
                disabled={busy || !result.batch.ready}
                onClick={() =>
                  void act(async () => {
                    setResult(
                      await api<BatchView>(
                        `${base}/imports/${result.batch.id}/confirm`,
                        "POST",
                        { version: result.batch.version },
                      ),
                    );
                    setRevision((v) => v + 1);
                  })
                }
              >
                {t.confirm} · {result.batch.ready}
              </button>
            )}
            {["failed", "cancelled"].includes(result.batch.state) && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  void act(async () =>
                    setResult(
                      await api<BatchView>(
                        `${base}/imports/${result.batch.id}/retry`,
                        "POST",
                        { version: result.batch.version },
                      ),
                    ),
                  )
                }
              >
                {t.retry}
              </button>
            )}
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setResult(null)}
            >
              {t.close}
            </button>
          </div>
        </section>
      )}
      {editing && (
        <section className="panel customer-edit">
          <h2>
            {t.editTitle} · {editing.external_id}
          </h2>
          <form
            key={`${editing.id}:${editing.version}`}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(async () => {
                await api(`${base}/customers/${editing.id}`, "PATCH", {
                  name: f.get("name"),
                  email: f.get("email"),
                  phone: f.get("phone"),
                  version: editing.version,
                });
                setEditing(null);
                setNotice(t.saved);
                setRevision((v) => v + 1);
              });
            }}
          >
            <label>
              {t.name}
              <input
                name="name"
                required
                minLength={2}
                maxLength={120}
                defaultValue={editing.name}
              />
            </label>
            <label>
              {t.email}
              <input
                name="email"
                type="email"
                maxLength={254}
                defaultValue={editing.email}
              />
            </label>
            <label>
              {t.phone}
              <input
                name="phone"
                type="tel"
                pattern="\+[1-9][0-9]{6,14}"
                defaultValue={editing.phone}
              />
            </label>
            <div className="import-actions">
              <button className="button primary" disabled={busy}>
                {t.save}
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                {t.cancel}
              </button>
            </div>
          </form>
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>
            <Users size={20} />
            {t.title}
            <span className="inline-count">
              {customers?.pagination.total ?? "—"}
            </span>
          </h2>
        </div>
        {!customers ? (
          <div className="empty">{t.loading}</div>
        ) : !customers.items.length ? (
          <div className="empty">
            <Users size={28} />
            <strong>{t.empty}</strong>
            <p>{t.emptyNote}</p>
          </div>
        ) : (
          <div className="customer-list">
            {customers.items.map((c) => (
              <article className="customer-card" key={c.id}>
                <div className="customer-avatar" aria-hidden="true">
                  {c.name.slice(0, 1)}
                </div>
                <div>
                  <h3>{c.name}</h3>
                  <small>{c.external_id}</small>
                  <p>{c.email || c.phone}</p>
                  {c.email && c.phone && <p>{c.phone}</p>}
                </div>
                <div className="customer-source">
                  <span>{t.source}</span>
                  <strong>
                    {c.source_file ||
                      (locale === "ru" ? "Создан вручную" : "Қолмен құрылды")}
                  </strong>
                  <small>
                    {c.source_row && (
                      <>
                        {t.row} {c.source_row} ·{" "}
                      </>
                    )}
                    {businessDate(new Date(c.created_at), locale, org.timezone)}
                  </small>
                </div>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setEditing(c);
                  }}
                  aria-label={`${t.edit}: ${c.name}`}
                >
                  {t.edit}
                </button>
              </article>
            ))}
          </div>
        )}
        {customers &&
          pager(page, customers.pagination.pages, (p) => {
            setCustomers(null);
            setPage(p);
          })}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>{t.history}</h2>
        </div>
        {history?.items.length ? (
          <div className="import-history">
            {history.items.map((b) => (
              <button
                disabled={busy}
                className="import-history-item"
                key={b.id}
                onClick={() =>
                  void act(async () =>
                    setResult(await api<BatchView>(`${base}/imports/${b.id}`)),
                  )
                }
              >
                <FileCheck2 size={21} />
                <span>
                  <strong>{b.filename}</strong>
                  <small>
                    {businessDate(
                      new Date(b.created_at),
                      locale,
                      org.timezone,
                      true,
                    )}{" "}
                    · {t.rows}: {b.total}
                  </small>
                </span>
                <span className={`import-status ${b.state}`}>
                  {status(b.state)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty">{history ? t.noHistory : t.loading}</div>
        )}
        {history &&
          pager(historyPage, history.pagination.pages, setHistoryPage)}
      </section>
    </div>
  );
}
