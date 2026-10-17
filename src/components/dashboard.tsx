"use client";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BarChart3,
  Clock3,
  Coins,
  Lightbulb,
  LoaderCircle,
  MapPin,
  Mic,
  RefreshCw,
  Send,
  Square,
  WalletCards,
} from "lucide-react";
import Decimal from "decimal.js";
import type { Locale, Workspace } from "@/domain/contracts";
import type { DashboardView, MainSituation } from "@/domain/dashboard";
import type { AssistantStatus } from "@/domain/assistant";
import { can } from "@/domain/permissions";
import { api, ApiError } from "@/lib/client";
import { useRevision } from "@/lib/live";
import { dictionary, errorText } from "@/lib/i18n";
import { executionError, factLabels, rules } from "@/lib/execution-i18n";
import { inventoryWords, quantityText } from "@/lib/inventory-i18n";
import { dashboardText, type DashboardText } from "@/lib/dashboard-i18n";
import { useVoiceRecorder } from "./assistant-page";

export type DashboardLink = NonNullable<DashboardView["payment"]["link"]>;
// Money from minor units (bigint strings) to whole tenge with thin grouping; no float math.
function tenge(minor: string) {
  const v = BigInt(minor),
    negative = v < 0n,
    abs = negative ? -v : v,
    whole = (abs + 50n) / 100n;
  return `${negative ? "−" : ""}${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₸`;
}
function compact(minor: string, locale: Locale) {
  const v = BigInt(minor),
    abs = v < 0n ? -v : v;
  if (abs < 100_000_000n) return tenge(minor);
  // Millions with two decimals, rounded half up on integers.
  const hundredths = (abs + 500_000n) / 1_000_000n;
  const text = `${hundredths / 100n},${String(hundredths % 100n).padStart(2, "0")}`;
  return `${v < 0n ? "−" : ""}${text} ${locale === "ru" ? "млн" : "млн"} ₸`;
}
// The first branch is created as "01"; it is shown by its role, as in the rest of the app.
const branchLabel = (name: string, locale: Locale) =>
  name === "01" ? dictionary(locale).mainBranch : name;
const pct = (value: string) =>
  `${value.startsWith("-") ? "−" : "+"}${value.replace(/^-/, "").replace(".", ",")}%`;
