"use client";
import { useEffect, useState } from "react";
import type { Locale, Workspace } from "@/domain/contracts";
import { can } from "@/domain/permissions";
import { api } from "@/lib/client";
import { errorText } from "@/lib/i18n";
import { executionError } from "@/lib/execution-i18n";
import { moneyText } from "@/lib/inventory-i18n";
import { ActionForm, Field } from "./purchasing-page";

const f = (d: FormData, n: string) => String(d.get(n) || "").trim();
type Row = {
  id: string;
  code: string;
  status: string;
  total_minor: string;
  customer_name: string;
  sales_order_id: string | null;
  accept_state: "sent" | "unknown" | "failed" | null;
  accept_error: string | null;
  version: number;
  order_number: number | null;
  order_state: string | null;
  revenue_minor: string | null;
  paid_minor: string | null;
  commission_minor: string;
  net_minor: string;
  settlements: number;
};
type Product = {
  product_code: string;
  name: string;
  orders: number;
  item_id: string | null;
  sku: string | null;
};
const accepts: Record<string, [string, string]> = {
  sent: ["Принят в Kaspi", "Kaspi-де қабылданды"],
  unknown: [
    "Результат неизвестен — проверьте в кабинете",
    "Нәтиже белгісіз — кабинеттен тексеріңіз",
  ],
  failed: ["Kaspi отклонил подтверждение", "Kaspi растауды қабылдамады"],
};
const orderStates: Record<string, [string, string]> = {
  confirmed: ["Резерв", "Резерв"],
  partial: ["Выдан частично", "Ішінара берілді"],
  fulfilled: ["Выдан", "Берілді"],
  cancelled: ["Отменён", "Бас тартылды"],
};
// T040: Kaspi orders on the sales page. Each step is a separate, explicit action.
export function ChannelOrders({
  workspace,
  locale,
}: {
  workspace: Workspace;
  locale: Locale;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const base = `organizations/${workspace.organization.id}`;
  const role = workspace.organization.role;
  const [data, setData] = useState<{
      connectionId: string | null;
      writes: boolean;
      version: number;
      items: Row[];
    } | null>(null),
    [products, setProducts] = useState<Product[]>([]),
    [items, setItems] = useState<
      { id: string; sku: string; name_ru: string }[]
    >([]),
    [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]),
    [settling, setSettling] = useState(""),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const refresh = () => setRevision((v) => v + 1);
  const msg = (code: string) =>
    executionError(code, locale) || errorText(code, locale);
  useEffect(() => {
    let live = true;
    api<typeof data>(`${base}/channel-orders`)
      .then((v) => {
        if (!live || !v) return;
        setData(v);
        setError("");
        if (v.connectionId)
          api<{ items: Product[] }>(
            `${base}/integrations/kaspi/${v.connectionId}/products`,
          )
            .then((p) => live && setProducts(p.items))
            .catch(() => undefined);
      })
      .catch((e) => live && setError(e.code || "INTERNAL_ERROR"));
    if (can(role, "catalog:read"))
      api<{ items: { id: string; sku: string; name_ru: string }[] }>(
        `${base}/catalog?limit=100`,
      )
        .then((v) => live && setItems(v.items))
        .catch(() => undefined);
    const branch = workspace.branches[0]?.id;
    if (can(role, "finance:write") && branch)
      api<{ items: { id: string; name: string }[] }>(
        `${base}/finance/accounts?branchId=${branch}`,
      )
        .then((v) => live && setAccounts(v.items))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [base, role, revision, workspace.branches]);
  const act = async (o: Row, path: string, body: Record<string, unknown>) => {
    try {
      await api(`${base}/channel-orders/${o.id}/${path}`, "POST", {
        key: crypto.randomUUID(),
        ...body,
      });
      setError("");
    } catch (e) {
      setError((e as { code?: string }).code || "INTERNAL_ERROR");
    }
    refresh();
  };
  if (!data)
    return (
      <section className="panel" aria-busy="true">
        {error ? (
          <p role="alert" className="commerce-alert">
            {msg(error)}
          </p>
        ) : (
          t("Загрузка заказов Kaspi…", "Kaspi тапсырыстары жүктелуде…")
        )}
      </section>
    );
  if (!data.connectionId) return null;
  const write = can(role, "orders:write");
  return (
    <section className="panel" aria-labelledby="kaspi-orders">
      <h2 id="kaspi-orders">{t("Заказы Kaspi", "Kaspi тапсырыстары")}</h2>
      <p>
        {t(
          "Порядок: связать товары → перенести в продажи (резерв) → подтвердить в Kaspi (если разрешено владельцем) → выдать → провести строку отчёта о выплате (сумма, комиссия, к выплате) → при возврате: вернуть товар, затем провести строку возврата. Комиссия берётся только из отчёта Kaspi, не рассчитывается.",
          "Тәртібі: тауарларды байланыстыру → сатуға көшіру (резерв) → Kaspi-де растау (иесі рұқсат етсе) → беру → төлем есебінің жолын жүргізу (сома, комиссия, төленетін) → қайтаруда: тауарды қайтару, содан кейін қайтару жолын жүргізу. Комиссия тек Kaspi есебінен алынады, есептелмейді.",
        )}
      </p>
      {error && (
        <p role="alert" className="commerce-alert">
          {msg(error)}
        </p>
      )}
      {can(role, "integrations:write") && (
        <p>
          {data.writes
            ? t(
                "Изменение статусов в Kaspi разрешено.",
                "Kaspi-де мәртебені өзгертуге рұқсат етілген.",
              )
            : t(
                "Изменение статусов в Kaspi выключено.",
                "Kaspi-де мәртебені өзгерту өшірулі.",
              )}{" "}
          <button
            type="button"
            className="secondary-button"
            onClick={async () => {
              try {
                await api(
                  `${base}/integrations/kaspi/${data.connectionId}/writes`,
                  "POST",
                  {
                    key: crypto.randomUUID(),
                    version: data.version,
                    enabled: !data.writes,
                  },
                );
              } catch (e) {
                setError((e as { code?: string }).code || "INTERNAL_ERROR");
              }
              refresh();
            }}
          >
            {data.writes
              ? t("Выключить", "Өшіру")
              : t("Разрешить", "Рұқсат ету")}
          </button>
        </p>
      )}
      {products.some((p) => !p.item_id) && write && items.length > 0 && (
        <ActionForm
          locale={locale}
          label={t("Связать товар Kaspi", "Kaspi тауарын байланыстыру")}
          submit={async (d, key) => {
            await api(
              `${base}/integrations/kaspi/${data.connectionId}/products`,
              "POST",
              { key, productCode: f(d, "productCode"), itemId: f(d, "itemId") },
            );
            refresh();
          }}
        >
          <Field label={t("Код Kaspi", "Kaspi коды")}>
            <select name="productCode">
              {products
                .filter((p) => !p.item_id)
                .map((p) => (
                  <option key={p.product_code} value={p.product_code}>
                    {p.product_code} · {p.name} ({p.orders})
                  </option>
                ))}
            </select>
          </Field>
          <Field label={t("Товар каталога", "Каталог тауары")}>
            <select name="itemId">
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.sku} · {i.name_ru}
                </option>
              ))}
            </select>
          </Field>
        </ActionForm>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{t("Заказ Kaspi", "Kaspi тапсырысы")}</th>
              <th scope="col">{t("Сумма", "Сома")}</th>
              <th scope="col">{t("В учёте", "Есепте")}</th>
              <th scope="col">{t("Деньги по отчёту", "Есеп бойынша ақша")}</th>
              <th scope="col">{t("Действия", "Әрекеттер")}</th>
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 && (
              <tr>
                <td colSpan={5}>{t("Заказов нет.", "Тапсырыстар жоқ.")}</td>
              </tr>
            )}
            {data.items.map((o) => (
              <tr key={o.id}>
                <td>
                  №{o.code} · {o.customer_name}
                  <br />
                  <small>
                    {o.status}
                    {o.accept_state &&
                      ` · ${accepts[o.accept_state][locale === "ru" ? 0 : 1]}`}
                  </small>
                </td>
                <td>{moneyText(o.total_minor)} ₸</td>
                <td>
                  {o.order_number
                    ? `№${o.order_number} · ${orderStates[o.order_state!]?.[locale === "ru" ? 0 : 1] ?? o.order_state} · ${t("выручка", "түсім")} ${moneyText(o.revenue_minor!)} ₸ · ${t("оплачено", "төленді")} ${moneyText(o.paid_minor!)} ₸`
                    : t("не перенесён", "көшірілмеген")}
                </td>
                <td>
                  {o.settlements
                    ? `${t("комиссия", "комиссия")} ${moneyText(o.commission_minor)} ₸ · ${t("к выплате", "төленетін")} ${moneyText(o.net_minor)} ₸`
                    : t("отчёт не проведён", "есеп жүргізілмеген")}
                </td>
                <td>
                  {write && !o.sales_order_id && (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => act(o, "import", { version: o.version })}
                    >
                      {t("В продажи (резерв)", "Сатуға (резерв)")}
                    </button>
                  )}
                  {write &&
                    data.writes &&
                    o.sales_order_id &&
                    !o.accept_state &&
                    o.status === "APPROVED_BY_BANK" && (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => act(o, "accept", { version: o.version })}
                      >
                        {t("Подтвердить в Kaspi", "Kaspi-де растау")}
                      </button>
                    )}
                  {write && o.order_state === "confirmed" && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() =>
                        act(o, "issue", { note: `Kaspi ${o.code}: выдача` })
                      }
                    >
                      {t("Выдать", "Беру")}
                    </button>
                  )}
                  {write &&
                    (o.order_state === "fulfilled" ||
                      o.order_state === "partial") && (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() =>
                          act(o, "return", { note: `Kaspi ${o.code}: возврат` })
                        }
                      >
                        {t("Вернуть товар", "Тауарды қайтару")}
                      </button>
                    )}
                  {accounts.length > 0 && o.sales_order_id && (
                    <button
                      type="button"
                      className="secondary-button"
                      aria-expanded={settling === o.id}
                      onClick={() => setSettling(settling === o.id ? "" : o.id)}
                    >
                      {t("Строка отчёта", "Есеп жолы")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {settling && (
        <ActionForm
          locale={locale}
          label={t(
            "Провести строку отчёта Kaspi",
            "Kaspi есебінің жолын жүргізу",
          )}
          submit={async (d, key) => {
            await api(
              `${base}/channel-orders/${settling}/settlements`,
              "POST",
              {
                key,
                kind: f(d, "kind"),
                accountId: f(d, "accountId"),
                document: f(d, "document"),
                reportDate: f(d, "reportDate"),
                gross: f(d, "gross"),
                commission: f(d, "commission"),
                net: f(d, "net"),
              },
            );
            setSettling("");
            refresh();
          }}
        >
          <Field label={t("Тип", "Түрі")}>
            <select name="kind">
              <option value="payout">{t("Выплата", "Төлем")}</option>
              <option value="return">{t("Возврат", "Қайтару")}</option>
            </select>
          </Field>
          <Field label={t("Счёт", "Шот")}>
            <select name="accountId">
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("Номер отчёта", "Есеп нөмірі")}>
            <input name="document" required maxLength={80} />
          </Field>
          <Field label={t("Дата отчёта", "Есеп күні")}>
            <input name="reportDate" type="date" required />
          </Field>
          <Field label={t("Сумма заказа, ₸", "Тапсырыс сомасы, ₸")}>
            <input
              name="gross"
              required
              inputMode="decimal"
              pattern="\d{1,15}(\.\d{1,2})?"
            />
          </Field>
          <Field label={t("Комиссия Kaspi, ₸", "Kaspi комиссиясы, ₸")}>
            <input
              name="commission"
              required
              inputMode="decimal"
              pattern="\d{1,15}(\.\d{1,2})?"
            />
          </Field>
          <Field
            label={t("К выплате / удержано, ₸", "Төленетін / ұсталған, ₸")}
          >
            <input
              name="net"
              required
              inputMode="decimal"
              pattern="\d{1,15}(\.\d{1,2})?"
            />
          </Field>
        </ActionForm>
      )}
    </section>
  );
}
