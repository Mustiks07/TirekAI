"use client";
import { useEffect, useState } from "react";
import type { Locale, Workspace } from "@/domain/contracts";
import type { Warehouse } from "@/domain/inventory";
import { api } from "@/lib/client";
import { errorText } from "@/lib/i18n";
import { businessDate } from "@/lib/dates";
import { executionError, stateText } from "@/lib/execution-i18n";
import { ActionForm, Field } from "./purchasing-page";

const f = (d: FormData, n: string) => String(d.get(n) || "").trim();
type Overview = {
  passports: {
    provider: string;
    name: string;
    contract: { source: string; checked: string; version: string } | null;
    auth: string;
    limits: string[];
    ownership: Record<string, string>;
    operations: {
      id: string;
      direction: string;
      entity: string;
      endpoint: string;
      implementation: string;
      verification: string;
      live: string;
      notes: string;
    }[];
    unverified: string[];
    disconnect: string;
  }[];
  connections: {
    id: string;
    provider: string;
    status: string;
    credentials_hint: string | null;
    last_success_at: string | null;
    last_error_code: string | null;
    verification: Record<string, string> | null;
    open_conflicts: number;
    pending_events: number;
    disconnected_at: string | null;
  }[];
  links: {
    warehouse_id: string;
    warehouse_name: string;
    connection_id: string;
    external_store_id: string;
    stock_as_of: string | null;
  }[];
  runs: {
    id: string;
    kind: string;
    state: string;
    stats: Record<string, number>;
    error_code: string | null;
    started_at: string;
  }[];
  conflicts: {
    id: string;
    entity_type: string;
    external_id: string;
    reason: string;
    remote: { name?: string };
    created_at: string;
  }[];
  canWrite: boolean;
};
const reasons: Record<string, [string, string]> = {
  sku_exists: [
    "Такой SKU уже есть в каталоге: товары не объединяются автоматически",
    "Мұндай SKU каталогта бар: тауарлар автоматты түрде біріктірілмейді",
  ],
  unit_unmapped: [
    "Единица измерения МойСклад не сопоставлена",
    "МойСклад өлшем бірлігі сәйкестендірілмеген",
  ],
  local_modified: [
    "Товар изменён у нас после последней синхронизации",
    "Тауар соңғы синхрондаудан кейін бізде өзгертілді",
  ],
  unit_changed: [
    "В МойСклад изменилась единица измерения",
    "МойСкладта өлшем бірлігі өзгерді",
  ],
};
export function IntegrationsPage({
  workspace,
  locale,
}: {
  workspace: Workspace;
  locale: Locale;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const base = `organizations/${workspace.organization.id}`,
    tz = workspace.organization.timezone;
  const [o, setO] = useState<Overview | null>(null),
    [warehouses, setWarehouses] = useState<Warehouse[]>([]),
    [stores, setStores] = useState<
      { id: string; name: string; archived: boolean }[] | null
    >(null),
    [secretUrl, setSecretUrl] = useState(""),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [revision, setRevision] = useState(0);
  const refresh = () => setRevision((v) => v + 1);
  const msg = (code: string) =>
    executionError(code, locale) || errorText(code, locale);
  useEffect(() => {
    let live = true;
    api<Overview>(`${base}/integrations`)
      .then((v) => live && (setO(v), setError("")))
      .catch((e) => live && setError(e.code || "INTERNAL_ERROR"));
    api<{ items: Warehouse[] }>(`${base}/warehouses`)
      .then((v) => live && setWarehouses(v.items))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [base, revision]);
  async function run(id: string, action: () => Promise<unknown>, done: string) {
    setBusy(id);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(done);
    } catch (e) {
      setError((e as { code?: string }).code || "INTERNAL_ERROR");
    } finally {
      setBusy("");
      refresh();
    }
  }
  const conn = o?.connections.find((c) => !c.disconnected_at);
  return (
    <div className="commerce-page integrations-page">
      {error && (
        <p role="alert" className="commerce-alert">
          {msg(error)}
        </p>
      )}
      {notice && (
        <p role="status" className="commerce-success">
          {notice}
        </p>
      )}
      {!o ? (
        <section className="panel" aria-busy="true">
          <p>{t("Загрузка…", "Жүктелуде…")}</p>
        </section>
      ) : (
        <>
          <section className="panel">
            <h2>МойСклад</h2>
            <p>
              {t("Состояние", "Күйі")}:{" "}
              <strong>
                {stateText(conn?.status || "not_configured", locale)}
              </strong>
              {conn?.credentials_hint &&
                ` · ${t("токен", "токен")} ${conn.credentials_hint}`}
              {conn?.last_success_at &&
                ` · ${t("последний успешный обмен", "соңғы сәтті алмасу")} ${businessDate(new Date(conn.last_success_at), locale, tz, true)}`}
              {conn?.last_error_code &&
                ` · ${t("ошибка", "қате")}: ${msg(conn.last_error_code)}`}
            </p>
            <p>
              {t(
                "Зелёный статус не означает живую проверку. Проверка соединения отмечает только доступ к аккаунту; операции ниже проверены контрактными тестами на тестовом сервере.",
                "Жасыл күй тірі тексеру дегенді білдірмейді. Қосылымды тексеру тек аккаунтқа қолжетімділікті белгілейді; төмендегі операциялар сынақ серверіндегі келісімшарт тесттерімен тексерілген.",
              )}
            </p>
            {o.canWrite && (
              <ActionForm
                locale={locale}
                label={
                  conn
                    ? t("Заменить токен", "Токенді ауыстыру")
                    : t("Сохранить подключение", "Қосылымды сақтау")
                }
                submit={async (d, key) => {
                  const r = await api<{
                    id: string;
                    webhookToken: string | null;
                  }>(`${base}/integrations`, "POST", {
                    key,
                    provider: "moysklad",
                    token: f(d, "token"),
                  });
                  if (r.webhookToken)
                    setSecretUrl(
                      `${window.location.origin}/api/integrations/moysklad/${r.id}/${r.webhookToken}`,
                    );
                  refresh();
                }}
              >
                <Field
                  label={t(
                    "Токен доступа МойСклад (хранится зашифрованным)",
                    "МойСклад кіру токені (шифрланып сақталады)",
                  )}
                >
                  <input
                    name="token"
                    type="password"
                    autoComplete="off"
                    required
                    minLength={16}
                    maxLength={200}
                  />
                </Field>
              </ActionForm>
            )}
            {secretUrl && (
              <p className="commerce-success">
                {t(
                  "Адрес для вебхуков показан один раз, сохраните его:",
                  "Вебхук мекенжайы бір рет көрсетіледі, сақтаңыз:",
                )}{" "}
                <code>{secretUrl}</code>
              </p>
            )}
            {conn && conn.status !== "disconnected" && (
              <div className="commerce-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!!busy}
                  onClick={() =>
                    run(
                      "check",
                      () =>
                        api(
                          `${base}/integrations/${conn.id}/check`,
                          "POST",
                          {},
                        ),
                      t("Соединение проверено.", "Қосылым тексерілді."),
                    )
                  }
                >
                  {t("Проверить соединение", "Қосылымды тексеру")}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!!busy}
                  onClick={() =>
                    run(
                      "sync",
                      () =>
                        api(`${base}/integrations/${conn.id}/sync`, "POST", {}),
                      t(
                        "Синхронизация выполнена, см. журнал.",
                        "Синхрондау орындалды, журналды қараңыз.",
                      ),
                    )
                  }
                >
                  {busy === "sync"
                    ? t("Синхронизация…", "Синхрондау…")
                    : t("Синхронизировать сейчас", "Қазір синхрондау")}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!!busy}
                  onClick={() =>
                    api<{ items: typeof stores }>(
                      `${base}/integrations/${conn.id}/stores`,
                    )
                      .then((r) => setStores(r.items))
                      .catch((e) => setError(e.code))
                  }
                >
                  {t("Загрузить склады МойСклад", "МойСклад қоймаларын жүктеу")}
                </button>
                {o.canWrite && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!!busy}
                    onClick={() =>
                      run(
                        "disconnect",
                        () =>
                          api(
                            `${base}/integrations/${conn.id}/disconnect`,
                            "POST",
                            {},
                          ),
                        t(
                          "Подключение отключено, токен удалён.",
                          "Қосылым ажыратылды, токен жойылды.",
                        ),
                      )
                    }
                  >
                    {t("Отключить и удалить токен", "Ажырату және токенді жою")}
                  </button>
                )}
              </div>
            )}
          </section>
          {conn && (
            <section className="panel">
              <h2>{t("Склады: источник остатка", "Қоймалар: қалдық көзі")}</h2>
              <p>
                {t(
                  "Связанный склад становится зеркалом МойСклад: приходы, выдачи и резервы по нему делаются в МойСклад, у нас они заблокированы. Так остаток не учитывается дважды.",
                  "Байланысқан қойма МойСклад айнасына айналады: кіріс, шығыс және резерв МойСкладта жасалады, бізде бұғатталған. Осылайша қалдық екі рет есептелмейді.",
                )}
              </p>
              <ul className="today-list">
                {o.links.map((l) => (
                  <li key={l.warehouse_id}>
                    {l.warehouse_name} ← {l.external_store_id.slice(0, 8)} ·{" "}
                    {t("остаток на", "қалдық уақыты")}{" "}
                    {l.stock_as_of
                      ? businessDate(new Date(l.stock_as_of), locale, tz, true)
                      : t("нет данных", "дерек жоқ")}
                    {o.canWrite && (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() =>
                          run(
                            "unlink",
                            () =>
                              api(
                                `${base}/integrations/${conn.id}/links/${l.warehouse_id}/remove`,
                                "POST",
                                {},
                              ),
                            t("Связь снята.", "Байланыс алынды."),
                          )
                        }
                      >
                        {t("Снять связь", "Байланысты алу")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {o.canWrite && stores && (
                <ActionForm
                  locale={locale}
                  label={t("Связать склад", "Қойманы байланыстыру")}
                  submit={async (d) => {
                    await api(`${base}/integrations/${conn.id}/links`, "POST", {
                      warehouseId: f(d, "warehouseId"),
                      storeId: f(d, "storeId"),
                    });
                    refresh();
                  }}
                >
                  <Field label={t("Склад МойСклад", "МойСклад қоймасы")}>
                    <select name="storeId">
                      {stores
                        .filter((s) => !s.archived)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label={t("Пустой склад у нас", "Біздегі бос қойма")}>
                    <select name="warehouseId">
                      {warehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </ActionForm>
              )}
            </section>
          )}
          {o.conflicts.length > 0 && (
            <section className="panel">
              <h2>
                {t(
                  "Конфликты: внешние данные не затираются молча",
                  "Қақтығыстар: сыртқы деректер үнсіз жазылмайды",
                )}
              </h2>
              <ul className="today-list">
                {o.conflicts.map((c) => (
                  <li key={c.id}>
                    {c.remote.name || c.external_id.slice(0, 8)} ·{" "}
                    {reasons[c.reason]?.[locale === "ru" ? 0 : 1] || c.reason}
                    {o.canWrite && (
                      <>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() =>
                            run(
                              c.id,
                              () =>
                                api(
                                  `${base}/integrations/conflicts/${c.id}`,
                                  "POST",
                                  {
                                    key: crypto.randomUUID(),
                                    decision: "kept_local",
                                  },
                                ),
                              t(
                                "Оставлены наши данные.",
                                "Біздің деректер қалдырылды.",
                              ),
                            )
                          }
                        >
                          {t("Оставить наше", "Біздікін қалдыру")}
                        </button>
                        {c.reason === "local_modified" && (
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() =>
                              run(
                                c.id,
                                () =>
                                  api(
                                    `${base}/integrations/conflicts/${c.id}`,
                                    "POST",
                                    {
                                      key: crypto.randomUUID(),
                                      decision: "took_remote",
                                    },
                                  ),
                                t(
                                  "Применены данные МойСклад.",
                                  "МойСклад деректері қолданылды.",
                                ),
                              )
                            }
                          >
                            {t("Взять из МойСклад", "МойСкладтан алу")}
                          </button>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="panel">
            <h2>{t("Журнал обмена", "Алмасу журналы")}</h2>
            {o.runs.length === 0 ? (
              <p>{t("Обменов не было.", "Алмасу болмады.")}</p>
            ) : (
              <ul className="today-list">
                {o.runs.map((r) => (
                  <li key={r.id}>
                    {businessDate(new Date(r.started_at), locale, tz, true)} ·{" "}
                    {r.kind} · {stateText(r.state, locale)}
                    {r.error_code && ` · ${msg(r.error_code)}`} ·{" "}
                    {Object.entries(r.stats)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(", ")}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel">
            <h2>{t("Паспорта подключений", "Қосылым паспорттары")}</h2>
            {o.passports.map((p) => (
              <details key={p.provider} open={p.provider === "moysklad"}>
                <summary>
                  {p.name} ·{" "}
                  {p.operations.length
                    ? t(
                        "адаптер реализован, живая проверка не выполнена",
                        "адаптер іске асырылған, тірі тексеру жоқ",
                      )
                    : t("адаптер не реализован", "адаптер іске асырылмаған")}
                </summary>
                {p.contract && (
                  <p>
                    {t("Контракт", "Келісімшарт")}:{" "}
                    <a
                      href={p.contract.source}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {p.contract.source}
                    </a>{" "}
                    · {t("проверен", "тексерілді")} {p.contract.checked}
                  </p>
                )}
                {p.operations.length > 0 && (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>{t("Операция", "Операция")}</th>
                          <th>{t("Направление", "Бағыт")}</th>
                          <th>{t("Реализация", "Іске асыру")}</th>
                          <th>{t("Проверка", "Тексеру")}</th>
                          <th>{t("Примечание", "Ескерту")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.operations.map((op) => (
                          <tr key={op.id}>
                            <td>
                              <code>{op.endpoint}</code>
                            </td>
                            <td>{op.direction}</td>
                            <td>{op.implementation}</td>
                            <td>
                              {op.verification} · live: {op.live}
                            </td>
                            <td>{op.notes}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <ul className="today-list">
                  {[...p.limits, ...p.unverified].map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </details>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
