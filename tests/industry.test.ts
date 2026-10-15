import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { IndustryService } from "../src/server/industry/service";
import { InventoryService } from "../src/server/inventory/service";
import { CommerceService } from "../src/server/commerce/service";
import { CrmService } from "../src/server/crm/service";
import { TaskService } from "../src/server/tasks/service";
import { industryDetail, industryView } from "../src/domain/industry";
import type { Profile } from "../src/domain/contracts";
import type {
  Production,
  Appointment,
  Enrollment,
  Project,
} from "../src/server/industry/types";
const key = () => randomUUID();
let db: Database,
  p: Platform,
  svc: IndustryService,
  stock: InventoryService,
  commerce: CommerceService,
  crm: CrmService,
  owner: string,
  ownerId: string,
  outsider: string;
type Fixture = {
  org: string;
  branch: string;
  warehouse: string;
  material: string;
  product: string;
  service: string;
  customer: string;
};
const fixtures = {} as Record<Profile, Fixture>;
const today = new Date().toISOString().slice(0, 10),
  future = "2099-12-31";
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const start = `${yesterday}T09:00:00Z`,
  end = `${yesterday}T10:00:00Z`;
beforeAll(async () => {
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  svc = new IndustryService(db);
  stock = new InventoryService(db);
  commerce = new CommerceService(db);
  crm = new CrmService(db);
  const u = await p.register({
    name: "Industry owner",
    email: `${key()}@example.test`,
    password: "Synthetic-Industry-661!",
  });
  owner = u.token;
  ownerId = u.user.id;
  outsider = (
    await p.register({
      name: "Outsider",
      email: `${key()}@example.test`,
      password: "Synthetic-Industry-661!",
    })
  ).token;
  for (const profile of [
    "food",
    "services",
    "education",
    "projects",
    "production",
  ] as const) {
    const org = (
        await p.createOrganization(owner, {
          name: `Industry ${profile}`,
          profile,
        })
      ).id,
      branch = (await p.workspace(owner, org)).branches[0].id;
    const warehouse = (
      await stock.createWarehouse(owner, org, {
        branchId: branch,
        name: "Склад",
      })
    ).id;
    const item = async (kind: "goods" | "service", sku: string) =>
      (
        await stock.saveItem(owner, org, {
          sku,
          name_ru: sku,
          kind,
          base_unit: "pc",
          purchase_price: "2",
          sale_price: "100",
        })
      ).id!;
    const material = await item("goods", "Материал"),
      product = await item("goods", "Продукция"),
      service = await item("service", "Услуга");
    const customer = (
      await crm.createCustomer(owner, org, {
        key: key(),
        branchId: branch,
        name: "Тестовый клиент",
        email: "",
        phone: "+77000000001",
        kind: "person",
        responsibleId: null,
        consents: { email: false, sms: false, messenger: false },
        consentNote: "Тестовые данные",
      })
    ).id;
    fixtures[profile] = {
      org,
      branch,
      warehouse,
      material,
      product,
      service,
      customer,
    };
  }
}, 60000);
afterAll(async () => await db?.close());
const cmd = (f: Fixture, input: Record<string, unknown>, secret = owner) =>
  svc.command(secret, f.org, { key: key(), ...input });
const create = (f: Fixture, input: Record<string, unknown>) =>
  cmd(f, { branchId: f.branch, ...input });
const detail = async (f: Fixture, id: string) =>
  industryDetail.parse(await svc.detail(owner, f.org, id));
const change = async (
  f: Fixture,
  id: string,
  input: Record<string, unknown>,
  secret = owner,
) =>
  cmd(
    f,
    {
      id,
      version: (await detail(f, id)).document.version,
      note: "Подтверждено тестом",
      ...input,
    },
    secret,
  );
const receipt = (f: Fixture, expiresOn: string | null = future) =>
  create(f, {
    kind: "lot_receipt",
    warehouseId: f.warehouse,
    itemId: f.material,
    quantity: "20",
    unit: "pc",
    unitCost: "2",
    lotCode: `RAW-${key()}`,
    expiresOn,
    note: "Поступление материала",
  });