function useClock(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
export function Dashboard({
  workspace,
  locale,
  branchId,
  onOpen,
  onAsk,
  branchSelect,
}: {
  workspace: Workspace;
  locale: Locale;
  branchId: string | null;
  // On a phone the branch choice sits under the heading instead of the top bar.
  branchSelect?: ReactNode;
  onOpen: (link: DashboardLink) => void;
  onAsk: (text: string, voice: { uncertain: string[] } | null) => void;
}) {
  const t = dashboardText(locale);
  const base = `organizations/${workspace.organization.id}`;
  const tz = workspace.organization.timezone;
  const [view, setView] = useState<DashboardView | null>(null),
    [error, setError] = useState(""),
    [refreshing, setRefreshing] = useState(false),
    [revision, setRevision] = useRevision();
  const now = useClock();
  const message = (code: string) =>
    executionError(code, locale) || errorText(code, locale);
  useEffect(() => {
    let alive = true;
    api<DashboardView>(
      `${base}/dashboard${branchId ? `?branchId=${branchId}` : ""}`,
    )
      .then((v) => {
        if (!alive) return;
        setView(v);
        setError("");
      })
      .catch((e) => alive && setError(e.code || "INTERNAL_ERROR"));
    return () => {
      alive = false;
    };
  }, [base, branchId, revision]);
  // A different branch is a different view: the old one is not shown as if it were current.
  const shown = view && view.branch_id === branchId ? view : null;
  async function refresh() {
    setRefreshing(true);
    try {
      // Re-run the situation checks (insights) when the role may, then reload the figures.
      if (shown?.can_refresh) await api(`${base}/insights/refresh`, "POST", {});
      setRevision((v) => v + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.code : "NETWORK");
    } finally {
      setRefreshing(false);
    }
  }
  const age = shown
    ? Math.max(0, Math.floor((now - Date.parse(shown.as_of)) / 60_000))
    : 0;
  const updated = !shown
    ? ""
    : age < 1
      ? t.justNow
      : age < 60
        ? `${age} ${t.minutesAgo}`
        : `${Math.floor(age / 60)} ${t.hoursAgo}`;
  const total = shown?.situations.total ?? 0;
  return (
    <div className="dashboard" aria-busy={!shown && !error}>
      <div className="dash-head">
        <div>
          <h1>{t.title}</h1>
          <p>
            {!shown
              ? t.loading
              : shown.situations.state === "no_access"
                ? t.noAccess
                : total
                  ? t.subtitle(total)
                  : t.subtitleNone}
          </p>
        </div>
        <div className="dash-updated">
          {shown && (
            <span>
              {t.updated} {updated}
            </span>
          )}
          <button
            type="button"
            className="icon-button"
            onClick={refresh}
            disabled={refreshing || !shown}
            aria-label={refreshing ? t.refreshing : t.refresh}
            title={t.refresh}
          >
            <RefreshCw size={17} className={refreshing ? "spin" : ""} />
          </button>
        </div>
      </div>
      {branchSelect && <div className="dash-mobile-branch">{branchSelect}</div>}
      {error && (
        <div className="dash-error" role="alert">
          <p>{shown ? message(error) : t.loadError}</p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setError("");
              setRevision((v) => v + 1);
            }}
          >
            {t.retry}
          </button>
        </div>
      )}
      {/* Without any data a failed load shows only the message and "retry", not empty cards. */}
      {!(error && !shown) && (
        <>
          <div className="dash-top">
            <MainCard
              t={t}
              locale={locale}
              base={base}
              view={shown}
              onOpen={onOpen}
              onChanged={() => setRevision((v) => v + 1)}
            />
            <div className="dash-side">
              <PaymentCard t={t} locale={locale} view={shown} onOpen={onOpen} />
              <SlowCard
                t={t}
                locale={locale}
                view={shown}
                onOpen={onOpen}
                branchId={branchId}
              />
            </div>
          </div>
          <div className="dash-bottom">
            <CashCard
              t={t}
              locale={locale}
              base={base}
              view={shown}
              tz={tz}
              onOpen={onOpen}
              onSaved={() => setRevision((v) => v + 1)}
            />
            <BranchesCard t={t} locale={locale} view={shown} onOpen={onOpen} />
            <EventsCard
              t={t}
              locale={locale}
              view={shown}
              tz={tz}
              onOpen={onOpen}
            />
          </div>
        </>
      )}
      <AskBar
        t={t}
        locale={locale}
        base={base}
        workspace={workspace}
        onAsk={onAsk}
      />
    </div>
  );
}
function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="dash-skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}
function Missing({ t, reasons }: { t: DashboardText; reasons: string[] }) {
  if (!reasons.length) return null;
  return (
    <ul className="dash-missing">
      {reasons.map((r) => (
        <li key={r}>{t.missing[r] ?? r}</li>
      ))}
    </ul>
  );
}
function MainCard({
  t,
  locale,
  base,
  view,
  onOpen,
  onChanged,
}: {
  t: DashboardText;
  locale: Locale;
  base: string;
  view: DashboardView | null;
  onOpen: (link: DashboardLink) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [done, setDone] = useState(false),
    [problem, setProblem] = useState(""),
    [calc, setCalc] = useState(false);
  // One idempotency key per situation: repeating the click reuses it.
  const key = useRef<{ insight: string; key: string } | null>(null);
  const s = view?.situations;
  const m = s?.main ?? null;
  // A new situation starts a new preparation (and a new idempotency key).
  const shownId = m?.insight_id;
  const [preparedFor, setPreparedFor] = useState<string | undefined>();
  if (preparedFor !== shownId) {
    setPreparedFor(shownId);
    setDone(false);
    setProblem("");
  }
  if (!view)
    return (
      <section className="panel dash-main" aria-label={t.title}>
        <Skeleton lines={6} />
      </section>
    );
  if (!s || s.state === "no_access")
    return (
      <section className="panel dash-main">
        <p className="dash-empty">{t.noAccess}</p>
      </section>
    );
  if (!m)
    return (
      <section className="panel dash-main dash-calm">
        <h2>{t.calmTitle}</h2>
        <p>{t.calmNote}</p>
      </section>
    );
  const words = inventoryWords(locale) as unknown as Record<string, string>;
  const unit = (u: string) => words[`unit_${u}`] ?? u;
  const st = m.stock;
  const urgent = m.severity >= 3;
  async function prepare() {
    if (busy || !m) return;
    if (key.current?.insight !== m.insight_id)
      key.current = { insight: m.insight_id, key: crypto.randomUUID() };
    setBusy(true);
    setProblem("");
    try {
      await api(`${base}/insights/${m.insight_id}/proposal`, "POST", {
        key: key.current.key,
      });
      setDone(true);
      onChanged();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "NETWORK";
      setProblem(executionError(code, locale) || errorText(code, locale));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={`panel dash-main${urgent ? " urgent" : ""}`}
      aria-labelledby="dash-main-title"
    >
      <div className="dash-main-head">
        <span
          className={`dash-risk-icon${urgent ? " urgent" : ""}`}
          aria-hidden="true"
        >
          <AlertCircle size={22} />
        </span>
        <div>
          <p className="dash-severity">
            {urgent
              ? locale === "ru"
                ? "Срочно"
                : "Шұғыл"
              : locale === "ru"
                ? "Важно"
                : "Маңызды"}
            {m.branch_name && ` · ${branchLabel(m.branch_name, locale)}`}
          </p>
          <h2 id="dash-main-title">
            {st
              ? t.runsOut(st.days_left)
              : (rules[m.rule as keyof typeof rules]?.[
                  locale === "ru" ? 0 : 1
                ] ?? m.rule)}
          </h2>
          <p className="dash-main-sub">
            {st
              ? `${locale === "ru" ? st.name_ru : st.name_kk} · ${st.warehouse}`
              : m.title}
          </p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t.open}
          onClick={() => onOpen(m.link)}
        >
          <ArrowRight size={18} />
        </button>
      </div>
      {st ? (
        <dl className="dash-metrics">
          <div>
            <dt>{t.stockLeft}</dt>
            <dd
              className={
                new Decimal(st.available).lte(st.minimum) ? "risk" : ""
              }
            >
              {quantityText(st.available)} {unit(st.unit)}
            </dd>
          </div>
          <div>
            <dt>{t.sales}</dt>
            <dd>
              {st.daily_sales
                ? `${quantityText(st.daily_sales)} ${unit(st.unit)}${t.perDay}`
                : t.noData}
            </dd>
          </div>
          <div>
            <dt>{t.delivery}</dt>
            <dd>{st.lead_days !== null ? t.days(st.lead_days) : t.noData}</dd>
          </div>
        </dl>
      ) : (
        <dl className="dash-metrics facts">
          {Object.entries(m.facts)
            .slice(0, 6)
            .map(([k, v]) => (
              <div key={k}>
                <dt>{factLabels[k]?.[locale === "ru" ? 0 : 1] ?? k}</dt>
                <dd>
                  {k.endsWith("_minor") && typeof v === "string"
                    ? tenge(v)
                    : String(v)}
                </dd>
              </div>
            ))}
        </dl>
      )}
      {st && (
        <div className="dash-reco">
          <div className="dash-reco-text">
            <span className="dash-reco-icon" aria-hidden="true">
              <Lightbulb size={20} />
            </span>
            <div>
              <p className="dash-reco-label">{t.recommendation}</p>
              {st.order ? (
                <p className="dash-reco-main">
                  {t.orderFrom(
                    quantityText(st.order.quantity),
                    unit(st.unit),
                    st.order.supplier,
                  )}
                </p>
              ) : (
                <p className="dash-reco-main">{t.missing.no_offer}</p>
              )}
              {st.transfer && (
                <p className="dash-reco-alt">
                  {t.transferFrom(
                    quantityText(st.transfer.spare),
                    unit(st.unit),
                    st.transfer.warehouse,
                  )}
                </p>
              )}
              {st.order && (
                <p className="dash-reco-alt">
                  {t.costOrder}: {tenge(st.order.total_minor)}
                </p>
              )}
            </div>
          </div>
          <div className="dash-reco-effect">
            <p>{t.atRisk}</p>
            <strong>
              {st.revenue_at_risk_minor !== null
                ? tenge(st.revenue_at_risk_minor)
                : t.noData}
            </strong>
            <small>{t.atRiskNote}</small>
          </div>
        </div>
      )}
      {m.missing.length > 0 && (
        <div className="dash-note" role="note">
          <strong>{t.missingTitle}</strong>
          <Missing t={t} reasons={m.missing} />
        </div>
      )}
      <div className="dash-actions">
        {m.can_prepare ? (
          <button
            type="button"
            className="primary-button"
            onClick={prepare}
            disabled={busy || done}
          >
            {busy ? <LoaderCircle size={17} className="spin" /> : null}
            {t.prepare}
            <ArrowRight size={17} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="primary-button"
            onClick={() => onOpen(m.link)}
          >
            {t.open}
            <ArrowRight size={17} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="secondary-button"
          onClick={() => setCalc(true)}
          aria-haspopup="dialog"
        >
          {t.showCalc}
        </button>
      </div>
      {done && (
        <div className="commerce-success dash-done" role="status">
          <p>{t.prepared}</p>
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              onOpen({ page: "approvals", id: null, branchId: null })
            }
          >
            {t.openApprovals}
          </button>
        </div>
      )}
      {problem && (
        <p className="commerce-alert" role="alert">
          {problem}
        </p>
      )}
      {calc && (
        <CalcDialog
          t={t}
          locale={locale}
          m={m}
          onClose={() => setCalc(false)}
        />
      )}
    </section>
  );
}
function CalcDialog({
  t,
  locale,
  m,
  onClose,
}: {
  t: DashboardText;
  locale: Locale;
  m: MainSituation;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    // A modal dialog keeps keyboard focus inside and closes with Escape.
    d?.showModal();
    return () => d?.close();
  }, []);
  const words = inventoryWords(locale) as unknown as Record<string, string>;
  const unit = (u: string) => words[`unit_${u}`] ?? u;
  const st = m.stock;
  const lines: string[] = [];
  if (st) {
    const u = unit(st.unit);
    lines.push(
      locale === "ru"
        ? `Продано за ${st.history_days} дн.: ${quantityText(st.sold)} ${u} → в среднем ${st.daily_sales ? quantityText(st.daily_sales) : t.noValue} ${u} в день`
        : `${st.history_days} күнде сатылды: ${quantityText(st.sold)} ${u} → күніне орташа ${st.daily_sales ? quantityText(st.daily_sales) : t.noValue} ${u}`,
    );
    lines.push(
      locale === "ru"
        ? `Доступно: ${quantityText(st.available)} ${u}; минимум ${quantityText(st.minimum)} + страховой запас ${quantityText(st.safety)} → не хватает ${quantityText(st.shortage)} ${u}`
        : `Қолжетімді: ${quantityText(st.available)} ${u}; ең аз ${quantityText(st.minimum)} + сақтық қор ${quantityText(st.safety)} → ${quantityText(st.shortage)} ${u} жетіспейді`,
    );
    if (st.days_left !== null)
      lines.push(
        locale === "ru"
          ? `Хватит на: ${quantityText(st.available)} ÷ ${quantityText(st.daily_sales!)} = ${st.days_left.replace(".", ",")} дн.`
          : `Жетеді: ${quantityText(st.available)} ÷ ${quantityText(st.daily_sales!)} = ${st.days_left.replace(".", ",")} күн`,
      );
    if (st.lost_units !== null && st.average_price_minor !== null)
      lines.push(
        locale === "ru"
          ? `До поставки (${st.lead_days} дн.) не хватит: ${quantityText(st.daily_sales!)} × ${st.lead_days} − ${quantityText(st.available)} = ${quantityText(st.lost_units)} ${u}; × средняя цена ${tenge(st.average_price_minor)} = ${tenge(st.revenue_at_risk_minor!)}`
          : `Жеткізуге дейін (${st.lead_days} күн) жетпейді: ${quantityText(st.daily_sales!)} × ${st.lead_days} − ${quantityText(st.available)} = ${quantityText(st.lost_units)} ${u}; × орташа баға ${tenge(st.average_price_minor)} = ${tenge(st.revenue_at_risk_minor!)}`,
      );
    if (st.order)
      lines.push(
        locale === "ru"
          ? `Заказ: ${quantityText(st.order.quantity)} ${u} у «${st.order.supplier}» за ${tenge(st.order.total_minor)} с доставкой (самое дешёвое сопоставимое предложение)`
          : `Тапсырыс: «${st.order.supplier}», ${quantityText(st.order.quantity)} ${u}, жеткізумен ${tenge(st.order.total_minor)} (ең арзан салыстырмалы ұсыныс)`,
      );
  } else lines.push(m.calculation);
  return (
    <dialog
      ref={ref}
      className="dash-dialog"
      aria-labelledby="calc-title"
      onClose={onClose}
      onCancel={onClose}
    >
      <div className="dash-dialog-head">
        <h2 id="calc-title">{t.calcTitle}</h2>
        <button type="button" className="secondary-button" onClick={onClose}>
          {t.close}
        </button>
      </div>
      <h3>{t.calcPeriod}</h3>
      <p>
        {st
          ? st.period_from
            ? locale === "ru"
              ? `продажи с ${st.period_from.split("-").reverse().join(".")} по сегодня (${st.history_days} дн., окно до 28 дней); остатки на момент обновления`
              : `${st.period_from.split("-").reverse().join(".")} бастап бүгінге дейінгі сатылым (${st.history_days} күн, 28 күнге дейінгі терезе); қалдықтар жаңарту сәтіндегі`
            : t.missing.no_sales_history
          : locale === "ru"
            ? `ситуация обнаружена ${m.detected_at.slice(0, 10).split("-").reverse().join(".")}`
            : `жағдай ${m.detected_at.slice(0, 10).split("-").reverse().join(".")} анықталды`}
      </p>
      <h3>{t.calcFormula}</h3>
      <ul>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <h3>{t.calcSources}</h3>
      <ul>
        {m.sources.map((x, i) => (
          <li key={i}>
            {x.type === "stock_balance"
              ? locale === "ru"
                ? "Складской журнал"
                : "Қойма журналы"
              : x.type === "supplier_offer"
                ? locale === "ru"
                  ? "Предложение поставщика"
                  : "Жеткізуші ұсынысы"
                : x.type}
            : {x.label}
          </li>
        ))}
        {st && (
          <li>
            {locale === "ru"
              ? "Выдачи и возвраты по заказам этого склада"
              : "Осы қойманың тапсырыстары бойынша беру және қайтару"}
          </li>
        )}
      </ul>
      {st && (
        <>
          <h3>{t.calcAssumptions}</h3>
          <ul>
            {t.assumptionsStock.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </>
      )}
      {m.missing.length > 0 && (
        <>
          <h3>{t.calcMissing}</h3>
          <Missing t={t} reasons={m.missing} />
        </>
      )}
    </dialog>
  );
}
function PaymentCard({
  t,
  locale,
  view,
  onOpen,
}: {
  t: DashboardText;
  locale: Locale;
  view: DashboardView | null;
  onOpen: (link: DashboardLink) => void;
}) {
  if (!view)
    return (
      <section className="panel dash-card">
        <Skeleton />
      </section>
    );
  const p = view.payment;
  if (p.state === "no_access") return null;
  if (p.state === "no_data")
    return (
      <section className="panel dash-card">
        <h2 className="dash-card-title">
          <WalletCards size={18} aria-hidden="true" />
          {t.paymentTitle(null, false).split(" ").slice(0, 2).join(" ")}
        </h2>
        <p className="dash-empty">{t.noPayments}</p>
      </section>
    );
  const risk = p.overdue || p.below_reserve === true;
  return (
    <section
      className={`panel dash-card dash-payment${risk ? " risk" : ""}`}
      aria-labelledby="dash-pay-title"
    >
      <div className="dash-card-head">
        <span className="dash-card-icon" aria-hidden="true">
          <WalletCards size={20} />
        </span>
        <h2 id="dash-pay-title">{t.paymentTitle(p.days, p.overdue)}</h2>
        {p.link && (
          <button
            type="button"
            className="icon-button"
            aria-label={t.open}
            onClick={() => onOpen(p.link!)}
          >
            <ArrowRight size={18} />
          </button>
        )}
      </div>
      <p className="dash-amount">
        {p.amount_minor ? tenge(p.amount_minor) : t.noValue}
      </p>
      <p className="dash-sub">
        {p.supplier}
        {p.kind === "purchase" && ` · ${t.purchasePayment}`}
        {p.due_date && ` · ${p.due_date.split("-").reverse().join(".")}`}
      </p>
      {p.after_minor !== null ? (
        <p className="dash-after">
          {t.afterPayment} <strong>{compact(p.after_minor, locale)}</strong>
        </p>
      ) : (
        <p className="dash-after">{t.noAccounts}</p>
      )}
      {p.below_reserve === true && (
        <p className="dash-flag" role="note">
          <AlertCircle size={15} aria-hidden="true" /> {t.belowReserve}
        </p>
      )}
      {p.reserve_minor === null && (
        <p className="dash-sub">{t.reserveNotSet}</p>
      )}
      {p.upcoming > 1 && (
        <p className="dash-sub">{t.morePayments(p.upcoming - 1)}</p>
      )}
    </section>
  );
}
function SlowCard({
  t,
  locale,
  view,
  onOpen,
  branchId,
}: {
  t: DashboardText;
  locale: Locale;
  view: DashboardView | null;
  onOpen: (link: DashboardLink) => void;
  branchId: string | null;
}) {
  if (!view)
    return (
      <section className="panel dash-card">
        <Skeleton />
      </section>
    );
  const s = view.slow_branch;
  if (s.state === "no_access") return null;
  const words = inventoryWords(locale) as unknown as Record<string, string>;
  const slow = s.rows.find((r) => r.branch_id === s.slow_branch_id);
  const name = (n: string) => branchLabel(n, locale);
  const shown = slow
    ? [slow, ...s.rows.filter((r) => r !== slow)].slice(0, 2)
    : s.rows.slice(0, 2);
  return (
    <section
      className="panel dash-card dash-slow"
      aria-labelledby="dash-slow-title"
    >
      <div className="dash-card-head">
        <span className="dash-card-icon blue" aria-hidden="true">
          <BarChart3 size={20} />
        </span>
        <h2 id="dash-slow-title">
          {slow
            ? t.slowTitle(name(slow.name))
            : s.state === "ok"
              ? t.evenTitle
              : t.branchesTitle}
        </h2>
      </div>
      {s.state !== "ok" ? (
        <p className="dash-empty">
          {s.missing.includes("single_branch")
            ? t.slowSingle
            : t.missing.no_sales_history}
        </p>
      ) : (
        <>
          <p className="dash-sub">
            {t.slowItem}: {locale === "ru" ? s.item?.name_ru : s.item?.name_kk}
          </p>
          <div className="dash-compare">
            {shown.map((r) => (
              <div key={r.branch_id}>
                <span>{name(r.name)}</span>
                <strong>
                  {quantityText(r.units)} {words[`unit_${s.item?.unit}`] ?? ""}
                </strong>
                {r.change_percent !== null ? (
                  <span
                    className={Number(r.change_percent) < 0 ? "down" : "up"}
                  >
                    {Number(r.change_percent) < 0 ? (
                      <ArrowDown size={14} aria-hidden="true" />
                    ) : (
                      <ArrowUp size={14} aria-hidden="true" />
                    )}
                    {pct(r.change_percent)}
                  </span>
                ) : (
                  <small>{t.noPrevious}</small>
                )}
              </div>
            ))}
          </div>
          <p className="dash-sub">
            {t.slowPeriod(s.from.split("-").reverse().join("."))}
          </p>
        </>
      )}
      <button
        type="button"
        className="secondary-button dash-wide"
        onClick={() =>
          onOpen({
            page: "inventory",
            id: null,
            branchId: slow?.branch_id ?? branchId,
          })
        }
      >
        {t.viewItems}
        <ArrowRight size={16} aria-hidden="true" />
      </button>
    </section>
  );
}
function CashChart({
  days,
  reserve,
  label,
}: {
  days: { date: string; balance_minor: string }[];
  reserve: string | null;
  label: string;
}) {
  const W = 320,
    H = 120,
    pad = 6;
  const values = days.map((d) => BigInt(d.balance_minor));
  if (reserve !== null) values.push(BigInt(reserve));
  let max = values.reduce((a, b) => (b > a ? b : a), values[0] ?? 0n),
    min = values.reduce((a, b) => (b < a ? b : a), values[0] ?? 0n);
  if (min > 0n) min = 0n;
  if (max === min) max = min + 1n;
  // Scaling for drawing only (pixels); amounts themselves stay exact.
  const y = (v: bigint) =>
    pad +
    (Number(((max - v) * 10_000n) / (max - min)) / 10_000) * (H - 2 * pad);
  const x = (i: number) =>
    pad + (i * (W - 2 * pad)) / Math.max(1, days.length - 1);
  const points = days.map(
    (d, i) => `${x(i).toFixed(1)},${y(BigInt(d.balance_minor)).toFixed(1)}`,
  );
  return (
    <figure className="dash-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={label}
        preserveAspectRatio="none"
      >
        <line
          x1={pad}
          x2={W - pad}
          y1={y(0n)}
          y2={y(0n)}
          className="dash-axis"
        />
        {reserve !== null && (
          <line
            x1={pad}
            x2={W - pad}
            y1={y(BigInt(reserve))}
            y2={y(BigInt(reserve))}
            className="dash-reserve-line"
          />
        )}
        <polygon
          className="dash-area"
          points={`${x(0)},${y(min)} ${points.join(" ")} ${x(days.length - 1)},${y(min)}`}
        />
        <polyline className="dash-line" points={points.join(" ")} />
        {days.map((d, i) => (
          <circle
            key={d.date}
            cx={x(i)}
            cy={y(BigInt(d.balance_minor))}
            r="2.2"
            className="dash-dot"
          />
        ))}
      </svg>
      <div className="dash-chart-axis" aria-hidden="true">
        {days
          .filter((_, i) => i % 3 === 0 || i === days.length - 1)
          .map((d) => (
            <span key={d.date}>
              {d.date.slice(8)}.{d.date.slice(5, 7)}
            </span>
          ))}
      </div>
    </figure>
  );
}
// Minor units → "12345.67" (or "12345" when there are no tiyn) for an editable field.
function plainKzt(minor: string) {
  const v = BigInt(minor),
    whole = v / BigInt(100),
    rest = v % BigInt(100);
  return rest === BigInt(0)
    ? whole.toString()
    : `${whole}.${rest.toString().padStart(2, "0")}`;
}
function CashCard({
  t,
  locale,
  base,
  view,
  tz,
  onOpen,
  onSaved,
}: {
  t: DashboardText;
  locale: Locale;
  base: string;
  view: DashboardView | null;
  tz: string;
  onOpen: (link: DashboardLink) => void;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState("");
  const key = useRef<{ value: string; key: string } | null>(null);
  void tz;
  if (!view)
    return (
      <section className="panel dash-card">
        <Skeleton lines={5} />
      </section>
    );
  const c = view.cash;
  if (c.state === "no_access") return null;
  const reserveDefault =
    c.reserve_minor === null ? "" : plainKzt(c.reserve_minor);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get("minimum") || "")
      .trim()
      .replace(/\s/g, "")
      .replace(",", ".");
    if (key.current?.value !== value)
      key.current = { value, key: crypto.randomUUID() };
    setBusy(true);
    setProblem("");
    try {
      await api(`${base}/finance/reserve`, "POST", {
        key: key.current.key,
        branchId: view!.branch_id,
        version: c.reserve_version,
        minimum: value,
      });
      key.current = null;
      setEditing(false);
      onSaved();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "NETWORK";
      setProblem(executionError(code, locale) || errorText(code, locale));
    } finally {
      setBusy(false);
    }
  }
  const fmtDate = (d: string) => `${d.slice(8)}.${d.slice(5, 7)}`;
  return (
    <section
      className="panel dash-card dash-cash"
      aria-labelledby="dash-cash-title"
    >
      <div className="dash-card-head">
        <span className="dash-card-icon" aria-hidden="true">
          <Coins size={20} />
        </span>
        <h2 id="dash-cash-title">{t.cashTitle}</h2>
        <button
          type="button"
          className="text-button"
          onClick={() =>
            onOpen({ page: "finance", id: null, branchId: view.branch_id })
          }
        >
          {t.details}
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      </div>
      {c.state === "insufficient" ? (
        <p className="dash-empty">{t.noAccounts}</p>
      ) : (
        <>
          <div className="dash-pair">
            <div>
              <span>{t.now}</span>
              <strong>
                {c.opening_minor ? compact(c.opening_minor, locale) : t.noValue}
              </strong>
            </div>
            <div>
              <span>{t.minimum}</span>
              {c.reserve_minor !== null ? (
                <strong
                  className={
                    c.lowest_minor !== null &&
                    BigInt(c.lowest_minor) < BigInt(c.reserve_minor)
                      ? "risk"
                      : ""
                  }
                >
                  {compact(c.reserve_minor, locale)}
                </strong>
              ) : (
                <strong className="muted-value">{t.reserveNotSet}</strong>
              )}
            </div>
          </div>
          {c.days.length > 0 && c.lowest_minor !== null && (
            <CashChart
              days={c.days}
              reserve={c.reserve_minor}
              label={t.cashChart(
                fmtDate(c.days[0].date),
                fmtDate(c.days[c.days.length - 1].date),
                compact(c.lowest_minor, locale),
                fmtDate(c.lowest_date!),
              )}
            />
          )}
          <p className="dash-sub">
            {t.plannedIn}:{" "}
            {c.planned_in_minor
              ? compact(c.planned_in_minor, locale)
              : t.noValue}{" "}
            · {t.plannedOut}:{" "}
            {c.planned_out_minor
              ? compact(c.planned_out_minor, locale)
              : t.noValue}
          </p>
        </>
      )}
      {c.can_set_reserve && !editing && (
        <button
          type="button"
          className="text-button"
          onClick={() => setEditing(true)}
        >
          {t.setReserve}
        </button>
      )}
      {editing && (
        <form className="dash-reserve-form" onSubmit={save}>
          <label>
            {t.reserveLabel}
            <input
              name="minimum"
              inputMode="decimal"
              required
              pattern="[0-9\s]+([.,][0-9]{1,2})?"
              defaultValue={reserveDefault}
            />
          </label>
          <div className="dash-actions">
            <button type="submit" className="primary-button" disabled={busy}>
              {t.save}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setEditing(false)}
            >
              {t.cancel}
            </button>
          </div>
          {problem && (
            <p className="commerce-alert" role="alert">
              {problem}
            </p>
          )}
        </form>
      )}
      <p className="dash-footnote">{t.cashNote}</p>
    </section>
  );
}
function BranchesCard({
  t,
  locale,
  view,
  onOpen,
}: {
  t: DashboardText;
  locale: Locale;
  view: DashboardView | null;
  onOpen: (link: DashboardLink) => void;
}) {
  if (!view)
    return (
      <section className="panel dash-card">
        <Skeleton lines={5} />
      </section>
    );
  const b = view.branches;
  if (b.state === "no_access") return null;
  const max = b.rows.reduce(
    (a, r) => (BigInt(r.today_minor) > a ? BigInt(r.today_minor) : a),
    0n,
  );
  return (
    <section
      className="panel dash-card dash-branches"
      aria-labelledby="dash-branches-title"
    >
      <div className="dash-card-head">
        <span className="dash-card-icon" aria-hidden="true">
          <MapPin size={20} />
        </span>
        <h2 id="dash-branches-title">{t.branchesTitle}</h2>
        <button
          type="button"
          className="text-button"
          onClick={() => onOpen({ page: "outcomes", id: null, branchId: null })}
        >
          {t.allBranchesLink}
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      </div>
      <table className="dash-table">
        <thead>
          <tr>
            <th scope="col">{t.branch}</th>
            <th scope="col">{t.revenueToday}</th>
            <th scope="col">{t.change}</th>
          </tr>
        </thead>
        <tbody>
          {b.rows.map((r) => {
            const share =
              max > 0n ? Number((BigInt(r.today_minor) * 1000n) / max) / 10 : 0;
            const down =
              r.change_percent !== null && Number(r.change_percent) < 0;
            return (
              <tr key={r.branch_id}>
                <th scope="row">{branchLabel(r.name, locale)}</th>
                <td>
                  <span>{tenge(r.today_minor)}</span>
                  <span className="dash-bar" aria-hidden="true">
                    <span style={{ width: `${share}%` }} />
                  </span>
                </td>
                <td
                  className={
                    down ? "down" : r.change_percent !== null ? "up" : ""
                  }
                >
                  {r.change_percent !== null ? (
                    <>
                      {down ? (
                        <ArrowDown size={14} aria-hidden="true" />
                      ) : (
                        <ArrowUp size={14} aria-hidden="true" />
                      )}
                      {pct(r.change_percent)}
                    </>
                  ) : BigInt(r.today_minor) > 0n ? (
                    t.newSales
                  ) : (
                    t.noValue
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {b.state === "no_data" && <p className="dash-empty">{t.noSalesToday}</p>}
      <p className="dash-footnote">
        <Clock3 size={13} aria-hidden="true" /> {t.vsYesterday(b.until)}
      </p>
    </section>
  );
}
function eventText(
  e: DashboardView["events"]["items"][number],
  locale: Locale,
) {
  const ru = locale === "ru";
  const x = e.text;
  const money = (v: unknown) => tenge(String(v));
  switch (e.kind) {
    case "order_created":
      return ru
        ? `Создан заказ №${x.number} · ${x.customer} · ${money(x.amount_minor)}`
        : `№${x.number} тапсырыс құрылды · ${x.customer} · ${money(x.amount_minor)}`;
    case "purchase_created":
      return ru
        ? `Создан заказ поставщику «${x.supplier}» · ${money(x.amount_minor)}`
        : `«${x.supplier}» жеткізушісіне тапсырыс құрылды · ${money(x.amount_minor)}`;
    case "receipt":
      return ru
        ? `Принят товар: ${x.name} +${quantityText(String(x.quantity))} · ${x.warehouse}`
        : `Тауар қабылданды: ${x.name} +${quantityText(String(x.quantity))} · ${x.warehouse}`;
    case "situation_opened":
      return ru ? `Новая ситуация: ${x.title}` : `Жаңа жағдай: ${x.title}`;
    case "average_check":
      return ru
        ? `Средний чек ${String(x.percent).startsWith("-") ? "снизился" : "вырос"} на ${String(x.percent).replace("-", "").replace(".", ",")}%, до ${money(x.amount_minor)}`
        : `Орташа чек ${String(x.percent).replace("-", "").replace(".", ",")}%-ға ${String(x.percent).startsWith("-") ? "төмендеді" : "өсті"}, ${money(x.amount_minor)}`;
    case "item_sales":
      return ru
        ? `Продажи «${x.name_ru}» ${String(x.percent).startsWith("-") ? "снизились" : "выросли"} на ${String(x.percent).replace("-", "").replace(".", ",")}% · ${x.branch}`
        : `«${x.name_kk}» сатылымы ${String(x.percent).replace("-", "").replace(".", ",")}%-ға ${String(x.percent).startsWith("-") ? "төмендеді" : "өсті"} · ${x.branch}`;
    default:
      return "";
  }
}
function EventsCard({
  t,
  locale,
  view,
  tz,
  onOpen,
}: {
  t: DashboardText;
  locale: Locale;
  view: DashboardView | null;
  tz: string;
  onOpen: (link: DashboardLink) => void;
}) {
  if (!view)
    return (
      <section className="panel dash-card">
        <Skeleton lines={5} />
      </section>
    );
  const time = new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  });
  const e = view.events;
  return (
    <section
      className="panel dash-card dash-events"
      aria-labelledby="dash-events-title"
    >
      <div className="dash-card-head">
        <span className="dash-card-icon" aria-hidden="true">
          <Clock3 size={20} />
        </span>
        <h2 id="dash-events-title">{t.eventsTitle}</h2>
        <button
          type="button"
          className="text-button"
          onClick={() => onOpen({ page: "today", id: null, branchId: null })}
        >
          {t.allEvents}
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      </div>
      {e.items.length === 0 ? (
        <p className="dash-empty">{t.noEvents}</p>
      ) : (
        <ol className="dash-timeline">
          {e.items.map((item, i) => (
            <li key={i} className={item.tone}>
              <span className="dash-tone" aria-hidden="true" />
              <time dateTime={item.at}>{time.format(new Date(item.at))}</time>
              {item.link ? (
                <button
                  type="button"
                  className="dash-event-link"
                  onClick={() => onOpen(item.link!)}
                >
                  <span aria-hidden="true">
                    {item.tone === "up"
                      ? "↑ "
                      : item.tone === "down"
                        ? "↓ "
                        : item.tone === "risk"
                          ? "! "
                          : ""}
                  </span>
                  {eventText(item, locale)}
                </button>
              ) : (
                <span>{eventText(item, locale)}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
function AskBar({
  t,
  locale,
  base,
  workspace,
  onAsk,
}: {
  t: DashboardText;
  locale: Locale;
  base: string;
  workspace: Workspace;
  onAsk: (text: string, voice: { uncertain: string[] } | null) => void;
}) {
  const [text, setText] = useState(""),
    [voiceOn, setVoiceOn] = useState(false);
  const allowed = can(workspace.organization.role, "assistant:use");
  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    api<AssistantStatus>(`${base}/assistant`)
      .then((s) => alive && setVoiceOn(s.settings.voice_enabled))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [base, allowed]);
  const voice = useVoiceRecorder({
    base,
    locale,
    voiceLocale: locale,
    // Recognized speech goes to the assistant once, as on the assistant screen.
    onTranscript: (v, uncertain) => onAsk(v, { uncertain }),
  });
  if (!allowed) return null;
  return (
    <form
      className="dash-ask"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onAsk(text.trim(), null);
      }}
    >
      <label className="sr-only" htmlFor="dash-ask-input">
        {t.askLabel}
      </label>
      <span className="dash-ask-icon" aria-hidden="true">
        ✦
      </span>
      <input
        id="dash-ask-input"
        value={text}
        maxLength={2000}
        onChange={(e) => setText(e.target.value)}
        placeholder={t.askPlaceholder}
      />
      {voiceOn &&
        (voice.state === "recording" ? (
          <button
            type="button"
            className="icon-button recording"
            onClick={voice.stop}
            aria-label={
              locale === "ru" ? "Остановить и распознать" : "Тоқтату және тану"
            }
          >
            <Square size={16} />
          </button>
        ) : (
          <button
            type="button"
            className="icon-button"
            onClick={voice.start}
            disabled={voice.state === "sending"}
            aria-label={locale === "ru" ? "Записать вопрос" : "Сұрақты жазу"}
          >
            {voice.state === "sending" ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <Mic size={17} />
            )}
          </button>
        ))}
      <button
        type="submit"
        className="icon-button dash-send"
        disabled={!text.trim()}
        aria-label={t.send}
      >
        <Send size={17} />
      </button>
      {voice.state === "recording" && (
        <span className="dash-recording" role="status">
          ●{" "}
          {locale === "ru"
            ? "Микрофон включён, идёт запись"
            : "Микрофон қосулы, жазылуда"}
        </span>
      )}
      {voice.problem && (
        <span className="dash-recording problem" role="alert">
          {voice.problem}
        </span>
      )}
    </form>
  );
}
