"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { branchName } from "@/lib/i18n";
import Decimal from "decimal.js";
import type { Locale, Workspace } from "@/domain/contracts";
import type { OutcomeView } from "@/domain/outcomes";
import { api } from "@/lib/client";
import { useRevision } from "@/lib/live";
import { errorText } from "@/lib/i18n";
import { industryText, industryLabels } from "@/lib/industry-i18n";
type Option = { id: string; name: string };
export function OutcomesPage({
  workspace,
  locale,
  onOpenOrder,
}: {
  workspace: Workspace;
  locale: Locale;
  onOpenOrder: (id: string, branch: string) => void;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const base = `organizations/${workspace.organization.id}`;
  const today = new Date().toISOString().slice(0, 10);
  const [branch, setBranch] = useState(
      workspace.organization.branch_id ?? workspace.branches[0]?.id ?? "",
    ),
    [from, setFrom] = useState(today.slice(0, 7) + "-01"),
    [to, setTo] = useState(today),
    [revision, setRevision] = useRevision();
  const [view, setView] = useState<OutcomeView | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [saved, setSaved] = useState(false);
  const [sourceType, setSourceType] = useState("order"),
    [sourceId, setSourceId] = useState(""),
    [options, setOptions] = useState<Option[]>([]),
    [offers, setOffers] = useState<Option[]>([]);
  const retry = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => {
    let live = true;
    api<OutcomeView>(
      `${base}/outcomes?branchId=${branch}&from=${from}&to=${to}`,
    )
      .then((v) => {
        if (live) {
          setView(v);
          setError("");
          setLoading(false);
        }
      })
      .catch((e) => {
        if (live) {
          setError(e.code);
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [base, branch, from, to, revision]);
  useEffect(() => {
    let live = true;
    api<{ items: { id: string; number: number; state: string }[] }>(
      `${base}/${sourceType === "order" ? "orders" : "purchases"}?branchId=${branch}&limit=100`,
    )
      .then(
        (v) =>
          live &&
          setOptions(
            v.items
              .filter(
                (x) =>
                  !["fulfilled", "partial", "completed", "cancelled"].includes(
                    x.state,
                  ),
              )
              .map((x) => ({
                id: x.id,
                name: `№${x.number} · ${industryText(locale, x.state)}`,
              })),
          ),
      )
      .catch((e) => live && setError(e.code));
    return () => {
      live = false;
    };
  }, [base, branch, sourceType, revision, locale]);
  useEffect(() => {
    if (sourceType !== "purchase" || !sourceId) return;
    let live = true;
    api<{ lines: { item_id: string; quantity: string }[] }>(
      `${base}/purchases/${sourceId}`,
    )
      .then((p) =>
        Promise.all(
          p.lines.map((l) =>
            api<{
              offers: {
                id: string;
                supplier_name: string;
                data: { supplierSku: string };
              }[];
            }>(`${base}/purchasing/compare`, "POST", {
              itemId: l.item_id,
              quantity: l.quantity,
              date: today,
            }),
          ),
        ),
      )
      .then(
        (rows) =>
          live &&
          setOffers(
            rows.flatMap((r) =>
              r.offers.map((o) => ({
                id: o.id,
                name: o.supplier_name + " · " + o.data.supplierSku,
              })),
            ),
          ),
      )
      .catch((e) => live && setError(e.code));
    return () => {
      live = false;
    };
  }, [base, sourceId, sourceType, today]);
  const money = (v: string | null) =>
    v === null ? "–" : new Decimal(v).div(100).toFixed(2) + " ₸";
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setSaved(false);
    const f = new FormData(e.currentTarget),
      payload = {
        branchId: branch,
        sourceType,
        sourceId,
        forecast: String(f.get("forecast") ?? "") || null,
        alternativeOfferIds:
          sourceType === "purchase" ? f.getAll("offers").map(String) : [],
        limitations: String(f.get("limitations") ?? ""),
      };
    const signature = JSON.stringify(payload);
    if (retry.current?.signature !== signature)
      retry.current = { signature, key: crypto.randomUUID() };
    try {
      await api(base + "/outcomes", "POST", {
        ...payload,
        key: retry.current.key,
      });
      setRevision((n) => n + 1);
      setSaved(true);
      retry.current = null;
    } catch (e) {
      setError((e as { code: string }).code ?? "INTERNAL_ERROR");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel outcomes-page">
      <h2>
        {t(
          "Результаты: прогноз → действие → факт",
          "Нәтижелер: болжам → әрекет → факт",
        )}
      </h2>
      <p>
        {t(
          "Заказы, созданные в выбранные даты: исполнение и оплаты на момент обновления. Один заказ учитывается один раз, даже если связан с несколькими модулями. Рост выручки сам по себе не доказывает эффект действия.",
          "Таңдалған күндерде құрылған тапсырыстар: жаңарту сәтіндегі орындалу мен төлемдер. Бірнеше модульмен байланысты тапсырыс бір рет есептеледі. Табыстың өсуі әрекет әсерін өздігінен дәлелдемейді.",
        )}
      </p>
      <div className="form-grid">
        <label>
          {t("Филиал", "Филиал")}
          <select
            aria-label={t("Филиал", "Филиал")}
            value={branch}
            onChange={(e) => {
              setBranch(e.target.value);
              setSourceId("");
              setView(null);
              setLoading(true);
            }}
          >
            {workspace.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {branchName(b.name, locale)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("С даты", "Бастап")}
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setLoading(true);
            }}
          />
        </label>
        <label>
          {t("По дату", "Дейін")}
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setLoading(true);
            }}
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="error">
          {industryLabels[error]
            ? industryText(locale, error)
            : errorText(error, locale)}
        </p>
      )}
      {loading && <p role="status">{t("Загрузка…", "Жүктелуде…")}</p>}
      {saved && (
        <p role="status">
          {t("Исходное сравнение сохранено.", "Бастапқы салыстыру сақталды.")}
        </p>
      )}
      {view && !loading && (
        <>
          <p>
            {t("Выручка", "Табыс")}: {money(view.revenueMinor)} ·{" "}
            {t("Оплаты за вычетом возвратов", "Қайтарым шегерілген төлемдер")}:{" "}
            {money(view.paidMinor)}
          </p>
          <p>
            {t("Известная себестоимость", "Белгілі өзіндік құн")}:{" "}
            {money(view.knownCostMinor)} ·{" "}
            {t(
              "Заказов с неизвестной себестоимостью",
              "Өзіндік құны белгісіз тапсырыстар",
            )}
            : {view.unknownCostOrders}
          </p>
          <p>
            {t(
              "Операционные расходы и прибыль проверяются отдельно в финансах. Прогнозы ниже не прибавляются к фактической выручке.",
              "Операциялық шығындар мен пайда қаржыда бөлек тексеріледі. Төмендегі болжамдар нақты табысқа қосылмайды.",
            )}
          </p>
          <h3>{t("Исходные операции", "Бастапқы операциялар")}</h3>
          {view.facts.map((f) => (
            <details key={f.id}>
              <summary>
                №{f.number} · {industryText(locale, f.state)} ·{" "}
                {money(f.revenueMinor)}
              </summary>
              <p>
                {t("Оплата", "Төлем")}: {money(f.paidMinor)} ·{" "}
                {t("Себестоимость", "Өзіндік құн")}: {money(f.costMinor)}
              </p>
              <button
                className="button secondary"
                onClick={() => onOpenOrder(f.id, f.branchId)}
              >
                {t("Открыть заказ и события", "Тапсырыс пен оқиғаларды ашу")}
              </button>
              <p>
                {t("Связанные документы", "Байланысты құжаттар")}:{" "}
                {f.sources.map((s) => `${s.type} ${s.id}`).join("; ") || "–"}
              </p>
              <p>
                {t(
                  "События исполнения и возврата",
                  "Орындау және қайтару оқиғалары",
                )}
                : {f.eventIds.join(", ") || "–"}
              </p>
            </details>
          ))}
          <h3>{t("Предложения и выполнение", "Ұсыныстар және орындалу")}</h3>
          <p>
            {t(
              "Отраслевые действия, подготовка публикации и операции канала ещё не являются выручкой. Экспорт материала не означает публикацию. Персональные записи клиники здесь не показываются.",
              "Салалық әрекеттер, жарияланымды дайындау және арна операциялары әлі табыс емес. Материалды экспорттау жариялау болып саналмайды. Клиниканың жеке жазбалары мұнда көрсетілмейді.",
            )}
          </p>
          {view.actions.map((a) => (
            <details key={a.id}>
              <summary>
                {industryText(locale, a.kind)} · {industryText(locale, a.state)}
              </summary>
              <p>{a.id}</p>
            </details>
          ))}
          {view.proposals.map((p) => (
            <p key={p.id}>
              {p.id} · {industryText(locale, p.state)} ·{" "}
              {t("Сумма действия, не экономия", "Әрекет сомасы, үнемдеу емес")}:{" "}
              {money(p.amountMinor)} · {p.resultId ?? "–"}
            </p>
          ))}
          <h3>
            {t(
              "Сохранённые сравнения: все даты",
              "Сақталған салыстырулар: барлық күндер",
            )}
          </h3>
          {view.measurements.map((m) => (
            <details key={m.id}>
              <summary>
                {m.sourceId} ·{" "}
                {t(
                  m.status === "measured"
                    ? "Измерено"
                    : m.status === "pending"
                      ? "Ожидает факта"
                      : "Несопоставимо",
                  m.status === "measured"
                    ? "Өлшенді"
                    : m.status === "pending"
                      ? "Нақты дерек күтілуде"
                      : "Салыстыруға келмейді",
                )}
              </summary>
              <p>
                {t("Прогноз", "Болжам")}: {money(m.forecastMinor)} ·{" "}
                {t("Сопоставимое предложение", "Салыстырмалы ұсыныс")}:{" "}
                {money(m.baselineMinor)} ·{" "}
                {t(
                  "Факт (выручка / стоимость закупки)",
                  "Нақты дерек (табыс / сатып алу құны)",
                )}
                : {money(m.actualMinor)} ·{" "}
                {t(
                  "Отклонение от прогноза / экономия закупки",
                  "Болжамнан ауытқу / сатып алу үнемі",
                )}
                : {money(m.differenceMinor)}
              </p>
              <p>{m.limitations}</p>
              <p>
                {t("Источники", "Дереккөздер")}:{" "}
                {m.evidenceIds.join(", ") || "–"}
              </p>
            </details>
          ))}
        </>
      )}
      <details>
        <summary>
          {t(
            "Зафиксировать прогноз до исполнения",
            "Орындалғанға дейін болжамды сақтау",
          )}
        </summary>
        <form onSubmit={save}>
          <p>
            {t(
              "Для закупки выберите по одному предложению на каждую позицию от одного альтернативного поставщика. Система проверит количество, упаковки, доставку, срок и условия оплаты. Уменьшение количества не считается экономией.",
              "Сатып алу үшін әр позицияға бір балама жеткізушінің бір ұсынысын таңдаңыз. Жүйе санды, қаптаманы, жеткізуді, мерзімді және төлем шарттарын тексереді. Санның азаюы үнем болып саналмайды.",
            )}
          </p>
          <div className="form-grid">
            <label>
              {t("Вид результата", "Нәтиже түрі")}
              <select
                aria-label={t("Вид результата", "Нәтиже түрі")}
                value={sourceType}
                onChange={(e) => {
                  setSourceType(e.target.value);
                  setSourceId("");
                  setOptions([]);
                  setOffers([]);
                }}
              >
                <option value="order">
                  {t("Выручка заказа", "Тапсырыс табысы")}
                </option>
                <option value="purchase">
                  {t("Экономия закупки", "Сатып алу үнемі")}
                </option>
              </select>
            </label>
            <label>
              {t(
                "Исходный документ (последние 100)",
                "Бастапқы құжат (соңғы 100)",
              )}
              <select
                aria-label={t(
                  "Исходный документ (последние 100)",
                  "Бастапқы құжат (соңғы 100)",
                )}
                required
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
              >
                <option value="">{t("Выберите", "Таңдаңыз")}</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t(
                "Прогноз выручки / экономии, ₸ (необязательно)",
                "Табыс / үнем болжамы, ₸ (міндетті емес)",
              )}
              <input name="forecast" type="number" min="0" step="0.01" />
            </label>
            {sourceType === "purchase" && (
              <label>
                {t("Альтернативные предложения", "Балама ұсыныстар")}
                <select
                  name="offers"
                  aria-label={t(
                    "Альтернативные предложения",
                    "Балама ұсыныстар",
                  )}
                  multiple
                  required
                  size={5}
                >
                  {offers.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              {t(
                "Условия сравнения и ограничения вывода",
                "Салыстыру шарттары мен қорытынды шектеулері",
              )}
              <textarea
                name="limitations"
                required
                minLength={10}
                maxLength={500}
              />
            </label>
          </div>
          <button disabled={busy} className="button primary">
            {busy
              ? t("Сохранение…", "Сақталуда…")
              : t(
                  "Сохранить исходное сравнение",
                  "Бастапқы салыстыруды сақтау",
                )}
          </button>
        </form>
      </details>
    </section>
  );
}
