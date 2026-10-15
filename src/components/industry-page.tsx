"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Locale, Workspace } from "@/domain/contracts";
import type { IndustryRecord } from "@/domain/industry";
import type { Item, Warehouse } from "@/domain/inventory";
import type {
  Production,
  Appointment,
  Project,
  Recipe,
} from "@/server/industry/types";
import { api } from "@/lib/client";
import { useRevision } from "@/lib/live";
import { errorText, profileNames } from "@/lib/i18n";
import { businessDate } from "@/lib/dates";
import {
  industryLabels,
  industryText,
  organizationInstant,
} from "@/lib/industry-i18n";
import type { Construction, Clinic } from "@/domain/extended-industry";
import Decimal from "decimal.js";
import { inventoryWords } from "@/lib/inventory-i18n";
type Option = { id: string; name: string };
type Field = {
  name: string;
  ru: string;
  kk: string;
  type?: string;
  options?: Option[];
  value?: string;
  optional?: boolean;
  multiple?: boolean;
  min?: string;
  max?: string;
};
const read = (d: FormData, k: string) => String(d.get(k) ?? "").trim();
export function IndustryPage({
  workspace,
  locale,
  onOpenOrder,
  onOpenPurchase,
}: {
  workspace: Workspace;
  locale: Locale;
  onOpenOrder: (id: string, branchId: string) => void;
  onOpenPurchase: (id: string, branchId: string) => void;
}) {
  const t = (ru: string, kk: string) => (locale === "ru" ? ru : kk),
    w = (s: string) => industryText(locale, s),
    org = workspace.organization,
    base = `organizations/${org.id}`;
  const [branch, setBranch] = useState(
      org.branch_id ?? workspace.branches[0]?.id ?? "",
    ),
    [suppliers, setSuppliers] = useState<Option[]>([]),
    [offers, setOffers] = useState<Option[]>([]),
    [docs, setDocs] = useState<IndustryRecord[]>([]),
    [selected, setSelected] = useState<IndustryRecord | null>(null),
    [history, setHistory] = useState<
      { version: number; action: string; note: string; created_at: string }[]
    >([]),
    [lots, setLots] = useState<
      {
        id: string;
        code: string;
        item_id: string;
        warehouse_id: string;
        quantity: string;
        expires_on: string | null;
      }[]
    >([]),
    [items, setItems] = useState<Item[]>([]),
    [warehouses, setWarehouses] = useState<Warehouse[]>([]),
    [customers, setCustomers] = useState<Option[]>([]),
    [quotes, setQuotes] = useState<Option[]>([]),
    [connections, setConnections] = useState<Option[]>([]),
    [orders, setOrders] = useState<Option[]>([]),
    [inquiries, setInquiries] = useState<Option[]>([]),
    [action, setAction] = useState(""),
    [revision, setRevision] = useRevision(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [filter, setFilter] = useState(""),
    [lineCount, setLineCount] = useState(1),
    [success, setSuccess] = useState(false);
  const words = inventoryWords(locale),
    unitName = (unit: string) =>
      words[`unit_${unit}` as keyof typeof words] || unit;
  const itemName = (item: Item) =>
    locale === "kk" && item.name_kk ? item.name_kk : item.name_ru;
  const retry = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([
      api<{ items: IndustryRecord[]; lots: typeof lots }>(
        `${base}/industry?branchId=${branch}`,
      ),
      api<{ items: Item[] }>(`${base}/catalog?limit=100`),
      api<{ items: Warehouse[] }>(`${base}/warehouses?branchId=${branch}`),
      api<{ items: Option[] }>(
        `${base}/order-customers?branchId=${branch}&limit=100`,
      ),
      org.profile === "projects"
        ? api<{
            items: {
              id: string;
              number: number;
              customer_name: string;
              order_id: string | null;
            }[];
          }>(`${base}/crm/quotes?branchId=${branch}&limit=100`)
        : Promise.resolve({ items: [] }),
      org.profile === "services"
        ? api<{
            connections: {
              id: string;
              provider: string;
              status: string;
              disconnected_at: string | null;
            }[];
          }>(`${base}/integrations`)
        : Promise.resolve({ connections: [] }),
      ["production", "food"].includes(org.profile)
        ? api<{
            items: {
              id: string;
              number: number;
              customer_name: string;
              state: string;
            }[];
          }>(`${base}/orders?branchId=${branch}&limit=100`)
        : Promise.resolve({ items: [] }),
      ["education", "services"].includes(org.profile)
        ? api<{
            items: { id: string; title: string; customer_name: string }[];
          }>(`${base}/crm/inquiries?branchId=${branch}&limit=100`)
        : Promise.resolve({ items: [] }),
    ])
      .then(([d, i, wh, c, q, connections, orders, inquiries]) => {
        if (!live) return;
        setDocs(d.items);
        setLots(d.lots);
        setItems(i.items);
        setWarehouses(wh.items);
        setCustomers(c.items);
        setConnections(
          connections.connections
            .filter((x) => x.provider === "telegram" && !x.disconnected_at)
            .map((x) => ({ id: x.id, name: `Telegram · ${x.status}` })),
        );
        setOrders(
          orders.items
            .filter((x) => ["draft", "confirmed", "partial"].includes(x.state))
            .map((x) => ({
              id: x.id,
              name: `№${x.number} · ${x.customer_name}`,
            })),
        );
        setInquiries(
          inquiries.items.map((x) => ({
            id: x.id,
            name: `${x.title} · ${x.customer_name}`,
          })),
        );
        setQuotes(
          q.items
            .filter((x) => !x.order_id)
            .map((x) => ({
              id: x.id,
              name: `№${x.number} · ${x.customer_name}`,
            })),
        );
        setError("");
        setLoading(false);
      })
      .catch((e) => {
        if (live) {
          setError(e.code ?? "INTERNAL_ERROR");
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [base, branch, revision, org.profile]);
  useEffect(() => {
    let live = true;
    if (!selected) return;
    api<{
      document: IndustryRecord;
      history: typeof history;
      lots: typeof lots;
    }>(`${base}/industry/${selected.id}`)
      .then((v) => {
        if (live) {
          setSelected(v.document);
          setHistory(v.history);
          setLots(v.lots);
        }
      })
      .catch((e) => live && setError(e.code ?? "INTERNAL_ERROR"));
    return () => {
      live = false;
    };
    // Refresh the selected document without restarting on its returned object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, selected?.id, revision]);
  useEffect(() => {
    if (org.profile !== "construction") return;
    let live = true;
    api<{ items: Option[] }>(base + "/suppliers?limit=100")
      .then((v) => live && setSuppliers(v.items))
      .catch((e) => live && setError(e.code));
    const lines =
      selected?.kind === "construction"
        ? (selected.data as unknown as Construction).lines
        : [];
    Promise.all(
      lines.map((l) =>
        api<{
          offers: {
            id: string;
            supplier_name: string;
            total_minor: string | null;
            data: { supplierSku: string };
          }[];
        }>(base + "/purchasing/compare", "POST", {
          itemId: l.itemId,
          quantity: l.quantity,
          date: new Date().toISOString().slice(0, 10),
        }),
      ),
    )
      .then(
        (rows) =>
          live &&
          setOffers(
            rows.flatMap((v) =>
              v.offers.map((o) => ({
                id: o.id,
                name:
                  o.supplier_name +
                  " · " +
                  o.data.supplierSku +
                  " · " +
                  (o.total_minor === null
                    ? t("Неполная цена", "Толық емес баға")
                    : new Decimal(o.total_minor).div(100).toFixed(2) + " ₸"),
              })),
            ),
          ),
      )
      .catch((e) => live && setError(e.code));
    return () => {
      live = false;
    };
    // Locale only changes labels, never requests or mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, org.profile, selected?.id, selected?.version, locale]);
  const construction =
    selected?.kind === "construction"
      ? (selected.data as unknown as Construction)
      : null;
  const clinic =
    selected?.kind === "clinic" ? (selected.data as unknown as Clinic) : null;
  const estimateForm = ["construction", "construction_revise"].includes(action);
  const options = (kind: string) =>
    docs
      .filter((x) => x.kind === kind)
      .map((x) => ({ id: x.id, name: x.title }));
  const goods = items
      .filter((x) => x.kind === "goods")
      .map((x) => ({
        id: x.id,
        name: `${itemName(x)} (${unitName(x.base_unit)})`,
      })),
    services = items
      .filter((x) => x.kind === "service")
      .map((x) => ({ id: x.id, name: itemName(x) }));
  const warehouseOptions = warehouses.map((x) => ({ id: x.id, name: x.name })),
    resourceOptions = options("resource"),
    members = workspace.members
      .filter((x) => !x.branch_id || x.branch_id === branch)
      .map((x) => ({ id: x.user_id, name: x.name }));
  const fields: Field[] = [];
  const add = (
    name: string,
    ru: string,
    kk: string,
    extra: Partial<Field> = {},
  ) => fields.push({ name, ru, kk, ...extra });
  const choice = (
    name: string,
    ru: string,
    kk: string,
    options: Option[],
    optional = false,
  ) => add(name, ru, kk, { options, optional });
  const numeric = (name: string, ru: string, kk: string, value = "0") =>
    add(name, ru, kk, {
      type: "number",
      value:
        [
          "unitCost",
          "price",
          "lessonPrice",
          "hourlyRate",
          "budget",
          "extraPrice",
        ].includes(name) && value === "0"
          ? ""
          : value,
      min: "0",
    });
  const createActions =
    org.profile === "construction"
      ? ["construction"]
      : org.profile === "clinic"
        ? ["resource", "clinic"]
        : org.profile === "food" || org.profile === "production"
          ? ["recipe", "lot_receipt", "production_plan", "resource", "waste"]
          : org.profile === "services"
            ? ["resource", "appointment"]
            : org.profile === "education"
              ? ["resource", "course", "group", "enroll", "lesson"]
              : ["project"];
  const recordActions =
    construction && selected?.state !== "completed"
      ? selected?.state === "pending"
        ? ["construction_revise", "construction_approve"]
        : [
            "construction_revise",
            "construction_purchase",
            "construction_materials",
            "construction_work",
            "construction_confirm",
            "construction_accept",
          ]
      : clinic
        ? selected?.state === "requested"
          ? ["clinic_book"]
          : selected?.state === "scheduled"
            ? ["clinic_book", "clinic_visit"]
            : selected?.state === "visited"
              ? ["clinic_invoice"]
              : []
        : selected?.kind === "recipe"
          ? ["recipe"]
          : selected?.kind === "production" && selected.state !== "completed"
            ? ["production_issue", "production_stage", "production_finish"]
            : selected?.kind === "appointment" && selected.state === "scheduled"
              ? (selected.data as unknown as Appointment).mode === "lesson"
                ? ["reschedule", "lesson_complete"]
                : ["reschedule", "appointment_end", "reminder"]
              : selected?.kind === "appointment" &&
                  (selected.data as unknown as Appointment).mode === "service"
                ? ["reminder"]
                : selected?.kind === "enrollment" &&
                    ["active", "frozen"].includes(selected.state)
                  ? ["enrollment_change"]
                  : selected?.kind === "project" && selected.state === "active"
                    ? [
                        "project_task",
                        "time",
                        "scope_change",
                        "scope_approve",
                        "project_stage",
                        "project_deliver",
                      ]
                    : [];
  const changing = !!selected && recordActions.includes(action);
  const production =
    selected?.kind === "production"
      ? (selected.data as unknown as Production)
      : null;
  const project =
    selected?.kind === "project" ? (selected.data as unknown as Project) : null;
  const recipe =
    selected?.kind === "recipe" ? (selected.data as unknown as Recipe) : null;
  if (["recipe", "resource", "course", "group", "project"].includes(action))
    add("title", "Название", "Атауы", {
      value: changing ? selected?.title : "",
    });
  if (action === "recipe") {
    choice("outputItemId", "Готовый товар", "Дайын тауар", goods);
    fields[fields.length - 1].value = recipe?.outputItemId;
    numeric(
      "outputQuantity",
      "Выход в базовых единицах",
      "Негізгі бірліктегі өнім",
      recipe?.outputQuantity ?? "1",
    );
    add("stages", "Этапы, через запятую", "Кезеңдер, үтір арқылы", {
      value:
        recipe?.stages.join(", ") ??
        t("Подготовка, Выпуск", "Дайындау, Шығару"),
    });
  }
  if (
    [
      "lot_receipt",
      "production_plan",
      "appointment",
      "course",
      "project",
      "waste",
    ].includes(action)
  )
    choice("warehouseId", "Склад", "Қойма", warehouseOptions);
  if (["lot_receipt", "waste"].includes(action)) {
    choice("itemId", "Товар", "Тауар", goods);
    numeric(
      "quantity",
      "Количество в базовых единицах",
      "Негізгі бірліктегі саны",
      "1",
    );
  }
  if (action === "lot_receipt")
    numeric(
      "unitCost",
      "Стоимость за базовую единицу, ₸",
      "Негізгі бірлік құны, ₸",
    );
  if (action === "lot_receipt" || action === "production_finish") {
    add("lotCode", "Код партии", "Партия коды");
    add("expiresOn", "Годен до", "Жарамдылық мерзімі", {
      type: "date",
      optional: org.profile !== "food",
    });
  }
  if (action === "production_plan") {
    choice(
      "salesOrderId",
      "Клиентский заказ",
      "Клиент тапсырысы",
      orders,
      true,
    );
    choice(
      "recipeId",
      "Рецептура / спецификация",
      "Рецептура / сипаттама",
      options("recipe"),
    );
    numeric("quantity", "План выпуска", "Өндіріс жоспары", "1");
    choice(
      "equipmentId",
      "Оборудование (необязательно)",
      "Жабдық (міндетті емес)",
      docs
        .filter(
          (x) => x.kind === "resource" && x.data.resourceKind === "equipment",
        )
        .map((x) => ({ id: x.id, name: x.title })),
      true,
    );
    add("startsAt", "Начало загрузки", "Жүктеменің басталуы", {
      type: "datetime-local",
      optional: true,
    });
    add("endsAt", "Конец загрузки", "Жүктеменің аяқталуы", {
      type: "datetime-local",
      optional: true,
    });
  }
  if (action === "production_stage") {
    choice(
      "stage",
      "Этап",
      "Кезең",
      production?.recipe.stages.map((name, i) => ({ id: String(i), name })) ??
        [],
    );
    numeric("defects", "Выявлено брака, единиц", "Анықталған ақау, бірлік");
    numeric(
      "reworked",
      "Исправлено переделкой, единиц",
      "Қайта өңдеп түзетілген, бірлік",
    );
  }
  if (action === "production_finish") {
    numeric(
      "goodQuantity",
      "Годный выпуск",
      "Жарамды өнім",
      production?.quantity ?? "1",
    );
    numeric("scrapQuantity", "Безвозвратный брак", "Қайтымсыз ақау");
  }
  if (action === "waste")
    choice(
      "lotId",
      "Партия",
      "Партия",
      lots.map((x) => ({ id: x.id, name: `${x.code} · ${x.quantity}` })),
    );
  if (action === "resource") {
    choice(
      "resourceKind",
      "Вид ресурса",
      "Ресурс түрі",
      (org.profile === "clinic"
        ? ["specialist", "room"]
        : org.profile === "services"
          ? ["specialist", "workplace"]
          : org.profile === "education"
            ? ["teacher", "room"]
            : ["equipment"]
      ).map((id) => ({ id, name: w(id) })),
    );
    numeric(
      "capacity",
      "Параллельные рабочие места",
      "Қатар жұмыс орындары",
      "1",
    );
    numeric(
      "bufferMinutes",
      "Буфер до и после, минут",
      "Алдындағы және кейінгі буфер, минут",
    );
    add("days", "Дни недели: 1 пн … 7 вс", "Апта күндері: 1 дс … 7 жс", {
      value: "1,2,3,4,5",
    });
    add("opens", "Начало рабочего дня", "Жұмыс күнінің басы", {
      type: "time",
      value: "09:00",
    });
    add("closes", "Конец рабочего дня", "Жұмыс күнінің соңы", {
      type: "time",
      value: "18:00",
    });
  }
  if (["appointment", "reschedule", "lesson", "clinic_book"].includes(action)) {
    add("startsAt", `Начало (${org.timezone})`, `Басталуы (${org.timezone})`, {
      type: "datetime-local",
    });
    add("endsAt", `Конец (${org.timezone})`, `Аяқталуы (${org.timezone})`, {
      type: "datetime-local",
    });
    add(
      "resources",
      "Ресурсы: выберите специалиста и место",
      "Ресурстар: маман мен орынды таңдаңыз",
      { options: resourceOptions, multiple: true },
    );
  }
  if (["appointment", "enroll"].includes(action))
    choice("inquiryId", "Обращение / заявка", "Өтініш", inquiries, true);
  if (["appointment", "enroll"].includes(action))
    choice("customerId", "Клиент / учащийся", "Клиент / оқушы", customers);
  if (["appointment", "course"].includes(action))
    choice("serviceItemId", "Услуга каталога", "Каталог қызметі", services);
  if (action === "appointment")
    numeric("price", "Цена визита, ₸", "Қабылдау бағасы, ₸");
  if (action === "appointment_end")
    choice(
      "outcome",
      "Результат",
      "Нәтиже",
      ["completed", "cancelled", "no_show"].map((id) => ({ id, name: w(id) })),
    );
  if (action === "reminder") {
    choice(
      "connectionId",
      "Подключённый Telegram",
      "Қосылған Telegram",
      connections,
    );
    add("text", "Текст напоминания", "Еске салу мәтіні", { type: "textarea" });
  }
  if (action === "course") {
    numeric(
      "lessonPrice",
      "Цена посещённого занятия, ₸",
      "Қатысқан сабақ бағасы, ₸",
    );
    numeric("lessons", "Число занятий", "Сабақ саны", "10");
  }
  if (action === "group") {
    choice("courseId", "Курс", "Курс", options("course"));
    numeric("capacity", "Вместимость", "Сыйымдылық", "10");
  }
  if (["enroll", "lesson"].includes(action))
    choice("groupId", "Группа", "Топ", options("group"));
  if (action === "enroll") {
    choice(
      "guardianId",
      "Законный представитель",
      "Заңды өкіл",
      customers,
      true,
    );
    add("endsOn", "Обучение до", "Оқу аяқталатын күн", { type: "date" });
  }
  if (action === "enrollment_change") {
    numeric(
      "additionalLessons",
      "Дополнительные занятия (только при продлении)",
      "Қосымша сабақтар (ұзарту кезінде ғана)",
    );
    choice(
      "action",
      "Действие",
      "Әрекет",
      ["freeze", "resume", "extend", "withdraw"].map((id) => ({
        id,
        name: w(id),
      })),
    );
    add(
      "until",
      "Новая дата (для заморозки / продления)",
      "Жаңа күн (тоқтату / ұзарту үшін)",
      { type: "date", optional: true },
    );
  }
  if (action === "project") {
    add(
      "estimatedHours",
      "Оценка часов (не фактические затраты)",
      "Сағат бағасы (нақты шығын емес)",
      { type: "number", optional: true, min: "0" },
    );
    choice("quoteId", "Предложение CRM", "CRM ұсынысы", quotes);
    numeric("budget", "Бюджет затрат, ₸", "Шығын бюджеті, ₸");
    add("team", "Команда", "Топ", { options: members, multiple: true });
    add("stages", "Этапы, через запятую", "Кезеңдер, үтір арқылы", {
      value: t("Работа, Сдача", "Жұмыс, Тапсыру"),
    });
  }
  if (action === "project_task")
    add("title", "Название задачи", "Тапсырма атауы");
  if (["time", "project_task"].includes(action)) {
    choice(
      "memberId",
      "Исполнитель",
      "Орындаушы",
      members.filter((x) => project?.team.includes(x.id)),
    );
    choice(
      "stage",
      "Этап",
      "Кезең",
      project?.stages.map((name, i) => ({ id: String(i), name })) ?? [],
    );
  }
  if (action === "time") {
    numeric("hours", "Часы", "Сағат", "1");
    numeric("hourlyRate", "Ставка, ₸/час", "Мөлшерлеме, ₸/сағ");
    add("workedOn", "Дата работы", "Жұмыс күні", { type: "date" });
  }
  if (action === "scope_change") {
    numeric(
      "budget",
      "Новый бюджет затрат, ₸",
      "Жаңа шығын бюджеті, ₸",
      project?.budget ?? "0",
    );
    numeric(
      "extraPrice",
      "Доплата заказчика, ₸",
      "Тапсырыс беруші қосымша төлемі, ₸",
    );
    add("description", "Изменение объёма", "Көлем өзгерісі", {
      type: "textarea",
    });
  }
  if (action === "project_stage")
    choice(
      "stage",
      "Этап",
      "Кезең",
      project?.stages.map((name, i) => ({ id: String(i), name })) ?? [],
    );
  if (estimateForm) {
    if (action === "construction") {
      add("title", "Объект строительства", "Құрылыс нысаны");
      choice("customerId", "Заказчик", "Тапсырыс беруші", customers);
      choice("warehouseId", "Склад объекта", "Нысан қоймасы", warehouseOptions);
      choice(
        "billingItemId",
        "Услуга для итогового счёта",
        "Қорытынды шот қызметі",
        services,
      );
    }
    numeric(
      "budget",
      "Бюджет затрат, ₸",
      "Шығын бюджеті, ₸",
      construction?.budget ?? "",
    );
    add("stages", "Этапы, через запятую", "Кезеңдер, үтір арқылы", {
      value: construction?.stages.join(", ") ?? "",
    });
  }
  if (action === "construction_purchase") {
    choice("supplierId", "Поставщик", "Жеткізуші", suppliers);
    choice("offerId", "Предложение поставщика", "Жеткізуші ұсынысы", offers);
    numeric("quantity", "Количество закупки", "Сатып алу саны", "1");
    add("date", "Дата предложения", "Ұсыныс күні", { type: "date" });
    add("dueDate", "Срок поставки", "Жеткізу мерзімі", { type: "date" });
  }
  if (action === "construction_work") {
    choice("contractorId", "Подрядчик", "Мердігер", suppliers);
    choice(
      "stage",
      "Этап",
      "Кезең",
      construction?.stages.map((name, i) => ({ id: String(i), name })) ?? [],
    );
    numeric("amount", "Стоимость работ, ₸", "Жұмыс құны, ₸", "");
    add(
      "evidence",
      "Подтверждение выполненного объёма",
      "Орындалған көлем дәлелі",
      { type: "textarea" },
    );
  }
  if (action === "construction_confirm")
    choice(
      "workId",
      "Работа для проверки",
      "Тексерілетін жұмыс",
      construction?.work
        .filter((w) => !w.confirmedBy)
        .map((w) => ({
          id: w.id,
          name:
            construction.stages[w.stage] +
            " · " +
            w.amount +
            " ₸ · " +
            w.evidence,
        })) ?? [],
    );
  if (action === "clinic") {
    add(
      "patientName",
      "Имя пациента (административный учёт)",
      "Пациент аты (әкімшілік есеп)",
    );
    add("contact", "Контакт (необязательно)", "Байланыс (міндетті емес)", {
      optional: true,
    });
    choice("serviceItemId", "Направление услуги", "Қызмет бағыты", services);
    choice(
      "warehouseId",
      "Подразделение расчёта",
      "Есеп бөлімі",
      warehouseOptions,
    );
    numeric("price", "Стоимость посещения, ₸", "Қабылдау құны, ₸", "");
  }
  if (action === "clinic_visit")
    choice(
      "outcome",
      "Итог посещения",
      "Қатысу нәтижесі",
      ["visited", "no_show", "cancelled"].map((id) => ({ id, name: w(id) })),
    );
  if (action)
    add("note", "Основание / подтверждение", "Негіз / растау", {
      type: "textarea",
    });
  const lessonDay = selected?.data.startsAt
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: org.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(String(selected.data.startsAt)))
    : "";
  const activeStudents = docs.filter(
    (x) =>
      x.kind === "enrollment" &&
      x.state === "active" &&
      x.data.groupId === selected?.data.groupId &&
      String(x.data.endsOn) >= lessonDay,
  );
  const needsMaterials = [
    "recipe",
    "production_issue",
    "appointment",
    "construction_materials",
  ].includes(action);
  const materialDefaults =
    action === "production_issue"
      ? production?.requirements
      : action === "recipe"
        ? recipe?.ingredients
        : undefined;
  const resetAction = (a: string) => {
    setAction(a);
    setLineCount(
      a === "construction_revise"
        ? (construction?.lines.length ?? 1)
        : a === "production_issue"
          ? (production?.requirements.length ?? 1)
          : a === "recipe"
            ? (recipe?.ingredients.length ?? 1)
            : 1,
    );
    setError("");
    setSuccess(false);
    retry.current = null;
  };
  const fail = (code: string) =>
    industryLabels[code] ? w(code) : errorText(code, locale);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setSuccess(false);
    const d = new FormData(e.currentTarget);
    try {
      const payload: Record<string, unknown> = { kind: action };
      for (const field of fields) {
        let value: unknown = field.multiple
          ? d.getAll(field.name).map(String)
          : read(d, field.name);
        if (field.type === "datetime-local")
          value = value
            ? organizationInstant(String(value), org.timezone)
            : null;
        if (field.optional && value === "") value = null;
        payload[field.name] = value;
      }
      if (changing) {
        payload.id = selected!.id;
        payload.version = selected!.version;
      } else payload.branchId = branch;
      if (action === "recipe") {
        payload.branchId = branch;
        payload.mode = org.profile;
        payload.stages = read(d, "stages")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
      }
      for (const name of [
        "capacity",
        "bufferMinutes",
        "lessons",
        "stage",
        "additionalLessons",
      ])
        if (name in payload) payload[name] = Number(payload[name]);
      if (action === "resource") {
        payload.days = read(d, "days").split(",").map(Number);
        delete payload.note;
      }
      if (action === "course" || action === "group") delete payload.note;
      if (action === "project" || estimateForm)
        payload.stages = read(d, "stages")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
      if (action === "clinic") payload.contact = read(d, "contact");
      if (action === "construction_purchase") {
        payload.lines = [
          { offerId: payload.offerId, quantity: payload.quantity },
        ];
        delete payload.offerId;
        delete payload.quantity;
      }
      if (estimateForm)
        payload.lines = Array.from({ length: lineCount }, (_, i) => {
          const itemId = read(d, `estimate-item-${i}`);
          return {
            itemId,
            unit: items.find((x) => x.id === itemId)?.base_unit ?? "pc",
            quantity: read(d, `estimate-qty-${i}`),
            price: read(d, `estimate-price-${i}`),
          };
        });
      if (needsMaterials) {
        const materials = Array.from({ length: lineCount }, (_, i) => {
          const itemId = read(d, `item-${i}`);
          return {
            itemId,
            quantity: read(d, `qty-${i}`),
            unit: items.find((x) => x.id === itemId)?.base_unit ?? "pc",
            ...(action === "recipe"
              ? { lossPercent: read(d, `loss-${i}`) || "0" }
              : {}),
          };
        }).filter((x) => x.itemId);
        payload[action === "recipe" ? "ingredients" : "materials"] = materials;
      }
      if (action === "lot_receipt")
        payload.unit =
          items.find((x) => x.id === payload.itemId)?.base_unit ?? "pc";
      if (action === "production_plan") {
        payload.salesOrderId ??= null;
        payload.equipmentId = payload.equipmentId ?? null;
      }
      if (action === "lesson_complete") {
        payload.attendance = activeStudents.map((x) => ({
          enrollmentId: x.id,
          present: d.get(`present-${x.id}`) === "on",
        }));
      }
      const signature = JSON.stringify(payload);
      if (retry.current?.signature !== signature)
        retry.current = { signature, key: crypto.randomUUID() };
      payload.key = retry.current.key;
      await api(`${base}/industry/commands`, "POST", payload);
      if (selected) {
        const fresh = await api<{
          document: IndustryRecord;
          history: typeof history;
          lots: typeof lots;
        }>(`${base}/industry/${selected.id}`);
        setSelected(fresh.document);
        setHistory(fresh.history);
        setLots(fresh.lots);
      }
      retry.current = null;
      setAction("");
      setRevision((x) => x + 1);
      setSuccess(true);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      setError(e.code ?? e.message ?? "INTERNAL_ERROR");
    } finally {
      setBusy(false);
    }
  }
  const money = (v: unknown) =>
    new Decimal(String(v ?? "0")).div(100).toFixed(2) + " ₸";
  return (
    <section className="industry-page">
      <div className="section-title">
        <div>
          <h2>{profileNames[locale][org.profile]}</h2>
          <p>
            {t(
              "Документы, фактические операции и история. Выручка и деньги учитываются отдельно.",
              "Құжаттар, нақты операциялар және тарих. Табыс пен ақша бөлек есептеледі.",
            )}
          </p>
        </div>
        <label>
          {t("Филиал", "Филиал")}
          <select
            value={branch}
            onChange={(e) => {
              setBranch(e.target.value);
              setSelected(null);
              setAction("");
              setLoading(true);
            }}
          >
            {workspace.branches.map((b) => (
              <option value={b.id} key={b.id}>
                {b.name === "01" ? t("Основной", "Негізгі") : b.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="industry-actions">
        {createActions.map((a) => (
          <button
            className="button secondary"
            key={a}
            onClick={() => {
              setSelected(null);
              resetAction(a);
            }}
          >
            {w(a)}
          </button>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {fail(error)}
        </p>
      )}
      {success && (
        <p role="status">
          {t(
            "Операция сохранена. Оплата выполняется отдельно в «Финансы».",
            "Операция сақталды. Төлем «Қаржы» бөлімінде бөлек жүргізіледі.",
          )}
        </p>
      )}
      {loading ? (
        <p role="status">{t("Загрузка…", "Жүктелуде…")}</p>
      ) : (
        <div className="industry-layout">
          <div className="panel">
            <label>
              {t("Поиск документа", "Құжат іздеу")}
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </label>
            <p className="muted">
              {t(
                "Показаны последние 200 документов филиала.",
                "Филиалдың соңғы 200 құжаты көрсетілген.",
              )}
            </p>
            <div className="industry-list">
              {docs
                .filter((x) =>
                  x.title.toLowerCase().includes(filter.toLowerCase()),
                )
                .map((d) => (
                  <button
                    className={`industry-card ${selected?.id === d.id ? "selected" : ""}`}
                    key={d.id}
                    onClick={() => {
                      setSelected(d);
                      setAction("");
                      setError("");
                      setSuccess(false);
                    }}
                  >
                    <strong>{d.title}</strong>
                    <span>
                      {w(d.kind)} · {w(d.state)} · v{d.version}
                    </span>
                  </button>
                ))}
              {!docs.length && (
                <p>
                  {t(
                    "Создайте первый документ для этого профиля.",
                    "Осы профиль үшін алғашқы құжатты жасаңыз.",
                  )}
                </p>
              )}
            </div>
          </div>
          <div className="panel industry-detail">
            {selected && (
              <>
                <h3>{selected.title}</h3>
                <p>
                  {w(selected.state)} · {t("Версия", "Нұсқа")}{" "}
                  {selected.version}
                </p>
                <div className="industry-actions">
                  {recordActions.map((a) => (
                    <button
                      className="button secondary"
                      key={a}
                      onClick={() => resetAction(a)}
                    >
                      {w(a)}
                    </button>
                  ))}
                </div>
                {production && (
                  <>
                    <p>
                      {t("План / годный выпуск", "Жоспар / жарамды өнім")}:{" "}
                      {production.quantity} / {production.goodQuantity ?? "–"}
                    </p>
                    <p>
                      {t(
                        "Фактическая стоимость материалов",
                        "Материалдардың нақты құны",
                      )}
                      :{" "}
                      {production.issued.length
                        ? money(production.costMinor)
                        : "–"}
                      ; {t("потери от брака", "ақау шығыны")}:{" "}
                      {production.scrapCostMinor
                        ? money(production.scrapCostMinor)
                        : "–"}
                    </p>
                    <p>
                      {t(
                        "Оценка материалов на момент планирования",
                        "Жоспарлау кезіндегі материал бағасы",
                      )}
                      :{" "}
                      {production.plannedMaterialCostMinor === null
                        ? "–"
                        : money(production.plannedMaterialCostMinor)}
                    </p>
                    <p>
                      {t(
                        "Нормативная потребность отдельно от фактического расхода.",
                        "Нормативтік қажеттілік нақты шығыннан бөлек.",
                      )}
                    </p>
                    <ul>
                      {production.requirements.map((m) => (
                        <li key={m.itemId}>
                          {items.find((x) => x.id === m.itemId)?.name_ru}:{" "}
                          {m.quantity} {unitName(m.unit)};{" "}
                          {t("выдано", "берілді")}{" "}
                          {production.issued
                            .filter((x) => x.itemId === m.itemId)
                            .reduce(
                              (n, x) => n.plus(x.quantity),
                              new Decimal(0),
                            )
                            .toFixed()}
                        </li>
                      ))}
                    </ul>
                    <ol>
                      {production.recipe.stages.map((name, i) => (
                        <li key={i}>
                          {production.stages[i] ? "✓" : "○"} {name}
                        </li>
                      ))}
                    </ol>
                    <p>
                      {t("Брак / переделано", "Ақау / түзетілген")}:{" "}
                      {production.defects} / {production.reworked}
                    </p>
                  </>
                )}
                {selected.kind === "appointment" && (
                  <>
                    <p>
                      {businessDate(
                        new Date(String(selected.data.startsAt)),
                        locale,
                        org.timezone,
                        true,
                      )}{" "}
                      →{" "}
                      {businessDate(
                        new Date(String(selected.data.endsAt)),
                        locale,
                        org.timezone,
                        true,
                      )}
                    </p>
                    <p>
                      {t("Клиент", "Клиент")}:{" "}
                      {customers.find((x) => x.id === selected.data.customerId)
                        ?.name ?? "–"}
                    </p>
                  </>
                )}
                {selected.kind === "enrollment" && (
                  <p>
                    {t(
                      "Учащийся / занятий / обучение до",
                      "Оқушы / сабақ / аяқталуы",
                    )}
                    :{" "}
                    {
                      customers.find((x) => x.id === selected.data.customerId)
                        ?.name
                    }{" "}
                    / {String(selected.data.attended)} /{" "}
                    {String(selected.data.endsOn)}
                  </p>
                )}
                {clinic && (
                  <>
                    <p>
                      {t(
                        "Только административные сведения. Не вносите диагнозы и назначения.",
                        "Тек әкімшілік деректер. Диагноздар мен тағайындауларды енгізбеңіз.",
                      )}
                    </p>
                    <p>
                      {clinic.patientName} · {clinic.contact}
                    </p>
                    <p>
                      {clinic.price} ₸ ·{" "}
                      {clinic.startsAt
                        ? businessDate(
                            new Date(clinic.startsAt),
                            locale,
                            org.timezone,
                            true,
                          )
                        : t("Ещё не записан", "Әлі жазылмаған")}
                    </p>
                    <p>
                      {t(
                        "В общих финансах имя и контакт пациента не отображаются.",
                        "Жалпы қаржыда пациенттің аты мен байланысы көрсетілмейді.",
                      )}
                    </p>
                  </>
                )}
                {construction && (
                  <>
                    <p>
                      {t("Версия сметы", "Смета нұсқасы")}{" "}
                      {construction.estimateVersion} ·{" "}
                      {t("Цена заказчику", "Тапсырыс беруші бағасы")}{" "}
                      {money(construction.priceMinor)} ·{" "}
                      {t("Бюджет затрат", "Шығын бюджеті")}{" "}
                      {construction.budget} ₸
                    </p>
                    <p>
                      {t("Фактические материалы", "Нақты материалдар")}:{" "}
                      {money(construction.materialCostMinor)}
                    </p>
                    <ol>
                      {construction.stages.map((stage, i) => (
                        <li key={i}>
                          {stage}:{" "}
                          {construction.work
                            .filter((w) => w.stage === i)
                            .map((w) => (
                              <p key={w.id}>
                                {w.amount} ₸ · {w.evidence} ·{" "}
                                {w.confirmedBy
                                  ? t("Проверено", "Тексерілді")
                                  : t("Ожидает проверки", "Тексеруді күтуде")}
                                {w.obligationId && (
                                  <span>
                                    {" "}
                                    ·{" "}
                                    {t(
                                      "Обязательство в финансах",
                                      "Қаржыдағы міндеттеме",
                                    )}
                                    : {w.obligationId}
                                  </span>
                                )}
                              </p>
                            ))}
                        </li>
                      ))}
                    </ol>
                    <details>
                      <summary>{t("Строки сметы", "Смета жолдары")}</summary>
                      {construction.lines.map((l) => (
                        <p key={l.itemId}>
                          {items.find((i) => i.id === l.itemId)?.name_ru} ·{" "}
                          {l.quantity} × {l.price} ₸
                        </p>
                      ))}
                    </details>
                    <p>
                      {t(
                        "Закупки: согласование, накладная и фактическая приёмка выполняются в разделе «Закупки».",
                        "Сатып алу: келісу, жүкқұжат және нақты қабылдау «Сатып алу» бөлімінде орындалады.",
                      )}
                    </p>
                    {construction.purchases.map((id, i) => (
                      <p key={id}>
                        <button
                          className="button secondary"
                          onClick={() => onOpenPurchase(id, selected.branch_id)}
                        >
                          {t(
                            "Открыть закупку и приёмку",
                            "Сатып алу мен қабылдауды ашу",
                          )}{" "}
                          {i + 1}
                        </button>
                      </p>
                    ))}
                    <p>
                      {t(
                        "Приёмка объекта: управленческое подтверждение, без юридической электронной подписи.",
                        "Нысанды қабылдау: заңды электрондық қолтаңбасыз басқарушылық растау.",
                      )}
                    </p>
                  </>
                )}
                {project && (
                  <>
                    <p>
                      {t("Согласованная цена", "Келісілген баға")}:{" "}
                      {money(project.priceMinor)};{" "}
                      {t("бюджет затрат", "шығын бюджеті")}: {project.budget} ₸;{" "}
                      {t(
                        "стоимость учтённого времени",
                        "есептелген уақыт құны",
                      )}
                      : {money(project.costMinor)}
                    </p>
                    <p>
                      {t(
                        "Трудозатраты не являются движением денег. Прочие расходы проверяйте в финансах.",
                        "Еңбек шығыны ақша қозғалысы емес. Басқа шығындарды қаржыда тексеріңіз.",
                      )}
                    </p>
                    <ol>
                      {project.stages.map((name, i) => (
                        <li key={i}>
                          {project.done[i] ? "✓" : "○"} {name}
                        </li>
                      ))}
                    </ol>
                    <p>
                      {t("Оценка / учтено часов", "Бағалау / есептелген сағат")}
                      : {project.estimatedHours ?? "–"} /{" "}
                      {project.time
                        .reduce((a, x) => a.plus(x.hours), new Decimal(0))
                        .toFixed()}
                    </p>
                    {project.tasks.map((task) => (
                      <p key={task.id}>
                        {t("Связанная задача", "Байланысты тапсырма")}:{" "}
                        <code>{task.id}</code> · {project.stages[task.stage]}
                      </p>
                    ))}
                    {project.change && (
                      <p>
                        {t(
                          "Ожидает второго согласующего",
                          "Екінші келісушіні күтуде",
                        )}
                        : {project.change.description}; {project.change.budget}{" "}
                        ₸
                      </p>
                    )}
                  </>
                )}
                {(
                  (selected.data.orderIds as string[] | undefined) ??
                  (selected.data.orderId ? [String(selected.data.orderId)] : [])
                ).map((id) => (
                  <p key={id}>
                    {t(
                      "Связанный заказ для оплаты в разделе «Финансы»",
                      "«Қаржы» бөлімінде төленетін байланысты тапсырыс",
                    )}
                    :{" "}
                    <button
                      className="button secondary"
                      onClick={() => onOpenOrder(id, selected.branch_id)}
                    >
                      {t("Открыть заказ и оплату", "Тапсырыс пен төлемді ашу")}
                    </button>
                  </p>
                ))}
                {lots.length > 0 && (
                  <details>
                    <summary>{t("Партии склада", "Қойма партиялары")}</summary>
                    {lots.map((l) => (
                      <p key={l.id}>
                        {l.code} ·{" "}
                        {items.find((x) => x.id === l.item_id)?.name_ru} ·{" "}
                        {l.quantity} · {l.expires_on ?? "–"}
                      </p>
                    ))}
                  </details>
                )}
                <details>
                  <summary>
                    {t("История и основания", "Тарих пен негіздер")}
                  </summary>
                  {history.map((h) => (
                    <p key={h.version}>
                      v{h.version} · {h.note} ·{" "}
                      {businessDate(
                        new Date(h.created_at),
                        locale,
                        org.timezone,
                        true,
                      )}
                    </p>
                  ))}
                </details>
              </>
            )}
            {action && (
              <form
                key={`${action}:${selected?.id ?? "new"}`}
                onSubmit={submit}
                aria-label={w(action)}
              >
                <h3>{w(action)}</h3>
                <div className="form-grid">
                  {fields.map((field) => (
                    <label key={field.name}>
                      {t(field.ru, field.kk)}
                      {field.options ? (
                        <select
                          aria-label={t(field.ru, field.kk)}
                          name={field.name}
                          required={!field.optional}
                          multiple={field.multiple}
                          size={field.multiple ? 4 : undefined}
                          defaultValue={
                            field.multiple ? [] : (field.value ?? "")
                          }
                        >
                          {!field.multiple && (
                            <option value="">
                              {t("Выберите", "Таңдаңыз")}
                            </option>
                          )}
                          {field.options.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                        </select>
                      ) : field.type === "textarea" ? (
                        <textarea
                          name={field.name}
                          required={!field.optional}
                          minLength={3}
                          maxLength={field.name === "text" ? 2000 : 250}
                          defaultValue={field.value}
                        />
                      ) : (
                        <input
                          name={field.name}
                          type={field.type ?? "text"}
                          required={!field.optional}
                          defaultValue={field.value}
                          min={field.min}
                          max={field.max}
                          step={
                            field.type === "number" ? "0.000001" : undefined
                          }
                        />
                      )}
                    </label>
                  ))}
                </div>
                {estimateForm && (
                  <fieldset>
                    <legend>
                      {t(
                        "Строки сметы: материалы и работы",
                        "Смета жолдары: материалдар мен жұмыстар",
                      )}
                    </legend>
                    {Array.from({ length: lineCount }, (_, i) => (
                      <div className="form-grid" key={i}>
                        <label>
                          {t("Позиция сметы", "Смета позициясы")} {i + 1}
                          <select
                            name={`estimate-item-${i}`}
                            aria-label={
                              t("Позиция сметы", "Смета позициясы") +
                              " " +
                              (i + 1)
                            }
                            required
                            defaultValue={construction?.lines[i]?.itemId ?? ""}
                          >
                            <option value="">
                              {t("Выберите", "Таңдаңыз")}
                            </option>
                            {[...goods, ...services].map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          {t("Количество по смете", "Смета саны")} {i + 1}
                          <input
                            name={`estimate-qty-${i}`}
                            type="number"
                            required
                            min="0.000001"
                            step="0.000001"
                            defaultValue={
                              construction?.lines[i]?.quantity ?? "1"
                            }
                          />
                        </label>
                        <label>
                          {t("Цена по смете, ₸", "Смета бағасы, ₸")} {i + 1}
                          <input
                            name={`estimate-price-${i}`}
                            type="number"
                            required
                            min="0"
                            step="0.000001"
                            defaultValue={construction?.lines[i]?.price ?? ""}
                          />
                        </label>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="button secondary"
                      disabled={lineCount >= 30}
                      onClick={() => setLineCount((n) => n + 1)}
                    >
                      {t("Добавить строку", "Жол қосу")}
                    </button>
                    {lineCount > 1 && (
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => setLineCount((n) => n - 1)}
                      >
                        {t(
                          "Убрать последнюю строку",
                          "Соңғы жолды алып тастау",
                        )}
                      </button>
                    )}
                  </fieldset>
                )}
                {needsMaterials && (
                  <fieldset>
                    <legend>
                      {t(
                        "Материалы в базовых единицах",
                        "Негізгі бірліктегі материалдар",
                      )}
                    </legend>
                    {Array.from({ length: lineCount }, (_, i) => (
                      <div className="form-grid" key={i}>
                        <label>
                          {t("Материал", "Материал")} {i + 1}
                          <select
                            name={`item-${i}`}
                            aria-label={`${t("Материал", "Материал")} ${i + 1}`}
                            required={action !== "appointment"}
                            defaultValue={materialDefaults?.[i]?.itemId ?? ""}
                          >
                            <option value="">
                              {t("Без материала", "Материалсыз")}
                            </option>
                            {goods.map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          {t("Количество", "Саны")}
                          <input
                            name={`qty-${i}`}
                            type="number"
                            min="0.000001"
                            step="0.000001"
                            defaultValue={
                              materialDefaults?.[i]?.quantity ?? "1"
                            }
                          />
                        </label>
                        {action === "recipe" && (
                          <label>
                            {t("Потери, %", "Жоғалту, %")}
                            <input
                              name={`loss-${i}`}
                              type="number"
                              min="0"
                              max="99.999999"
                              step="0.000001"
                              defaultValue={
                                recipe?.ingredients[i]?.lossPercent ?? "0"
                              }
                            />
                          </label>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      className="button secondary"
                      disabled={lineCount >= 30}
                      onClick={() => setLineCount((x) => x + 1)}
                    >
                      {t("Добавить материал", "Материал қосу")}
                    </button>
                  </fieldset>
                )}
                {action === "lesson_complete" && (
                  <fieldset>
                    <legend>
                      {t(
                        "Присутствовали (остальные отмечаются отсутствующими)",
                        "Қатысқандар (қалғандары келмеді деп белгіленеді)",
                      )}
                    </legend>
                    {activeStudents.map((d) => (
                      <label key={d.id}>
                        <input
                          type="checkbox"
                          name={`present-${d.id}`}
                          defaultChecked
                        />
                        {customers.find((x) => x.id === d.data.customerId)
                          ?.name ?? d.title}
                      </label>
                    ))}
                  </fieldset>
                )}
                <div className="industry-actions">
                  <button className="button primary" disabled={busy}>
                    {busy ? t("Сохранение…", "Сақталуда…") : w(action)}
                  </button>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => setAction("")}
                  >
                    {t("Закрыть", "Жабу")}
                  </button>
                </div>
              </form>
            )}
            {!selected && !action && (
              <p>
                {t(
                  "Выберите документ или создайте новый.",
                  "Құжатты таңдаңыз немесе жаңасын жасаңыз.",
                )}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
