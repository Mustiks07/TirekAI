"use client";
import { useEffect, useState } from "react";
import type { Locale, Workspace } from "@/domain/contracts";
import type { Warehouse } from "@/domain/inventory";
import { api } from "@/lib/client";
import { useRevision } from "@/lib/live";
import { errorText } from "@/lib/i18n";
import { businessDate } from "@/lib/dates";
import { executionError, stateText } from "@/lib/execution-i18n";
import { moneyText } from "@/lib/inventory-i18n";
import { ActionForm, Field } from "./purchasing-page";
import { ConnectorsPanel } from "./connectors-panel";

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
    version: number;
    supply: { enabled: boolean; organization_id: string | null } | null;
  }[];
  exports: {
    id: string;
    order_number: number;
    state: string;
    attempts: number;
    expected_minor: string;
    external_sum_minor: string | null;
    external_id: string | null;
    warning: string | null;
    error_code: string | null;
    created_at: string;
  }[];
  counterparties: {
    connection_id: string;
    supplier_id: string;
    supplier_name: string;
    counterparty_id: string;
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
    connection_id: string;
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
const directions: Record<string, [string, string]> = {
  read: ["чтение из МойСклад", "МойСкладтан оқу"],
  write: ["запись в МойСклад", "МойСкладқа жазу"],
  inbound: ["входящие уведомления", "кіріс хабарламалар"],
};
const opNames: Record<string, [string, string]> = {
  check: ["Проверка соединения", "Қосылымды тексеру"],
  stores: ["Склады", "Қоймалар"],
  products: ["Товары", "Тауарлар"],
  stock: ["Остатки по складам", "Қоймалар бойынша қалдықтар"],
  webhook: ["Вебхуки об изменениях", "Өзгерістер туралы вебхуктар"],
  webhook_register: ["Регистрация вебхука", "Вебхукты тіркеу"],
  supply_create: ["Создание приёмки в МойСклад", "МойСкладта қабылдау құру"],
  currencies: ["Валюты", "Валюталар"],
  parties: ["Юрлица и контрагенты", "Заңды тұлғалар мен контрагенттер"],
  contacts: ["Контакты CRM", "CRM контактілері"],
  contact_get: ["Чтение контакта по событию", "Оқиға бойынша контактіні оқу"],
  events: ["Входящие события", "Кіріс оқиғалар"],
  deal_write: ["Запись сделок", "Мәмілелерді жазу"],
  write: ["Запись", "Жазу"],
  statement_import: ["Импорт банковской выписки", "Банк үзіндісін импорттау"],
  cash_register: ["Онлайн-касса (ОФД)", "Онлайн-касса (ОФД)"],
  bank_api: ["API банка", "Банк API"],
  updates: ["Входящие сообщения", "Кіріс хабарламалар"],
  send: ["Отправка сообщения", "Хабарлама жіберу"],
  orders: ["Заказы", "Тапсырыстар"],
  entries: ["Состав заказа", "Тапсырыс құрамы"],
  accept: ["Принятие заказа", "Тапсырысты қабылдау"],
  settlements: ["Комиссия и выплаты", "Комиссия мен төлемдер"],
};
const exportStates: Record<string, [string, string]> = {
  pending: ["ждёт отправки", "жіберуді күтеді"],
  sent: ["создана в МойСклад", "МойСкладта құрылды"],
  failed: ["ошибка, будет повтор", "қате, қайталанады"],
  dead: ["остановлена, нужен разбор", "тоқтатылды, талдау қажет"],
};
const opNotes: Record<string, [string, string]> = {
  stores: [
    "Склад связывается с нашим только явным действием собственника.",
    "Қойма біздікімен тек иесінің нақты әрекетімен байланысады.",
  ],
  products: [
    "Курсор по дате изменения с перекрытием; единицы по коду ОКЕИ; наши правки не затираются молча. Цены берутся только в KZT; иначе цена остаётся «не указана», а не 0.",
    "Өзгеру күні бойынша қабаттасқан курсор; бірліктер ОКЕИ коды бойынша; біздің түзетулер үнсіз жазылмайды. Бағалар тек KZT-пен алынады; әйтпесе баға 0 емес, «көрсетілмеген» болып қалады.",
  ],
  currencies: [
    "Код валюты (isoCode) определяет, можно ли взять цену.",
    "Валюта коды (isoCode) бағаны алуға болатынын анықтайды.",
  ],
  parties: [
    "Юрлицо и контрагент для приёмки выбирает собственник; по названию ничего не сопоставляется.",
    "Қабылдауға арналған заңды тұлға мен контрагентті иесі таңдайды; атау бойынша ештеңе сәйкестендірілмейді.",
  ],
  stock: [
    "Зеркало физического остатка для связанных складов; локальные складские операции по ним заблокированы.",
    "Байланысқан қоймалар үшін нақты қалдық айнасы; олар бойынша жергілікті операциялар бұғатталған.",
  ],
  webhook: [
    "Подписи в официальном контракте нет: секретный адрес и защита от повторов по requestId; ответ до обработки (лимит 1500 мс).",
    "Ресми келісімшартта қолтаңба жоқ: құпия мекенжай және requestId бойынша қайталаудан қорғау; өңдеуге дейін жауап (1500 мс).",
  ],
  webhook_register: [
    "Только явное действие собственника; нужен публичный HTTPS-адрес и платный тариф.",
    "Тек иесінің нақты әрекеті; жария HTTPS мекенжайы және ақылы тариф қажет.",
  ],
  supply_create: [
    "Выключено по умолчанию. После включения подтверждённая приёмка на связанный склад не создаёт движение у нас, а ставится в очередь как приёмка МойСклад; внешний код защищает от дублей при повторе.",
    "Әдепкі бойынша өшірулі. Қосылғаннан кейін байланысқан қоймаға расталған қабылдау бізде қозғалыс жасамайды, МойСклад қабылдауы ретінде кезекке қойылады; сыртқы код қайталағанда көшірмеден қорғайды.",
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
    [parties, setParties] = useState<{
      organizations: { id: string; name: string; archived: boolean }[];
      counterparties: { id: string; name: string; archived: boolean }[];
    } | null>(null),
    [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]),
    [secretUrl, setSecretUrl] = useState(""),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [revision, setRevision] = useRevision();
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
    api<{ items: { id: string; data: { name: string } }[] }>(
      `${base}/suppliers?limit=100&page=1`,
    )
      .then(
        (v) =>
          live &&
          setSuppliers(v.items.map((x) => ({ id: x.id, name: x.data.name }))),
      )
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
  const conn = o?.connections.find(
    (c) => c.provider === "moysklad" && !c.disconnected_at,
  );
  const conflicts = (o?.conflicts || []).filter(
    (c) => c.connection_id === conn?.id,
  );
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
          {conn && conn.status !== "disconnected" && (
            <section className="panel" aria-labelledby="supply-writeback">
              <h2 id="supply-writeback">
                {t("Приёмки в МойСклад", "МойСкладқа қабылдаулар")}
              </h2>
              <p>
                {conn.supply?.enabled
                  ? t(
                      "Включено: подтверждённая приёмка на связанный склад создаёт приёмку в МойСклад. У нас движение не создаётся, остаток придёт со следующей синхронизацией.",
                      "Қосулы: байланысқан қоймаға расталған қабылдау МойСкладта қабылдау құрады. Бізде қозғалыс жасалмайды, қалдық келесі синхрондаумен келеді.",
                    )
                  : t(
                      "Выключено: приёмку на связанный склад нужно делать в МойСклад.",
                      "Өшірулі: байланысқан қоймаға қабылдауды МойСкладта жасау керек.",
                    )}
              </p>
              {o.canWrite && (
                <ActionForm
                  locale={locale}
                  label={t(
                    "Загрузить юрлица и контрагентов",
                    "Заңды тұлғалар мен контрагенттерді жүктеу",
                  )}
                  submit={async (d) => {
                    setParties(
                      await api(
                        `${base}/integrations/${conn.id}/parties?search=${encodeURIComponent(f(d, "search"))}`,
                      ),
                    );
                  }}
                >
                  <Field
                    label={t(
                      "Поиск контрагента (часть названия)",
                      "Контрагентті іздеу (атаудың бөлігі)",
                    )}
                  >
                    <input name="search" maxLength={80} />
                  </Field>
                </ActionForm>
              )}
              {o.canWrite && parties && !conn.supply?.enabled && (
                <ActionForm
                  locale={locale}
                  label={t(
                    "Включить выгрузку приёмок",
                    "Қабылдауды жіберуді қосу",
                  )}
                  submit={async (d, key) => {
                    await api(
                      `${base}/integrations/${conn.id}/supply`,
                      "POST",
                      {
                        key,
                        version: conn.version,
                        enabled: true,
                        organizationId: f(d, "organizationId"),
                      },
                    );
                    refresh();
                  }}
                >
                  <Field
                    label={t("Юрлицо в МойСклад", "МойСкладтағы заңды тұлға")}
                  >
                    <select name="organizationId" required>
                      {parties.organizations
                        .filter((x) => !x.archived)
                        .map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                </ActionForm>
              )}
              {o.canWrite && conn.supply?.enabled && (
                <div className="commerce-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!!busy}
                    onClick={() =>
                      run(
                        "supply-off",
                        () =>
                          api(
                            `${base}/integrations/${conn.id}/supply`,
                            "POST",
                            {
                              key: crypto.randomUUID(),
                              version: conn.version,
                              enabled: false,
                              organizationId: null,
                            },
                          ),
                        t("Выгрузка выключена.", "Жіберу өшірілді."),
                      )
                    }
                  >
                    {t("Выключить выгрузку", "Жіберуді өшіру")}
                  </button>
                </div>
              )}
              <h3>
                {t("Поставщики → контрагенты", "Жеткізушілер → контрагенттер")}
              </h3>
              {o.counterparties.length === 0 ? (
                <p>{t("Сопоставлений нет.", "Сәйкестендірулер жоқ.")}</p>
              ) : (
                <ul className="today-list">
                  {o.counterparties.map((m) => (
                    <li key={m.supplier_id}>
                      {m.supplier_name} → {m.counterparty_id.slice(0, 8)}
                      {o.canWrite && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() =>
                            run(
                              m.supplier_id,
                              () =>
                                api(
                                  `${base}/integrations/${conn.id}/counterparties`,
                                  "POST",
                                  {
                                    key: crypto.randomUUID(),
                                    supplierId: m.supplier_id,
                                    counterpartyId: null,
                                  },
                                ),
                              t(
                                "Сопоставление снято.",
                                "Сәйкестендіру алынды.",
                              ),
                            )
                          }
                        >
                          {t("Снять", "Алу")}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {o.canWrite && parties && suppliers.length > 0 && (
                <ActionForm
                  locale={locale}
                  label={t(
                    "Сопоставить поставщика",
                    "Жеткізушіні сәйкестендіру",
                  )}
                  submit={async (d, key) => {
                    await api(
                      `${base}/integrations/${conn.id}/counterparties`,
                      "POST",
                      {
                        key,
                        supplierId: f(d, "supplierId"),
                        counterpartyId: f(d, "counterpartyId"),
                      },
                    );
                    refresh();
                  }}
                >
                  <Field label={t("Наш поставщик", "Біздің жеткізуші")}>
                    <select name="supplierId" required>
                      {suppliers.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label={t("Контрагент МойСклад", "МойСклад контрагенті")}
                  >
                    <select name="counterpartyId" required>
                      {parties.counterparties
                        .filter((x) => !x.archived)
                        .map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                </ActionForm>
              )}
              <h3>{t("Очередь выгрузки", "Жіберу кезегі")}</h3>
              {o.exports.length === 0 ? (
                <p>{t("Выгрузок не было.", "Жіберулер болмады.")}</p>
              ) : (
                <ul className="today-list">
                  {o.exports.map((x) => (
                    <li key={x.id}>
                      {t("Закупка", "Сатып алу")} №{x.order_number} ·{" "}
                      {moneyText(x.expected_minor)} ₸ ·{" "}
                      <strong>
                        {exportStates[x.state]?.[locale === "ru" ? 0 : 1] ||
                          x.state}
                      </strong>
                      {x.external_sum_minor &&
                        ` · ${t("сумма в МойСклад", "МойСкладтағы сома")} ${moneyText(x.external_sum_minor)} ₸`}
                      {x.warning &&
                        ` · ${
                          x.warning === "sum_mismatch"
                            ? t(
                                "сумма в МойСклад отличается — проверьте округление",
                                "МойСкладтағы сома өзгеше — дөңгелектеуді тексеріңіз",
                              )
                            : t(
                                "МойСклад не вернул сумму",
                                "МойСклад соманы қайтармады",
                              )
                        }`}
                      {x.error_code && ` · ${msg(x.error_code)}`}
                      {o.canWrite && ["dead", "failed"].includes(x.state) && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() =>
                            run(
                              x.id,
                              () =>
                                api(
                                  `${base}/integrations/exports/${x.id}/retry`,
                                  "POST",
                                  { key: crypto.randomUUID() },
                                ),
                              t("Поставлено в очередь.", "Кезекке қойылды."),
                            )
                          }
                        >
                          {t("Повторить", "Қайталау")}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {conflicts.length > 0 && (
            <section className="panel">
              <h2>
                {t(
                  "Конфликты: внешние данные не затираются молча",
                  "Қақтығыстар: сыртқы деректер үнсіз жазылмайды",
                )}
              </h2>
              <ul className="today-list">
                {conflicts.map((c) => (
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
          <ConnectorsPanel
            workspace={workspace}
            locale={locale}
            canWrite={o.canWrite}
            connections={o.connections}
            conflicts={o.conflicts}
            msg={msg}
            run={run}
            refresh={refresh}
            busy={busy}
          />
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
                  <ul className="today-list passport-ops">
                    {p.operations.map((op) => (
                      <li key={op.id} className="today-situation">
                        <strong>
                          {opNames[op.id]?.[locale === "ru" ? 0 : 1] || op.id}
                        </strong>
                        <code>{op.endpoint}</code>
                        <span>
                          {directions[op.direction]?.[
                            locale === "ru" ? 0 : 1
                          ] || op.direction}{" "}
                          ·{" "}
                          {op.implementation === "implemented"
                            ? t("реализовано", "іске асырылған")
                            : t("запланировано", "жоспарланған")}{" "}
                          ·{" "}
                          {op.verification === "contract_test"
                            ? t(
                                "контрактный тест пройден",
                                "келісімшарт тесті өтті",
                              )
                            : t("не проверено", "тексерілмеген")}{" "}
                          ·{" "}
                          {t("живая проверка не выполнена", "тірі тексеру жоқ")}
                        </span>
                        {opNotes[op.id] && (
                          <small>
                            {opNotes[op.id][locale === "ru" ? 0 : 1]}
                          </small>
                        )}
                      </li>
                    ))}
                  </ul>
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
