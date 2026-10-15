"use client";
import { useState, type ReactNode } from "react";
import type { Locale, Workspace } from "@/domain/contracts";
import { api } from "@/lib/client";
import { businessDate } from "@/lib/dates";
import { stateText } from "@/lib/execution-i18n";
import { ActionForm, Field } from "./purchasing-page";

const f = (d: FormData, n: string) => String(d.get(n) || "").trim();
export type ConnectorRow = {
  id: string;
  provider: string;
  status: string;
  credentials_hint: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  open_conflicts: number;
  pending_events: number;
  disconnected_at: string | null;
  version: number;
};
export type ConnectorConflict = {
  id: string;
  connection_id: string;
  external_id: string;
  reason: string;
  remote: { name?: string };
};
type Ctx = {
  workspace: Workspace;
  locale: Locale;
  canWrite: boolean;
  connections: ConnectorRow[];
  conflicts: ConnectorConflict[];
  msg: (code: string) => string;
  run: (id: string, action: () => Promise<unknown>, done: string) => void;
  refresh: () => void;
  busy: string;
};
const reasons: Record<string, [string, string]> = {
  possible_duplicate: [
    "Похоже на существующего клиента (та же почта или телефон): не объединено автоматически",
    "Бар клиентке ұқсайды (сол пошта не телефон): автоматты түрде біріктірілмеді",
  ],
  sku_exists: [
    "Такой SKU уже есть: товары не объединяются автоматически",
    "Мұндай SKU бар: тауарлар автоматты түрде біріктірілмейді",
  ],
  unit_unmapped: [
    "Единица измерения не сопоставлена",
    "Өлшем бірлігі сәйкестендірілмеген",
  ],
  unit_changed: ["Изменилась единица измерения", "Өлшем бірлігі өзгерді"],
  local_modified: [
    "Изменено у нас после последней синхронизации",
    "Соңғы синхрондаудан кейін бізде өзгертілді",
  ],
};
// One block per adapter (T031–T034): status, owner-only setup, check/sync/disconnect, conflicts.
function Connector({
  ctx,
  provider,
  title,
  note,
  setup,
  actions = ["check", "sync"],
  extra,
}: {
  ctx: Ctx;
  provider: string;
  title: string;
  note: string;
  setup: ReactNode;
  actions?: ("check" | "sync")[];
  extra?: (conn: ConnectorRow) => ReactNode;
}) {
  const { locale, msg, run, busy } = ctx;
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const base = `organizations/${ctx.workspace.organization.id}`;
  const conn = ctx.connections.find(
    (c) => c.provider === provider && !c.disconnected_at,
  );
  const conflicts = ctx.conflicts.filter((c) => c.connection_id === conn?.id);
  return (
    <section className="panel" aria-labelledby={`connector-${provider}`}>
      <h2 id={`connector-${provider}`}>{title}</h2>
      <p>
        {t("Состояние", "Күйі")}:{" "}
        <strong>{stateText(conn?.status || "not_configured", locale)}</strong>
        {conn?.credentials_hint && ` · ${conn.credentials_hint}`}
        {conn?.last_success_at &&
          ` · ${t("последний успешный обмен", "соңғы сәтті алмасу")} ${businessDate(new Date(conn.last_success_at), locale, ctx.workspace.organization.timezone, true)}`}
        {conn?.last_error_code &&
          ` · ${t("ошибка", "қате")}: ${msg(conn.last_error_code)}`}
      </p>
      <p>{note}</p>
      {ctx.canWrite && setup}
      {conn && (
        <div className="commerce-actions">
          {actions.map((a) => (
            <button
              key={a}
              type="button"
              className="secondary-button"
              disabled={!!busy}
              onClick={() =>
                run(
                  `${provider}-${a}`,
                  () =>
                    api(
                      `${base}/integrations/${provider}/${conn.id}/${a}`,
                      "POST",
                      {},
                    ),
                  a === "check"
                    ? t("Соединение проверено.", "Қосылым тексерілді.")
                    : t(
                        "Синхронизация выполнена, см. журнал.",
                        "Синхрондау орындалды, журналды қараңыз.",
                      ),
                )
              }
            >
              {a === "check"
                ? t("Проверить соединение", "Қосылымды тексеру")
                : busy === `${provider}-sync`
                  ? t("Синхронизация…", "Синхрондау…")
                  : t("Синхронизировать сейчас", "Қазір синхрондау")}
            </button>
          ))}
          {ctx.canWrite && (
            <button
              type="button"
              className="secondary-button"
              disabled={!!busy}
              onClick={() =>
                run(
                  `${provider}-disconnect`,
                  () =>
                    api(
                      `${base}/integrations/${provider}/${conn.id}/disconnect`,
                      "POST",
                      {},
                    ),
                  t(
                    "Подключение отключено, реквизиты удалены.",
                    "Қосылым ажыратылды, деректемелер жойылды.",
                  ),
                )
              }
            >
              {t(
                "Отключить и удалить реквизиты",
                "Ажырату және деректемелерді жою",
              )}
            </button>
          )}
        </div>
      )}
      {conn && extra?.(conn)}
      {conflicts.length > 0 && (
        <>
          <h3>{t("Конфликты", "Қақтығыстар")}</h3>
          <ul className="today-list">
            {conflicts.map((c) => (
              <li key={c.id}>
                {c.remote.name || c.external_id} ·{" "}
                {reasons[c.reason]?.[locale === "ru" ? 0 : 1] || c.reason}
                {ctx.canWrite &&
                  (["kept_local", "took_remote"] as const)
                    .filter(
                      (d) =>
                        d === "kept_local" || c.reason === "local_modified",
                    )
                    .map((d) => (
                      <button
                        key={d}
                        type="button"
                        className="secondary-button"
                        onClick={() =>
                          run(
                            c.id,
                            () =>
                              api(
                                `${base}/integrations/${provider}/conflicts/${c.id}`,
                                "POST",
                                {
                                  key: crypto.randomUUID(),
                                  decision: d,
                                },
                              ),
                            t("Решение сохранено.", "Шешім сақталды."),
                          )
                        }
                      >
                        {d === "kept_local"
                          ? t("Оставить наше", "Біздікін қалдыру")
                          : t("Взять внешнее", "Сыртқысын алу")}
                      </button>
                    ))}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
export function ConnectorsPanel(
  props: Omit<Ctx, "busy" | "run"> & {
    busy: string;
    run: Ctx["run"];
  },
) {
  const ctx: Ctx = props;
  const { locale, workspace } = ctx;
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const base = `organizations/${workspace.organization.id}`;
  const [inbound, setInbound] = useState<Record<string, string>>({});
  const shown = (provider: string) =>
    inbound[provider] && (
      <p className="commerce-success">
        {t(
          "Адрес для входящих событий показан один раз, сохраните его:",
          "Кіріс оқиғалар мекенжайы бір рет көрсетіледі, сақтаңыз:",
        )}{" "}
        <code>{inbound[provider]}</code>
      </p>
    );
  return (
    <>
      <Connector
        ctx={ctx}
        provider="bitrix24"
        title="Битрикс24"
        note={t(
          "Читаются контакты CRM (облачный портал, входящий вебхук). Клиенты из Битрикс24 приходят без согласий на рассылки; совпадение почты или телефона и наши правки становятся конфликтами. Запись в Битрикс24 не включена.",
          "CRM контактілері оқылады (бұлттық портал, кіріс вебхук). Битрикс24 клиенттері таратылымға келісімсіз келеді; пошта не телефон сәйкестігі және біздің түзетулер қақтығысқа айналады. Битрикс24-ке жазу қосылмаған.",
        )}
        setup={
          <>
            <ActionForm
              locale={locale}
              label={t("Сохранить Битрикс24", "Битрикс24 сақтау")}
              submit={async (d, key) => {
                const r = await api<{
                  id: string;
                  webhookToken: string | null;
                }>(`${base}/integrations/bitrix24`, "POST", {
                  key,
                  webhookUrl: f(d, "webhookUrl"),
                  applicationToken: f(d, "applicationToken") || null,
                  branchId: f(d, "branchId"),
                });
                if (r.webhookToken)
                  setInbound((v) => ({
                    ...v,
                    bitrix24: `${window.location.origin}/api/integrations/bitrix24/${r.id}/${r.webhookToken}`,
                  }));
                ctx.refresh();
              }}
            >
              <Field
                label={t(
                  "Адрес входящего вебхука (хранится зашифрованным)",
                  "Кіріс вебхук мекенжайы (шифрланып сақталады)",
                )}
              >
                <input
                  name="webhookUrl"
                  type="password"
                  autoComplete="off"
                  required
                  maxLength={300}
                  placeholder="https://<портал>.bitrix24.kz/rest/1/<код>/"
                />
              </Field>
              <Field
                label={t(
                  "Токен исходящего вебхука (application_token, необязательно)",
                  "Шығыс вебхук токені (application_token, міндетті емес)",
                )}
              >
                <input
                  name="applicationToken"
                  type="password"
                  autoComplete="off"
                  maxLength={64}
                />
              </Field>
              <Field
                label={t("Филиал для клиентов", "Клиенттерге арналған филиал")}
              >
                <select name="branchId">
                  {workspace.branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </Field>
            </ActionForm>
            {shown("bitrix24")}
          </>
        }
      />
      <Connector
        ctx={ctx}
        provider="onec"
        title="1С"
        note={t(
          "Стандартный интерфейс OData опубликованной базы 1С (только HTTPS на публичном адресе). Читается номенклатура и классификатор единиц; цены не читаются и остаются «не указана». Изменения определяются по DataVersion при полном просмотре не чаще раза в час. Запись в 1С не выполняется.",
          "Жарияланған 1С базасының стандартты OData интерфейсі (тек жария мекенжайдағы HTTPS). Номенклатура мен өлшем бірліктері жіктеуіші оқылады; бағалар оқылмайды және «көрсетілмеген» болып қалады. Өзгерістер DataVersion бойынша сағатына бір реттен жиі емес толық қарауда анықталады. 1С-ке жазу орындалмайды.",
        )}
        setup={
          <ActionForm
            locale={locale}
            label={t("Сохранить 1С", "1С сақтау")}
            submit={async (d, key) => {
              await api(`${base}/integrations/onec`, "POST", {
                key,
                infobaseUrl: f(d, "infobaseUrl"),
                user: f(d, "user"),
                password: String(d.get("password") || ""),
                products: f(d, "products"),
                units: f(d, "units"),
                unitField: f(d, "unitField"),
                skuField: f(d, "skuField"),
              });
              ctx.refresh();
            }}
          >
            <Field
              label={t(
                "Адрес публикации базы (https://…/база)",
                "База жариялау мекенжайы (https://…/база)",
              )}
            >
              <input
                name="infobaseUrl"
                required
                maxLength={300}
                inputMode="url"
              />
            </Field>
            <Field
              label={t(
                "Пользователь 1С (только чтение)",
                "1С пайдаланушысы (тек оқу)",
              )}
            >
              <input name="user" required maxLength={100} autoComplete="off" />
            </Field>
            <Field
              label={t(
                "Пароль (хранится зашифрованным)",
                "Құпиясөз (шифрланып сақталады)",
              )}
            >
              <input
                name="password"
                type="password"
                required
                maxLength={200}
                autoComplete="off"
              />
            </Field>
            <Field
              label={t("Справочник номенклатуры", "Номенклатура анықтамалығы")}
            >
              <input
                name="products"
                defaultValue="Catalog_Номенклатура"
                required
                maxLength={90}
              />
            </Field>
            <Field label={t("Классификатор единиц", "Бірліктер жіктеуіші")}>
              <input
                name="units"
                defaultValue="Catalog_КлассификаторЕдиницИзмерения"
                required
                maxLength={90}
              />
            </Field>
            <Field label={t("Поле единицы", "Бірлік өрісі")}>
              <input
                name="unitField"
                defaultValue="ЕдиницаИзмерения_Key"
                required
                maxLength={90}
              />
            </Field>
            <Field label={t("Поле артикула", "Артикул өрісі")}>
              <input
                name="skuField"
                defaultValue="Артикул"
                required
                maxLength={90}
              />
            </Field>
          </ActionForm>
        }
      />
    </>
  );
}
