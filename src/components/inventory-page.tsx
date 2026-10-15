"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  PackagePlus,
  Package,
  Warehouse as WarehouseIcon,
  Plus,
  Search,
  RefreshCw,
  ArrowRightLeft,
} from "lucide-react";
import type { Locale, Workspace } from "@/domain/contracts";
import {
  units,
  type Item,
  type CatalogView,
  type Warehouse,
  type StockView,
  type MovementsView,
  type ReservationsView,
  type TransfersView,
  type StockCommand,
} from "@/domain/inventory";
import { can } from "@/domain/permissions";
import { api, ApiError } from "@/lib/client";
import { useRevision } from "@/lib/live";
import { dictionary, errorText } from "@/lib/i18n";
import {
  inventoryWords,
  inventoryError,
  moneyText,
  quantityText,
} from "@/lib/inventory-i18n";
import { businessDate } from "@/lib/dates";
type Section = "balances" | "movements" | "reservations" | "transfers";
type Operation = {
  item: Item;
  kind: StockCommand["kind"];
  quantity?: string;
  version: number;
  reservationId?: string;
  transferId?: string;
  movementId?: string;
};
const field = (f: FormData, n: string) => String(f.get(n) || "").trim();
const priceText = (v: string | null | undefined, missing: string) =>
  v === null || v === undefined ? missing : quantityText(v);