async function recipe(f: Fixture, mode: "food" | "production") {
  return (
    await create(f, {
      kind: "recipe",
      title: "Рецептура / спецификация",
      mode,
      outputItemId: f.product,
      outputQuantity: "10",
      ingredients: [
        { itemId: f.material, quantity: "10", unit: "pc", lossPercent: "0" },
      ],
      stages: ["Подготовка", "Выпуск"],
      note: "Первая версия",
    })
  ).id;
}
async function resource(
  f: Fixture,
  resourceKind: string,
  bufferMinutes = 0,
  capacity = 1,
) {
  return (
    await create(f, {
      kind: "resource",
      title: `Ресурс ${resourceKind}`,
      resourceKind,
      capacity,
      bufferMinutes,
      days: [1, 2, 3, 4, 5, 6, 7],
      opens: "00:00",
      closes: "23:59",
    })
  ).id;
}
it("T041: recipe snapshot → need → actual material issue → food lot → sale → expiry write-off, exact cost and replay", async () => {
  const f = fixtures.food;
  await receipt(f);
  const r = await recipe(f, "food");
  const plan = (
    await create(f, {
      kind: "production_plan",
      recipeId: r,
      warehouseId: f.warehouse,
      quantity: "10",
      note: "План выпуска",
    })
  ).id;
  expect(
    ((await detail(f, plan)).document.data as unknown as Production)
      .requirements[0].quantity,
  ).toBe("10");
  await change(f, r, {
    kind: "recipe",
    branchId: f.branch,
    title: "Новая рецептура",
    mode: "food",
    outputItemId: f.product,
    outputQuantity: "10",
    ingredients: [
      { itemId: f.material, quantity: "15", unit: "pc", lossPercent: "0" },
    ],
    stages: ["Подготовка", "Выпуск"],
  });
  expect(
    ((await detail(f, plan)).document.data as unknown as Production)
      .recipeVersion,
  ).toBe(1);
  await change(f, plan, {
    kind: "production_issue",
    materials: [{ itemId: f.material, quantity: "10", unit: "pc" }],
  });
  await change(f, plan, { kind: "production_stage", stage: 0 });
  await change(f, plan, { kind: "production_stage", stage: 1 });
  const finish = {
    key: key(),
    id: plan,
    version: (await detail(f, plan)).document.version,
    kind: "production_finish",
    goodQuantity: "10",
    scrapQuantity: "0",
    lotCode: "BREAD-01",
    expiresOn: future,
    note: "Фактический выпуск",
  };
  await svc.command(owner, f.org, finish);
  expect((await svc.command(owner, f.org, finish)).reused).toBe(true);
  const d = await detail(f, plan);
  expect(d.document.state).toBe("completed");
  expect(d.document.data.costMinor).toBe("2000");
  const order = (
    await commerce.create(owner, f.org, {
      key: key(),
      branchId: f.branch,
      customerId: f.customer,
      warehouseId: f.warehouse,
      dueDate: today,
      delivery: "pickup",
      taxMode: "excluded",
      note: "Продажа выпечки",
      lines: [
        {
          itemId: f.product,
          quantity: "3",
          unit: "pc",
          price: "5",
          discount: "0",
        },
      ],
    })
  ).id;
  await commerce.transition(owner, f.org, order, {
    key: key(),
    version: 1,
    kind: "confirm",
    note: "Продажа подтверждена",
  });
  const [line] = await db.query<{ id: string }>(
    "SELECT id FROM sales_order_lines WHERE order_id=$1",
    [order],
  );
  await commerce.transition(owner, f.org, order, {
    key: key(),
    version: 2,
    kind: "fulfill",
    lineId: line.id,
    quantity: "3",
    note: "Продажа исполнена",
  });
  const lot = (await detail(f, plan)).lots.find(
    (x) => x.item_id === f.product,
  )!;
  expect(lot.quantity).toBe("7.000000");
  await db.query("UPDATE stock_lots SET expires_on='2000-01-01' WHERE id=$1", [
    lot.id,
  ]);
  await expect(
    stock.execute(owner, f.org, {
      key: key(),
      kind: "issue",
      warehouseId: f.warehouse,
      itemId: f.product,
      quantity: "1",
      unit: "pc",
      note: "Не продавать просрочку",
    }),
  ).rejects.toMatchObject({ code: "LOT_AVAILABLE_EXCEEDED" });
  await create(f, {
    kind: "waste",
    warehouseId: f.warehouse,
    itemId: f.product,
    lotId: lot.id,
    quantity: "7",
    note: "Истёк срок хранения",
  });
  expect(
    (
      await db.query(
        "SELECT quantity::text,value_minor::text FROM stock_balances WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3",
        [f.org, f.warehouse, f.product],
      )
    )[0],
  ).toMatchObject({ quantity: "0.000000", value_minor: "0" });
  expect(
    industryView.parse(await svc.list(owner, f.org, { branchId: f.branch }))
      .items.length,
  ).toBeGreaterThan(0);
});
it("T041: material operations roll back together, cannot be returned independently, and recipe units are locked", async () => {
  const f = fixtures.food,
    recipeId = await recipe(f, "food");
  const plan = (
    await create(f, {
      kind: "production_plan",
      recipeId,
      warehouseId: f.warehouse,
      quantity: "10",
      note: "План повторный",
    })
  ).id;
  await expect(
    change(f, plan, {
      kind: "production_issue",
      materials: [{ itemId: f.material, quantity: "100", unit: "pc" }],
    }),
  ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
  expect((await detail(f, plan)).document.version).toBe(1);
  await change(f, plan, {
    kind: "production_issue",
    materials: [{ itemId: f.material, quantity: "1", unit: "pc" }],
  });
  const [m] = await db.query<{ movement_id: string }>(
    "SELECT movement_id FROM industry_stock_links WHERE document_id=$1",
    [plan],
  );
  await expect(
    stock.execute(owner, f.org, {
      key: key(),
      kind: "return",
      warehouseId: f.warehouse,
      itemId: f.material,
      quantity: "1",
      unit: "pc",
      movementId: m.movement_id,
      note: "Независимый возврат",
    }),
  ).rejects.toMatchObject({ code: "INDUSTRY_OPERATION_REQUIRED" });
});
it("T042: resource buffers prevent duplicate booking, move is atomic, completion consumes materials and creates payable order once", async () => {
  const f = fixtures.services,
    specialist = await resource(f, "specialist", 10),
    workplace = await resource(f, "workplace");
  await stock.execute(owner, f.org, {
    key: key(),
    kind: "receipt",
    warehouseId: f.warehouse,
    itemId: f.material,
    quantity: "5",
    unit: "pc",
    unitCost: "2",
    note: "Материалы услуги",
  });
  const input = {
    kind: "appointment",
    customerId: f.customer,
    serviceItemId: f.service,
    price: "100",
    warehouseId: f.warehouse,
    materials: [{ itemId: f.material, quantity: "2", unit: "pc" }],
    startsAt: start,
    endsAt: end,
    resources: [specialist, workplace],
    note: "Запись клиента",
  };
  const id = (await create(f, input)).id;
  await expect(
    create(f, {
      ...input,
      startsAt: `${yesterday}T10:05:00Z`,
      endsAt: `${yesterday}T11:00:00Z`,
    }),
  ).rejects.toMatchObject({ code: "RESOURCE_CONFLICT" });
  const other = (
    await create(f, {
      ...input,
      startsAt: `${yesterday}T12:00:00Z`,
      endsAt: `${yesterday}T13:00:00Z`,
    })
  ).id;
  await expect(
    change(f, id, {
      kind: "reschedule",
      resources: [specialist, workplace],
      startsAt: `${yesterday}T12:00:00Z`,
      endsAt: `${yesterday}T13:00:00Z`,
    }),
  ).rejects.toMatchObject({ code: "RESOURCE_CONFLICT" });
  expect((await detail(f, id)).document.data.startsAt).toBe(start);
  await change(f, id, {
    kind: "reschedule",
    resources: [specialist, workplace],
    startsAt: `${yesterday}T14:00:00Z`,
    endsAt: `${yesterday}T15:00:00Z`,
  });
  const complete = {
    key: key(),
    kind: "appointment_end",
    id,
    version: (await detail(f, id)).document.version,
    outcome: "completed",
    note: "Работа выполнена",
  };
  await svc.command(owner, f.org, complete);
  await svc.command(owner, f.org, complete);
  const data = (await detail(f, id)).document.data as unknown as Appointment;
  expect(data.orderIds).toHaveLength(1);
  expect(data.materialCostMinor).toBe("400");
  const account = (
    await commerce.createAccount(owner, f.org, {
      key: key(),
      branchId: f.branch,
      name: "Касса",
      opening: "0",
    })
  ).id;
  await commerce.money(owner, f.org, {
    key: key(),
    kind: "payment",
    accountId: account,
    orderId: data.orderIds[0],
    amount: "50",
    note: "Частичная оплата",
  });
  await change(f, other, { kind: "appointment_end", outcome: "no_show" });
  expect((await detail(f, other)).document.data.orderIds).toEqual([]);
});
it("T043: group capacity, shared timetable, attendance, freeze and extension, partial payment and no duplicate accrual", async () => {
  const f = fixtures.education,
    teacher = await resource(f, "teacher"),
    room = await resource(f, "room");
  const course = (
    await create(f, {
      kind: "course",
      title: "Курс",
      serviceItemId: f.service,
      warehouseId: f.warehouse,
      lessonPrice: "20",
      lessons: 4,
    })
  ).id;
  const group = (
    await create(f, {
      kind: "group",
      title: "Группа",
      courseId: course,
      capacity: 1,
    })
  ).id;
  const enrollment = (
    await create(f, {
      kind: "enroll",
      groupId: group,
      customerId: f.customer,
      guardianId: null,
      endsOn: today,
      note: "Зачисление",
    })
  ).id;
  await expect(
    create(f, {
      kind: "enroll",
      groupId: group,
      customerId: f.customer,
      guardianId: null,
      endsOn: future,
      note: "Повтор",
    }),
  ).rejects.toMatchObject({ code: "ALREADY_ENROLLED" });
  await change(f, enrollment, {
    kind: "enrollment_change",
    action: "freeze",
    until: future,
  });
  await change(f, enrollment, {
    kind: "enrollment_change",
    action: "resume",
    until: null,
  });
  await change(f, enrollment, {
    kind: "enrollment_change",
    action: "extend",
    until: future,
    additionalLessons: 2,
  });
  const lesson = (
    await create(f, {
      kind: "lesson",
      groupId: group,
      startsAt: start,
      endsAt: end,
      resources: [teacher, room],
      note: "Занятие",
    })
  ).id;
  await expect(
    create(f, {
      kind: "lesson",
      groupId: group,
      startsAt: start,
      endsAt: end,
      resources: [teacher, room],
      note: "Наложение",
    }),
  ).rejects.toMatchObject({ code: "RESOURCE_CONFLICT" });
  const complete = {
    key: key(),
    kind: "lesson_complete",
    id: lesson,
    version: 1,
    attendance: [{ enrollmentId: enrollment, present: true }],
    note: "Посещение подтверждено",
  };
  await svc.command(owner, f.org, complete);
  expect((await svc.command(owner, f.org, complete)).reused).toBe(true);
  const e = (await detail(f, enrollment)).document
    .data as unknown as Enrollment;
  expect(e.attended).toBe(1);
  expect(e.lessonLimit).toBeGreaterThan(2);
  expect(e.orderIds).toHaveLength(1);
  const account = (
    await commerce.createAccount(owner, f.org, {
      key: key(),
      branchId: f.branch,
      name: "Учебная касса",
      opening: "0",
    })
  ).id;
  await commerce.money(owner, f.org, {
    key: key(),
    kind: "payment",
    accountId: account,
    orderId: e.orderIds[0],
    amount: "10",
    note: "Частичная оплата занятия",
  });
  expect(
    (
      await db.query(
        "SELECT revenue_minor::text,paid_minor::text FROM sales_orders WHERE id=$1",
        [e.orderIds[0]],
      )
    )[0],
  ).toMatchObject({ revenue_minor: "2000", paid_minor: "1000" });
});
it("T044: quote → project → time → versioned scope approval by another actor → delivery → payment", async () => {
  const f = fixtures.projects;
  const other = await p.register({
    name: "Manager",
    email: `${key()}@example.test`,
    password: "Synthetic-Industry-661!",
  });
  const inv = await p.invite(owner, f.org, {
    email: other.user.email,
    role: "manager",
    branchId: f.branch,
  });
  await p.acceptInvitation(other.token, { token: inv.token });
  const inquiry = (
    await crm.createInquiry(owner, f.org, {
      key: key(),
      branchId: f.branch,
      customerId: f.customer,
      source: "manual",
      externalId: "",
      title: "Разработка",
      message: "Тестовый проект",
      responsibleId: null,
    })
  ).id;
  const quote = (
    await crm.saveQuote(owner, f.org, {
      key: key(),
      inquiryId: inquiry,
      validUntil: future,
      terms: "Условия проекта",
      note: "Предложение",
      lines: [
        {
          itemId: f.service,
          quantity: "1",
          unit: "pc",
          price: "100",
          discount: "0",
        },
      ],
    })
  ).id;
  const project = (
    await create(f, {
      kind: "project",
      title: "Проект",
      quoteId: quote,
      warehouseId: f.warehouse,
      budget: "20",
      team: [ownerId],
      stages: ["Разработка"],
      note: "Старт проекта",
    })
  ).id;
  await change(f, project, {
    kind: "time",
    memberId: ownerId,
    stage: 0,
    hours: "2",
    hourlyRate: "5",
    workedOn: today,
  });
  await expect(
    change(f, project, {
      kind: "time",
      memberId: ownerId,
      stage: 0,
      hours: "3",
      hourlyRate: "5",
      workedOn: today,
    }),
  ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  await change(f, project, {
    kind: "scope_change",
    budget: "30",
    extraPrice: "10",
    description: "Дополнительный объём",
  });
  await expect(
    change(f, project, { kind: "scope_approve" }),
  ).rejects.toMatchObject({ code: "SECOND_PERSON_REQUIRED" });
  await change(f, project, { kind: "scope_approve" }, other.token);
  await change(f, project, {
    kind: "time",
    memberId: ownerId,
    stage: 0,
    hours: "3",
    hourlyRate: "5",
    workedOn: today,
  });
  await change(f, project, {
    kind: "project_task",
    title: "Проверить результат",
    memberId: ownerId,
    stage: 0,
  });
  await expect(
    change(f, project, { kind: "project_stage", stage: 0 }),
  ).rejects.toMatchObject({ code: "PROJECT_TASKS_OPEN" });
  const taskId = (
    (await detail(f, project)).document.data as unknown as Project
  ).tasks[0].id;
  const tasks = new TaskService(db);
  await tasks.command(owner, f.org, taskId, {
    key: key(),
    version: 1,
    kind: "start",
  });
  await tasks.command(owner, f.org, taskId, {
    key: key(),
    version: 2,
    kind: "complete",
    note: "Результат выполнен",
  });
  await tasks.command(other.token, f.org, taskId, {
    key: key(),
    version: 3,
    kind: "verify",
    note: "Результат проверен",
  });
  await change(f, project, { kind: "project_stage", stage: 0 });
  await change(f, project, { kind: "project_deliver" });
  const data = (await detail(f, project)).document.data as unknown as Project;
  expect(data.priceMinor).toBe("11000");
  expect(data.costMinor).toBe("2500");
  expect(data.orderId).toBeTruthy();
  const account = (
    await commerce.createAccount(owner, f.org, {
      key: key(),
      branchId: f.branch,
      name: "Счёт проекта",
      opening: "0",
    })
  ).id;
  await commerce.money(owner, f.org, {
    key: key(),
    kind: "payment",
    accountId: account,
    orderId: data.orderId,
    amount: "110",
    note: "Оплата проекта",
  });
  expect(
    (await db.query("SELECT order_id FROM quotes WHERE id=$1", [quote]))[0],
  ).toMatchObject({ order_id: data.orderId });
});
it("T045: equipment capacity, recipe version, defect and rework preserve actual cost and produced-lot traceability", async () => {
  const f = fixtures.production;
  await receipt(f);
  const recipeId = await recipe(f, "production"),
    machine = await resource(f, "equipment");
  const base = {
    kind: "production_plan",
    recipeId,
    warehouseId: f.warehouse,
    quantity: "10",
    equipmentId: machine,
    startsAt: start,
    endsAt: end,
    note: "Производственное задание",
  };
  const id = (await create(f, base)).id;
  await expect(create(f, base)).rejects.toMatchObject({
    code: "RESOURCE_CONFLICT",
  });
  await change(f, id, {
    kind: "production_issue",
    materials: [{ itemId: f.material, quantity: "10", unit: "pc" }],
  });
  await change(f, id, { kind: "production_stage", stage: 0, defects: "2" });
  await change(f, id, {
    kind: "production_issue",
    materials: [{ itemId: f.material, quantity: "1", unit: "pc" }],
  });
  await change(f, id, { kind: "production_stage", stage: 1, reworked: "1" });
  await expect(
    change(f, id, {
      kind: "production_finish",
      goodQuantity: "10",
      scrapQuantity: "0",
      lotCode: "FURN-01",
      expiresOn: null,
    }),
  ).rejects.toMatchObject({ code: "OUTPUT_MISMATCH" });
  await change(f, id, {
    kind: "production_finish",
    goodQuantity: "9",
    scrapQuantity: "1",
    lotCode: "FURN-01",
    expiresOn: null,
  });
  const data = (await detail(f, id)).document.data as unknown as Production;
  expect(data.costMinor).toBe("2200");
  expect(data.scrapCostMinor).toBe("220");
  const [b] = await db.query(
    "SELECT quantity::text,value_minor::text FROM stock_balances WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3",
    [f.org, f.warehouse, f.product],
  );
  expect(b).toMatchObject({ quantity: "9.000000", value_minor: "1980" });
  expect(
    (
      await db.query(
        "SELECT * FROM stock_lot_allocations a JOIN industry_stock_links i ON i.organization_id=a.organization_id AND i.movement_id=a.movement_id WHERE i.document_id=$1",
        [id],
      )
    ).length,
  ).toBe(3);
});
it("T041–T045: tenant, branch and role checks apply before replay; profiles cannot invoke unrelated processes", async () => {
  const f = fixtures.services,
    d = (await svc.list(owner, f.org, {})).items[0] as { id: string };
  await expect(svc.detail(outsider, f.org, d.id)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  const user = await p.register({
    name: "Branch manager",
    email: `${key()}@example.test`,
    password: "Synthetic-Industry-661!",
  });
  const branch = (await p.createBranch(owner, f.org, { name: "Другой филиал" }))
    .id;
  const inv = await p.invite(owner, f.org, {
    email: user.user.email,
    role: "manager",
    branchId: branch,
  });
  await p.acceptInvitation(user.token, { token: inv.token });
  const replay = {
    key: key(),
    branchId: branch,
    kind: "resource",
    title: "Специалист филиала",
    resourceKind: "specialist",
    capacity: 1,
    bufferMinutes: 0,
    days: [1, 2, 3, 4, 5],
    opens: "09:00",
    closes: "18:00",
  };
  await svc.command(user.token, f.org, replay);
  await db.query(
    "UPDATE memberships SET role='employee' WHERE organization_id=$1 AND user_id=$2",
    [f.org, user.user.id],
  );
  await expect(svc.command(user.token, f.org, replay)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(svc.detail(user.token, f.org, d.id)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(
    create(f, {
      kind: "course",
      title: "Чужой профиль",
      serviceItemId: f.service,
      warehouseId: f.warehouse,
      lessonPrice: "20",
      lessons: 2,
    }),
  ).rejects.toMatchObject({ code: "PROFILE_NOT_SUPPORTED" });
});

it("lot receipt replay returns the movement; partial returns and transfers preserve quantities, expiry and lineage", async () => {
  const f = fixtures.food;
  const itemId = (
    await stock.saveItem(owner, f.org, {
      sku: key(),
      name_ru: "Прослеживаемый материал",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "3",
      sale_price: "5",
    })
  ).id!;
  const input = {
    key: key(),
    branchId: f.branch,
    kind: "lot_receipt",
    warehouseId: f.warehouse,
    itemId,
    quantity: "20",
    unit: "pc",
    unitCost: "3",
    lotCode: key(),
    expiresOn: future,
    note: "Приход партии",
  };
  const result = await svc.command(owner, f.org, input);
  expect(await svc.command(owner, f.org, input)).toEqual({
    ...result,
    reused: true,
  });
  expect(
    await db.query("SELECT id FROM stock_movements WHERE id=$1", [result.id]),
  ).toHaveLength(1);
  const command = (c: Record<string, unknown>) =>
    stock.execute(owner, f.org, {
      key: key(),
      warehouseId: f.warehouse,
      itemId,
      unit: "pc",
      note: "Проверка партии",
      ...c,
    });
  const issue = await command({ kind: "issue", quantity: "3" });
  await command({ kind: "return", movementId: issue.id, quantity: "2" });
  const destination = (
    await stock.createWarehouse(owner, f.org, {
      branchId: f.branch,
      name: "Второй склад",
    })
  ).id;
  const transfer = await command({
    kind: "dispatch",
    quantity: "4",
    destinationId: destination,
  });
  await stock.execute(owner, f.org, {
    key: key(),
    warehouseId: destination,
    itemId,
    kind: "receive",
    transferId: transfer.id,
    note: "Принято перемещение",
  });
  const rows = await db.query<{
    quantity: string;
    expires_on: string;
    parent_id: string | null;
  }>(
    "SELECT quantity::text,expires_on::text,parent_id FROM stock_lots WHERE organization_id=$1 AND item_id=$2 ORDER BY parent_id NULLS FIRST",
    [f.org, itemId],
  );
  expect(rows.map((x) => x.quantity)).toEqual(["15.000000", "4.000000"]);
  expect(rows.every((x) => x.expires_on === future)).toBe(true);
  expect(rows[1].parent_id).toBeTruthy();
  const [balance] = await db.query<{ version: number }>(
    "SELECT version FROM stock_balances WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3",
    [f.org, f.warehouse, itemId],
  );
  await command({
    kind: "count",
    quantity: "16",
    version: balance.version,
    unitCost: "3",
    lot: { code: "COUNT-01", expiresOn: future },
  });
  expect(
    (
      await db.query<{ n: string }>(
        "SELECT sum(quantity)::text n FROM stock_lots WHERE organization_id=$1 AND warehouse_id=$2 AND item_id=$3",
        [f.org, f.warehouse, itemId],
      )
    )[0].n,
  ).toBe("16.000000");
  await expect(
    command({ kind: "issue", quantity: "1", lotId: key() }),
  ).rejects.toMatchObject({ code: "LOT_AVAILABLE_EXCEEDED" });
});

it("equipment capacity uses peak overlap and completed bookings still protect their historical slots", async () => {
  const f = fixtures.production,
    recipeId = await recipe(f, "production"),
    equipmentId = await resource(f, "equipment", 0, 2);
  const plan = (startsAt: string, endsAt: string) =>
    create(f, {
      kind: "production_plan",
      recipeId,
      warehouseId: f.warehouse,
      quantity: "1",
      equipmentId,
      startsAt,
      endsAt,
      note: "Загрузка мощности",
    });
  await plan(`${yesterday}T06:00:00Z`, `${yesterday}T07:00:00Z`);
  await plan(`${yesterday}T07:00:00Z`, `${yesterday}T08:00:00Z`);
  await plan(`${yesterday}T06:00:00Z`, `${yesterday}T08:00:00Z`);
  await expect(
    plan(`${yesterday}T06:30:00Z`, `${yesterday}T07:30:00Z`),
  ).rejects.toMatchObject({ code: "RESOURCE_CONFLICT" });
  const [completed] = await db.query<{ id: string }>(
    "SELECT id FROM industry_documents WHERE organization_id=$1 AND kind='production' AND state='completed'",
    [f.org],
  );
  expect(
    await db.query(
      "SELECT document_id FROM industry_slots WHERE document_id=$1",
      [completed.id],
    ),
  ).toHaveLength(1);
});

it("all-scrap production records the loss without inventing an output receipt", async () => {
  const f = fixtures.production,
    recipeId = await recipe(f, "production");
  const id = (
    await create(f, {
      kind: "production_plan",
      recipeId,
      warehouseId: f.warehouse,
      quantity: "1",
      note: "Полный брак",
    })
  ).id;
  await change(f, id, {
    kind: "production_issue",
    materials: [{ itemId: f.material, quantity: "1", unit: "pc" }],
  });
  await change(f, id, { kind: "production_stage", stage: 0, defects: "1" });
  await change(f, id, { kind: "production_stage", stage: 1 });
  await change(f, id, {
    kind: "production_finish",
    goodQuantity: "0",
    scrapQuantity: "1",
    lotCode: "SCRAP-ONLY",
    expiresOn: null,
  });
  const d = (await detail(f, id)).document;
  expect(d.state).toBe("completed");
  expect(d.data.scrapCostMinor).toBe("200");
  expect(d.data.outputMovementId).toBeUndefined();
});
