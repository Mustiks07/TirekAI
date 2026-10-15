"use client";
import { useEffect, useState } from "react";
import type { Locale, Workspace } from "@/domain/contracts";
import type { CampaignData, Evaluation } from "@/domain/marketing";
import { can } from "@/domain/permissions";
import { api } from "@/lib/client";
import { useRevision } from "@/lib/live";
import { errorText } from "@/lib/i18n";
import { executionError } from "@/lib/execution-i18n";
import { moneyText } from "@/lib/inventory-i18n";
import { ActionForm, Field } from "./purchasing-page";

const f = (d: FormData, n: string) => String(d.get(n) || "").trim();
type Item = { id: string; sku: string; name_ru: string; kind: string };
type Warehouse = { id: string; name: string; branch_id: string };
type Row = {
  id: string;
  name: string;
  state: string;
  version: number;
  approved_version: number | null;
  starts_on: string;
  ends_on: string;
  offer: string;
};
type Detail = {
  campaign: {
    id: string;
    state: string;
    version: number;
    approved_version: number | null;
    data: CampaignData;
    spend_minor: string | null;
    spend_version: number;
  };
  evaluation: Evaluation;
  versions: {
    version: number;
    note: string;
    author: string;
    created_at: string;
  }[];
  decisions: {
    decision: string;
    version: number;
    override: boolean;
    note: string;
    actor: string;
    created_at: string;
  }[];
  images: { id: string; mime: string; size: number; alt_ru: string }[];
  publications: {
    id: string;
    version: number;
    channel: string;
    material: string;
    locale: string;
    state: string;
    reason: string | null;
    recipients: number;
    sent: number;
    undelivered: number;
    created_at: string;
    actor: string;
  }[];
  can: { write: boolean; approve: boolean; override: boolean; cost: boolean };
};
type Period = {
  from: string;
  to: string;
  quantity: string;
  revenueMinor: string;
  discountMinor: string;
  costMinor: string | null;
  unknownCostEvents: number;
  grossProfitMinor: string | null;
  orders: number;
};
type Analysis = {
  campaign: Period | null;
  control: Period | null;
  difference: { quantity: string; revenueMinor: string } | null;
  spendMinor: string | null;
  spendNote: string;
  spendVersion: number;
  netAfterSpendMinor: string | null;
  reach: { sent: number; queuedOrTried: number } | null;
  caveats: string[];
};
const states: Record<string, [string, string]> = {
  draft: ["Черновик", "Жоба"],
  pending: ["На согласовании", "Келісуде"],
  approved: ["Согласована", "Келісілді"],
  rejected: ["Отклонена", "Қабылданбады"],
  archived: ["В архиве", "Мұрағатта"],
  exported: ["Выгружено (не опубликовано)", "Жүктелді (жарияланбаған)"],
  queued: ["В очереди канала", "Арна кезегінде"],
  not_configured: [
    "Канал не подключён — не отправлено",
    "Арна қосылмаған — жіберілмеді",
  ],
  blocked: ["Некому отправить", "Жіберетін ешкім жоқ"],
  submitted: ["Отправлена на согласование", "Келісуге жіберілді"],
};
const statusText: Record<string, [string, string]> = {
  ok: ["Маржа не ниже порога", "Маржа шектен төмен емес"],
  below_threshold: ["Маржа ниже порога", "Маржа шектен төмен"],
  unknown_margin: [
    "Маржа неизвестна: нет себестоимости",
    "Маржа белгісіз: өзіндік құн жоқ",
  ],
  invalid: ["Есть блокирующие ошибки", "Бұғаттайтын қателер бар"],
};
const issueText: Record<string, [string, string]> = {
  ITEM_NOT_FOUND: ["товар не найден", "тауар табылмады"],
  ITEM_INACTIVE: ["товар неактивен", "тауар белсенді емес"],
  PRICE_MISSING: ["нет цены продажи", "сату бағасы жоқ"],
  BUNDLE_NOT_CHEAPER: [
    "комплект не дешевле обычных цен",
    "жиынтық әдеттегі бағадан арзан емес",
  ],
  WAREHOUSE_NOT_FOUND: [
    "склад не найден в филиале",
    "қойма филиалда табылмады",
  ],
  IMAGE_NOT_FOUND: ["изображение не найдено", "сурет табылмады"],
  OUT_OF_STOCK: [
    "недостаточно доступного остатка",
    "қолжетімді қалдық жеткіліксіз",
  ],
  MARGIN_BELOW: ["маржа ниже порога", "маржа шектен төмен"],
  MARGIN_UNKNOWN: ["себестоимость неизвестна", "өзіндік құн белгісіз"],
};
const caveatText: Record<string, [string, string]> = {
  seasonality_not_adjusted: [
    "Сезонность не учтена: контрольный период — равный отрезок прямо перед акцией.",
    "Маусымдық ескерілмеген: бақылау кезеңі — акция алдындағы тең кезең.",
  ],
  not_causal: [
    "Разница с контрольным периодом не равна эффекту акции.",
    "Бақылау кезеңімен айырма акция әсеріне тең емес.",
  ],
  period_not_started: ["Акция ещё не началась.", "Акция әлі басталмады."],
  period_in_progress: [
    "Акция идёт, данные неполные.",
    "Акция жүріп жатыр, деректер толық емес.",
  ],
  unknown_costs: [
    "Есть продажи без себестоимости — прибыль не показана.",
    "Өзіндік құнсыз сатулар бар — пайда көрсетілмейді.",
  ],
  no_control_sales: [
    "В контрольном периоде не было продаж этих товаров.",
    "Бақылау кезеңінде бұл тауарлар сатылмаған.",
  ],
  spend_unknown: [
    "Расходы на акцию не внесены — это неизвестно, а не ноль.",
    "Акция шығындары енгізілмеген — бұл нөл емес, белгісіз.",
  ],
  overlapping_campaigns: [
    "В тот же период действуют другие акции на эти товары.",
    "Сол кезеңде осы тауарларға басқа акциялар бар.",
  ],
};
const money = (minor: string | null, locale: Locale) =>
  minor === null
    ? locale === "ru"
      ? "неизвестно"
      : "белгісіз"
    : `${moneyText(minor)} ₸`;