export function InventoryPage({
  workspace,
  locale,
}: {
  workspace: Workspace;
  locale: Locale;
}) {
  const t = inventoryWords(locale),
    org = workspace.organization,
    base = `organizations/${org.id}`;
  const write = can(org.role, "inventory:write"),
    sell = can(org.role, "inventory:sell"),
    cost = can(org.role, "inventory:cost");
  const [catalog, setCatalog] = useState<CatalogView | null>(null),
    [warehouses, setWarehouses] = useState<Warehouse[]>([]),
    [warehouse, setWarehouse] = useState("");
  const [query, setQuery] = useState(""),
    [catalogPage, setCatalogPage] = useState(1),
    [section, setSection] = useState<Section>("balances"),
    [stockPage, setStockPage] = useState(1),
    [revision, setRevision] = useRevision();
  const [stock, setStock] = useState<
    StockView | MovementsView | ReservationsView | TransfersView | null
  >(null);
  const [editing, setEditing] = useState<Item | "new" | null>(null),
    [warehouseForm, setWarehouseForm] = useState(false),
    [operation, setOperation] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState("");
  const commandRef = useRef<{ signature: string; key: string } | null>(null);
  const operationRef = useRef<HTMLElement>(null),
    editorRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const target = operation
      ? operationRef.current
      : editing
        ? editorRef.current
        : null;
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [operation, editing]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<CatalogView>(
        `${base}/catalog?q=${encodeURIComponent(query)}&page=${catalogPage}`,
      ),
      api<{ items: Warehouse[] }>(`${base}/warehouses`),
    ])
      .then(([c, w]) => {
        if (!cancelled) {
          setCatalog(c);
          setWarehouses(w.items);
          setWarehouse((current) =>
            w.items.some((v) => v.id === current)
              ? current
              : w.items[0]?.id || "",
          );
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [base, query, catalogPage, revision]);
  useEffect(() => {
    if (!warehouse) return;
    let cancelled = false;
    api<StockView | MovementsView | ReservationsView | TransfersView>(
      `${base}/inventory/${section}?warehouseId=${warehouse}&page=${stockPage}`,
    )
      .then((v) => {
        if (!cancelled) setStock(v);
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [base, warehouse, section, stockPage, revision]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  function unitName(u: string) {
    return t[`unit_${u}` as keyof typeof t] || u;
  }
  function name(i: Item) {
    return locale === "kk" && i.name_kk ? i.name_kk : i.name_ru;
  }
  function pager(page: number, pages: number, change: (p: number) => void) {
    return (
      pages > 1 && (
        <div className="import-pagination">
          <button
            className="button secondary"
            disabled={busy || page <= 1}
            onClick={() => change(page - 1)}
          >
            {t.prev}
          </button>
          <span>
            {t.page} {page} / {pages}
          </span>
          <button
            className="button secondary"
            disabled={busy || page >= pages}
            onClick={() => change(page + 1)}
          >
            {t.next}
          </button>
        </div>
      )
    );
  }
  async function openOperation(
    id: string,
    sku: string,
    kind: Operation["kind"],
    extra: Partial<Operation> = {},
  ) {
    await act(async () => {
      const view = await api<CatalogView>(
          `${base}/catalog?q=${encodeURIComponent(sku)}&limit=100`,
        ),
        item = view.items.find((i) => i.id === id);
      if (!item) throw new ApiError("NOT_FOUND");
      const b = await api<{ quantity: string; version: number }>(
        `${base}/inventory/balance?warehouseId=${warehouse}&itemId=${id}`,
      );
      commandRef.current = null;
      setOperation({
        item,
        kind,
        version: b.version,
        ...(kind === "count" ? { quantity: b.quantity } : {}),
        ...extra,
      });
    });
  }
  async function submitItem(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await act(async () => {
      const conversions = field(f, "conversions")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("=");
          if (parts.length !== 2) throw new ApiError("CONVERSIONS_FORMAT");
          return { unit: parts[0].trim(), factor: parts[1].trim() };
        });
      const data = {
        sku: field(f, "sku"),
        name_ru: field(f, "name_ru"),
        name_kk: field(f, "name_kk"),
        category: field(f, "category"),
        variant: field(f, "variant"),
        barcode: field(f, "barcode"),
        kind: field(f, "kind"),
        base_unit: field(f, "base_unit"),
        conversions,
        purchase_price: field(f, "purchase_price") || null,
        sale_price: field(f, "sale_price") || null,
        active: f.get("active") === "on",
        ...(editing && editing !== "new" ? { version: editing.version } : {}),
      };
      await api(
        `${base}/catalog${editing && editing !== "new" ? `/${editing.id}` : ""}`,
        editing && editing !== "new" ? "PATCH" : "POST",
        data,
      );
      setEditing(null);
      setNotice("saved");
      setRevision((v) => v + 1);
    });
  }
  async function submitOperation(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await act(async () => {
      if (!operation) return;
      const o = operation;
      const data = {
        warehouseId: warehouse,
        itemId: o.item.id,
        note: field(f, "note"),
        kind: o.kind,
        ...(!["receive", "release"].includes(o.kind)
          ? { quantity: field(f, "quantity"), unit: field(f, "unit") }
          : {}),
        ...(o.kind === "receipt" || (o.kind === "count" && field(f, "unitCost"))
          ? { unitCost: field(f, "unitCost") }
          : {}),
        ...(o.kind === "count" ? { version: o.version } : {}),
        ...(["receipt", "count"].includes(o.kind) && field(f, "lotCode")
          ? {
              lot: {
                code: field(f, "lotCode"),
                expiresOn: field(f, "expiresOn") || null,
              },
            }
          : {}),
        ...(o.reservationId ? { reservationId: o.reservationId } : {}),
        ...(o.transferId ? { transferId: o.transferId } : {}),
        ...(o.movementId ? { movementId: o.movementId } : {}),
        ...(o.kind === "dispatch"
          ? { destinationId: field(f, "destinationId") }
          : {}),
      };
      const signature = JSON.stringify(data);
      if (commandRef.current?.signature !== signature)
        commandRef.current = { signature, key: crypto.randomUUID() };
      const result = await api<{ reused: boolean }>(
        `${base}/stock-commands`,
        "POST",
        { ...data, key: commandRef.current.key },
      );
      setOperation(null);
      setNotice(result.reused ? "replayed" : "posted");
      setRevision((v) => v + 1);
    });
  }
  const kinds: Operation["kind"][] = [
    ...(write ? (["receipt", "dispatch", "count"] as const) : []),
    ...(sell ? (["issue", "reserve"] as const) : []),
  ];
  const initial = editing && editing !== "new" ? editing : null;
  return (
    <div className="inventory-page">
      {error != null && (
        <div role="alert" className="error-notice">
          <strong>{dictionary(locale).errorTitle}</strong>
          <span>
            {inventoryError(
              error instanceof ApiError ? error.code : "INTERNAL_ERROR",
              locale,
            ) ||
              errorText(
                error instanceof ApiError ? error.code : "INTERNAL_ERROR",
                locale,
              )}
          </span>
          {error instanceof ApiError && error.requestId && (
            <small>ID: {error.requestId}</small>
          )}
        </div>
      )}
      {notice && (
        <div className="success-notice" role="status">
          {t[notice as keyof typeof t] || notice}
        </div>
      )}
      <div className="inventory-intro">
        <div>
          <span className="inventory-icon">
            <Package size={25} />
          </span>
          <p>{t.scopeNote}</p>
        </div>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => {
            setError(null);
            setRevision((v) => v + 1);
          }}
        >
          <RefreshCw size={16} />
          {t.refresh}
        </button>
      </div>
      <section className="panel warehouse-panel">
        <div className="panel-heading">
          <h2>
            <WarehouseIcon size={20} />
            {t.stock}
          </h2>
          {write && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setWarehouseForm((v) => !v)}
            >
              <Plus size={16} />
              {t.newWarehouse}
            </button>
          )}
        </div>
        <div className="warehouse-choice">
          <label>
            {t.warehouse}
            <select
              aria-label={t.warehouse}
              value={warehouse}
              disabled={busy}
              onChange={(e) => {
                setWarehouse(e.target.value);
                setStock(null);
                setStockPage(1);
                setOperation(null);
              }}
            >
              {!warehouses.length && <option value="">{t.noWarehouse}</option>}
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ·{" "}
                  {workspace.branches.find((b) => b.id === w.branch_id)
                    ?.name === "01"
                    ? dictionary(locale).mainBranch
                    : workspace.branches.find((b) => b.id === w.branch_id)
                        ?.name}
                </option>
              ))}
            </select>
          </label>
          <p>{t.stockNote}</p>
        </div>
        {warehouseForm && (
          <form
            className="inventory-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(async () => {
                const result = await api<{ id: string }>(
                  `${base}/warehouses`,
                  "POST",
                  { branchId: field(f, "branchId"), name: field(f, "name") },
                );
                setWarehouse(result.id);
                setWarehouseForm(false);
                setNotice("saved");
                setRevision((v) => v + 1);
              });
            }}
          >
            <fieldset disabled={busy}>
              <label>
                {t.warehouseName}
                <input name="name" minLength={2} maxLength={120} required />
              </label>
              <label>
                {t.branch}
                <select aria-label={t.branch} name="branchId">
                  {workspace.branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name === "01" ? dictionary(locale).mainBranch : b.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="inventory-form-actions">
                <button className="button primary">{t.createWarehouse}</button>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => setWarehouseForm(false)}
                >
                  {t.cancel}
                </button>
              </div>
            </fieldset>
          </form>
        )}
      </section>
      {operation && (
        <section
          ref={operationRef}
          className="panel inventory-operation"
          aria-label={t.operate}
        >
          <div className="panel-heading">
            <h2>
              <ArrowRightLeft size={20} />
              {t[operation.kind]} · {name(operation.item)}
            </h2>
          </div>
          <form
            className="inventory-form"
            onSubmit={submitOperation}
            key={`${operation.item.id}:${operation.kind}:${operation.reservationId || operation.transferId || operation.movementId || ""}`}
          >
            <fieldset disabled={busy}>
              {!operation.reservationId &&
                !operation.transferId &&
                !operation.movementId && (
                  <label>
                    {t.operate}
                    <select
                      aria-label={t.operate}
                      value={operation.kind}
                      onChange={(e) =>
                        void openOperation(
                          operation.item.id,
                          operation.item.sku,
                          e.target.value as Operation["kind"],
                        )
                      }
                    >
                      {kinds.map((k) => (
                        <option key={k} value={k}>
                          {t[k]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              {!["receive", "release"].includes(operation.kind) && (
                <>
                  <label>
                    {operation.kind === "count" ? t.quantity : t.amount}
                    <input
                      name="quantity"
                      inputMode="decimal"
                      required
                      pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?"
                      defaultValue={
                        operation.quantity
                          ? quantityText(operation.quantity)
                          : "1"
                      }
                      readOnly={Boolean(operation.reservationId)}
                    />
                  </label>
                  <label>
                    {t.unit}
                    <select
                      aria-label={t.unit}
                      name="unit"
                      defaultValue={operation.item.base_unit}
                    >
                      {(operation.reservationId
                        ? [operation.item.base_unit]
                        : [
                            operation.item.base_unit,
                            ...operation.item.conversions.map((c) => c.unit),
                          ]
                      ).map((u) => (
                        <option key={u} value={u}>
                          {unitName(u)}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {["receipt", "count"].includes(operation.kind) && (
                <label>
                  {operation.kind === "count" ? t.countCost : t.unitCost}
                  <input
                    name="unitCost"
                    inputMode="decimal"
                    required={operation.kind === "receipt"}
                    pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?"
                    defaultValue={
                      operation.kind === "receipt"
                        ? priceText(operation.item.purchase_price, "")
                        : ""
                    }
                  />
                </label>
              )}
              {operation.kind === "dispatch" && (
                <label>
                  {t.destination}
                  <select
                    aria-label={t.destination}
                    name="destinationId"
                    required
                  >
                    <option value="">–</option>
                    {warehouses
                      .filter((w) => w.id !== warehouse)
                      .map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {["receipt", "count"].includes(operation.kind) && (
                <>
                  <label>
                    {locale === "ru"
                      ? "Код новой партии (если ведётся партийный учёт)"
                      : "Жаңа партия коды (партиялық есеп жүргізілсе)"}
                    <input name="lotCode" maxLength={120} />
                  </label>
                  <label>
                    {locale === "ru" ? "Годен до" : "Жарамдылық мерзімі"}
                    <input type="date" name="expiresOn" />
                  </label>
                </>
              )}
              {(operation.transferId ||
                operation.reservationId ||
                operation.movementId) && (
                <p className="inventory-hint">
                  {t.reference}:{" "}
                  <code>
                    {operation.transferId ||
                      operation.reservationId ||
                      operation.movementId}
                  </code>
                </p>
              )}
              {operation.kind === "count" && (
                <p className="inventory-hint">{t.countNote}</p>
              )}
              {operation.kind === "return" && (
                <p className="inventory-hint">{t.returnNote}</p>
              )}
              {operation.reservationId && (
                <p className="inventory-hint">{t.reservationNote}</p>
              )}
              <label className="inventory-wide">
                {t.note}
                <input name="note" minLength={3} maxLength={250} required />
              </label>
              <div className="inventory-form-actions">
                <button className="button primary">
                  {busy ? t.loading : t.post}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setOperation(null)}
                >
                  {t.cancel}
                </button>
              </div>
            </fieldset>
          </form>
        </section>
      )}
      {warehouse && (
        <section className="panel stock-panel">
          <div className="inventory-tabs" role="group" aria-label={t.stock}>
            {(
              ["balances", "movements", "reservations", "transfers"] as const
            ).map((k) => (
              <button
                key={k}
                aria-pressed={section === k}
                disabled={busy}
                onClick={() => {
                  setSection(k);
                  setStockPage(1);
                  setStock(null);
                }}
              >
                {t[k]}
              </button>
            ))}
          </div>
          {!stock ? (
            <div className="empty">{t.loading}</div>
          ) : stock.items.length === 0 ? (
            <div className="empty">
              <Package size={26} />
              <strong>{t.nothing}</strong>
              <p>{t.chooseItem}</p>
            </div>
          ) : (
            <div className="stock-records">
              {section === "balances" &&
                (stock as StockView).items.map((b) => (
                  <article className="stock-record" key={b.item_id}>
                    <div className="stock-record-name">
                      <strong>
                        {locale === "kk" && b.name_kk ? b.name_kk : b.name_ru}
                      </strong>
                      <small>
                        {b.sku} · {unitName(b.base_unit)}
                      </small>
                    </div>
                    <div className="stock-numbers">
                      <div>
                        <span>{t.quantity}</span>
                        <strong>{quantityText(b.quantity)}</strong>
                      </div>
                      <div>
                        <span>{t.reserved}</span>
                        <strong>{quantityText(b.reserved)}</strong>
                      </div>
                      <div className="available-number">
                        <span>{t.available}</span>
                        <strong>{quantityText(b.available)}</strong>
                      </div>
                      {b.value_minor !== undefined && (
                        <div>
                          <span>{t.value}</span>
                          <strong>{moneyText(b.value_minor)}</strong>
                        </div>
                      )}
                    </div>
                    {kinds.length > 0 && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          void openOperation(
                            b.item_id,
                            b.sku,
                            write ? "receipt" : "issue",
                          )
                        }
                      >
                        {t.operate}
                      </button>
                    )}
                  </article>
                ))}
              {section === "movements" &&
                (stock as MovementsView).items.map((m) => (
                  <article className="stock-record" key={m.id}>
                    <div className="stock-record-name">
                      <strong>
                        {t[m.kind as keyof typeof t] || m.kind} · {m.sku}
                      </strong>
                      <small>
                        {businessDate(
                          new Date(m.created_at),
                          locale,
                          org.timezone,
                          true,
                        )}
                      </small>
                      <p>{m.note}</p>
                      <small className="record-id">ID: {m.id}</small>
                      {(m.source_id || m.transfer_id) && (
                        <small className="record-id">
                          {t.reference}: {m.source_id || m.transfer_id}
                        </small>
                      )}
                    </div>
                    <div className="stock-numbers">
                      <div>
                        <span>{t.amount}</span>
                        <strong>
                          {quantityText(m.quantity)} {unitName(m.base_unit)}
                        </strong>
                      </div>
                      {m.value_minor !== undefined && (
                        <div>
                          <span>{t.cost}</span>
                          <strong>{moneyText(m.value_minor)}</strong>
                        </div>
                      )}
                    </div>
                    {m.kind === "issue" && sell && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          void openOperation(m.item_id, m.sku, "return", {
                            movementId: m.id,
                            quantity: quantityText(m.quantity.replace("-", "")),
                          })
                        }
                      >
                        {t.return}
                      </button>
                    )}
                  </article>
                ))}
              {section === "reservations" &&
                (stock as ReservationsView).items.map((r) => (
                  <article className="stock-record" key={r.id}>
                    <div className="stock-record-name">
                      <strong>
                        {r.sku} · {quantityText(r.quantity)}{" "}
                        {unitName(r.base_unit)}
                      </strong>
                      <small>{r.note}</small>
                      <span className="import-status">
                        {r.status === "active" ? t.activeStatus : t[r.status]}
                      </span>
                      <small className="record-id">ID: {r.id}</small>
                    </div>
                    {r.status === "active" && sell && (
                      <div className="record-actions">
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() =>
                            void openOperation(r.item_id, r.sku, "issue", {
                              reservationId: r.id,
                              quantity: r.quantity,
                            })
                          }
                        >
                          {t.reservedIssue}
                        </button>
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() =>
                            void openOperation(r.item_id, r.sku, "release", {
                              reservationId: r.id,
                            })
                          }
                        >
                          {t.release}
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              {section === "transfers" &&
                (stock as TransfersView).items.map((tr) => (
                  <article className="stock-record" key={tr.id}>
                    <div className="stock-record-name">
                      <strong>
                        {tr.sku} · {quantityText(tr.quantity)}{" "}
                        {unitName(tr.base_unit)}
                      </strong>
                      <small>→ {tr.destination_name}</small>
                      <p>{tr.note}</p>
                      <small className="record-id">ID: {tr.id}</small>
                    </div>
                    <span className="import-status">{t[tr.state]}</span>
                    {tr.state === "in_transit" &&
                      tr.destination_id === warehouse &&
                      write && (
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() =>
                            void openOperation(tr.item_id, tr.sku, "receive", {
                              transferId: tr.id,
                            })
                          }
                        >
                          {t.receive}
                        </button>
                      )}
                  </article>
                ))}
            </div>
          )}
          {stock &&
            pager(stockPage, stock.pagination.pages, (p) => {
              setStock(null);
              setStockPage(p);
            })}
        </section>
      )}
      {editing && (
        <section ref={editorRef} className="panel catalog-editor">
          <div className="panel-heading">
            <h2>{editing === "new" ? t.newItem : t.editItem}</h2>
          </div>
          <form
            className="inventory-form"
            onSubmit={submitItem}
            key={initial?.id || "new"}
          >
            <fieldset disabled={busy}>
              {(
                [
                  "sku",
                  "name_ru",
                  "name_kk",
                  "category",
                  "variant",
                  "barcode",
                ] as const
              ).map((k) => (
                <label key={k}>
                  {t[k]}
                  <input
                    name={k}
                    defaultValue={initial?.[k] || ""}
                    required={["sku", "name_ru"].includes(k)}
                    minLength={k === "name_ru" ? 2 : undefined}
                    maxLength={
                      k.startsWith("name_") ? 120 : k === "sku" ? 60 : 80
                    }
                  />
                </label>
              ))}
              <label>
                {t.kind}
                <select
                  aria-label={t.kind}
                  name="kind"
                  defaultValue={initial?.kind || "goods"}
                >
                  <option value="goods">{t.goods}</option>
                  <option value="service">{t.service}</option>
                </select>
              </label>
              <label>
                {t.base_unit}
                <select
                  aria-label={t.base_unit}
                  name="base_unit"
                  defaultValue={initial?.base_unit || "pc"}
                >
                  {units.map((u) => (
                    <option key={u} value={u}>
                      {unitName(u)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t.purchase_price}
                <input
                  name="purchase_price"
                  inputMode="decimal"
                  defaultValue={
                    initial ? priceText(initial.purchase_price, "") : ""
                  }
                />
              </label>
              <label>
                {t.sale_price}
                <input
                  name="sale_price"
                  inputMode="decimal"
                  defaultValue={
                    initial ? priceText(initial.sale_price, "") : ""
                  }
                />
              </label>
              <label className="inventory-wide">
                {t.conversions}
                <textarea
                  name="conversions"
                  rows={3}
                  defaultValue={
                    initial?.conversions
                      .map((c) => `${c.unit}=${c.factor}`)
                      .join("\n") || ""
                  }
                />
                <small>{t.conversionsNote}</small>
              </label>
              <label className="inventory-checkbox">
                <input
                  name="active"
                  type="checkbox"
                  defaultChecked={initial?.active ?? true}
                />
                {t.active}
              </label>
              <div className="inventory-form-actions">
                <button className="button primary">
                  {busy ? t.loading : t.save}
                </button>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => setEditing(null)}
                >
                  {t.cancel}
                </button>
              </div>
            </fieldset>
          </form>
        </section>
      )}
      <section className="panel catalog-panel">
        <div className="panel-heading">
          <h2>
            <PackagePlus size={20} />
            {t.title}
            <span className="inline-count">
              {catalog?.pagination.total ?? "–"}
            </span>
          </h2>
          {catalog?.canWrite && (
            <button
              className="button primary"
              disabled={busy}
              onClick={() => {
                setEditing("new");
                setError(null);
              }}
            >
              <Plus size={16} />
              {t.newItem}
            </button>
          )}
        </div>
        <form
          className="catalog-search"
          onSubmit={(e) => {
            e.preventDefault();
            setCatalog(null);
            setCatalogPage(1);
            setQuery(field(new FormData(e.currentTarget), "query"));
          }}
        >
          <label className="sr-only" htmlFor="catalog-search">
            {t.search}
          </label>
          <Search size={18} />
          <input
            id="catalog-search"
            name="query"
            maxLength={80}
            placeholder={t.search}
          />
          <button className="button secondary" disabled={busy}>
            {locale === "ru" ? "Найти" : "Іздеу"}
          </button>
        </form>
        {!catalog ? (
          <div className="empty">{t.loading}</div>
        ) : !catalog.items.length ? (
          <div className="empty">
            <Package size={28} />
            <strong>{query ? t.emptySearch : t.emptyCatalog}</strong>
          </div>
        ) : (
          <div className="catalog-grid">
            {catalog.items.map((i) => (
              <article
                className={`catalog-card ${!i.active ? "archived-card" : ""}`}
                key={i.id}
              >
                <div className="catalog-card-top">
                  <span className="inventory-icon">
                    <Package size={22} />
                  </span>
                  <span className="import-status">
                    {i.active ? t[i.kind] : t.archived}
                  </span>
                </div>
                <small>
                  {i.sku}
                  {i.variant ? ` · ${i.variant}` : ""}
                </small>
                <h3>{name(i)}</h3>
                <p>
                  {i.category || "–"} · {unitName(i.base_unit)}
                  {i.barcode ? ` · ${i.barcode}` : ""}
                </p>
                <div className="catalog-prices">
                  <div>
                    <span>{t.sale_price}</span>
                    <strong>{priceText(i.sale_price, t.priceUnknown)}</strong>
                  </div>
                  {cost && i.purchase_price !== undefined && (
                    <div>
                      <span>{t.purchase_price}</span>
                      <strong>
                        {priceText(i.purchase_price, t.priceUnknown)}
                      </strong>
                    </div>
                  )}
                </div>
                {i.kind === "service" && <p>{t.serviceNote}</p>}
                <div className="catalog-actions">
                  {catalog.canWrite && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => {
                        setEditing(i);
                        setError(null);
                      }}
                      aria-label={`${t.edit}: ${name(i)}`}
                    >
                      {t.edit}
                    </button>
                  )}
                  {i.kind === "goods" &&
                    i.active &&
                    warehouse &&
                    kinds.length > 0 && (
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={() =>
                          void openOperation(
                            i.id,
                            i.sku,
                            write ? "receipt" : "issue",
                          )
                        }
                        aria-label={`${t.operate}: ${name(i)}`}
                      >
                        {t.operate}
                      </button>
                    )}
                </div>
              </article>
            ))}
          </div>
        )}
        {catalog &&
          pager(catalogPage, catalog.pagination.pages, (p) => {
            setCatalog(null);
            setCatalogPage(p);
          })}
      </section>
    </div>
  );
}
