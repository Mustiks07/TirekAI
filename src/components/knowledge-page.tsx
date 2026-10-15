"use client";
import { useEffect, useState } from "react";
import type { Locale, Workspace } from "@/domain/contracts";
import { roles } from "@/domain/contracts";
import type { KnowledgeDetail, KnowledgeHit } from "@/domain/knowledge";
import { api } from "@/lib/client";
import { useRevision } from "@/lib/live";
import { errorText, roleNames } from "@/lib/i18n";
import { businessDate } from "@/lib/dates";
import { can } from "@/domain/permissions";
import { executionError, stateText } from "@/lib/execution-i18n";
import { ActionForm, Field } from "./purchasing-page";

const f = (d: FormData, n: string) => String(d.get(n) || "").trim();
type Row = KnowledgeDetail["document"];
export function KnowledgePage({
  workspace,
  locale,
}: {
  workspace: Workspace;
  locale: Locale;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const base = `organizations/${workspace.organization.id}`,
    tz = workspace.organization.timezone,
    edit = can(workspace.organization.role, "knowledge:write");
  const [list, setList] = useState<{ items: Row[] } | null>(null),
    [query, setQuery] = useState(""),
    [hits, setHits] = useState<KnowledgeHit[] | null>(null),
    [selected, setSelected] = useState(""),
    [number, setNumber] = useState<number | null>(null),
    [doc, setDoc] = useState<KnowledgeDetail | null>(null),
    [revision, setRevision] = useRevision(),
    [error, setError] = useState("");
  const refresh = () => setRevision((v) => v + 1);
  useEffect(() => {
    let live = true;
    api<{ items: Row[] }>(`${base}/knowledge`)
      .then((v) => live && (setList(v), setError("")))
      .catch((e) => live && setError(e.code || "INTERNAL_ERROR"));
    return () => {
      live = false;
    };
  }, [base, revision]);
  useEffect(() => {
    let live = true;
    if (!selected) return;
    api<KnowledgeDetail>(
      `${base}/knowledge/${selected}${number ? `?number=${number}` : ""}`,
    )
      .then((v) => live && setDoc(v))
      .catch((e) => live && setError(e.code || "INTERNAL_ERROR"));
    return () => {
      live = false;
    };
  }, [base, selected, number, revision]);
  const d = doc?.document.id === selected ? doc : null;
  const meta = (
    <>
      <Field label={t("Область", "Аймақ")}>
        <select name="branchId">
          <option value="">{t("Вся организация", "Бүкіл ұйым")}</option>
          {workspace.branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("Название", "Атауы")}>
        <input name="title" required minLength={3} maxLength={160} />
      </Field>
      <Field label={t("Раздел", "Бөлім")}>
        <input name="category" required minLength={2} maxLength={60} />
      </Field>
      <Field label={t("Актуально до", "Өзекті мерзімі")}>
        <input type="date" name="reviewDue" />
      </Field>
      <fieldset>
        <legend>
          {t(
            "Кому доступно (пусто: всем ролям)",
            "Кімге қолжетімді (бос: барлық рөлге)",
          )}
        </legend>
        {roles.map((r) => (
          <label key={r} className="commerce-check">
            <input type="checkbox" name={`role-${r}`} />
            {roleNames[locale][r]}
          </label>
        ))}
      </fieldset>
      <Field label={t("Основание изменения", "Өзгерту негізі")}>
        <input name="changeNote" required minLength={3} maxLength={250} />
      </Field>
    </>
  );
  const common = (fd: FormData, key: string) => ({
    key,
    branchId: f(fd, "branchId") || null,
    title: f(fd, "title"),
    category: f(fd, "category"),
    audience: roles.filter((r) => fd.has(`role-${r}`)),
    reviewDue: f(fd, "reviewDue") || null,
    changeNote: f(fd, "changeNote"),
  });
  return (
    <div className="commerce-page knowledge-page">
      {error && (
        <p role="alert" className="commerce-alert">
          {executionError(error, locale) || errorText(error, locale)}
        </p>
      )}
      <section className="panel">
        <h2>
          {t(
            "Поиск по действующим инструкциям",
            "Әрекеттегі нұсқаулықтар бойынша іздеу",
          )}
        </h2>
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            api<{ items: KnowledgeHit[] }>(
              `${base}/knowledge/search?q=${encodeURIComponent(query)}`,
            )
              .then((r) => setHits(r.items))
              .catch((x) => setError(x.code));
          }}
          className="commerce-toolbar"
        >
          <Field label={t("Что найти", "Не табу керек")}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              minLength={2}
              maxLength={120}
              required
            />
          </Field>
          <button type="submit" className="primary-button">
            {t("Найти", "Табу")}
          </button>
        </form>
        {hits &&
          (hits.length === 0 ? (
            <p>
              {t(
                "Ничего не найдено в опубликованных инструкциях.",
                "Жарияланған нұсқаулықтардан ештеңе табылмады.",
              )}
            </p>
          ) : (
            <ul className="today-list">
              {hits.map((h) => (
                <li key={`${h.document_id}-${h.version}`}>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => (
                      setSelected(h.document_id),
                      setNumber(null)
                    )}
                  >
                    {h.title} · v{h.version}
                  </button>
                  {h.stale &&
                    ` · ${t("срок актуальности истёк", "өзектілік мерзімі өтті")}`}
                  <p>…{h.excerpt}…</p>
                </li>
              ))}
            </ul>
          ))}
      </section>
      <section className="panel">
        <h2>{t("Документы", "Құжаттар")}</h2>
        {!list ? (
          <p aria-busy="true">{t("Загрузка…", "Жүктелуде…")}</p>
        ) : list.items.length === 0 ? (
          <p>{t("Документов пока нет.", "Әзірге құжат жоқ.")}</p>
        ) : (
          <div className="task-list">
            {list.items.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`commerce-order ${selected === r.id ? "active" : ""}`}
                onClick={() => (setSelected(r.id), setNumber(null))}
              >
                <strong>{r.title}</strong>
                <span>
                  {r.category} · {stateText(r.state, locale)} ·{" "}
                  {t("опубликована версия", "жарияланған нұсқа")}{" "}
                  {r.published_version ?? "–"} / {r.latest_version}
                  {r.stale &&
                    ` · ${t("нужна проверка актуальности", "өзектілігін тексеру қажет")}`}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      {d && (
        <section className="panel">
          <h2>{d.document.title}</h2>
          <p>
            {stateText(d.document.state, locale)} · {d.document.category}
            {d.document.review_due &&
              ` · ${t("актуально до", "өзекті мерзімі")} ${d.document.review_due}`}
          </p>
          {d.current ? (
            <article className="knowledge-body">
              <p>
                {t("Версия", "Нұсқа")} {d.current.number} ·{" "}
                {d.current.author_name} · {d.current.change_note}
                {d.current.published_at
                  ? ` · ${t("опубликована", "жарияланды")} ${businessDate(new Date(d.current.published_at), locale, tz)}`
                  : ` · ${t("не опубликована", "жарияланбаған")}`}
              </p>
              <pre className="procurement-extraction">{d.current.body}</pre>
              {d.current.filename && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={async () => {
                    const file = await api<{
                      filename: string;
                      content: string;
                    }>(
                      `${base}/knowledge/${d.document.id}/original?number=${d.current!.number}`,
                    );
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(
                      new Blob([
                        Uint8Array.from(atob(file.content), (c) =>
                          c.charCodeAt(0),
                        ),
                      ]),
                    );
                    a.download = file.filename;
                    a.click();
                  }}
                >
                  {t("Скачать оригинал", "Түпнұсқаны жүктеу")}
                </button>
              )}
            </article>
          ) : (
            <p>{t("Опубликованной версии нет.", "Жарияланған нұсқа жоқ.")}</p>
          )}
          {d.canEdit && (
            <>
              <Field label={t("Открыть версию", "Нұсқаны ашу")}>
                <select
                  value={number || d.document.latest_version}
                  onChange={(e) => setNumber(Number(e.target.value))}
                >
                  {d.versions.map((v) => (
                    <option key={v.id} value={v.number}>
                      v{v.number} · {v.change_note}{" "}
                      {v.published_at
                        ? `· ${t("публиковалась", "жарияланған")}`
                        : ""}
                    </option>
                  ))}
                </select>
              </Field>
              {d.document.state !== "archived" && (
                <ActionForm
                  key={`pub-${d.document.version}`}
                  locale={locale}
                  label={t(
                    "Опубликовать открытую версию",
                    "Ашық нұсқаны жариялау",
                  )}
                  submit={async (_fd, key) => {
                    await api(
                      `${base}/knowledge/${d.document.id}/publication`,
                      "POST",
                      {
                        key,
                        version: d.document.version,
                        number: d.current!.number,
                        action: "publish",
                      },
                    );
                    refresh();
                  }}
                >
                  <p>
                    {t(
                      "Сотрудники увидят и AI будет цитировать только опубликованную версию.",
                      "Қызметкерлер тек жарияланған нұсқаны көреді, AI тек соны келтіреді.",
                    )}
                  </p>
                </ActionForm>
              )}
              {d.document.state !== "archived" && (
                <ActionForm
                  key={`rev-${d.document.version}`}
                  locale={locale}
                  label={t("Сохранить новую версию", "Жаңа нұсқаны сақтау")}
                  submit={async (fd, key) => {
                    await api(
                      `${base}/knowledge/${d.document.id}/versions`,
                      "POST",
                      {
                        key,
                        version: d.document.version,
                        title: f(fd, "title"),
                        body: f(fd, "body"),
                        changeNote: f(fd, "changeNote"),
                        reviewDue: f(fd, "reviewDue") || null,
                      },
                    );
                    setNumber(null);
                    refresh();
                  }}
                >
                  <Field label={t("Название", "Атауы")}>
                    <input
                      name="title"
                      defaultValue={d.current?.title}
                      required
                      minLength={3}
                      maxLength={160}
                    />
                  </Field>
                  <Field label={t("Текст", "Мәтін")}>
                    <textarea
                      name="body"
                      defaultValue={d.current?.body}
                      rows={8}
                      required
                    />
                  </Field>
                  <Field label={t("Актуально до", "Өзекті мерзімі")}>
                    <input
                      type="date"
                      name="reviewDue"
                      defaultValue={d.document.review_due || ""}
                    />
                  </Field>
                  <Field label={t("Что изменено", "Не өзгерді")}>
                    <input
                      name="changeNote"
                      required
                      minLength={3}
                      maxLength={250}
                    />
                  </Field>
                </ActionForm>
              )}
              {d.document.state !== "archived" && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    api(
                      `${base}/knowledge/${d.document.id}/publication`,
                      "POST",
                      {
                        key: crypto.randomUUID(),
                        version: d.document.version,
                        number: 1,
                        action: "archive",
                      },
                    )
                      .then(refresh)
                      .catch((x) => setError(x.code))
                  }
                >
                  {t("Перенести в архив", "Мұрағатқа көшіру")}
                </button>
              )}
            </>
          )}
        </section>
      )}
      {edit && (
        <section className="panel">
          <h2>{t("Новая инструкция", "Жаңа нұсқаулық")}</h2>
          <ActionForm
            locale={locale}
            label={t("Сохранить черновик", "Жобаны сақтау")}
            submit={async (fd, key) => {
              const r = await api<{ id: string }>(`${base}/knowledge`, "POST", {
                ...common(fd, key),
                body: f(fd, "body"),
              });
              setSelected(r.id);
              refresh();
            }}
          >
            {meta}
            <Field label={t("Текст", "Мәтін")}>
              <textarea name="body" rows={6} required />
            </Field>
          </ActionForm>
          <h3>
            {t(
              "Загрузить файл (TXT, MD, PDF до 3 МБ)",
              "Файл жүктеу (TXT, MD, PDF 3 МБ дейін)",
            )}
          </h3>
          <ActionForm
            locale={locale}
            label={t("Загрузить", "Жүктеу")}
            submit={async (fd, key) => {
              const file = fd.get("file") as File;
              const bytes = new Uint8Array(await file.arrayBuffer());
              let bin = "";
              for (const b of bytes) bin += String.fromCharCode(b);
              const r = await api<{ id: string }>(
                `${base}/knowledge/uploads`,
                "POST",
                { ...common(fd, key), filename: file.name, content: btoa(bin) },
              );
              setSelected(r.id);
              refresh();
            }}
          >
            {meta}
            <Field label={t("Файл", "Файл")}>
              <input
                type="file"
                name="file"
                accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf"
                required
              />
            </Field>
          </ActionForm>
        </section>
      )}
    </div>
  );
}
