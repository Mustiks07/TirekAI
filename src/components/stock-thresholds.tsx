"use client";
import { useEffect, useState } from "react";
import type { Locale, Workspace } from "@/domain/contracts";
import type { CatalogView, Warehouse } from "@/domain/inventory";
import { api } from "@/lib/client";
import { useRevision } from "@/lib/live";
import { can } from "@/domain/permissions";
import { ActionForm, Field } from "./purchasing-page";
const f = (d: FormData, n: string) => String(d.get(n) || "").trim();
export function StockThresholds({
  workspace,
  locale,
}: {
  workspace: Workspace;
  locale: Locale;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk);
  const base = `organizations/${workspace.organization.id}`,
    role = workspace.organization.role;
  const [items, setItems] = useState<CatalogView["items"]>([]),
    [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [revision, setRevision] = useRevision();
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    let live = true;
    if (can(role, "inventory:write"))
      Promise.all([
        api<CatalogView>(`${base}/catalog?limit=100`),
        api<{ items: Warehouse[] }>(`${base}/warehouses`),
      ])
        .then(([c, w]) => {
          if (live) {
            setItems(c.items.filter((i) => i.kind === "goods"));
            setWarehouses(w.items);
            setLoadError(false);
          }
        })
        .catch(() => {
          if (live) setLoadError(true);
        });
    return () => {
      live = false;
    };
  }, [base, role, revision]);
  return (
    <>
      {loadError && (
        <p role="alert">
          {t(
            "Не удалось загрузить настройки запаса.",
            "Қор баптауларын жүктеу мүмкін болмады.",
          )}{" "}
          <button
            className="secondary-button"
            onClick={() => setRevision((v) => v + 1)}
          >
            {t("Повторить", "Қайталау")}
          </button>
        </p>
      )}
      {can(role, "inventory:write") && warehouses.length > 0 && (
        <details className="panel stock-thresholds">
          <summary>{t("Пороги запаса", "Қор шектері")}</summary>
          <h2>
            {t(
              "Пороги запаса для обнаружения нехватки",
              "Тапшылықты анықтау үшін қор шектері",
            )}
          </h2>
          <ActionForm
            locale={locale}
            label={t("Сохранить порог", "Шекті сақтау")}
            submit={async (d) => {
              const points = await api<{
                items: {
                  warehouse_id: string;
                  item_id: string;
                  version: number;
                }[];
              }>(`${base}/insights/reorder-points`);
              const current = points.items.find(
                (x) =>
                  x.warehouse_id === f(d, "warehouseId") &&
                  x.item_id === f(d, "itemId"),
              );
              await api(`${base}/insights/reorder-points`, "POST", {
                warehouseId: f(d, "warehouseId"),
                itemId: f(d, "itemId"),
                minimum: f(d, "minimum"),
                safety: f(d, "safety"),
                leadDays: Number(f(d, "leadDays")),
                version: current?.version || 0,
              });
              setRevision((v) => v + 1);
            }}
          >
            <Field label={t("Склад", "Қойма")}>
              <select name="warehouseId" required>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("Товар", "Тауар")}>
              <select name="itemId" required>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.sku} ·{" "}
                    {locale === "kk" && i.name_kk ? i.name_kk : i.name_ru} (
                    {i.base_unit})
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={t("Минимум, базовые единицы", "Ең аз, негізгі бірлік")}
            >
              <input
                name="minimum"
                inputMode="decimal"
                required
                pattern="[0-9]+([.][0-9]+)?"
              />
            </Field>
            <Field label={t("Страховой запас", "Сақтандыру қоры")}>
              <input
                name="safety"
                inputMode="decimal"
                required
                defaultValue="0"
                pattern="[0-9]+([.][0-9]+)?"
              />
            </Field>
            <Field label={t("Срок поставки, дней", "Жеткізу мерзімі, күн")}>
              <input
                name="leadDays"
                type="number"
                min={0}
                max={365}
                required
                defaultValue={3}
              />
            </Field>
          </ActionForm>
        </details>
      )}
    </>
  );
}
