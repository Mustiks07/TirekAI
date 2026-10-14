"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { CalendarView } from "@/domain/commerce";
import type { Locale } from "@/domain/contracts";
import { api, ApiError } from "@/lib/client";
import { moneyText } from "@/lib/inventory-i18n";
import { errorText } from "@/lib/i18n";
export function PaymentCalendar({
  base,
  branch,
  revision,
  locale,
  onOrder,
}: {
  base: string;
  branch: string;
  revision: number;
  locale: Locale;
  onOrder: (id: string) => void;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const [query, setQuery] = useState("days=30&delayDays=0&expensePercent=100"),
    [data, setData] = useState<CalendarView | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let stale = false;
    api<CalendarView>(`${base}/finance/calendar?branchId=${branch}&${query}`)
      .then((v) => {
        if (!stale) {
          setData(v);
          setError("");
        }
      })
      .catch((e) => {
        if (!stale) setError(e instanceof ApiError ? e.code : "INTERNAL_ERROR");
      })
      .finally(() => {
        if (!stale) setBusy(false);
      });
    return () => {
      stale = true;
    };
  }, [base, branch, revision, query, refresh]);
  function calculate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      next = new URLSearchParams({
        days: String(f.get("days")),
        delayDays: String(f.get("delay")),
        expensePercent: String(f.get("percent")),
      }).toString();
    setBusy(true);
    setQuery(next);
    setRefresh((v) => v + 1);
  }
  const all = data?.days.flatMap((d) => [
    BigInt(d.baseline_minor),
    BigInt(d.scenario_minor),
  ]) || [0n];
  const min = all.reduce((a, b) => (a < b ? a : b), 0n),
    max = all.reduce((a, b) => (a > b ? a : b), 0n),
    span = max - min || 1n;
  const y = (v: string) =>
    170 - Number(((BigInt(v) - min) * 14000n) / span) / 100;
  const points = (key: "baseline_minor" | "scenario_minor") =>
    data?.days
      .map(
        (d, i) =>
          `${20 + (i * 560) / Math.max(1, data.days.length - 1)},${y(d[key])}`,
      )
      .join(" ");
  return (
    <section
      className="panel commerce-section"
      aria-label={t(
        "Платёжный календарь и сценарий",
        "Төлем күнтізбесі және сценарий",
      )}
    >
      <h3>
        {t("Платёжный календарь и сценарий", "Төлем күнтізбесі және сценарий")}
      </h3>
      <p>
        {t(
          "Прогноз по неоплаченным заказам и обязательствам. Это ожидаемые движения, а не фактическая выручка. Просроченные суммы перенесены на сегодня; регулярные расходы и другие будущие платежи здесь не учтены. Расчёт не меняет документы.",
          "Төленбеген тапсырыстар мен міндеттемелер бойынша болжам. Бұл нақты түсім емес, күтілетін қозғалыстар. Мерзімі өткен сомалар бүгінге ауыстырылды; тұрақты шығындар мен басқа болашақ төлемдер есепке алынбаған. Есеп құжаттарды өзгертпейді.",
        )}
      </p>
      <form onSubmit={calculate} className="commerce-grid">
        <label className="commerce-field">
          <span>{t("Горизонт, дней", "Көкжиек, күн")}</span>
          <input
            name="days"
            type="number"
            min="1"
            max="365"
            defaultValue="30"
            required
          />
        </label>
        <label className="commerce-field">
          <span>
            {t("Задержка поступлений, дней", "Түсімнің кешігуі, күн")}
          </span>
          <input
            name="delay"
            type="number"
            min="0"
            max="365"
            defaultValue="0"
            required
          />
        </label>
        <label className="commerce-field">
          <span>
            {t("Плановые выплаты, % от базы", "Жоспарлы төлемдер, базадан %")}
          </span>
          <input
            name="percent"
            inputMode="decimal"
            defaultValue="100"
            required
          />
        </label>
        <button className="secondary-button" type="submit" disabled={busy}>
          {t("Рассчитать сценарий", "Сценарийді есептеу")}
        </button>
      </form>
      {error && (
        <p role="alert">
          {error === "CALENDAR_LIMIT"
            ? t(
                "Более 5000 документов. Уменьшите горизонт или выберите филиал.",
                "5000-нан астам құжат. Көкжиекті қысқартыңыз немесе филиалды таңдаңыз.",
              )
            : errorText(error, locale)}
        </p>
      )}
      {data && (
        <>
          <div className="commerce-order-totals" role="status">
            <p>
              {data.today} → {data.through}
            </p>
            <p>
              {t("Фактический остаток сейчас", "Қазіргі нақты қалдық")}:{" "}
              <strong>{moneyText(data.opening_minor)} ₸</strong>
            </p>
            <p>
              {t("Прогноз на конец · база", "Кезең соңына болжам · база")}:{" "}
              <strong>{moneyText(data.baseline_minor)} ₸</strong>
            </p>
            <p>
              {t(
                "Прогноз на конец · сценарий",
                "Кезең соңына болжам · сценарий",
              )}
              : <strong>{moneyText(data.scenario_minor)} ₸</strong>
            </p>
          </div>
          <svg
            className="commerce-forecast"
            viewBox="0 0 600 195"
            aria-hidden="true"
          >
            <line
              x1="20"
              x2="580"
              y1={y("0")}
              y2={y("0")}
              stroke="#a3aea1"
              strokeDasharray="3 5"
            />
            <polyline
              points={points("baseline_minor")}
              fill="none"
              stroke="#206e55"
              strokeWidth="3"
            />
            <polyline
              points={points("scenario_minor")}
              fill="none"
              stroke="#844c15"
              strokeWidth="3"
              strokeDasharray="8 5"
            />
          </svg>
          <p>
            {t(
              "Сплошная зелёная — база; пунктирная коричневая — сценарий. Точные суммы доступны ниже.",
              "Тұтас жасыл — база; үзік қоңыр — сценарий. Нақты сомалар төменде берілген.",
            )}
          </p>
          <details>
            <summary>{t("Суммы по дням", "Күндер бойынша сомалар")}</summary>
            <div
              className="commerce-calendar-table"
              role="region"
              aria-label={t("Прогноз по дням", "Күндер бойынша болжам")}
              // Keyboard users must be able to scroll the day-by-day table.
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
            >
              <table>
                <thead>
                  <tr>
                    <th>{t("Дата", "Күні")}</th>
                    <th>{t("База, ₸", "База, ₸")}</th>
                    <th>{t("Сценарий, ₸", "Сценарий, ₸")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.days.map((d) => (
                    <tr key={d.date}>
                      <td>{d.date}</td>
                      <td>{moneyText(d.baseline_minor)}</td>
                      <td>{moneyText(d.scenario_minor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <details>
            <summary>
              {t("Документы расчёта", "Есеп құжаттары")} ·{" "}
              {data.documents.length}
            </summary>
            {data.documents.map((d) => (
              <div className="commerce-line-card" key={`${d.kind}-${d.id}`}>
                <div>
                  <strong>{d.name}</strong>
                  <small>
                    {d.due_date} ·{" "}
                    {d.kind === "order"
                      ? t("Поступление", "Түсім")
                      : t("Выплата", "Төлем")}
                    {d.overdue ? ` · ${t("Просрочено", "Мерзімі өтті")}` : ""}
                  </small>
                  {d.kind === "order" && (
                    <button
                      className="text-button"
                      onClick={() => onOrder(d.id)}
                    >
                      {t("Открыть заказ", "Тапсырысты ашу")}
                    </button>
                  )}
                </div>
                <strong>{moneyText(d.amount_minor)} ₸</strong>
              </div>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
