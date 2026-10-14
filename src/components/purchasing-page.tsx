"use client";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { z } from "zod";
import type { Locale, Workspace } from "@/domain/contracts";
import type { Item, Warehouse, CatalogView } from "@/domain/inventory";
import {
  supplierList,
  purchaseList,
  documentList,
  needView,
  budgetView,
  type Comparison,
  type PurchaseDetail,
  type DocumentView,
} from "@/domain/purchasing";
import { api, ApiError } from "@/lib/client";
import { errorText } from "@/lib/i18n";
import { moneyText, quantityText, inventoryError } from "@/lib/inventory-i18n";
import { can } from "@/domain/permissions";
import { executionError } from "@/lib/execution-i18n";
const f = (data: FormData, n: string) => String(data.get(n) || "").trim();
// Exact minor units → "123.45" without binary floating point.
const minorInput = (minor: string) => {
  const digits = minor.padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
};
const words: Record<string, [string, string]> = {
  draft: ["Черновик", "Жоба"],
  pending: ["На согласовании", "Келісуде"],
  approved: ["Одобрено", "Мақұлданды"],
  sent: ["Отправлено вручную", "Қолмен жіберілді"],
  partial: ["Частично принято", "Ішінара қабылданды"],
  completed: ["Принято полностью", "Толық қабылданды"],
  cancelled: ["Отменено", "Бас тартылды"],
  review: ["Нужна проверка", "Тексеру қажет"],
  characteristics: [
    "Не подтверждены характеристики",
    "Сипаттамалар расталмаған",
  ],
  delivery: ["Неизвестна доставка", "Жеткізу құны белгісіз"],
  tax: ["Неизвестны налоги", "Салықтар белгісіз"],
  exchange_rate: [
    "Нет курса с источником и датой",
    "Курс, дереккөз және күн жоқ",
  ],
  expired: ["Цена не действует на эту дату", "Бұл күнге баға жарамсыз"],
  quantity_limit: ["Превышен предел количества", "Сан шегі асты"],
  insufficient_history: [
    "Мало истории: расчёт по минимальному запасу",
    "Тарих аз: ең аз қор бойынша есеп",
  ],
  stockout_days_excluded: [
    "Дни без остатка исключены из оценки спроса",
    "Қорсыз күндер сұраныс есебінен алынды",
  ],
  zero_sales_not_zero_demand: [
    "Нулевые продажи не доказывают отсутствие спроса",
    "Нөлдік сату сұраныс жоқтығын дәлелдемейді",
  ],
  budget: ["Отложено: недостаточно бюджета", "Кейінге: бюджет жеткіліксіз"],
  review_conditions: [
    "Нужно уточнить условия и оценки поставщика",
    "Жеткізуші шарттары мен бағасын нақтылау керек",
  ],
  within_budget: ["Помещается в бюджет", "Бюджетке сай"],
};
const errors: Record<string, [string, string]> = {
  SUPPLIER_EXISTS: [
    "Поставщик с таким названием уже есть.",
    "Осындай жеткізуші бар.",
  ],
  OFFER_INCOMPARABLE: [
    "Сначала уточните неизвестные условия предложения.",
    "Алдымен ұсыныстың белгісіз шарттарын нақтылаңыз.",
  ],
  DELIVERY_CONFLICT: [
    "В выбранных прайсах различается стоимость доставки. Уточните предложение поставщика.",
    "Таңдалған прайстарда жеткізу құны әртүрлі. Жеткізуші ұсынысын нақтылаңыз.",
  ],
  BUDGET_EXCEEDED: [
    "Сумма закупки превышает бюджет.",
    "Сатып алу сомасы бюджеттен асады.",
  ],
  DUPLICATE_DOCUMENT: [
    "Этот файл, внешний ID или номер документа с поставщиком и датой уже зарегистрирован. Откройте существующий документ.",
    "Осы файл, сыртқы ID немесе жеткізуші мен күні бар құжат нөмірі тіркелген. Бар құжатты ашыңыз.",
  ],
  DOCUMENT_NOT_APPROVED: [
    "Сначала проверьте и подтвердите документ.",
    "Алдымен құжатты тексеріп растаңыз.",
  ],
  DOCUMENT_TOTAL_MISMATCH: [
    "Итог должен равняться сумме строк и доставки. Сумма должна быть больше нуля.",
    "Қорытынды жолдар мен жеткізу сомасына тең және нөлден үлкен болуы керек.",
  ],
  DISCREPANCY_REVIEW_REQUIRED: [
    "Есть расхождения с заказом. Проверьте строки и явно подтвердите расхождения.",
    "Тапсырыспен айырмашылықтар бар. Жолдарды тексеріп, айырмашылықтарды растаңыз.",
  ],
  ITEM_MISMATCH: [
    "Проверьте товар, базовую единицу и его наличие в заказе.",
    "Тауарды, негізгі бірлікті және тапсырыста болуын тексеріңіз.",
  ],
  ORDER_STATE: [
    "Действие недоступно в текущем состоянии заказа.",
    "Әрекет тапсырыстың ағымдағы күйінде қолжетімсіз.",
  ],
  DOCUMENT_APPROVED: [
    "Документ уже подтверждён и сохранён в истории.",
    "Құжат расталған және тарихта сақталған.",
  ],
  QUANTITY_EXCEEDS: [
    "Количество больше остатка по документу или заказу.",
    "Саны құжат немесе тапсырыс қалдығынан асады.",
  ],
  DOCUMENT_FORMAT_UNSUPPORTED: [
    "Выберите CSV, TSV, PDF, PNG или JPEG.",
    "CSV, TSV, PDF, PNG немесе JPEG таңдаңыз.",
  ],
  DOCUMENT_PARSE_FAILED: [
    "Не удалось прочитать файл. Проверьте формат, качество и отсутствие пароля.",
    "Файл оқылмады. Пішімін, сапасын және құпиясөз жоқтығын тексеріңіз.",
  ],
  IMAGE_TOO_LARGE: [
    "Изображение больше 16 мегапикселей.",
    "Кескін 16 мегапиксельден үлкен.",
  ],
  DOCUMENT_PAGE_LIMIT: [
    "Документ должен содержать не больше 5 страниц.",
    "Құжат 5 беттен аспауы керек.",
  ],
  LINE_DECISION_REQUIRED: [
    "Есть строки вне заказа или без товара каталога. Выберите для каждой: замена, отклонить или отдельная закупка.",
    "Тапсырыстан тыс немесе каталог тауарынсыз жолдар бар. Әрқайсысына шешім таңдаңыз: ауыстыру, қабылдамау немесе бөлек сатып алу.",
  ],
  UNIT_MISMATCH: [
    "Замена должна иметь ту же базовую единицу, что и заказанный товар.",
    "Ауыстыру тапсырыс берілген тауармен бірдей негізгі бірлікте болуы керек.",
  ],
  DELIVERY_WITHOUT_LINES: [
    "Доставку нельзя принять без принятых строк.",
    "Қабылданған жолдарсыз жеткізуді қабылдауға болмайды.",
  ],
  SPLIT_NESTED: [
    "Документ отдельной закупки нельзя ещё раз разделить.",
    "Бөлек сатып алу құжатын қайта бөлуге болмайды.",
  ],
  QUANTITY_BELOW_RECEIVED: [
    "Количество не может быть меньше уже принятого на склад.",
    "Саны қоймаға қабылданғаннан аз бола алмайды.",
  ],
  VALUE_BELOW_RECEIVED: [
    "Сумма строки не может быть меньше стоимости уже принятого товара.",
    "Жол сомасы қабылданған тауар құнынан аз бола алмайды.",
  ],
  OBLIGATION_PAID_EXCEEDS: [
    "Долг нельзя уменьшить ниже уже оплаченной суммы.",
    "Қарызды төленген сомадан төмен азайтуға болмайды.",
  ],
  ADJUSTMENT_TO_ZERO: [
    "Корректировка не может обнулить долг. Используйте отмену с основанием.",
    "Түзету қарызды нөлге түсіре алмайды.",
  ],
  DOCUMENT_PROCESSOR_BUSY: [
    "Распознавание занято. Повторите позже.",
    "Тану бос емес. Кейінірек қайталаңыз.",
  ],
};
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="commerce-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function ActionForm({
  locale,
  label,
  submit,
  children,
}: {
  locale: Locale;
  label: string;
  submit: (data: FormData, key: string) => Promise<void>;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [ok, setOk] = useState(false);
  const retry = useRef<{ signature: string; key: string } | null>(null);
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const data = new FormData(e.currentTarget),
      signature = JSON.stringify(
        [...data.entries()].map(([k, v]) => [
          k,
          typeof v === "string" ? v : [v.name, v.size, v.lastModified],
        ]),
      );
    if (retry.current?.signature !== signature)
      retry.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    setOk(false);
    try {
      await submit(data, retry.current.key);
      retry.current = null;
      setOk(true);
    } catch (e) {
      const code =
        e instanceof ApiError
          ? e.code
          : e instanceof Error
            ? e.message
            : "INTERNAL_ERROR";
      setError(
        errors[code]?.[locale === "ru" ? 0 : 1] ||
          executionError(code, locale) ||
          inventoryError(code, locale) ||
          errorText(code, locale),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={send}>
      <fieldset disabled={busy} className="commerce-grid">
        {children}
        <div className="procurement-submit">
          <button type="submit" className="primary-button">
            {busy ? (locale === "ru" ? "Обрабатываем…" : "Өңделуде…") : label}
          </button>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="commerce-alert">
          {error}
        </p>
      )}
      {ok && (
        <p role="status" className="commerce-success">
          {locale === "ru" ? "Готово" : "Дайын"}
        </p>
      )}
    </form>
  );
}
export function PurchasingPage({
  workspace,
  locale,
}: {
  workspace: Workspace;
  locale: Locale;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk),
    word = (key: string) => words[key]?.[locale === "ru" ? 0 : 1] || key,
    base = `organizations/${workspace.organization.id}`,
    write = can(workspace.organization.role, "purchasing:write"),
    approve = can(workspace.organization.role, "purchasing:approve");
  const [tab, setTab] = useState<"orders" | "suppliers" | "planning">("orders"),
    [branch, setBranch] = useState(workspace.branches[0]?.id || ""),
    [revision, setRevision] = useState(0),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [suppliers, setSuppliers] = useState<z.infer<
      typeof supplierList
    > | null>(null),
    [supplierPage, setSupplierPage] = useState(1),
    [supplierSearch, setSupplierSearch] = useState("");
  const [items, setItems] = useState<Item[]>([]),
    [itemSearch, setItemSearch] = useState(""),
    [warehouses, setWarehouses] = useState<Warehouse[]>([]),
    [orders, setOrders] = useState<z.infer<typeof purchaseList> | null>(null),
    [selected, setSelected] = useState(""),
    [loadedDetail, setDetail] = useState<PurchaseDetail | null>(null),
    [historyPage, setHistoryPage] = useState(1);
  const [compared, setCompared] = useState<Comparison | null>(null),
    [basket, setBasket] = useState<
      {
        offer: Comparison["offers"][number];
        itemName: string;
        quantity: string;
      }[]
    >([]),
    [docs, setDocs] = useState<z.infer<typeof documentList> | null>(null),
    [docPage, setDocPage] = useState(1),
    [docId, setDocId] = useState(""),
    [extraRows, setExtraRows] = useState(0),
    [loadedDoc, setDoc] = useState<DocumentView | null>(null);
  const [need, setNeed] = useState<z.infer<typeof needView> | null>(null),
    [budget, setBudget] = useState<z.infer<typeof budgetView> | null>(null);
  const detail = loadedDetail?.order.id === selected ? loadedDetail : null,
    doc = loadedDoc?.document.id === docId ? loadedDoc : null;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: workspace.organization.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const refresh = () => setRevision((v) => v + 1),
    post = (path: string, body: unknown) =>
      api<{ id: string }>(`${base}/${path}`, "POST", body);
  useEffect(() => {
    let live = true;
    Promise.all([
      api<z.infer<typeof supplierList>>(
        `${base}/suppliers?limit=100&page=${supplierPage}&q=${encodeURIComponent(supplierSearch)}`,
      ),
      api<CatalogView>(
        `${base}/catalog?limit=100&q=${encodeURIComponent(itemSearch)}`,
      ),
      api<{ items: Warehouse[] }>(`${base}/warehouses?branchId=${branch}`),
    ])
      .then(([s, c, w]) => {
        if (live) {
          setSuppliers(s);
          setItems(c.items);
          setWarehouses(w.items);
        }
      })
      .catch((e) => {
        if (live) setError(e.code || "INTERNAL_ERROR");
      });
    return () => {
      live = false;
    };
  }, [base, branch, revision, itemSearch, supplierPage, supplierSearch]);
  useEffect(() => {
    let live = true;
    api<z.infer<typeof purchaseList>>(
      `${base}/purchases?branchId=${branch}&page=${page}&q=${encodeURIComponent(search)}`,
    )
      .then((v) => {
        if (live) {
          setOrders(v);
          setError("");
        }
      })
      .catch((e) => {
        if (live) setError(e.code || "INTERNAL_ERROR");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [base, branch, page, search, revision]);
  useEffect(() => {
    let live = true;
    if (!selected) {
      return;
    }
    Promise.all([
      api<PurchaseDetail>(`${base}/purchases/${selected}?page=${historyPage}`),
      api<z.infer<typeof documentList>>(
        `${base}/purchase-documents?orderId=${selected}&page=${docPage}`,
      ),
    ])
      .then(([o, d]) => {
        if (live) {
          setDetail(o);
          setDocs(d);
        }
      })
      .catch((e) => {
        if (live) setError(e.code || "INTERNAL_ERROR");
      });
    return () => {
      live = false;
    };
  }, [base, selected, revision, historyPage, docPage]);
  useEffect(() => {
    let live = true;
    if (!docId) {
      return;
    }
    api<DocumentView>(`${base}/purchase-documents/${docId}`)
      .then((d) => {
        if (live) setDoc(d);
      })
      .catch((e) => {
        if (live) setError(e.code || "INTERNAL_ERROR");
      });
    return () => {
      live = false;
    };
  }, [base, docId, revision]);
  const itemSelect = (name = "itemId", value?: string) => (
    <Field label={t("Товар", "Тауар")}>
      <select name={name} required defaultValue={value}>
        <option value="">{t("Выберите товар", "Тауар таңдаңыз")}</option>
        {items
          .filter((i) => i.kind === "goods")
          .map((i) => (
            <option key={i.id} value={i.id}>
              {i.sku} · {locale === "kk" && i.name_kk ? i.name_kk : i.name_ru} (
              {i.base_unit})
            </option>
          ))}
      </select>
    </Field>
  );
  const warehouseSelect = (
    <Field label={t("Склад", "Қойма")}>
      <select name="warehouseId" required>
        <option value="">{t("Выберите склад", "Қойма таңдаңыз")}</option>
        {warehouses.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
    </Field>
  );
  const supplierSelect = (
    <Field label={t("Поставщик", "Жеткізуші")}>
      <select name="supplierId" required>
        <option value="">
          {t("Выберите поставщика", "Жеткізуші таңдаңыз")}
        </option>
        {suppliers?.items.map((s) => (
          <option key={s.id} value={s.id}>
            {s.data.name}
          </option>
        ))}
      </select>
    </Field>
  );
  const number = (name: string, label: string, value = "", required = true) => (
    <Field label={label}>
      <input
        name={name}
        inputMode="decimal"
        defaultValue={value}
        required={required}
        pattern="[0-9]+([.][0-9]+)?"
      />
    </Field>
  );
  const note = (
    <Field label={t("Основание / комментарий", "Негізі / түсініктеме")}>
      <input name="note" required minLength={3} maxLength={250} />
    </Field>
  );
  const pagination = (
    current: number,
    total: number,
    change: (v: number) => void,
  ) => (
    <div className="commerce-pagination">
      <button
        type="button"
        className="secondary-button"
        disabled={current <= 1}
        onClick={() => change(current - 1)}
      >
        {t("Назад", "Артқа")}
      </button>
      <span>
        {current} / {Math.max(1, total)}
      </span>
      <button
        type="button"
        className="secondary-button"
        disabled={current >= total}
        onClick={() => change(current + 1)}
      >
        {t("Далее", "Әрі қарай")}
      </button>
    </div>
  );
  async function download() {
    if (!doc) return;
    const file = await api<{ filename: string; content: string }>(
        `${base}/purchase-documents/${doc.document.id}/original`,
      ),
      bytes = Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0)),
      url = URL.createObjectURL(
        new Blob([bytes], { type: "application/octet-stream" }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = file.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="commerce-page inventory-page procurement-page">
      <section className="panel commerce-toolbar">
        <Field label={t("Филиал", "Филиал")}>
          <select
            value={branch}
            onChange={(e) => {
              setBranch(e.target.value);
              setPage(1);
              setSelected("");
              setDocId("");
            }}
          >
            {workspace.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="commerce-actions">
          {(["orders", "suppliers", "planning"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={tab === v}
              className="secondary-button"
              onClick={() => setTab(v)}
            >
              {
                {
                  orders: t("Закупки и приёмка", "Сатып алу және қабылдау"),
                  suppliers: t(
                    "Поставщики и прайсы",
                    "Жеткізушілер мен прайстар",
                  ),
                  planning: t("Потребность и бюджет", "Қажеттілік және бюджет"),
                }[v]
              }
            </button>
          ))}
          <button type="button" className="secondary-button" onClick={refresh}>
            {t("Обновить", "Жаңарту")}
          </button>
        </div>
      </section>
      {error && (
        <p role="alert" className="commerce-alert">
          {errors[error]?.[locale === "ru" ? 0 : 1] || errorText(error, locale)}
        </p>
      )}
      <section className="panel commerce-section">
        <Field
          label={t(
            "Поиск товара для выбора (до 100 совпадений)",
            "Таңдау үшін тауар іздеу (100 сәйкестікке дейін)",
          )}
        >
          <input
            value={itemSearch}
            onChange={(e) => setItemSearch(e.target.value)}
            maxLength={80}
          />
        </Field>
      </section>
      {tab === "suppliers" && (
        <>
          <section className="panel commerce-section">
            <h2>{t("Поставщики", "Жеткізушілер")}</h2>
            <Field label={t("Поиск поставщика", "Жеткізушіні іздеу")}>
              <input
                value={supplierSearch}
                onChange={(e) => {
                  setSupplierSearch(e.target.value);
                  setSupplierPage(1);
                }}
              />
            </Field>
            {suppliers?.items.map((s) => (
              <article className="commerce-row" key={s.id}>
                <strong>{s.data.name}</strong>
                <span>
                  {s.data.contact} · {s.data.paymentTerms}
                </span>
                <small>
                  {t("Качество / надёжность", "Сапа / сенімділік")}:{" "}
                  {s.data.quality ?? "?"} / {s.data.reliability ?? "?"}
                </small>
              </article>
            ))}
            {suppliers &&
              pagination(
                supplierPage,
                suppliers.pagination.pages,
                setSupplierPage,
              )}
            {write && (
              <details>
                <summary>
                  {t("Добавить поставщика", "Жеткізушіні қосу")}
                </summary>
                <ActionForm
                  locale={locale}
                  label={t("Сохранить поставщика", "Жеткізушіні сақтау")}
                  submit={async (d, key) => {
                    await post("suppliers", {
                      key,
                      name: f(d, "name"),
                      contact: f(d, "contact"),
                      paymentTerms: f(d, "terms"),
                      quality: f(d, "quality") ? Number(f(d, "quality")) : null,
                      reliability: f(d, "reliability")
                        ? Number(f(d, "reliability"))
                        : null,
                    });
                    refresh();
                  }}
                >
                  <Field label={t("Название", "Атауы")}>
                    <input name="name" required minLength={2} maxLength={120} />
                  </Field>
                  <Field label={t("Контакт", "Байланыс")}>
                    <input name="contact" maxLength={200} />
                  </Field>
                  <Field label={t("Условия оплаты", "Төлем шарттары")}>
                    <input name="terms" maxLength={250} />
                  </Field>
                  {["quality", "reliability"].map((n) => (
                    <Field
                      key={n}
                      label={
                        n === "quality"
                          ? t("Оценка качества", "Сапа бағасы")
                          : t("Оценка надёжности", "Сенімділік бағасы")
                      }
                    >
                      <select name={n}>
                        <option value="">{t("Неизвестно", "Белгісіз")}</option>
                        {[1, 2, 3, 4, 5].map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    </Field>
                  ))}
                </ActionForm>
              </details>
            )}
          </section>
          {write && (
            <section className="panel commerce-section">
              <h2>
                {t("Новое предложение поставщика", "Жеткізушінің жаңа ұсынысы")}
              </h2>
              <p>
                {t(
                  "Упаковка задаётся в базовых единицах выбранного SKU. Новая цена сохраняется отдельным предложением с датой.",
                  "Қаптама таңдалған SKU негізгі бірліктерімен беріледі. Жаңа баға күні бар бөлек ұсыныс болып сақталады.",
                )}
              </p>
              <ActionForm
                locale={locale}
                label={t("Сохранить предложение", "Ұсынысты сақтау")}
                submit={async (d, key) => {
                  const item = items.find((i) => i.id === f(d, "itemId"));
                  await post("supplier-offers", {
                    key,
                    supplierId: f(d, "supplierId"),
                    itemId: f(d, "itemId"),
                    supplierSku: f(d, "supplierSku"),
                    packQuantity: f(d, "packQuantity"),
                    baseUnit: item?.base_unit,
                    packPrice: f(d, "packPrice"),
                    minimumPacks: Number(f(d, "minimumPacks")),
                    delivery: f(d, "delivery") || null,
                    leadDays: f(d, "leadDays")
                      ? Number(f(d, "leadDays"))
                      : null,
                    currency: f(d, "currency"),
                    rate: f(d, "rate") || null,
                    rateDate: f(d, "rateDate") || null,
                    rateSource: f(d, "rateSource"),
                    tax: f(d, "tax"),
                    taxPercent: f(d, "taxPercent") || null,
                    dated: f(d, "dated"),
                    validUntil: f(d, "validUntil"),
                    characteristicsConfirmed: d.has("characteristics"),
                    note: f(d, "note"),
                  });
                  refresh();
                }}
              >
                {supplierSelect}
                {itemSelect()}
                <Field
                  label={t(
                    "Название / артикул поставщика",
                    "Жеткізуші атауы / артикулы",
                  )}
                >
                  <input
                    name="supplierSku"
                    minLength={2}
                    maxLength={120}
                    required
                  />
                </Field>
                {number(
                  "packQuantity",
                  t(
                    "Базовых единиц в упаковке",
                    "Қаптамадағы негізгі бірліктер",
                  ),
                  "1",
                )}
                {number("packPrice", t("Цена упаковки", "Қаптама бағасы"))}
                {number(
                  "minimumPacks",
                  t("Минимум упаковок", "Ең аз қаптама саны"),
                  "1",
                )}
                {number(
                  "delivery",
                  t(
                    "Доставка на весь заказ; пусто = неизвестно",
                    "Бүкіл тапсырысты жеткізу; бос = белгісіз",
                  ),
                  "",
                  false,
                )}
                {number(
                  "leadDays",
                  t(
                    "Срок в днях; пусто = неизвестно",
                    "Мерзімі күнмен; бос = белгісіз",
                  ),
                  "",
                  false,
                )}
                <Field label={t("Валюта", "Валюта")}>
                  <input
                    name="currency"
                    defaultValue="KZT"
                    pattern="[A-Z]{3}"
                    required
                  />
                </Field>
                {number(
                  "rate",
                  t(
                    "Курс к KZT для иностранной валюты",
                    "Шетел валютасының KZT бағамы",
                  ),
                  "",
                  false,
                )}
                <Field label={t("Дата курса", "Бағам күні")}>
                  <input type="date" name="rateDate" />
                </Field>
                <Field
                  label={t(
                    "Источник курса / ручное подтверждение",
                    "Бағам көзі / қолмен растау",
                  )}
                >
                  <input name="rateSource" maxLength={160} />
                </Field>
                <Field label={t("Налоги в цене", "Бағадағы салықтар")}>
                  <select name="tax">
                    <option value="unknown">
                      {t("Неизвестно", "Белгісіз")}
                    </option>
                    <option value="included">
                      {t(
                        "Включены / не применяются",
                        "Қосылған / қолданылмайды",
                      )}
                    </option>
                    <option value="excluded">
                      {t(
                        "Добавить указанный процент",
                        "Көрсетілген пайызды қосу",
                      )}
                    </option>
                  </select>
                </Field>
                {number(
                  "taxPercent",
                  t(
                    "Процент по условиям поставщика",
                    "Жеткізуші шарты бойынша пайыз",
                  ),
                  "",
                  false,
                )}
                <Field label={t("Дата прайса", "Прайс күні")}>
                  <input
                    type="date"
                    name="dated"
                    defaultValue={today}
                    required
                  />
                </Field>
                <Field label={t("Действует до", "Дейін жарамды")}>
                  <input type="date" name="validUntil" required />
                </Field>
                <label className="commerce-check">
                  <input type="checkbox" name="characteristics" />
                  {t(
                    "Проверены SKU, характеристики и упаковка",
                    "SKU, сипаттамалар және қаптама тексерілді",
                  )}
                </label>
                {note}
              </ActionForm>
            </section>
          )}
        </>
      )}
      {(tab === "suppliers" || tab === "planning") && (
        <section className="panel commerce-section">
          <h2>{t("Сравнить предложения", "Ұсыныстарды салыстыру")}</h2>
          <ActionForm
            locale={locale}
            label={t("Рассчитать полную стоимость", "Толық құнын есептеу")}
            submit={async (d) =>
              setCompared(
                await api<Comparison>(`${base}/purchasing/compare`, "POST", {
                  itemId: f(d, "itemId"),
                  quantity: f(d, "quantity"),
                  date: f(d, "date"),
                }),
              )
            }
          >
            {itemSelect()}
            {number(
              "quantity",
              t("Нужно базовых единиц", "Қажет негізгі бірліктер"),
              "1",
            )}
            <Field label={t("На дату", "Күніне")}>
              <input type="date" name="date" defaultValue={today} required />
            </Field>
          </ActionForm>
          {compared && (
            <>
              <p>
                {t(
                  "Стоимость включает целые упаковки, минимум заказа, доставку и указанные налоги. Неизвестные условия требуют проверки.",
                  "Құнға толық қаптамалар, ең аз тапсырыс, жеткізу және көрсетілген салықтар кіреді. Белгісіз шарттар тексеруді талап етеді.",
                )}
              </p>
              {compared.offers.length === 0 && (
                <p>{t("Предложений пока нет", "Ұсыныстар әзірге жоқ")}</p>
              )}
              {compared.offers.map((o) => (
                <article className="procurement-offer" key={o.id}>
                  <h3>
                    {o.supplier_name} · {o.data.supplierSku}
                  </h3>
                  <p>
                    {o.packs} × {o.data.packQuantity} = {o.quantity}{" "}
                    {o.data.baseUnit} · {t("Срок", "Мерзім")}:{" "}
                    {o.data.leadDays ?? "?"} {t("дн.", "күн")}
                  </p>
                  <p>
                    {t("Качество / надёжность", "Сапа / сенімділік")}:{" "}
                    {o.quality ?? "?"} / {o.reliability ?? "?"}
                  </p>
                  {o.total_minor !== null ? (
                    <strong>
                      {moneyText(o.total_minor)} KZT · {o.unit_cost} KZT/
                      {o.data.baseUnit}
                    </strong>
                  ) : (
                    <ul>
                      {o.reasons.map((r) => (
                        <li key={r}>{word(r)}</li>
                      ))}
                    </ul>
                  )}
                  {write && o.comparable && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setBasket((b) => [
                          ...b.filter(
                            (x) => x.offer.data.itemId !== o.data.itemId,
                          ),
                          {
                            offer: o,
                            itemName:
                              items.find((i) => i.id === o.data.itemId)
                                ?.name_ru || o.data.supplierSku,
                            quantity: compared.quantity,
                          },
                        ]);
                        setTab("orders");
                      }}
                    >
                      {t("В проект закупки", "Сатып алу жобасына")}
                    </button>
                  )}
                </article>
              ))}
            </>
          )}
        </section>
      )}
      {tab === "planning" && (
        <>
          <section className="panel commerce-section">
            <h2>{t("Объяснимая потребность", "Түсіндірілетін қажеттілік")}</h2>
            <ActionForm
              locale={locale}
              label={t("Рассчитать потребность", "Қажеттілікті есептеу")}
              submit={async (d) =>
                setNeed(
                  await api<z.infer<typeof needView>>(
                    `${base}/purchasing/need`,
                    "POST",
                    {
                      warehouseId: f(d, "warehouseId"),
                      itemId: f(d, "itemId"),
                      minimum: f(d, "minimum"),
                      safety: f(d, "safety"),
                      leadDays: Number(f(d, "leadDays")),
                      historyDays: Number(f(d, "historyDays")),
                    },
                  ),
                )
              }
            >
              {warehouseSelect}
              {itemSelect()}
              {number("minimum", t("Минимальный запас", "Ең аз қор"), "0")}
              {number("safety", t("Страховой запас", "Сақтық қоры"), "0")}
              {number(
                "leadDays",
                t("Срок поставки, дней", "Жеткізу мерзімі, күн"),
                "3",
              )}
              {number(
                "historyDays",
                t("История, дней (7–365)", "Тарих, күн (7–365)"),
                "30",
              )}
            </ActionForm>
            {need && (
              <div role="status">
                <h3>
                  {t(
                    "Рекомендуется проверить закупку",
                    "Сатып алуды тексеру ұсынылады",
                  )}
                  : {need.need}
                </h3>
                <p>
                  {t(
                    "Доступно / резерв / в пути / целевой запас",
                    "Қолжетімді / резерв / жолда / мақсатты қор",
                  )}
                  : {need.available} / {need.reserved} / {need.in_transit} /{" "}
                  {need.target}
                </p>
                <p>
                  {t(
                    "Продано / наблюдаемых дней / дней с остатком на конец дня",
                    "Сатылды / бақыланған күндер / күн соңында қоры бар күндер",
                  )}
                  : {need.demand} / {need.observed_days} / {need.in_stock_days}
                </p>
                {need.warnings.map((w) => (
                  <p key={w}>{word(w)}</p>
                ))}
              </div>
            )}
          </section>
          <section className="panel commerce-section">
            <h2>{t("Вариант под бюджет", "Бюджетке сай нұсқа")}</h2>
            <p>
              {t(
                "Позиции берутся из проекта закупки. Приоритет — порядок добавления. Для автоматического выбора нужны известный срок и оценки качества и надёжности от 3. Доставка на каждую строку учитывается отдельно, чтобы не занизить бюджет.",
                "Тауарлар сатып алу жобасынан алынады. Басымдық — қосу реті. Автоматты таңдау үшін мерзім белгілі, сапа мен сенімділік бағасы кемінде 3 болуы керек. Бюджетті төмендетпеу үшін әр жолдың жеткізуі бөлек есептеледі.",
              )}
            </p>
            <ActionForm
              locale={locale}
              label={t("Пересчитать бюджет", "Бюджетті қайта есептеу")}
              submit={async (d) =>
                setBudget(
                  await api<z.infer<typeof budgetView>>(
                    `${base}/purchasing/budget`,
                    "POST",
                    {
                      budget: f(d, "budget"),
                      date: f(d, "date"),
                      lines: basket.map((x, i) => ({
                        itemId: x.offer.data.itemId,
                        quantity: x.quantity,
                        priority: i + 1,
                      })),
                    },
                  ),
                )
              }
            >
              {number("budget", t("Бюджет KZT", "Бюджет KZT"))}
              <Field label={t("Дата", "Күні")}>
                <input type="date" name="date" defaultValue={today} required />
              </Field>
            </ActionForm>
            {budget && (
              <>
                <p>
                  {t("Остаток бюджета", "Бюджет қалдығы")}:{" "}
                  {moneyText(budget.remaining_minor)} KZT
                </p>
                {budget.lines.map((l) => (
                  <article key={l.itemId} className="procurement-offer">
                    <strong>
                      {
                        basket.find((b) => b.offer.data.itemId === l.itemId)
                          ?.itemName
                      }
                    </strong>
                    <p>
                      {word(l.reason)} ·{" "}
                      {
                        l.alternatives.find((a) => a.id === l.selected_offer_id)
                          ?.supplier_name
                      }
                    </p>
                    <p>
                      {t("Рассмотрено предложений", "Қаралған ұсыныстар")}:{" "}
                      {l.alternatives.length}
                    </p>
                  </article>
                ))}
              </>
            )}
          </section>
        </>
      )}
      {tab === "orders" && (
        <>
          {write && basket.length > 0 && (
            <section className="panel commerce-section">
              <h2>{t("Проект закупки", "Сатып алу жобасы")}</h2>
              {basket.map((b) => (
                <div className="commerce-row" key={b.offer.id}>
                  <strong>{b.itemName}</strong>
                  <span>
                    {b.offer.supplier_name} · {b.quantity} → {b.offer.quantity}{" "}
                    {b.offer.data.baseUnit}
                  </span>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      setBasket((v) =>
                        v.filter((x) => x.offer.id !== b.offer.id),
                      )
                    }
                  >
                    {t("Убрать", "Алып тастау")}
                  </button>
                </div>
              ))}
              <p>
                {t(
                  "Один заказ — один поставщик. Удалите позиции другого поставщика перед созданием.",
                  "Бір тапсырыс — бір жеткізуші. Құру алдында басқа жеткізуші тауарларын алып тастаңыз.",
                )}
              </p>
              <ActionForm
                locale={locale}
                label={t(
                  "Создать закупочный заказ",
                  "Сатып алу тапсырысын құру",
                )}
                submit={async (d, key) => {
                  const r = await post("purchases", {
                    key,
                    branchId: branch,
                    warehouseId: f(d, "warehouseId"),
                    supplierId: basket[0].offer.data.supplierId,
                    date: f(d, "date"),
                    dueDate: f(d, "dueDate"),
                    budget: f(d, "budget"),
                    note: f(d, "note"),
                    lines: basket.map((b) => ({
                      offerId: b.offer.id,
                      quantity: b.quantity,
                    })),
                  });
                  setBasket([]);
                  setSelected(r.id);
                  refresh();
                }}
              >
                {warehouseSelect}
                {number("budget", t("Бюджет KZT", "Бюджет KZT"))}
                <Field label={t("Дата закупки", "Сатып алу күні")}>
                  <input
                    type="date"
                    name="date"
                    defaultValue={today}
                    required
                  />
                </Field>
                <Field label={t("План оплаты", "Төлем жоспары")}>
                  <input
                    type="date"
                    name="dueDate"
                    defaultValue={today}
                    required
                  />
                </Field>
                {note}
              </ActionForm>
            </section>
          )}
          <section className="panel commerce-section">
            <h2>{t("Закупочные заказы", "Сатып алу тапсырыстары")}</h2>
            <Field
              label={t(
                "Поиск по номеру / поставщику",
                "Нөмір / жеткізуші бойынша іздеу",
              )}
            >
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </Field>
            {loading && <p role="status">{t("Загрузка…", "Жүктелуде…")}</p>}
            {orders?.items.length === 0 && (
              <p>
                {t(
                  "Выберите предложение поставщика и добавьте его в проект закупки.",
                  "Жеткізуші ұсынысын таңдап, сатып алу жобасына қосыңыз.",
                )}
              </p>
            )}
            {orders?.items.map((o) => (
              <button
                type="button"
                key={o.id}
                className={`commerce-order ${selected === o.id ? "active" : ""}`}
                onClick={() => {
                  setSelected(o.id);
                  setDocId("");
                  setHistoryPage(1);
                  setDocPage(1);
                }}
              >
                <strong>
                  №{o.number} · {o.supplier_name}
                </strong>
                <span>
                  {word(o.state)} · {moneyText(o.total_minor)} KZT
                </span>
              </button>
            ))}
            {orders && pagination(page, orders.pagination.pages, setPage)}
          </section>
          {detail && (
            <section className="panel commerce-section">
              <h2>
                {t("Закупка", "Сатып алу")} №{detail.order.number} ·{" "}
                {word(detail.order.state)}
              </h2>
              <p>
                {detail.order.supplier_name} ·{" "}
                {moneyText(detail.order.total_minor)} KZT
              </p>
              {detail.lines.map((l) => (
                <article key={l.id} className="commerce-row">
                  <strong>{l.name}</strong>
                  <span>
                    {t("Принято / заказано", "Қабылданды / тапсырыс берілді")}:{" "}
                    {quantityText(l.received)} / {quantityText(l.quantity)}{" "}
                    {l.base_unit}
                  </span>
                  <span>{moneyText(l.total_minor)} KZT</span>
                </article>
              ))}
              {write &&
                !["completed", "cancelled"].includes(detail.order.state) && (
                  <ActionForm
                    key={`${selected}-${detail.order.version}`}
                    locale={locale}
                    label={t("Изменить состояние", "Күйін өзгерту")}
                    submit={async (d, key) => {
                      await post(`purchases/${selected}/commands`, {
                        key,
                        version: detail.order.version,
                        kind: f(d, "kind"),
                        note: f(d, "note"),
                      });
                      refresh();
                    }}
                  >
                    <Field label={t("Действие", "Әрекет")}>
                      <select name="kind">
                        {detail.order.state === "draft" && (
                          <option value="submit">
                            {t("На согласование", "Келісуге")}
                          </option>
                        )}
                        {detail.order.state === "pending" && approve && (
                          <option value="approve">
                            {t("Одобрить", "Мақұлдау")}
                          </option>
                        )}
                        {detail.order.state === "approved" && (
                          <option value="sent">
                            {t(
                              "Отметить: отправлено вручную",
                              "Белгілеу: қолмен жіберілді",
                            )}
                          </option>
                        )}
                        <option value="cancel">
                          {t(
                            "Отменить неполученный остаток",
                            "Алынбаған қалдықтан бас тарту",
                          )}
                        </option>
                      </select>
                    </Field>
                    {note}
                  </ActionForm>
                )}
              <p>
                {t(
                  "Отметка отправки не отправляет сообщение поставщику. При отмене уже принятый товар и подтверждённый долг сохраняются.",
                  "Жіберу белгісі жеткізушіге хабарлама жібермейді. Бас тарту кезінде қабылданған тауар мен расталған қарыз сақталады.",
                )}
              </p>
              <h3>
                {t(
                  "Документы и фактическая приёмка",
                  "Құжаттар және нақты қабылдау",
                )}
              </h3>
              {write && (
                <ActionForm
                  locale={locale}
                  label={t("Загрузить и распознать", "Жүктеу және тану")}
                  submit={async (d, key) => {
                    const file = d.get("file") as File;
                    if (!file?.size || file.size > 5 * 1024 * 1024)
                      throw new Error("TOO_LARGE");
                    const bytes = new Uint8Array(await file.arrayBuffer());
                    let binary = "";
                    for (let i = 0; i < bytes.length; i += 8192)
                      binary += String.fromCharCode(
                        ...bytes.subarray(i, i + 8192),
                      );
                    const r = await post("purchase-documents", {
                      key,
                      orderId: selected,
                      filename: file.name,
                      content: btoa(binary),
                      externalId: f(d, "externalId"),
                    });
                    setDocId(r.id);
                    setExtraRows(0);
                    refresh();
                  }}
                >
                  <Field
                    label={t(
                      "Файл: PDF до 5 страниц, PNG/JPEG до 16 Мп, CSV/TSV до 256 КБ; максимум 5 МБ",
                      "Файл: PDF 5 бетке дейін, PNG/JPEG 16 Мп дейін, CSV/TSV 256 КБ дейін; ең көбі 5 МБ",
                    )}
                  >
                    <input
                      type="file"
                      name="file"
                      accept=".pdf,.png,.jpg,.jpeg,.csv,.tsv"
                      required
                    />
                  </Field>
                  <Field
                    label={t(
                      "Внешний ID, если известен",
                      "Белгілі болса, сыртқы ID",
                    )}
                  >
                    <input name="externalId" maxLength={120} />
                  </Field>
                </ActionForm>
              )}
              {docs?.items.map((d) => (
                <button
                  className="commerce-order"
                  type="button"
                  key={d.id}
                  onClick={() => {
                    setDocId(d.id);
                    setExtraRows(0);
                  }}
                >
                  <strong>{d.filename}</strong>
                  <span>
                    {word(d.state)} · {d.number || "—"}
                  </span>
                </button>
              ))}
              {docs && pagination(docPage, docs.pagination.pages, setDocPage)}
              {(detail.exports || []).length > 0 && (
                <ul
                  className="today-list"
                  aria-label={t("Приёмки в МойСклад", "МойСкладқа қабылдаулар")}
                >
                  {detail.exports.map((x) => (
                    <li key={x.id}>
                      {t("Приёмка в МойСклад", "МойСкладқа қабылдау")} ·{" "}
                      <strong>
                        {x.state === "sent"
                          ? t("создана", "құрылды")
                          : x.state === "pending"
                            ? t("ждёт отправки", "жіберуді күтеді")
                            : x.state === "failed"
                              ? t("ошибка, будет повтор", "қате, қайталанады")
                              : t(
                                  "остановлена, нужен разбор",
                                  "тоқтатылды, талдау қажет",
                                )}
                      </strong>
                      {x.error_code &&
                        ` · ${executionError(x.error_code, locale) || x.error_code}`}
                      {x.warning &&
                        ` · ${t("проверьте сумму в МойСклад", "МойСкладтағы соманы тексеріңіз")}`}
                    </li>
                  ))}
                </ul>
              )}
              <details>
                <summary>{t("История закупки", "Сатып алу тарихы")}</summary>
                {detail.events.map((e) => (
                  <p key={e.id}>
                    {e.actor_name} · {e.note} ·{" "}
                    {new Date(e.created_at).toLocaleString(
                      locale === "ru" ? "ru-RU" : "kk-KZ",
                    )}
                  </p>
                ))}
                {pagination(
                  historyPage,
                  detail.eventPagination.pages,
                  setHistoryPage,
                )}
              </details>
            </section>
          )}
          {doc && detail && doc.document.order_id === detail.order.id && (
            <section className="panel commerce-section">
              <h2>
                {doc.document.filename} · {word(doc.document.state)}
              </h2>
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  download().catch((e) => setError(e.code || "INTERNAL_ERROR"))
                }
              >
                {t(
                  "Скачать сохранённый оригинал",
                  "Сақталған түпнұсқаны жүктеу",
                )}
              </button>
              <p>
                {t("Распознавание", "Тану")}: {doc.document.extraction.engine} ·{" "}
                {t("Уверенность OCR", "OCR сенімділігі")}:{" "}
                {doc.document.extraction.confidence === null
                  ? t("Не оценивается", "Бағаланбайды")
                  : `${Math.round(doc.document.extraction.confidence * 100)}%`}
              </p>
              <p className="commerce-alert">
                {t(
                  "Проверьте каждую строку, упаковку, цену и итог по оригиналу. Уверенность OCR относится к тексту, а не к правильности суммы. Загрузка не меняет остатки.",
                  "Әр жолды, қаптаманы, бағаны және қорытындыны түпнұсқамен тексеріңіз. OCR сенімділігі соманың дұрыстығына емес, мәтінге қатысты. Жүктеу қорды өзгертпейді.",
                )}
              </p>
              <details open>
                <summary>{t("Распознанный текст", "Танылған мәтін")}</summary>
                <pre className="procurement-extraction">
                  {doc.document.extraction.text}
                </pre>
              </details>
              {doc.document.extraction.candidates.length > 0 && (
                <details open>
                  <summary>
                    {t(
                      "Предполагаемые строки — требуют проверки",
                      "Болжамды жолдар — тексеру қажет",
                    )}
                  </summary>
                  {doc.document.extraction.candidates.map((c, i) => (
                    <article key={i} className="procurement-offer">
                      <strong>{c.name}</strong>
                      <p>
                        {t(
                          "Количество / единица / цена / сумма",
                          "Саны / бірлік / баға / сома",
                        )}
                        : {c.quantity ?? "?"} / {c.unit ?? "?"} /{" "}
                        {c.unitPrice ?? "?"} / {c.total ?? "?"}
                      </p>
                    </article>
                  ))}
                </details>
              )}
              {doc.document.state === "review" &&
                write &&
                (() => {
                  const saved = doc.document.review?.lines || [],
                    orderedFor = (itemId: string) =>
                      saved.find(
                        (x) =>
                          (x.decision === "accept" && x.itemId === itemId) ||
                          (x.decision === "substitute" &&
                            x.replacesItemId === itemId),
                      ),
                    savedExtras = saved.filter(
                      (x) =>
                        !(
                          x.decision === "substitute" ||
                          (x.decision === "accept" &&
                            detail.lines.some((l) => l.item_id === x.itemId))
                        ),
                    ),
                    extraCount = Math.max(extraRows, savedExtras.length);
                  return (
                    <ActionForm
                      key={`${doc.document.id}-${doc.document.version}`}
                      locale={locale}
                      label={t(
                        "Сохранить проверку документа",
                        "Құжат тексеруін сақтау",
                      )}
                      submit={async (d, key) => {
                        const lines = [
                          ...detail.lines
                            .filter((l) => d.has(`include-${l.id}`))
                            .map((l) => {
                              const replacement = f(d, `replace-${l.id}`);
                              return {
                                itemId: replacement || l.item_id,
                                name: l.name,
                                unit: f(d, `unit-${l.id}`),
                                quantity: f(d, `qty-${l.id}`),
                                unitPrice: f(d, `price-${l.id}`),
                                decision: replacement ? "substitute" : "accept",
                                replacesItemId: replacement ? l.item_id : null,
                              };
                            }),
                          ...Array.from({ length: extraCount }, (_, i) => ({
                            itemId: f(d, `extra-item-${i}`) || null,
                            name: f(d, `extra-name-${i}`),
                            unit: f(d, `extra-unit-${i}`),
                            quantity: f(d, `extra-qty-${i}`),
                            unitPrice: f(d, `extra-price-${i}`),
                            decision: f(d, `extra-decision-${i}`),
                            replacesItemId: null,
                          })).filter((l) => l.name),
                        ];
                        await post(
                          `purchase-documents/${doc.document.id}/${f(d, "reviewAction")}`,
                          {
                            key,
                            version: doc.document.version,
                            number: f(d, "number"),
                            date: f(d, "date"),
                            dueDate: f(d, "dueDate"),
                            delivery: f(d, "delivery"),
                            total: f(d, "total"),
                            lines,
                            note: f(d, "note"),
                            acknowledgeDiscrepancies: d.has("acknowledge"),
                          },
                        );
                        refresh();
                      }}
                    >
                      <Field
                        label={t("Результат проверки", "Тексеру нәтижесі")}
                      >
                        <select name="reviewAction">
                          <option value="review-draft">
                            {t(
                              "Сохранить исправления, без долга и приёмки",
                              "Түзетулерді сақтау, қарызсыз және қабылдаусыз",
                            )}
                          </option>
                          <option value="review">
                            {t(
                              "Подтвердить документ и создать долг поставщику",
                              "Құжатты растау және жеткізушіге қарыз құру",
                            )}
                          </option>
                        </select>
                      </Field>
                      <Field label={t("Номер документа", "Құжат нөмірі")}>
                        <input
                          name="number"
                          required
                          maxLength={80}
                          defaultValue={doc.document.review?.number}
                        />
                      </Field>
                      <Field label={t("Дата документа", "Құжат күні")}>
                        <input
                          type="date"
                          name="date"
                          required
                          defaultValue={doc.document.review?.date}
                        />
                      </Field>
                      <Field label={t("Срок оплаты", "Төлем мерзімі")}>
                        <input
                          type="date"
                          name="dueDate"
                          required
                          defaultValue={doc.document.review?.dueDate}
                        />
                      </Field>
                      {detail.lines.map((l) => {
                        const prior = orderedFor(l.item_id);
                        return (
                          <div key={l.id} className="procurement-review-line">
                            <label className="commerce-check">
                              <input
                                type="checkbox"
                                name={`include-${l.id}`}
                                defaultChecked={!doc.document.review || !!prior}
                              />
                              {l.name}
                            </label>
                            <Field
                              label={t(
                                "Фактический SKU в документе",
                                "Құжаттағы нақты SKU",
                              )}
                            >
                              <select
                                name={`replace-${l.id}`}
                                defaultValue={
                                  prior?.decision === "substitute"
                                    ? prior.itemId || ""
                                    : ""
                                }
                              >
                                <option value="">
                                  {t("Как в заказе", "Тапсырыстағыдай")}
                                </option>
                                {items
                                  .filter(
                                    (i) =>
                                      i.kind === "goods" &&
                                      i.id !== l.item_id &&
                                      i.base_unit === l.base_unit,
                                  )
                                  .map((i) => (
                                    <option key={i.id} value={i.id}>
                                      {t("Замена:", "Ауыстыру:")} {i.sku} ·{" "}
                                      {locale === "kk" && i.name_kk
                                        ? i.name_kk
                                        : i.name_ru}
                                    </option>
                                  ))}
                              </select>
                            </Field>
                            {number(
                              `qty-${l.id}`,
                              t("Количество в документе", "Құжаттағы саны"),
                              prior?.quantity || "",
                              false,
                            )}
                            <Field
                              label={t(
                                "Единица в документе; проверьте преобразование в каталоге",
                                "Құжат бірлігі; каталогтағы түрлендіруді тексеріңіз",
                              )}
                            >
                              <input
                                name={`unit-${l.id}`}
                                defaultValue={prior?.unit || l.base_unit}
                                maxLength={20}
                              />
                            </Field>
                            {number(
                              `price-${l.id}`,
                              t(
                                "Цена за эту единицу, включая налоги, KZT",
                                "Осы бірлік бағасы, салықтармен, KZT",
                              ),
                              prior?.unitPrice || "",
                              false,
                            )}
                          </div>
                        );
                      })}
                      <fieldset className="procurement-extra-lines">
                        <legend>
                          {t(
                            "Строки документа вне заказа",
                            "Тапсырыстан тыс құжат жолдары",
                          )}
                        </legend>
                        <p>
                          {t(
                            "Такая строка не попадает на склад и в долг без решения. Отдельная закупка проходит обычное согласование.",
                            "Мұндай жол шешімсіз қоймаға және қарызға түспейді. Бөлек сатып алу әдеттегі келісуден өтеді.",
                          )}
                        </p>
                        {Array.from({ length: extraCount }, (_, i) => {
                          const prior = savedExtras[i];
                          return (
                            <div
                              key={i}
                              className="procurement-review-line"
                              data-testid={`extra-line-${i}`}
                            >
                              <Field
                                label={t(
                                  "Наименование по документу",
                                  "Құжат бойынша атауы",
                                )}
                              >
                                <input
                                  name={`extra-name-${i}`}
                                  minLength={2}
                                  maxLength={120}
                                  defaultValue={prior?.name}
                                />
                              </Field>
                              <Field
                                label={t("Товар каталога", "Каталог тауары")}
                              >
                                <select
                                  name={`extra-item-${i}`}
                                  defaultValue={prior?.itemId || ""}
                                >
                                  <option value="">
                                    {t(
                                      "Нет в каталоге / неизвестно",
                                      "Каталогта жоқ / белгісіз",
                                    )}
                                  </option>
                                  {items
                                    .filter((x) => x.kind === "goods")
                                    .map((x) => (
                                      <option key={x.id} value={x.id}>
                                        {x.sku} ·{" "}
                                        {locale === "kk" && x.name_kk
                                          ? x.name_kk
                                          : x.name_ru}{" "}
                                        ({x.base_unit})
                                      </option>
                                    ))}
                                </select>
                              </Field>
                              <Field label={t("Единица", "Бірлік")}>
                                <input
                                  name={`extra-unit-${i}`}
                                  maxLength={20}
                                  defaultValue={prior?.unit || "pc"}
                                />
                              </Field>
                              {number(
                                `extra-qty-${i}`,
                                t("Количество", "Саны"),
                                prior?.quantity || "",
                                false,
                              )}
                              {number(
                                `extra-price-${i}`,
                                t(
                                  "Цена за единицу, включая налоги, KZT",
                                  "Бірлік бағасы, салықтармен, KZT",
                                ),
                                prior?.unitPrice || "",
                                false,
                              )}
                              <Field label={t("Решение", "Шешім")}>
                                <select
                                  name={`extra-decision-${i}`}
                                  defaultValue={prior?.decision || "accept"}
                                >
                                  <option value="accept">
                                    {t(
                                      "Не решено — блокирует подтверждение",
                                      "Шешілмеген — растауды бұғаттайды",
                                    )}
                                  </option>
                                  <option value="reject">
                                    {t(
                                      "Отклонить: не принимать и не оплачивать",
                                      "Қабылдамау: қабылдамау және төлемеу",
                                    )}
                                  </option>
                                  <option value="separate">
                                    {t(
                                      "Оформить отдельной закупкой на согласование",
                                      "Келісуге бөлек сатып алу ретінде рәсімдеу",
                                    )}
                                  </option>
                                </select>
                              </Field>
                            </div>
                          );
                        })}
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => setExtraRows(extraCount + 1)}
                        >
                          {t(
                            "Добавить строку вне заказа",
                            "Тапсырыстан тыс жол қосу",
                          )}
                        </button>
                      </fieldset>
                      {number(
                        "delivery",
                        t("Доставка, KZT", "Жеткізу, KZT"),
                        doc.document.review?.delivery || "0",
                      )}
                      {number(
                        "total",
                        t(
                          "Итог по оригиналу, KZT",
                          "Түпнұсқа қорытындысы, KZT",
                        ),
                        doc.document.review?.total || "",
                      )}
                      {note}
                      <label className="commerce-check">
                        <input type="checkbox" name="acknowledge" />
                        {t(
                          "Проверены расхождения с заказом; принимаю их с указанным основанием",
                          "Тапсырыспен айырмашылықтар тексерілді; көрсетілген негізбен қабылдаймын",
                        )}
                      </label>
                    </ActionForm>
                  );
                })()}
              {(doc.document.state === "approved" || doc.document.review) && (
                <>
                  <p>
                    {t(
                      doc.document.state === "approved"
                        ? "Подтверждённый документ не редактируется. Изменения долга — только корректировкой с основанием. Долг доступен в разделе «Финансы»."
                        : "Исправления сохранены. Подтверждение документа ещё не выполнено.",
                      doc.document.state === "approved"
                        ? "Расталған құжат өңделмейді. Қарыз тек негізі бар түзетумен өзгереді. Қарыз «Қаржы» бөлімінде қолжетімді."
                        : "Түзетулер сақталды. Құжат әлі расталмаған.",
                    )}
                  </p>
                  {doc.document.parent_document_id && (
                    <p>
                      {t(
                        "Это часть документа, выделенная в отдельную закупку. Оригинал общий.",
                        "Бұл бөлек сатып алуға бөлінген құжат бөлігі. Түпнұсқа ортақ.",
                      )}
                    </p>
                  )}
                  {doc.obligation && (
                    <p>
                      {t("Долг поставщику", "Жеткізушіге қарыз")}:{" "}
                      {moneyText(doc.obligation.amount_minor)} KZT ·{" "}
                      {t("оплачено", "төленді")}{" "}
                      {moneyText(doc.obligation.paid_minor)} KZT
                    </p>
                  )}
                  {doc.document.discrepancies.length > 0 && (
                    <div className="commerce-alert">
                      <strong>
                        {t(
                          "Расхождения с заказом",
                          "Тапсырыспен айырмашылықтар",
                        )}
                      </strong>
                      {doc.document.discrepancies.map((v) => {
                        const [kind, id] = v.split(":"),
                          reviewLine = /^\d+$/.test(id || "")
                            ? doc.document.review?.lines[Number(id)]
                            : undefined;
                        return (
                          <p key={v}>
                            {
                              {
                                price: t("Цена", "Баға"),
                                quantity: t("Количество", "Саны"),
                                item: t(
                                  "Товар вне заказа — нужно решение",
                                  "Тапсырыстан тыс тауар — шешім қажет",
                                ),
                                missing: t("Нет в документе", "Құжатта жоқ"),
                                total: t("Общая сумма", "Жалпы сома"),
                                substitute: t("Замена SKU", "SKU ауыстыру"),
                                rejected: t(
                                  "Отклонено, не принято и не оплачивается",
                                  "Қабылданбады, төленбейді",
                                ),
                                separate: t(
                                  "Выделено в отдельную закупку",
                                  "Бөлек сатып алуға бөлінді",
                                ),
                              }[kind]
                            }{" "}
                            {reviewLine?.name ||
                              detail.lines.find((l) => l.item_id === id)?.name}
                          </p>
                        );
                      })}
                    </div>
                  )}
                  {doc.decisions.map((x) => (
                    <p key={x.id}>
                      {x.name}: {quantityText(x.quantity)} {x.unit} ·{" "}
                      {moneyText(x.total_minor)} KZT ·{" "}
                      {
                        {
                          substitute: t("замена SKU", "SKU ауыстыру"),
                          reject: t("отклонено", "қабылданбады"),
                          separate: t("отдельная закупка", "бөлек сатып алу"),
                        }[x.decision]
                      }
                      {x.split_order_id && (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => {
                            setSelected(x.split_order_id!);
                            setDocId(x.split_document_id || "");
                          }}
                        >
                          {t(
                            "Открыть отдельную закупку",
                            "Бөлек сатып алуды ашу",
                          )}
                        </button>
                      )}
                    </p>
                  ))}
                  {doc.lines.map((l) => (
                    <p key={l.id}>
                      {l.name}: {quantityText(l.received)} /{" "}
                      {quantityText(l.base_quantity)}{" "}
                      {
                        detail.lines.find((p) =>
                          l.purchase_line_id
                            ? p.id === l.purchase_line_id
                            : p.item_id === l.item_id,
                        )?.base_unit
                      }{" "}
                      · {moneyText(l.total_minor)} KZT ·{" "}
                      {t("принято на сумму", "қабылданған сомасы")}{" "}
                      {moneyText(l.received_value_minor)} KZT
                    </p>
                  ))}
                  {write &&
                    doc.document.state === "approved" &&
                    ["sent", "partial"].includes(detail.order.state) && (
                      <ActionForm
                        key={`${doc.document.id}-${detail.order.version}`}
                        locale={locale}
                        label={t(
                          "Подтвердить фактическую приёмку",
                          "Нақты қабылдауды растау",
                        )}
                        submit={async (d, key) => {
                          await post(`purchases/${selected}/receipts`, {
                            key,
                            documentId: doc.document.id,
                            version: detail.order.version,
                            note: f(d, "note"),
                            lines: doc.lines
                              .filter(
                                (l) => f(d, l.id) && Number(f(d, l.id)) > 0,
                              )
                              .map((l) => ({
                                lineId: l.id,
                                quantity: f(d, l.id),
                              })),
                          });
                          refresh();
                        }}
                      >
                        {doc.lines
                          .filter(
                            (l) => Number(l.received) < Number(l.base_quantity),
                          )
                          .map((l) => (
                            <div key={l.id}>
                              {number(
                                l.id,
                                `${l.name} · ${t("Принято сейчас, в базовых единицах", "Қазір қабылданды, негізгі бірліктермен")}`,
                                "",
                                false,
                              )}
                            </div>
                          ))}
                        {note}
                      </ActionForm>
                    )}
                  {approve &&
                    doc.document.state === "approved" &&
                    doc.obligation &&
                    doc.lines.length > 0 && (
                      <details>
                        <summary>
                          {t(
                            "Корректировка подтверждённого документа и долга",
                            "Расталған құжат пен қарызды түзету",
                          )}
                        </summary>
                        <ActionForm
                          key={`adjust-${doc.document.id}-${doc.document.version}`}
                          locale={locale}
                          label={t(
                            "Провести корректировку",
                            "Түзетуді жүргізу",
                          )}
                          submit={async (d, key) => {
                            await post(
                              `purchase-documents/${doc.document.id}/adjustments`,
                              {
                                key,
                                version: doc.document.version,
                                reason: f(d, "note"),
                                lines: doc.lines.map((l) => ({
                                  lineId: l.id,
                                  baseQuantity: f(d, `adj-qty-${l.id}`),
                                  total: f(d, `adj-total-${l.id}`),
                                })),
                              },
                            );
                            refresh();
                          }}
                        >
                          <p>
                            {t(
                              "Например, кредит-нота поставщика или отказ от недопоставки. Нельзя уменьшить ниже принятого и оплаченного. Стоимость уже принятого товара не пересчитывается.",
                              "Мысалы, жеткізушінің кредит-нотасы немесе жеткізілмегеннен бас тарту. Қабылданған және төленгеннен төмен азайтуға болмайды. Қабылданған тауар құны қайта есептелмейді.",
                            )}
                          </p>
                          {doc.lines.map((l) => (
                            <div key={l.id} className="procurement-review-line">
                              {number(
                                `adj-qty-${l.id}`,
                                `${l.name} · ${t("количество в базовых единицах", "негізгі бірліктегі саны")}`,
                                l.base_quantity.replace(/\.?0+$/, ""),
                              )}
                              {number(
                                `adj-total-${l.id}`,
                                `${l.name} · ${t("сумма строки, KZT", "жол сомасы, KZT")}`,
                                minorInput(l.total_minor),
                              )}
                            </div>
                          ))}
                          {note}
                        </ActionForm>
                      </details>
                    )}
                  <details>
                    <summary>{t("История проверки", "Тексеру тарихы")}</summary>
                    {doc.revisions.map((r) => (
                      <p key={r.id}>
                        {r.actor_name} · {r.note}
                      </p>
                    ))}
                    {doc.adjustments.map((a) => (
                      <p key={a.id}>
                        {a.actor_name} · {t("корректировка", "түзету")}{" "}
                        {moneyText(a.delta_minor)} KZT · {a.reason}
                        {a.warnings.length > 0 &&
                          ` · ${t("стоимость принятого товара не пересчитана", "қабылданған тауар құны қайта есептелмеді")}`}
                      </p>
                    ))}
                  </details>
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