async function base64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function download(content: string, filename: string, mime: string) {
  const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function EvaluationTable({ e, locale }: { e: Evaluation; locale: Locale }) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  return (
    <>
      <p role="status">
        <strong>{statusText[e.status][locale === "ru" ? 0 : 1]}</strong>
        {" · "}
        {t("порог", "шек")} {e.minMargin}%
        {e.costVisible && e.lowestMargin !== null
          ? ` · ${t("минимальная маржа", "ең төмен маржа")} ${e.lowestMargin}%`
          : ""}
        {!e.costVisible &&
          ` · ${t("себестоимость скрыта для вашей роли", "өзіндік құн сіздің рөліңіз үшін жасырын")}`}
      </p>
      {e.issues.length > 0 && (
        <ul>
          {e.issues.map((i, n) => (
            <li key={n}>
              {issueText[i.code]?.[locale === "ru" ? 0 : 1] || i.code}
              {i.itemId
                ? ` (${e.lines.find((l) => l.itemId === i.itemId)?.sku ?? i.itemId.slice(0, 8)})`
                : ""}
            </li>
          ))}
        </ul>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{t("Товар", "Тауар")}</th>
              <th scope="col">{t("Цена", "Баға")}</th>
              <th scope="col">
                {e.offer === "discount"
                  ? t("Акция", "Акция")
                  : t("Кол-во", "Саны")}
              </th>
              <th scope="col">{t("Себестоимость", "Өзіндік құн")}</th>
              <th scope="col">{t("Маржа", "Маржа")}</th>
              <th scope="col">{t("Доступно", "Қолжетімді")}</th>
            </tr>
          </thead>
          <tbody>
            {e.lines.map((l) => (
              <tr key={l.itemId}>
                <td>
                  {(locale === "kk" && l.nameKk) || l.nameRu || l.itemId}
                  <br />
                  <small>{l.sku}</small>
                </td>
                <td>{money(l.priceMinor, locale)}</td>
                <td>
                  {e.offer === "discount"
                    ? `${money(l.promoMinor, locale)} (−${l.discount}%)`
                    : l.quantity}
                </td>
                <td>
                  {e.costVisible ? money(l.costMinor, locale) : "—"}
                  <br />
                  <small>
                    {l.costSource === "stock_average"
                      ? t("средняя по остатку", "қалдық бойынша орташа")
                      : l.costSource === "purchase_price"
                        ? t("закупочная цена", "сатып алу бағасы")
                        : t("нет данных", "дерек жоқ")}
                  </small>
                </td>
                <td>
                  {e.costVisible
                    ? l.margin !== null
                      ? `${l.margin}% (${t("было", "бұрын")} ${l.regularMargin}%)`
                      : l.regularMargin
                        ? "—"
                        : t("неизвестно", "белгісіз")
                    : "—"}
                </td>
                <td>{l.available ?? t("услуга", "қызмет")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {e.bundle && (
        <p>
          {t("Комплект", "Жиынтық")}: {money(e.bundle.priceMinor, locale)} ·{" "}
          {t("по обычным ценам", "әдеттегі бағамен")}{" "}
          {money(e.bundle.regularMinor, locale)}
          {e.costVisible &&
            ` · ${t("себестоимость", "өзіндік құн")} ${money(e.bundle.costMinor, locale)} · ${t("маржа", "маржа")} ${e.bundle.margin ?? t("неизвестно", "белгісіз")}${e.bundle.margin ? "%" : ""}`}
          {e.bundle.sets !== null &&
            ` · ${t("наборов из остатка", "қалдықтан жиынтық")} ${e.bundle.sets}`}
        </p>
      )}
    </>
  );
}
type Draft = CampaignData;
function emptyDraft(branchId: string): Draft {
  const today = new Date().toISOString().slice(0, 10);
  return {
    name: "",
    branchId,
    warehouseId: null,
    startsOn: today,
    endsOn: today,
    budget: null,
    minMargin: "15",
    offer: { kind: "discount", lines: [] },
    segment: {
      kind: "all",
      itemIds: [],
      days: 90,
      channel: "none",
      excluded: [],
    },
    materials: {
      ru: { title: "", body: "", terms: "" },
      kk: { title: "", body: "", terms: "" },
      imageId: null,
    },
  };
}
// Campaign editor: every change re-evaluates margin and availability on the server.
function CampaignEditor({
  base,
  locale,
  items,
  warehouses,
  initial,
  images,
  save,
}: {
  base: string;
  locale: Locale;
  items: Item[];
  warehouses: Warehouse[];
  initial: Draft;
  images: Detail["images"];
  save: (d: Draft, key: string, note: string) => Promise<void>;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const [d, setD] = useState<Draft>(initial),
    [e, setE] = useState<Evaluation | null>(null),
    [evalError, setEvalError] = useState(""),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [key, setKey] = useState(() => crypto.randomUUID());
  const set = (patch: Partial<Draft>) => {
    setD((v) => ({ ...v, ...patch }));
    setKey(crypto.randomUUID());
  };
  useEffect(() => {
    if (!d.offer.lines.length) return;
    const timer = setTimeout(() => {
      api<Evaluation>(`${base}/marketing/evaluate`, "POST", d)
        .then((v) => (setE(v), setEvalError("")))
        .catch((x) => setEvalError(x.code || "INVALID_INPUT"));
    }, 400);
    return () => clearTimeout(timer);
  }, [base, d]);
  const lines = d.offer.lines as {
    itemId: string;
    discount?: string;
    quantity?: string;
  }[];
  const setLines = (next: typeof lines) =>
    set({
      offer:
        d.offer.kind === "discount"
          ? {
              kind: "discount",
              lines: next.map((l) => ({
                itemId: l.itemId,
                discount: l.discount || "10",
              })),
            }
          : {
              kind: "bundle",
              price: d.offer.price,
              lines: next.map((l) => ({
                itemId: l.itemId,
                quantity: l.quantity || "1",
              })),
            },
    });
  const text = (loc: "ru" | "kk", k: "title" | "body" | "terms", v: string) =>
    set({
      materials: {
        ...d.materials,
        [loc]: { ...d.materials[loc], [k]: v },
      },
    });
  const msg = (code: string) =>
    executionError(code, locale) || errorText(code, locale);
  return (
    <form
      onSubmit={async (ev) => {
        ev.preventDefault();
        setBusy(true);
        setError("");
        try {
          await save(d, key, note);
          setKey(crypto.randomUUID());
        } catch (x) {
          setError((x as { code?: string }).code || "INTERNAL_ERROR");
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy} className="commerce-grid">
        <Field label={t("Название", "Атауы")}>
          <input
            required
            minLength={2}
            maxLength={100}
            value={d.name}
            onChange={(v) => set({ name: v.target.value })}
          />
        </Field>
        <Field label={t("Начало", "Басталуы")}>
          <input
            type="date"
            required
            value={d.startsOn}
            onChange={(v) => set({ startsOn: v.target.value })}
          />
        </Field>
        <Field label={t("Окончание", "Аяқталуы")}>
          <input
            type="date"
            required
            value={d.endsOn}
            onChange={(v) => set({ endsOn: v.target.value })}
          />
        </Field>
        <Field label={t("Минимальная маржа, %", "Ең төмен маржа, %")}>
          <input
            required
            inputMode="decimal"
            pattern="\d{1,2}(\.\d{1,2})?"
            value={d.minMargin}
            onChange={(v) => set({ minMargin: v.target.value })}
          />
        </Field>
        <Field
          label={t(
            "Бюджет (план), ₸ — пусто, если не задан",
            "Бюджет (жоспар), ₸ — берілмесе бос",
          )}
        >
          <input
            inputMode="decimal"
            pattern="\d{1,15}(\.\d{1,2})?"
            value={d.budget ?? ""}
            onChange={(v) => set({ budget: v.target.value || null })}
          />
        </Field>
        <Field
          label={t(
            "Склад для наличия и себестоимости",
            "Қалдық пен өзіндік құн қоймасы",
          )}
        >
          <select
            value={d.warehouseId ?? ""}
            onChange={(v) => set({ warehouseId: v.target.value || null })}
          >
            <option value="">
              {t("Все склады филиала", "Филиалдың барлық қоймалары")}
            </option>
            {warehouses
              .filter((w) => w.branch_id === d.branchId)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label={t("Тип предложения", "Ұсыныс түрі")}>
          <select
            value={d.offer.kind}
            onChange={(v) =>
              set({
                offer:
                  v.target.value === "bundle"
                    ? {
                        kind: "bundle",
                        price: "0",
                        lines: lines.map((l) => ({
                          itemId: l.itemId,
                          quantity: "1",
                        })),
                      }
                    : {
                        kind: "discount",
                        lines: lines.map((l) => ({
                          itemId: l.itemId,
                          discount: "10",
                        })),
                      },
              })
            }
          >
            <option value="discount">
              {t("Скидка на товары", "Тауарларға жеңілдік")}
            </option>
            <option value="bundle">
              {t("Комплект по цене", "Бағасы бар жиынтық")}
            </option>
          </select>
        </Field>
        {d.offer.kind === "bundle" && (
          <Field label={t("Цена комплекта, ₸", "Жиынтық бағасы, ₸")}>
            <input
              required
              inputMode="decimal"
              pattern="\d{1,15}(\.\d{1,2})?"
              value={d.offer.price}
              onChange={(v) =>
                set({
                  offer: {
                    ...(d.offer as Extract<Draft["offer"], { kind: "bundle" }>),
                    price: v.target.value,
                  },
                })
              }
            />
          </Field>
        )}
      </fieldset>
      <fieldset disabled={busy}>
        <legend>{t("Товары предложения", "Ұсыныс тауарлары")}</legend>
        {lines.map((l, i) => (
          <div key={i} className="commerce-grid">
            <Field label={t("Товар", "Тауар")}>
              <select
                value={l.itemId}
                onChange={(v) =>
                  setLines(
                    lines.map((x, j) =>
                      j === i ? { ...x, itemId: v.target.value } : x,
                    ),
                  )
                }
              >
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.sku} · {it.name_ru}
                  </option>
                ))}
              </select>
            </Field>
            {d.offer.kind === "discount" ? (
              <Field label={t("Скидка, %", "Жеңілдік, %")}>
                <input
                  required
                  inputMode="decimal"
                  pattern="\d{1,2}(\.\d{1,2})?"
                  value={l.discount ?? ""}
                  onChange={(v) =>
                    setLines(
                      lines.map((x, j) =>
                        j === i ? { ...x, discount: v.target.value } : x,
                      ),
                    )
                  }
                />
              </Field>
            ) : (
              <Field label={t("Количество", "Саны")}>
                <input
                  required
                  inputMode="decimal"
                  value={l.quantity ?? ""}
                  onChange={(v) =>
                    setLines(
                      lines.map((x, j) =>
                        j === i ? { ...x, quantity: v.target.value } : x,
                      ),
                    )
                  }
                />
              </Field>
            )}
            <button
              type="button"
              className="secondary-button"
              onClick={() => setLines(lines.filter((_, j) => j !== i))}
            >
              {t("Убрать", "Алып тастау")}
            </button>
          </div>
        ))}
        {items.length > 0 && lines.length < 20 && (
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              setLines([
                ...lines,
                {
                  itemId:
                    items.find((it) => !lines.some((l) => l.itemId === it.id))
                      ?.id ?? items[0].id,
                  discount: "10",
                  quantity: "1",
                },
              ])
            }
          >
            {t("Добавить товар", "Тауар қосу")}
          </button>
        )}
      </fieldset>
      {evalError ? (
        <p role="alert" className="commerce-alert">
          {msg(evalError)}
        </p>
      ) : (
        e &&
        d.offer.lines.length > 0 && <EvaluationTable e={e} locale={locale} />
      )}
      <fieldset disabled={busy} className="commerce-grid">
        <legend>{t("Сегмент и согласия", "Сегмент және келісімдер")}</legend>
        <Field label={t("Клиенты", "Клиенттер")}>
          <select
            value={d.segment.kind}
            onChange={(v) =>
              set({
                segment: {
                  ...d.segment,
                  kind: v.target.value as Draft["segment"]["kind"],
                  itemIds:
                    v.target.value === "bought_items"
                      ? d.offer.lines.map((l) => l.itemId)
                      : [],
                },
              })
            }
          >
            <option value="all">
              {t("Все клиенты филиала", "Филиалдың барлық клиенттері")}
            </option>
            <option value="bought_items">
              {t("Покупали эти товары", "Осы тауарларды сатып алғандар")}
            </option>
            <option value="inactive">
              {t("Давно не покупали", "Көптен бері сатып алмағандар")}
            </option>
          </select>
        </Field>
        <Field label={t("Период, дней", "Кезең, күн")}>
          <input
            type="number"
            min={1}
            max={730}
            value={d.segment.days}
            onChange={(v) =>
              set({
                segment: { ...d.segment, days: Number(v.target.value) || 90 },
              })
            }
          />
        </Field>
        <Field
          label={t(
            "Канал (только с согласием клиента)",
            "Арна (тек клиент келісімімен)",
          )}
        >
          <select
            value={d.segment.channel}
            onChange={(v) =>
              set({
                segment: {
                  ...d.segment,
                  channel: v.target.value as Draft["segment"]["channel"],
                },
              })
            }
          >
            <option value="none">
              {t(
                "Без рассылки (только материалы)",
                "Таратусыз (тек материалдар)",
              )}
            </option>
            <option value="messenger">Telegram</option>
            <option value="email">
              {t("E-mail (не подключён)", "E-mail (қосылмаған)")}
            </option>
            <option value="sms">
              {t("SMS (не подключён)", "SMS (қосылмаған)")}
            </option>
          </select>
        </Field>
      </fieldset>
      <fieldset disabled={busy} className="commerce-grid">
        <legend>{t("Тексты RU / KK", "Мәтіндер RU / KK")}</legend>
        {(["ru", "kk"] as const).map((loc) => (
          <div key={loc}>
            <Field
              label={`${t("Заголовок", "Тақырып")} (${loc.toUpperCase()})`}
            >
              <input
                required
                minLength={2}
                maxLength={80}
                value={d.materials[loc].title}
                onChange={(v) => text(loc, "title", v.target.value)}
              />
            </Field>
            <Field label={`${t("Текст", "Мәтін")} (${loc.toUpperCase()})`}>
              <textarea
                maxLength={600}
                rows={3}
                value={d.materials[loc].body}
                onChange={(v) => text(loc, "body", v.target.value)}
              />
            </Field>
            <Field label={`${t("Условия", "Шарттар")} (${loc.toUpperCase()})`}>
              <textarea
                maxLength={300}
                rows={2}
                value={d.materials[loc].terms}
                onChange={(v) => text(loc, "terms", v.target.value)}
              />
            </Field>
          </div>
        ))}
        {images.length > 0 && (
          <Field label={t("Изображение", "Сурет")}>
            <select
              value={d.materials.imageId ?? ""}
              onChange={(v) =>
                set({
                  materials: {
                    ...d.materials,
                    imageId: v.target.value || null,
                  },
                })
              }
            >
              <option value="">{t("Без изображения", "Суретсіз")}</option>
              {images.map((img) => (
                <option key={img.id} value={img.id}>
                  {img.alt_ru}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field
          label={t("Что изменено (для версии)", "Не өзгерді (нұсқа үшін)")}
        >
          <input
            required
            minLength={3}
            maxLength={250}
            value={note}
            onChange={(v) => setNote(v.target.value)}
          />
        </Field>
        <div className="procurement-submit">
          <button
            type="submit"
            className="primary-button"
            disabled={!d.offer.lines.length}
          >
            {busy
              ? t("Сохраняем…", "Сақталуда…")
              : t("Сохранить версию", "Нұсқаны сақтау")}
          </button>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="commerce-alert">
          {msg(error)}
        </p>
      )}
    </form>
  );
}
// T039: campaigns with margin control, versioned approval, materials and an honest publication log.
export function MarketingPage({
  workspace,
  locale,
}: {
  workspace: Workspace;
  locale: Locale;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const base = `organizations/${workspace.organization.id}`;
  const role = workspace.organization.role;
  const branchId = workspace.branches[0]?.id ?? "";
  const [list, setList] = useState<Row[] | null>(null),
    [items, setItems] = useState<Item[]>([]),
    [warehouses, setWarehouses] = useState<Warehouse[]>([]),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<Detail | null>(null),
    [analysis, setAnalysis] = useState<Analysis | null>(null),
    [creating, setCreating] = useState(false),
    [editing, setEditing] = useState(false),
    [error, setError] = useState(""),
    [info, setInfo] = useState(""),
    [segment, setSegment] = useState<Record<
      string,
      number | string | boolean
    > | null>(null),
    [rec, setRec] = useState<{
      sufficient: boolean;
      anchorOrders: number;
      minAnchorOrders: number;
      items: {
        itemId: string;
        sku: string;
        name: string;
        together: number;
        confidence: string;
        lift: string;
      }[];
    } | null>(null),
    [revision, setRevision] = useRevision();
  const refresh = () => setRevision((v) => v + 1);
  const msg = (code: string) =>
    executionError(code, locale) || errorText(code, locale);
  const fail = (x: unknown) =>
    setError((x as { code?: string }).code || "INTERNAL_ERROR");
  useEffect(() => {
    let live = true;
    api<{ items: Row[] }>(`${base}/marketing/campaigns`)
      .then((v) => live && (setList(v.items), setError("")))
      .catch((x) => live && fail(x));
    if (can(role, "catalog:read"))
      api<{ items: Item[] }>(`${base}/catalog?limit=100`)
        .then((v) => live && setItems(v.items))
        .catch(() => undefined);
    if (can(role, "inventory:read"))
      api<{ items: Warehouse[] }>(`${base}/warehouses`)
        .then((v) => live && setWarehouses(v.items))
        .catch(() => undefined);
    if (selected) {
      api<Detail>(`${base}/marketing/campaigns/${selected}`)
        .then((v) => live && setDetail(v))
        .catch((x) => live && fail(x));
      api<Analysis>(`${base}/marketing/campaigns/${selected}/analysis`)
        .then((v) => live && setAnalysis(v))
        .catch(() => live && setAnalysis(null));
    }
    return () => {
      live = false;
    };
  }, [base, role, revision, selected]);
  const decide = async (body: Record<string, unknown>) => {
    if (!detail) return;
    try {
      await api(
        `${base}/marketing/campaigns/${detail.campaign.id}/decisions`,
        "POST",
        {
          key: crypto.randomUUID(),
          version: detail.campaign.version,
          ...body,
        },
      );
      refresh();
    } catch (x) {
      fail(x);
    }
  };
  const c = detail?.campaign;
  return (
    <section className="panel commerce-page" aria-labelledby="marketing-title">
      <h2 id="marketing-title">{t("Продвижение", "Жылжыту")}</h2>
      <p>
        {t(
          "Акции и комплекты с проверкой маржи по фактической себестоимости, наличием и сроками. Согласование привязано к версии. Материалы выгружаются в PDF; статус «опубликовано» не ставится без подтверждения канала. Автопубликация, рекламный бюджет, e-mail/SMS и генератор изображений не подключены.",
          "Нақты өзіндік құн бойынша маржасы, қалдығы мен мерзімі тексерілетін акциялар мен жиынтықтар. Келісу нұсқаға байланған. Материалдар PDF-ке жүктеледі; арна растамасынсыз «жарияланды» күйі қойылмайды. Автожариялау, жарнама бюджеті, e-mail/SMS және сурет генераторы қосылмаған.",
        )}
      </p>
      {error && (
        <p role="alert" className="commerce-alert">
          {msg(error)}
        </p>
      )}
      {info && (
        <p role="status" className="commerce-success">
          {info}
        </p>
      )}
      {!list ? (
        <p aria-busy="true">{t("Загрузка…", "Жүктелуде…")}</p>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <caption>{t("Акции", "Акциялар")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("Название", "Атауы")}</th>
                  <th scope="col">{t("Состояние", "Күйі")}</th>
                  <th scope="col">{t("Версия", "Нұсқа")}</th>
                  <th scope="col">{t("Сроки", "Мерзімі")}</th>
                </tr>
              </thead>
              <tbody>
                {list.length === 0 && (
                  <tr>
                    <td colSpan={4}>
                      {t("Акций пока нет.", "Әзірге акция жоқ.")}
                    </td>
                  </tr>
                )}
                {list.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <button
                        type="button"
                        className="secondary-button"
                        aria-pressed={selected === r.id}
                        onClick={() => {
                          setSelected(r.id);
                          setEditing(false);
                          setSegment(null);
                          setInfo("");
                        }}
                      >
                        {r.name}
                      </button>
                    </td>
                    <td>
                      {states[r.state]?.[locale === "ru" ? 0 : 1] ?? r.state}
                    </td>
                    <td>
                      v{r.version}
                      {r.approved_version
                        ? ` (${t("согласована", "келісілді")} v${r.approved_version})`
                        : ""}
                    </td>
                    <td>
                      {r.starts_on} — {r.ends_on}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {can(role, "marketing:write") && (
            <button
              type="button"
              className="primary-button"
              onClick={() => setCreating((v) => !v)}
              aria-expanded={creating}
            >
              {t("Новая акция", "Жаңа акция")}
            </button>
          )}
          {creating && (
            <CampaignEditor
              base={base}
              locale={locale}
              items={items}
              warehouses={warehouses}
              images={[]}
              initial={emptyDraft(branchId)}
              save={async (d, key) => {
                const r = await api<{ id: string }>(
                  `${base}/marketing/campaigns`,
                  "POST",
                  {
                    key,
                    data: d,
                  },
                );
                setCreating(false);
                setSelected(r.id);
                refresh();
              }}
            />
          )}
        </>
      )}
      {selected && !detail && (
        <p aria-busy="true">{t("Загрузка акции…", "Акция жүктелуде…")}</p>
      )}
      {detail && c && c.id === selected && (
        <article aria-labelledby="campaign-title">
          <h3 id="campaign-title">
            {c.data.name} · v{c.version} ·{" "}
            {states[c.state]?.[locale === "ru" ? 0 : 1]}
          </h3>
          <p>
            {c.data.startsOn} — {c.data.endsOn} ·{" "}
            {t("бюджет (план)", "бюджет (жоспар)")}:{" "}
            {c.data.budget ? `${c.data.budget} ₸` : t("не задан", "берілмеген")}
          </p>
          <EvaluationTable e={detail.evaluation} locale={locale} />
          <div className="commerce-grid">
            {detail.can.write && c.state !== "archived" && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => setEditing((v) => !v)}
              >
                {t("Изменить (новая версия)", "Өзгерту (жаңа нұсқа)")}
              </button>
            )}
            {detail.can.write && ["draft", "rejected"].includes(c.state) && (
              <button
                type="button"
                className="primary-button"
                onClick={() => decide({ kind: "submit" })}
              >
                {t("Отправить на согласование", "Келісуге жіберу")}
              </button>
            )}
          </div>
          {editing && (
            <>
              <button
                type="button"
                className="secondary-button"
                onClick={async () => {
                  try {
                    const tpl = await api<CampaignData["materials"]>(
                      `${base}/marketing/campaigns/${c.id}/template`,
                    );
                    setInfo(
                      `${t("Шаблон", "Үлгі")}: ${tpl.ru.body} / ${tpl.kk.body}`,
                    );
                  } catch (x) {
                    fail(x);
                  }
                }}
              >
                {t(
                  "Показать шаблонный текст по фактам",
                  "Деректер бойынша үлгі мәтінді көрсету",
                )}
              </button>
              <CampaignEditor
                key={c.version}
                base={base}
                locale={locale}
                items={items}
                warehouses={warehouses}
                images={detail.images}
                initial={c.data}
                save={async (d, key, note) => {
                  await api(`${base}/marketing/campaigns/${c.id}`, "PATCH", {
                    key,
                    version: c.version,
                    data: d,
                    note,
                  });
                  setEditing(false);
                  refresh();
                }}
              />
            </>
          )}
          {detail.can.approve && c.state === "pending" && (
            <ActionForm
              locale={locale}
              label={t("Решение по версии", "Нұсқа бойынша шешім")}
              submit={async (d, key) => {
                await api(
                  `${base}/marketing/campaigns/${c.id}/decisions`,
                  "POST",
                  {
                    key,
                    version: c.version,
                    kind: f(d, "kind"),
                    note: f(d, "note"),
                    ...(f(d, "kind") === "approve"
                      ? { override: d.get("override") === "on" }
                      : {}),
                  },
                );
                refresh();
              }}
            >
              <Field label={t("Решение", "Шешім")}>
                <select name="kind">
                  <option value="approve">{t("Согласовать", "Келісу")}</option>
                  <option value="reject">{t("Отклонить", "Қабылдамау")}</option>
                </select>
              </Field>
              <Field label={t("Комментарий / причина", "Түсініктеме / себеп")}>
                <input name="note" required minLength={3} maxLength={250} />
              </Field>
              {detail.can.override && detail.evaluation.status !== "ok" && (
                <Field
                  label={t(
                    "Разрешить ниже порога (владелец, причина ≥ 10 символов)",
                    "Шектен төмен рұқсат ету (иесі, себеп ≥ 10 таңба)",
                  )}
                >
                  <input type="checkbox" name="override" />
                </Field>
              )}
            </ActionForm>
          )}
          {detail.can.write && c.state !== "archived" && (
            <ActionForm
              locale={locale}
              label={t("Загрузить изображение", "Суретті жүктеу")}
              submit={async (d, key) => {
                const file = d.get("file") as File;
                if (!file || !file.size) throw new Error("INVALID_INPUT");
                await api(
                  `${base}/marketing/campaigns/${c.id}/images`,
                  "POST",
                  {
                    key,
                    mime:
                      file.type === "image/jpeg" ? "image/jpeg" : "image/png",
                    content: await base64(file),
                    altRu: f(d, "altRu"),
                    altKk: f(d, "altKk"),
                  },
                );
                refresh();
              }}
            >
              <Field
                label={t(
                  "PNG или JPEG до 2 МБ",
                  "2 МБ дейінгі PNG немесе JPEG",
                )}
              >
                <input
                  type="file"
                  name="file"
                  accept="image/png,image/jpeg"
                  required
                />
              </Field>
              <Field label={t("Описание (RU)", "Сипаттама (RU)")}>
                <input name="altRu" required minLength={3} maxLength={200} />
              </Field>
              <Field label={t("Описание (KK)", "Сипаттама (KK)")}>
                <input name="altKk" required minLength={3} maxLength={200} />
              </Field>
            </ActionForm>
          )}
          {detail.can.write && (
            <button
              type="button"
              className="secondary-button"
              onClick={() =>
                api(
                  `${base}/marketing/campaigns/${c.id}/images/generate`,
                  "POST",
                  {},
                ).catch(fail)
              }
            >
              {t("Сгенерировать изображение", "Сурет жасау")}
            </button>
          )}
          {c.state === "approved" && detail.can.write && (
            <section aria-labelledby="materials-title">
              <h4 id="materials-title">
                {t("Материалы (PDF)", "Материалдар (PDF)")}
              </h4>
              <div className="commerce-grid">
                {(["poster", "price_tag", "card"] as const).flatMap(
                  (material) =>
                    (["ru", "kk"] as const).map((loc) => (
                      <button
                        key={material + loc}
                        type="button"
                        className="secondary-button"
                        onClick={async () => {
                          try {
                            const r = await api<{
                              filename: string;
                              mime: string;
                              content: string;
                            }>(
                              `${base}/marketing/campaigns/${c.id}/exports`,
                              "POST",
                              {
                                key: crypto.randomUUID(),
                                version: c.version,
                                material,
                                locale: loc,
                              },
                            );
                            download(r.content, r.filename, r.mime);
                            refresh();
                          } catch (x) {
                            fail(x);
                          }
                        }}
                      >
                        {material === "poster"
                          ? t("Плакат", "Плакат")
                          : material === "price_tag"
                            ? t("Ценник", "Баға белгісі")
                            : t("Карточка", "Карточка")}{" "}
                        {loc.toUpperCase()}
                      </button>
                    )),
                )}
              </div>
              {detail.can.approve && (
                <div className="commerce-grid">
                  {(["ru", "kk"] as const).map((loc) => (
                    <button
                      key={loc}
                      type="button"
                      className="primary-button"
                      onClick={async () => {
                        try {
                          const r = await api<{
                            state: string;
                            recipients: number;
                          }>(
                            `${base}/marketing/campaigns/${c.id}/publications`,
                            "POST",
                            {
                              key: crypto.randomUUID(),
                              version: c.version,
                              channel: "telegram",
                              locale: loc,
                            },
                          );
                          setInfo(
                            `${states[r.state]?.[locale === "ru" ? 0 : 1] ?? r.state} · ${t("получателей", "алушылар")}: ${r.recipients}`,
                          );
                          refresh();
                        } catch (x) {
                          fail(x);
                        }
                      }}
                    >
                      {t(
                        "Поставить в очередь Telegram",
                        "Telegram кезегіне қою",
                      )}{" "}
                      {loc.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
          <button
            type="button"
            className="secondary-button"
            onClick={async () => {
              try {
                setSegment(
                  await api(`${base}/marketing/segments/preview`, "POST", {
                    branchId: c.data.branchId,
                    segment: c.data.segment,
                  }),
                );
              } catch (x) {
                fail(x);
              }
            }}
          >
            {t("Проверить сегмент", "Сегментті тексеру")}
          </button>
          {segment && (
            <p role="status">
              {t("Подходит", "Сәйкес")}: {String(segment.matched)} ·{" "}
              {t("исключены", "алынып тасталған")}: {String(segment.excluded)} ·{" "}
              {t("без согласия", "келісімсіз")}: {String(segment.noConsent)} ·{" "}
              {t("нет контакта/чата", "байланыс/чат жоқ")}:{" "}
              {String(segment.noContact)} ·{" "}
              {t("можно связаться", "байланысуға болады")}:{" "}
              {String(segment.reachable)}
              {!segment.sendable && segment.channel !== "none"
                ? ` · ${t("канал не подключён для отправки", "арна жіберу үшін қосылмаған")}`
                : ""}
            </p>
          )}
          <h4>{t("Журнал публикаций", "Жариялау журналы")}</h4>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("Когда", "Қашан")}</th>
                  <th scope="col">{t("Канал", "Арна")}</th>
                  <th scope="col">{t("Состояние", "Күйі")}</th>
                  <th scope="col">
                    {t("Доставка (по каналу)", "Жеткізу (арна бойынша)")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.publications.length === 0 && (
                  <tr>
                    <td colSpan={4}>
                      {t(
                        "Ничего не выгружалось и не отправлялось.",
                        "Ештеңе жүктелмеген және жіберілмеген.",
                      )}
                    </td>
                  </tr>
                )}
                {detail.publications.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.created_at.slice(0, 16)} · {p.actor}
                    </td>
                    <td>
                      {p.channel === "export" ? "PDF" : "Telegram"} ·{" "}
                      {p.material} · {p.locale.toUpperCase()} · v{p.version}
                    </td>
                    <td>
                      {states[p.state]?.[locale === "ru" ? 0 : 1] ?? p.state}
                      {p.reason ? ` (${msg(p.reason) || p.reason})` : ""}
                    </td>
                    <td>
                      {p.channel === "telegram"
                        ? `${t("в очереди", "кезекте")} ${p.recipients} · ${t("доставлено", "жеткізілді")} ${p.sent} · ${t("не доставлено", "жеткізілмеді")} ${p.undelivered}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h4>{t("Версии и решения", "Нұсқалар мен шешімдер")}</h4>
          <ul className="today-list">
            {detail.versions.map((v) => (
              <li key={`v${v.version}`}>
                v{v.version} · {v.author} · {v.note} ·{" "}
                {v.created_at.slice(0, 16)}
              </li>
            ))}
            {detail.decisions.map((x, i) => (
              <li key={`d${i}`}>
                v{x.version} ·{" "}
                {states[x.decision]?.[locale === "ru" ? 0 : 1] ?? x.decision}
                {x.override
                  ? ` · ${t("ниже порога с разрешения владельца", "иесінің рұқсатымен шектен төмен")}`
                  : ""}{" "}
                · {x.actor} · {x.note}
              </li>
            ))}
          </ul>
          {detail.can.approve && c.state !== "archived" && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => decide({ kind: "archive", note: "В архив" })}
            >
              {t("В архив", "Мұрағатқа")}
            </button>
          )}
          {analysis && (
            <section aria-labelledby="analysis-title">
              <h4 id="analysis-title">
                {t("Анализ результата", "Нәтиже талдауы")}
              </h4>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t("Показатель", "Көрсеткіш")}</th>
                      <th scope="col">{t("Период акции", "Акция кезеңі")}</th>
                      <th scope="col">
                        {t("Контрольный период", "Бақылау кезеңі")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.campaign ? (
                      (
                        [
                          [
                            t("Даты", "Күндер"),
                            (p: Period) => `${p.from} — ${p.to}`,
                          ],
                          [
                            t("Продано (нетто)", "Сатылды (нетто)"),
                            (p: Period) => p.quantity,
                          ],
                          [
                            t("Выручка", "Түсім"),
                            (p: Period) => money(p.revenueMinor, locale),
                          ],
                          [
                            t("Скидки", "Жеңілдіктер"),
                            (p: Period) => money(p.discountMinor, locale),
                          ],
                          [
                            t("Себестоимость", "Өзіндік құн"),
                            (p: Period) =>
                              detail.can.cost
                                ? money(p.costMinor, locale)
                                : "—",
                          ],
                          [
                            t("Валовая прибыль", "Жалпы пайда"),
                            (p: Period) =>
                              detail.can.cost
                                ? money(p.grossProfitMinor, locale)
                                : "—",
                          ],
                          [
                            t("Заказов", "Тапсырыстар"),
                            (p: Period) => String(p.orders),
                          ],
                        ] as [string, (p: Period) => string][]
                      ).map(([label, value]) => (
                        <tr key={label}>
                          <th scope="row">{label}</th>
                          <td>{value(analysis.campaign!)}</td>
                          <td>
                            {analysis.control ? value(analysis.control) : "—"}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={3}>
                          {t(
                            "Период акции ещё не начался.",
                            "Акция кезеңі әлі басталмады.",
                          )}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p>
                {t("Расходы на акцию", "Акция шығындары")}:{" "}
                {money(analysis.spendMinor, locale)}
                {detail.can.cost &&
                  ` · ${t("после расходов", "шығындардан кейін")}: ${money(analysis.netAfterSpendMinor, locale)}`}
                {" · "}
                {t("охват", "қамту")}:{" "}
                {analysis.reach
                  ? `${analysis.reach.sent} ${t("доставлено", "жеткізілді")}`
                  : t("нет данных", "дерек жоқ")}
              </p>
              <ul>
                {analysis.caveats.map((x) => (
                  <li key={x}>
                    {caveatText[x]?.[locale === "ru" ? 0 : 1] ?? x}
                  </li>
                ))}
              </ul>
              {detail.can.write && (
                <ActionForm
                  locale={locale}
                  label={t(
                    "Внести фактические расходы",
                    "Нақты шығындарды енгізу",
                  )}
                  submit={async (d, key) => {
                    await api(
                      `${base}/marketing/campaigns/${c.id}/spend`,
                      "POST",
                      {
                        key,
                        spendVersion: analysis.spendVersion,
                        spend: f(d, "spend") || null,
                        note: f(d, "note"),
                      },
                    );
                    refresh();
                  }}
                >
                  <Field
                    label={t(
                      "Сумма, ₸ (пусто — неизвестно)",
                      "Сома, ₸ (бос — белгісіз)",
                    )}
                  >
                    <input
                      name="spend"
                      inputMode="decimal"
                      pattern="\d{1,15}(\.\d{1,2})?"
                    />
                  </Field>
                  <Field label={t("Документ-основание", "Негіздеме құжаты")}>
                    <input name="note" required minLength={3} maxLength={250} />
                  </Field>
                </ActionForm>
              )}
            </section>
          )}
        </article>
      )}
      {items.length > 0 && (
        <section aria-labelledby="copurchase-title">
          <h3 id="copurchase-title">
            {t("Совместные покупки", "Бірге сатып алу")}
          </h3>
          <ActionForm
            locale={locale}
            label={t("Найти", "Табу")}
            submit={async (d) => {
              setRec(
                await api(
                  `${base}/marketing/recommendations?itemId=${f(d, "itemId")}&days=${f(d, "days") || "180"}`,
                ),
              );
            }}
          >
            <Field label={t("Товар", "Тауар")}>
              <select name="itemId">
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.sku} · {it.name_ru}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("За дней", "Күн ішінде")}>
              <input
                name="days"
                type="number"
                min={30}
                max={730}
                defaultValue={180}
              />
            </Field>
          </ActionForm>
          {rec &&
            (rec.sufficient ? (
              <ul className="today-list">
                {rec.items.length === 0 && (
                  <li>{t("Устойчивых пар нет.", "Тұрақты жұптар жоқ.")}</li>
                )}
                {rec.items.map((x) => (
                  <li key={x.itemId}>
                    {x.sku} · {x.name} · {t("вместе", "бірге")} {x.together} ·{" "}
                    {x.confidence}% · lift {x.lift}
                  </li>
                ))}
              </ul>
            ) : (
              <p role="status">
                {t(
                  `Недостаточно истории: ${rec.anchorOrders} заказов с товаром, нужно не меньше ${rec.minAnchorOrders}. Рекомендации не показываются.`,
                  `Тарих жеткіліксіз: тауармен ${rec.anchorOrders} тапсырыс, кемінде ${rec.minAnchorOrders} қажет. Ұсыныстар көрсетілмейді.`,
                )}
              </p>
            ))}
        </section>
      )}
    </section>
  );
}
