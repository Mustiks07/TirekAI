"use client";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ShoppingBag, Wallet, RefreshCw, Plus, ArrowLeft } from "lucide-react";
import type { Locale, Workspace } from "@/domain/contracts";
import type { Item, Warehouse, CatalogView } from "@/domain/inventory";
import type {
  OrdersView,
  OrderView,
  Account,
  Ledger,
  Obligations,
  Summary,
} from "@/domain/commerce";
import { can } from "@/domain/permissions";
import { api, ApiError } from "@/lib/client";
import { errorText } from "@/lib/i18n";
import { inventoryError, moneyText, quantityText } from "@/lib/inventory-i18n";
import { businessDate } from "@/lib/dates";
import { PaymentCalendar } from "./payment-calendar";
const field = (f: FormData, n: string) => String(f.get(n) || "").trim();
const labels: Record<string, [string, string]> = {
  draft: ["Черновик", "Жоба"],
  confirmed: ["Подтверждён", "Расталды"],
  partial: ["Частично исполнен", "Ішінара орындалды"],
  fulfilled: ["Исполнен", "Орындалды"],
  cancelled: ["Отменён", "Бас тартылды"],
  created: ["Создание", "Құру"],
  confirm: ["Подтверждение", "Растау"],
  cancel: ["Отмена остатка", "Қалдықты болдырмау"],
  fulfill: ["Исполнение", "Орындау"],
  return: ["Возврат товара / услуги", "Тауарды / қызметті қайтару"],
  payment: ["Оплата заказа", "Тапсырыс төлемі"],
  refund: ["Возврат денег", "Ақшаны қайтару"],
  supplier_payment: ["Оплата поставщику", "Жеткізушіге төлем"],
  income: ["Прочее поступление", "Басқа түсім"],
  expense: ["Расход", "Шығыс"],
  transfer: ["Перевод между счетами", "Шоттар арасында аудару"],
  opening: ["Начальный остаток", "Бастапқы қалдық"],
};
const errors: Record<string, [string, string]> = {
  ORDER_STATE: [
    "Действие недоступно в текущем состоянии заказа.",
    "Тапсырыстың ағымдағы күйінде әрекет қолжетімсіз.",
  ],
  QUANTITY_EXCEEDS: [
    "Количество превышает неисполненный остаток.",
    "Саны орындалмаған қалдықтан асады.",
  ],
  PAYMENT_EXCEEDS: [
    "Сумма превышает остаток к оплате.",
    "Сома төленетін қалдықтан асады.",
  ],
  REFUND_EXCEEDS: [
    "Нельзя вернуть больше полученной оплаты.",
    "Алынған төлемнен артық қайтаруға болмайды.",
  ],
  INSUFFICIENT_MONEY: [
    "Недостаточно денег на выбранном счёте.",
    "Таңдалған шотта қаражат жеткіліксіз.",
  ],
  ACCOUNT_SCOPE: [
    "Счёт и документ должны относиться к одному филиалу.",
    "Шот пен құжат бір филиалға тиесілі болуы керек.",
  ],
  ACCOUNT_EXISTS: [
    "Счёт с таким названием уже существует.",
    "Осындай атауы бар шот бар.",
  ],
  CUSTOMER_SCOPE: [
    "Выберите клиента этого филиала.",
    "Осы филиалдың клиентін таңдаңыз.",
  ],
  WAREHOUSE_SCOPE: [
    "Выберите склад этого филиала.",
    "Осы филиалдың қоймасын таңдаңыз.",
  ],
  DUPLICATE_LINE: [
    "Одна позиция может быть в заказе только один раз.",
    "Бір позиция тапсырыста бір рет қана болуы мүмкін.",
  ],
  SAME_ACCOUNT: ["Выберите разные счета.", "Әртүрлі шоттарды таңдаңыз."],
};
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="commerce-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function CommercePage({
  workspace,
  locale,
  mode,
}: {
  workspace: Workspace;
  locale: Locale;
  mode: "orders" | "finance";
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk),
    word = (key: string) => labels[key]?.[locale === "ru" ? 0 : 1] || key;
  const org = workspace.organization,
    base = `organizations/${org.id}`,
    write = can(org.role, mode === "orders" ? "orders:write" : "finance:write"),
    cost = can(org.role, "inventory:cost");
  const [branch, setBranch] = useState(workspace.branches[0]?.id || ""),
    [revision, setRevision] = useState(0),
    [page, setPage] = useState(1),
    [query, setQuery] = useState("");
  const [orders, setOrders] = useState<OrdersView | null>(null),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<OrderView | null>(null),
    [historyPage, setHistoryPage] = useState(1);
  const [accounts, setAccounts] = useState<Account[]>([]),
    [ledger, setLedger] = useState<Ledger | null>(null),
    [obligations, setObligations] = useState<Obligations | null>(null),
    [summary, setSummary] = useState<Summary | null>(null);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>(
      [],
    ),
    [items, setItems] = useState<Item[]>([]),
    [warehouses, setWarehouses] = useState<Warehouse[]>([]),
    [customerSearch, setCustomerSearch] = useState(""),
    [itemSearch, setItemSearch] = useState("");
  const [form, setForm] = useState<
      "order" | "account" | "obligation" | "money" | null
    >(null),
    [moneyKind, setMoneyKind] = useState("payment"),
    [lineCount, setLineCount] = useState(1),
    [operation, setOperation] = useState<{
      kind: string;
      lineId?: string;
      eventId?: string;
      service?: boolean;
    } | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [success, setSuccess] = useState(false);
  const retry = useRef<{ signature: string; key: string } | null>(null),
    editor = useRef<HTMLElement>(null);
  useEffect(() => {
    editor.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [form, operation]);
  useEffect(() => {
    let stale = false;
    const q = `branchId=${branch}&q=${encodeURIComponent(query)}&page=${page}`;
    const read = async () => {
      await Promise.resolve();
      if (stale) return;
      setLoading(true);
      setError(null);
      const list = await api<OrdersView>(`${base}/orders?${q}`);
      if (stale) return;
      setOrders(list);
      if (mode === "finance") {
        const [a, l, o, s] = await Promise.all([
          api<{ items: Account[] }>(
            `${base}/finance/accounts?branchId=${branch}`,
          ),
          api<Ledger>(`${base}/finance/ledger?${q}`),
          api<Obligations>(`${base}/finance/obligations?${q}`),
          api<Summary>(`${base}/finance/summary?branchId=${branch}`),
        ]);
        if (stale) return;
        setAccounts(a.items);
        setLedger(l);
        setObligations(o);
        setSummary(s);
      }
      if (selected) {
        const d = await api<OrderView>(
          `${base}/orders/${selected}?page=${historyPage}`,
        );
        if (!stale) setDetail(d);
      }
    };
    void read()
      .catch((e) => {
        if (!stale) setError(e);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [base, branch, mode, page, query, revision, selected, historyPage]);
  useEffect(() => {
    if (form !== "order") return;
    let stale = false;
    Promise.all([
      api<{ items: { id: string; name: string }[] }>(
        `${base}/order-customers?branchId=${branch}&limit=100&q=${encodeURIComponent(customerSearch)}`,
      ),
      api<CatalogView>(
        `${base}/catalog?limit=100&q=${encodeURIComponent(itemSearch)}`,
      ),
      api<{ items: Warehouse[] }>(`${base}/warehouses?branchId=${branch}`),
    ])
      .then(([c, i, w]) => {
        if (!stale) {
          setCustomers(c.items);
          setItems((previous) => [
            ...previous.filter((p) => !i.items.some((v) => v.id === p.id)),
            ...i.items.filter((v) => v.active),
          ]);
          setWarehouses(w.items);
        }
      })
      .catch((e) => {
        if (!stale) setError(e);
      });
    return () => {
      stale = true;
    };
  }, [base, branch, form, customerSearch, itemSearch]);
  async function send(path: string, data: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSuccess(false);
    const signature = JSON.stringify({ path, data });
    if (retry.current?.signature !== signature)
      retry.current = { signature, key: crypto.randomUUID() };
    try {
      const result = await api<{ id: string }>(path, "POST", {
        ...data,
        key: retry.current.key,
      });
      retry.current = null;
      setForm(null);
      setOperation(null);
      setSuccess(true);
      if (form === "order") {
        setSelected(result.id);
        setDetail(null);
        setHistoryPage(1);
      }
      setHistoryPage(1);
      setRevision((v) => v + 1);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  function createOrder(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void send(`${base}/orders`, {
      branchId: branch,
      customerId: field(f, "customer"),
      warehouseId: field(f, "warehouse"),
      dueDate: field(f, "due"),
      delivery: field(f, "delivery"),
      note: field(f, "note"),
      taxMode: "excluded",
      lines: Array.from({ length: lineCount }, (_, i) => ({
        itemId: field(f, `item${i}`),
        quantity: field(f, `quantity${i}`),
        unit: field(f, `unit${i}`),
        price: field(f, `price${i}`),
        discount: field(f, `discount${i}`),
      })),
    });
  }
  function submitMoney(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      data: Record<string, unknown> = {
        kind: moneyKind,
        accountId: field(f, "account"),
        amount: field(f, "amount"),
        note: field(f, "note"),
      };
    if (["payment", "refund"].includes(moneyKind))
      data.orderId = field(f, "order");
    if (moneyKind === "supplier_payment")
      data.obligationId = field(f, "obligation");
    if (moneyKind === "transfer") data.destinationId = field(f, "destination");
    if (["income", "expense"].includes(moneyKind)) {
      data.category = field(f, "category");
      data.counterparty = field(f, "counterparty");
    }
    if (moneyKind === "expense") data.operating = f.has("operating");
    void send(`${base}/finance/commands`, data);
  }
  const noteField = (
    <Field label={t("Основание", "Негізі")}>
      <input name="note" required minLength={3} maxLength={250} />
    </Field>
  );
  const submit = (
    <button className="primary-button" disabled={busy || loading} type="submit">
      {busy ? t("Сохранение…", "Сақталуда…") : t("Сохранить", "Сақтау")}
    </button>
  );
  const dateField = (
    <Field label={t("Срок оплаты", "Төлем мерзімі")}>
      <input name="due" type="date" required />
    </Field>
  );
  const errorCode = error instanceof ApiError ? error.code : "";
  const errorMessage =
    errors[errorCode]?.[locale === "ru" ? 0 : 1] ||
    inventoryError(errorCode, locale) ||
    errorText(errorCode || "INTERNAL_ERROR", locale);
  return (
    <div className="commerce-page inventory-page" aria-busy={loading || busy}>
      <section className="panel commerce-toolbar">
        <div>
          <h2>
            {mode === "orders" ? (
              <ShoppingBag aria-hidden size={23} />
            ) : (
              <Wallet aria-hidden size={23} />
            )}{" "}
            {t(
              mode === "orders"
                ? "Заказы и исполнение"
                : "Деньги и обязательства",
              mode === "orders"
                ? "Тапсырыстар және орындау"
                : "Ақша және міндеттемелер",
            )}
          </h2>
          <p>
            {t(
              "Каждая операция сохраняет автора, время и связь с документом.",
              "Әр операция авторын, уақытын және құжатпен байланысын сақтайды.",
            )}
          </p>
        </div>
        <Field label={t("Филиал", "Филиал")}>
          <select
            aria-label={t("Филиал", "Филиал")}
            value={branch}
            disabled={busy}
            onChange={(e) => {
              setBranch(e.target.value);
              setSelected("");
              setDetail(null);
              setHistoryPage(1);
              setForm(null);
              setOperation(null);
              setPage(1);
            }}
          >
            {workspace.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name === "01"
                  ? t("Основной филиал", "Негізгі филиал")
                  : b.name}
              </option>
            ))}
          </select>
        </Field>
        <button
          className="secondary-button"
          onClick={() => setRevision((v) => v + 1)}
          disabled={busy || loading}
        >
          <RefreshCw size={16} aria-hidden />
          {t("Обновить", "Жаңарту")}
        </button>
        {write && (
          <div className="commerce-actions">
            {(mode === "orders"
              ? ["order"]
              : ["account", "money", "obligation"]
            ).map((f) => (
              <button
                key={f}
                className="secondary-button"
                disabled={busy || loading}
                onClick={() => {
                  setForm(f as typeof form);
                  setOperation(null);
                  setLineCount(1);
                  setSuccess(false);
                  retry.current = null;
                }}
              >
                <Plus size={16} aria-hidden />
                {f === "order"
                  ? t("Создать заказ", "Тапсырыс құру")
                  : f === "account"
                    ? t("Добавить счёт", "Шот қосу")
                    : f === "money"
                      ? t("Денежная операция", "Ақша операциясы")
                      : t("Обязательство поставщику", "Жеткізушіге міндеттеме")}
              </button>
            ))}
          </div>
        )}
      </section>
      {!!error && (
        <div role="alert" className="commerce-alert">
          {errorMessage}
        </div>
      )}
      {success && (
        <p role="status" className="commerce-success">
          {t(
            "Операция сохранена. Данные обновлены.",
            "Операция сақталды. Деректер жаңартылды.",
          )}
        </p>
      )}
      {loading && <p role="status">{t("Загрузка…", "Жүктелуде…")}</p>}
      {(form || operation) && (
        <section
          className="panel commerce-editor"
          ref={editor}
          aria-label={t("Форма операции", "Операция пішіні")}
        >
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              setForm(null);
              setOperation(null);
            }}
          >
            <ArrowLeft size={16} aria-hidden />
            {t("Закрыть форму", "Пішінді жабу")}
          </button>
          {form === "order" && (
            <form onSubmit={createOrder}>
              <h3>{t("Новый заказ", "Жаңа тапсырыс")}</h3>
              <p>
                {t(
                  "Цены указываются без косвенных налогов. Налоги здесь не рассчитываются. Клиента можно предварительно добавить через импорт в разделе «Клиенты».",
                  "Бағалар жанама салықтарсыз көрсетіледі. Салықтар мұнда есептелмейді. Клиентті «Клиенттер» бөлімінде импорт арқылы алдын ала қосуға болады.",
                )}
              </p>
              <fieldset disabled={busy}>
                <div className="commerce-grid">
                  <Field label={t("Поиск клиента", "Клиентті іздеу")}>
                    <input
                      value={customerSearch}
                      onChange={(e) => setCustomerSearch(e.target.value)}
                    />
                  </Field>
                  <Field label={t("Клиент", "Клиент")}>
                    <select
                      name="customer"
                      required
                      aria-label={t("Клиент", "Клиент")}
                    >
                      <option value="">
                        {t("Выберите клиента", "Клиентті таңдаңыз")}
                      </option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t("Склад заказа", "Тапсырыс қоймасы")}>
                    <select
                      name="warehouse"
                      required
                      aria-label={t("Склад заказа", "Тапсырыс қоймасы")}
                    >
                      <option value="">
                        {t("Выберите склад", "Қойманы таңдаңыз")}
                      </option>
                      {warehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {dateField}
                  <Field label={t("Способ исполнения", "Орындау тәсілі")}>
                    <select
                      name="delivery"
                      aria-label={t("Способ исполнения", "Орындау тәсілі")}
                    >
                      <option value="pickup">{t("Выдача", "Беру")}</option>
                      <option value="delivery">
                        {t("Доставка", "Жеткізу")}
                      </option>
                    </select>
                  </Field>
                  {noteField}
                </div>
                <Field
                  label={t("Поиск товара / услуги", "Тауарды / қызметті іздеу")}
                >
                  <input
                    value={itemSearch}
                    onChange={(e) => setItemSearch(e.target.value)}
                  />
                </Field>
                <p>
                  {t(
                    "Поиск загружает до 100 совпадений; выбранные ранее позиции остаются в списке.",
                    "Іздеу 100 сәйкестікке дейін жүктейді; бұрын таңдалған позициялар тізімде қалады.",
                  )}
                </p>
                {Array.from({ length: lineCount }, (_, i) => (
                  <OrderLineEditor
                    key={i}
                    index={i}
                    items={items}
                    locale={locale}
                  />
                ))}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={lineCount >= 30}
                  onClick={() => setLineCount((v) => v + 1)}
                >
                  {t("Добавить строку", "Жол қосу")}
                </button>
                {lineCount > 1 && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setLineCount((v) => v - 1)}
                  >
                    {t("Убрать последнюю строку", "Соңғы жолды алып тастау")}
                  </button>
                )}{" "}
                {submit}
              </fieldset>
            </form>
          )}
          {operation && detail && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void send(`${base}/orders/${detail.order.id}/commands`, {
                  kind: operation.kind,
                  version: detail.order.version,
                  note: field(f, "note"),
                  ...(operation.lineId ? { lineId: operation.lineId } : {}),
                  ...(operation.eventId ? { eventId: operation.eventId } : {}),
                  ...(["fulfill", "return"].includes(operation.kind)
                    ? { quantity: field(f, "quantity") }
                    : {}),
                  ...(operation.service && cost && field(f, "serviceCost")
                    ? { serviceCost: field(f, "serviceCost") }
                    : {}),
                });
              }}
            >
              <h3>
                {word(operation.kind)} · №{detail.order.number}
              </h3>
              <p>
                {operation.kind === "confirm"
                  ? t(
                      "Будет зарезервирован весь товар. При нехватке хотя бы одной позиции заказ останется черновиком.",
                      "Барлық тауар резервтеледі. Бір позиция жетпесе, тапсырыс жоба күйінде қалады.",
                    )
                  : operation.kind === "cancel"
                    ? t(
                        "Отменяется только неисполненный остаток. Оплата автоматически не возвращается.",
                        "Тек орындалмаған қалдық жойылады. Төлем автоматты түрде қайтарылмайды.",
                      )
                    : operation.kind === "return"
                      ? t(
                          "Возврат уменьшает выручку и возвращает товар на склад. Возврат денег проводится отдельно.",
                          "Қайтару түсімді азайтып, тауарды қоймаға қайтарады. Ақшаны қайтару бөлек жүргізіледі.",
                        )
                      : t(
                          "Будет зафиксировано исполнение, выручка и складское списание товара.",
                          "Орындау, түсім және тауарды қоймадан шығару тіркеледі.",
                        )}
              </p>
              <fieldset disabled={busy} className="commerce-grid">
                {["fulfill", "return"].includes(operation.kind) && (
                  <Field
                    label={t(
                      "Количество в единицах строки",
                      "Жол бірлігіндегі саны",
                    )}
                  >
                    <input
                      name="quantity"
                      inputMode="decimal"
                      required
                      defaultValue="1"
                    />
                  </Field>
                )}
                {operation.service && cost && (
                  <Field
                    label={t(
                      "Себестоимость этой части услуги, ₸ (если известна)",
                      "Қызметтің осы бөлігінің өзіндік құны, ₸ (белгілі болса)",
                    )}
                  >
                    <input name="serviceCost" inputMode="decimal" />
                  </Field>
                )}
                {noteField}
                {submit}
              </fieldset>
            </form>
          )}
          {form === "account" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void send(`${base}/finance/accounts`, {
                  branchId: branch,
                  name: field(f, "name"),
                  opening: field(f, "opening"),
                });
              }}
            >
              <h3>{t("Новый денежный счёт · KZT", "Жаңа ақша шоты · KZT")}</h3>
              <fieldset className="commerce-grid" disabled={busy}>
                <Field label={t("Название счёта", "Шот атауы")}>
                  <input name="name" required minLength={2} maxLength={80} />
                </Field>
                <Field label={t("Начальный остаток, ₸", "Бастапқы қалдық, ₸")}>
                  <input
                    name="opening"
                    defaultValue="0"
                    required
                    inputMode="decimal"
                  />
                </Field>
                {submit}
              </fieldset>
            </form>
          )}
          {form === "obligation" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void send(`${base}/finance/obligations`, {
                  branchId: branch,
                  supplier: field(f, "supplier"),
                  amount: field(f, "amount"),
                  dueDate: field(f, "due"),
                  note: field(f, "note"),
                });
              }}
            >
              <h3>
                {t(
                  "Обязательство перед поставщиком",
                  "Жеткізуші алдындағы міндеттеме",
                )}
              </h3>
              <p>
                {t(
                  "Ручное обязательство не подтверждает приёмку товара и не начисляет расход повторно.",
                  "Қолмен енгізілген міндеттеме тауарды қабылдауды растамайды және шығысты қайта есептемейді.",
                )}
              </p>
              <fieldset disabled={busy} className="commerce-grid">
                <Field label={t("Поставщик", "Жеткізуші")}>
                  <input name="supplier" required minLength={2} />
                </Field>
                <Field label={t("Сумма, ₸", "Сома, ₸")}>
                  <input name="amount" required inputMode="decimal" />
                </Field>
                {dateField}
                {noteField}
                {submit}
              </fieldset>
            </form>
          )}
          {form === "money" && (
            <form onSubmit={submitMoney}>
              <h3>{t("Денежная операция", "Ақша операциясы")}</h3>
              <p>
                {t(
                  "Денежная операция отражает фактическое движение. Плановые платежи остаются обязательствами.",
                  "Ақша операциясы нақты қозғалысты көрсетеді. Жоспарланған төлемдер міндеттеме болып қалады.",
                )}
              </p>
              <fieldset disabled={busy} className="commerce-grid">
                <Field label={t("Вид операции", "Операция түрі")}>
                  <select
                    aria-label={t("Вид операции", "Операция түрі")}
                    value={moneyKind}
                    onChange={(e) => setMoneyKind(e.target.value)}
                  >
                    {[
                      "payment",
                      "refund",
                      "supplier_payment",
                      "income",
                      "expense",
                      "transfer",
                    ].map((k) => (
                      <option key={k} value={k}>
                        {word(k)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("Денежный счёт", "Ақша шоты")}>
                  <select
                    name="account"
                    required
                    aria-label={t("Денежный счёт", "Ақша шоты")}
                  >
                    <option value="">
                      {t("Выберите счёт", "Шотты таңдаңыз")}
                    </option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} · {moneyText(a.balance_minor)} ₸
                      </option>
                    ))}
                  </select>
                </Field>
                {["payment", "refund"].includes(moneyKind) && (
                  <Field label={t("Заказ", "Тапсырыс")}>
                    <select
                      name="order"
                      required
                      defaultValue={selected}
                      aria-label={t("Заказ", "Тапсырыс")}
                    >
                      <option value="">
                        {t(
                          "Выберите заказ из текущей страницы",
                          "Ағымдағы беттен тапсырысты таңдаңыз",
                        )}
                      </option>
                      {orders?.items
                        .filter((o) => o.state !== "draft")
                        .map((o) => (
                          <option key={o.id} value={o.id}>
                            №{o.number} · {o.customer_name}
                          </option>
                        ))}
                    </select>
                  </Field>
                )}
                {moneyKind === "supplier_payment" && (
                  <Field label={t("Обязательство", "Міндеттеме")}>
                    <select
                      name="obligation"
                      required
                      aria-label={t("Обязательство", "Міндеттеме")}
                    >
                      <option value="">
                        {t("Выберите обязательство", "Міндеттемені таңдаңыз")}
                      </option>
                      {obligations?.items.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.supplier} · {o.due_date} ·{" "}
                          {moneyText(
                            String(
                              BigInt(o.amount_minor) - BigInt(o.paid_minor),
                            ),
                          )}{" "}
                          ₸
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {moneyKind === "transfer" && (
                  <Field label={t("Счёт получателя", "Алушы шоты")}>
                    <select
                      name="destination"
                      required
                      aria-label={t("Счёт получателя", "Алушы шоты")}
                    >
                      <option value="">
                        {t("Выберите счёт", "Шотты таңдаңыз")}
                      </option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {["income", "expense"].includes(moneyKind) && (
                  <>
                    <Field label={t("Категория", "Санат")}>
                      <input name="category" required minLength={2} />
                    </Field>
                    <Field label={t("Контрагент", "Контрагент")}>
                      <input name="counterparty" required minLength={2} />
                    </Field>
                  </>
                )}
                {moneyKind === "expense" && (
                  <label className="commerce-check">
                    <input name="operating" type="checkbox" defaultChecked />
                    {t(
                      "Операционный расход (влияет на результат)",
                      "Операциялық шығыс (нәтижеге әсер етеді)",
                    )}
                  </label>
                )}
                <Field label={t("Сумма, ₸", "Сома, ₸")}>
                  <input name="amount" required inputMode="decimal" />
                </Field>
                {noteField}
                {submit}
              </fieldset>
            </form>
          )}
        </section>
      )}
      {mode === "finance" && summary && (
        <>
          <section
            className="commerce-metrics"
            aria-label={t("Финансовая сводка", "Қаржы жиынтығы")}
          >
            {[
              [t("Чистая выручка", "Таза түсім"), summary.revenue_minor],
              [t("Деньги на счетах", "Шоттардағы ақша"), summary.cash_minor],
              [
                t(
                  "Долг клиентов за исполненное",
                  "Орындалған тапсырыс үшін клиент қарызы",
                ),
                summary.receivable_minor,
              ],
              [
                t("Долг поставщикам", "Жеткізушілерге қарыз"),
                summary.payable_minor,
              ],
              [
                t("Себестоимость (известная)", "Өзіндік құн (белгілі)"),
                summary.cost_minor,
              ],
              [t("Валовая прибыль", "Жалпы пайда"), summary.gross_profit_minor],
              [
                t("Операционные расходы", "Операциялық шығыстар"),
                summary.operating_expenses_minor,
              ],
              [
                t(
                  "Операционный результат · неполный",
                  "Операциялық нәтиже · толық емес",
                ),
                summary.operating_result_minor,
              ],
              [
                t(
                  "Просроченный долг клиентов",
                  "Клиенттердің мерзімі өткен қарызы",
                ),
                summary.overdue_minor,
              ],
              [
                t(
                  "Авансы и переплата клиентов",
                  "Клиенттердің авансы мен артық төлемі",
                ),
                summary.customer_credit_minor,
              ],
            ].map(([name, value]) => (
              <article className="panel commerce-metric" key={name}>
                <span>{name}</span>
                <strong>
                  {value === null
                    ? t("Недостаточно данных", "Дерек жеткіліксіз")
                    : `${moneyText(value!)} ₸`}
                </strong>
              </article>
            ))}
          </section>
          <p className="commerce-explanation">
            {t(
              "За весь период, выбранный филиал. Выручка — исполненные строки после скидок и возвратов; оплата показана отдельно. Цены без косвенных налогов, налоговый расчёт не настроен. Операционный результат неполный: полнота расходов не подтверждена.",
              "Бүкіл кезең, таңдалған филиал. Түсім — жеңілдік пен қайтарудан кейін орындалған жолдар; төлем бөлек көрсетіледі. Бағалар жанама салықтарсыз, салық есебі бапталмаған. Операциялық нәтиже толық емес: шығыстардың толықтығы расталмаған.",
            )}{" "}
            {t("Маржа", "Маржа")}: {summary.margin_percent ?? "—"}% ·{" "}
            {t("Наценка", "Үстеме")}: {summary.markup_percent ?? "—"}%
          </p>
          <section className="panel commerce-section">
            <h3>{t("Денежные счета · KZT", "Ақша шоттары · KZT")}</h3>
            {accounts.length ? (
              accounts.map((a) => (
                <div className="commerce-row" key={a.id}>
                  <span>{a.name}</span>
                  <strong>{moneyText(a.balance_minor)} ₸</strong>
                </div>
              ))
            ) : (
              <p>{t("Счетов пока нет.", "Әзірге шоттар жоқ.")}</p>
            )}
          </section>
        </>
      )}
      <section className="panel commerce-section">
        <div className="commerce-list-head">
          <h3>
            {mode === "orders"
              ? t("Заказы", "Тапсырыстар")
              : t("Заказы и сроки оплат", "Тапсырыстар мен төлем мерзімдері")}
          </h3>
          <Field
            label={t(
              "Поиск по клиенту или номеру",
              "Клиент немесе нөмір бойынша іздеу",
            )}
          >
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </Field>
        </div>
        {!loading && !orders?.items.length && (
          <p>{t("Заказов не найдено.", "Тапсырыстар табылмады.")}</p>
        )}
        {orders?.items.map((o) => (
          <button
            className={`commerce-order ${selected === o.id ? "active" : ""}`}
            key={o.id}
            onClick={() => {
              setSelected(o.id);
              setDetail(null);
              setHistoryPage(1);
              setOperation(null);
              setForm(null);
            }}
          >
            <span>
              <strong>
                №{o.number} · {o.customer_name}
              </strong>
              <small>
                {word(o.state)} · {t("Срок", "Мерзім")}: {o.due_date}
              </small>
            </span>
            <span>
              <strong>{moneyText(o.total_minor)} ₸</strong>
              <small>
                {t("Исполнено", "Орындалды")}: {moneyText(o.revenue_minor)} ·{" "}
                {t("Оплачено", "Төленді")}: {moneyText(o.paid_minor)}
              </small>
            </span>
          </button>
        ))}
        <div className="commerce-pagination">
          <button
            className="secondary-button"
            disabled={loading || page === 1}
            onClick={() => setPage((v) => v - 1)}
          >
            {t("Назад", "Артқа")}
          </button>
          <span>
            {t("Страница", "Бет")} {page}
          </span>
          <button
            className="secondary-button"
            disabled={
              loading ||
              page >=
                Math.max(
                  orders?.pagination.pages || 1,
                  ledger?.pagination.pages || 1,
                  obligations?.pagination.pages || 1,
                )
            }
            onClick={() => setPage((v) => v + 1)}
          >
            {t("Далее", "Келесі")}
          </button>
        </div>
      </section>
      {detail && (
        <section
          className="panel commerce-section"
          aria-label={t("Карточка заказа", "Тапсырыс карточкасы")}
        >
          <h3>
            {t("Заказ", "Тапсырыс")} №{detail.order.number} ·{" "}
            {word(detail.order.state)}
          </h3>
          <p>
            {detail.order.customer_name} ·{" "}
            {detail.order.delivery === "delivery"
              ? t("Доставка", "Жеткізу")
              : t("Выдача", "Беру")}{" "}
            · {detail.order.note}
          </p>
          <div className="commerce-order-totals">
            <p>
              {t("Долг за исполненное", "Орындалған тапсырыс қарызы")}:{" "}
              <strong>{moneyText(detail.order.receivable_minor)} ₸</strong>
            </p>
            <p>
              {t(
                "Ожидается по всему заказу",
                "Бүкіл тапсырыс бойынша күтіледі",
              )}
              : <strong>{moneyText(detail.order.expected_minor)} ₸</strong>
            </p>
            <p>
              {t(
                "Переплата после отмены / возврата",
                "Бас тарту / қайтарудан кейінгі артық төлем",
              )}
              : <strong>{moneyText(detail.order.credit_minor)} ₸</strong>
            </p>
          </div>
          {mode === "orders" && write && (
            <div className="commerce-actions">
              {detail.order.state === "draft" && (
                <button
                  className="primary-button"
                  disabled={loading || busy}
                  onClick={() => {
                    setOperation({ kind: "confirm" });
                    setForm(null);
                  }}
                >
                  {t("Подтвердить и зарезервировать", "Растау және резервтеу")}
                </button>
              )}
              {["draft", "confirmed", "partial"].includes(
                detail.order.state,
              ) && (
                <button
                  className="secondary-button"
                  disabled={loading || busy}
                  onClick={() => {
                    setOperation({ kind: "cancel" });
                    setForm(null);
                  }}
                >
                  {t("Отменить остаток", "Қалдықты болдырмау")}
                </button>
              )}
            </div>
          )}
          {detail.lines.map((l) => (
            <article key={l.id} className="commerce-line-card">
              <div>
                <strong>
                  {locale === "kk" && l.name_kk ? l.name_kk : l.name_ru} ·{" "}
                  {l.sku}
                </strong>
                <p>
                  {quantityText(l.quantity)} {l.unit} × {quantityText(l.price)}{" "}
                  ₸ · {t("Скидка", "Жеңілдік")} {quantityText(l.discount)}% ·{" "}
                  {moneyText(l.total_minor)} ₸
                </p>
                <p>
                  {t("Исполнено", "Орындалды")}: {quantityText(l.fulfilled)} ·{" "}
                  {t("Возвращено", "Қайтарылды")}: {quantityText(l.returned)}
                </p>
              </div>
              {mode === "orders" &&
                write &&
                ["confirmed", "partial"].includes(detail.order.state) &&
                l.fulfilled !== l.quantity && (
                  <button
                    className="secondary-button"
                    disabled={busy || loading}
                    onClick={() => {
                      setOperation({
                        kind: "fulfill",
                        lineId: l.id,
                        service: l.kind === "service",
                      });
                      setForm(null);
                    }}
                  >
                    {t("Исполнить часть", "Бір бөлігін орындау")}
                  </button>
                )}
            </article>
          ))}
          <h4>
            {t(
              "История и связанные операции",
              "Тарих және байланысты операциялар",
            )}
          </h4>
          <div className="commerce-pagination">
            <button
              className="secondary-button"
              disabled={loading || historyPage === 1}
              onClick={() => setHistoryPage((v) => v - 1)}
            >
              {t("Новые события", "Жаңа оқиғалар")}
            </button>
            <span>
              {historyPage} / {detail.eventPagination.pages || 1}
            </span>
            <button
              className="secondary-button"
              disabled={loading || historyPage >= detail.eventPagination.pages}
              onClick={() => setHistoryPage((v) => v + 1)}
            >
              {t("Предыдущие события", "Бұрынғы оқиғалар")}
            </button>
          </div>
          {detail.events.map((e) => (
            <article className="commerce-event" key={e.id}>
              <div>
                <strong>{word(e.kind)}</strong>
                <small>
                  {businessDate(
                    new Date(e.created_at),
                    locale,
                    org.timezone,
                    true,
                  )}{" "}
                  · {e.actor_name}
                </small>
                <p>
                  {e.note}
                  {e.line_id ? ` · ${quantityText(e.quantity)}` : ""}
                  {e.kind === "fulfill" || e.kind === "return"
                    ? ` · ${t("Выручка", "Түсім")}: ${moneyText(e.revenue_minor)} ₸`
                    : ""}
                </p>
                {e.cost_minor !== undefined &&
                  ["fulfill", "return"].includes(e.kind) && (
                    <small>
                      {t("Себестоимость", "Өзіндік құн")}:{" "}
                      {e.cost_minor === null
                        ? t("Не указана", "Көрсетілмеген")
                        : `${moneyText(e.cost_minor)} ₸`}
                    </small>
                  )}
                {e.source_id && (
                  <small>
                    {t("Исходное исполнение", "Бастапқы орындау")}:{" "}
                    {e.source_id}
                  </small>
                )}
              </div>
              {mode === "orders" && write && e.kind === "fulfill" && (
                <button
                  className="secondary-button"
                  disabled={busy || loading}
                  onClick={() => {
                    setOperation({ kind: "return", eventId: e.id });
                    setForm(null);
                  }}
                >
                  {t("Оформить возврат", "Қайтаруды рәсімдеу")}
                </button>
              )}
            </article>
          ))}
        </section>
      )}
      {mode === "finance" && (
        <>
          <PaymentCalendar
            key={branch}
            base={base}
            branch={branch}
            revision={revision}
            locale={locale}
            onOrder={(id) => {
              setSelected(id);
              setDetail(null);
              setHistoryPage(1);
            }}
          />
          <section className="panel commerce-section">
            <h3>
              {t(
                "Обязательства и сроки поставщиков",
                "Жеткізушілердің міндеттемелері мен мерзімдері",
              )}
            </h3>
            {!obligations?.items.length && (
              <p>{t("Обязательств нет.", "Міндеттемелер жоқ.")}</p>
            )}
            {obligations?.items.map((o) => (
              <article className="commerce-line-card" key={o.id}>
                <div>
                  <strong>{o.supplier}</strong>
                  <p>
                    {o.note} · {o.due_date}
                  </p>
                </div>
                <div>
                  {t("Осталось", "Қалды")}:{" "}
                  {moneyText(
                    String(BigInt(o.amount_minor) - BigInt(o.paid_minor)),
                  )}{" "}
                  ₸
                  <small>
                    {t("Оплачено", "Төленді")}: {moneyText(o.paid_minor)} ₸
                  </small>
                </div>
              </article>
            ))}
          </section>
          <section className="panel commerce-section">
            <h3>{t("Журнал денег", "Ақша журналы")}</h3>
            {!ledger?.items.length && (
              <p>{t("Операций нет.", "Операциялар жоқ.")}</p>
            )}
            {ledger?.items.map((e) => (
              <article className="commerce-event" key={e.id}>
                <div>
                  <strong>
                    {word(e.kind)} · {e.account_name}
                  </strong>
                  <small>
                    {businessDate(
                      new Date(e.created_at),
                      locale,
                      org.timezone,
                      true,
                    )}
                  </small>
                  <p>
                    {e.note} · {e.counterparty}
                    {["income", "expense"].includes(e.kind)
                      ? ` · ${e.category}`
                      : ""}
                  </p>
                  {e.order_id && (
                    <button
                      className="text-button"
                      onClick={() => {
                        setSelected(e.order_id!);
                        setDetail(null);
                        setHistoryPage(1);
                      }}
                    >
                      {t(
                        "Открыть связанный заказ",
                        "Байланысты тапсырысты ашу",
                      )}
                    </button>
                  )}
                </div>
                <strong>{moneyText(e.amount_minor)} ₸</strong>
              </article>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
function OrderLineEditor({
  index,
  items,
  locale,
}: {
  index: number;
  items: Item[];
  locale: Locale;
}) {
  const [id, setId] = useState(""),
    item = items.find((i) => i.id === id),
    t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  return (
    <div className="commerce-order-line">
      <h4>
        {t("Строка", "Жол")} {index + 1}
      </h4>
      <div className="commerce-grid">
        <Field label={t("Позиция", "Позиция")}>
          <select
            name={`item${index}`}
            required
            aria-label={`${t("Позиция", "Позиция")} ${index + 1}`}
            value={id}
            onChange={(e) => setId(e.target.value)}
          >
            <option value="">
              {t("Выберите товар / услугу", "Тауарды / қызметті таңдаңыз")}
            </option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.sku} · {locale === "kk" && i.name_kk ? i.name_kk : i.name_ru}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Количество", "Саны")}>
          <input
            name={`quantity${index}`}
            aria-label={`${t("Количество", "Саны")} ${index + 1}`}
            required
            defaultValue="1"
            inputMode="decimal"
          />
        </Field>
        <Field label={t("Единица", "Бірлік")}>
          <select
            key={id}
            name={`unit${index}`}
            required
            aria-label={`${t("Единица", "Бірлік")} ${index + 1}`}
          >
            {item &&
              [item.base_unit, ...item.conversions.map((c) => c.unit)].map(
                (u) => <option key={u}>{u}</option>,
              )}
          </select>
        </Field>
        <Field
          label={t(
            "Цена за выбранную единицу, ₸",
            "Таңдалған бірлік бағасы, ₸",
          )}
        >
          <input
            key={id}
            name={`price${index}`}
            aria-label={`${t("Цена", "Баға")} ${index + 1}`}
            required
            defaultValue={item?.sale_price ?? ""}
            inputMode="decimal"
          />
        </Field>
        <Field label={t("Скидка, %", "Жеңілдік, %")}>
          <input
            name={`discount${index}`}
            aria-label={`${t("Скидка", "Жеңілдік")} ${index + 1}`}
            defaultValue="0"
            required
            inputMode="decimal"
          />
        </Field>
      </div>
      <p>
        {t(
          "При другой единице пересчитайте цену явно; цена каталога указана за базовую единицу.",
          "Басқа бірлік үшін бағаны қайта есептеңіз; каталог бағасы негізгі бірлікке берілген.",
        )}
      </p>
    </div>
  );
}
