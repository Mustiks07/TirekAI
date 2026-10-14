import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { InventoryService } from "../src/server/inventory/service";
import { PurchasingService } from "../src/server/purchasing/service";
import { TaskService } from "../src/server/tasks/service";
import { InsightService } from "../src/server/decisions/insights";
import { AutomationService } from "../src/server/automations/service";
import { ExecutionWorker } from "../src/server/jobs/execution-worker";
import { ruleDetail, executionList } from "../src/domain/automations";

let db: Database,
  p: Platform,
  a: AutomationService,
  tasks: TaskService,
  org: string,
  branch: string,
  warehouse: string,
  owner: string,
  manager: string,
  buyerId: string,
  employeeId: string,
  employeeMember: string;
const key = () => randomUUID();
beforeAll(async () => {
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  a = new AutomationService(db);
  tasks = new TaskService(db);
  const user = () =>
    p.register({
      name: `Auto ${key().slice(0, 4)}`,
      email: `${key()}@example.test`,
      password: "Synthetic-Automation-661!",
    });
  owner = (await user()).token;
  org = (await p.createOrganization(owner, { name: "Auto", profile: "retail" }))
    .id;
  branch = (await p.workspace(owner, org)).branches[0].id;
  const join = async (role: string) => {
    const u = await user(),
      i = await p.invite(owner, org, {
        email: u.user.email,
        role,
        branchId: branch,
      });
    await p.acceptInvitation(u.token, { token: i.token });
    return u;
  };
  manager = (await join("manager")).token;
  buyerId = (await join("purchasing")).user.id;
  employeeId = (await join("employee")).user.id;
  employeeMember = (await p.workspace(owner, org)).members.find(
    (m) => m.user_id === employeeId,
  )!.id;
  warehouse = (
    await new InventoryService(db).createWarehouse(owner, org, {
      branchId: branch,
      name: "Main",
    })
  ).id;
});
afterAll(async () => {
  await db?.close();
});
const rule = async (
  token: string,
  name: string,
  definition: Record<string, unknown>,
) => {
  const id = (
    await a.create(token, org, {
      key: key(),
      branchId: branch,
      name,
      definition,
      note: "Создано для теста",
    })
  ).id;
  return id;
};
const version = async (id: string) =>
  ruleDetail.parse(JSON.parse(JSON.stringify(await a.get(owner, org, id)))).rule
    .version;
const activate = async (
  token: string,
  id: string,
  sample: { topic: string; payload: Record<string, unknown> },
) => {
  await expect(
    a.command(token, org, id, {
      key: key(),
      version: await version(id),
      kind: "activate",
      note: "Включить",
    }),
  ).rejects.toMatchObject({ code: "RULE_NOT_TESTED" });
  const t = await a.test(token, org, id, { sample });
  expect(t.passed).toBe(true);
  await a.command(token, org, id, {
    key: key(),
    version: await version(id),
    kind: "activate",
    note: "Проверено",
  });
};
const drain = async () => {
  const w = new ExecutionWorker(db);
  for (let i = 0; i < 6; i++) await w.runOnce();
};
it("T025: a tested rule turns a low-stock situation into one task; redelivery and repeated ticks do not duplicate it", async () => {
  const id = await rule(manager, "Нехватка → задача", {
    trigger: { type: "event", topic: "insight.opened" },
    conditions: [{ field: "rule", op: "eq", value: "low_stock" }],
    actions: [
      {
        type: "create_task",
        title: "Проверить нехватку",
        kind: "purchase",
        assigneeId: buyerId,
        dueInHours: 4,
      },
      { type: "propose_purchase" },
    ],
  });
  // A failing dry-run (wrong topic) does not unlock activation.
  const failed = await a.test(manager, org, id, {
    sample: { topic: "task.created", payload: {} },
  });
  expect(failed).toMatchObject({ passed: false, matched: false });
  await activate(manager, id, {
    topic: "insight.opened",
    payload: { rule: "low_stock", entityId: key() },
  });
  const inv = new InventoryService(db),
    pur = new PurchasingService(db);
  const sku = (
    await inv.saveItem(owner, org, {
      sku: "AUTO-1",
      name_ru: "Товар",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "0",
      sale_price: "5",
    })
  ).id!;
  const supplier = (
    await pur.createSupplier(owner, org, {
      key: key(),
      name: "Supplier Auto",
      contact: "contact",
      paymentTerms: "terms",
      quality: 4,
      reliability: 4,
    })
  ).id;
  await pur.createOffer(owner, org, {
    key: key(),
    supplierId: supplier,
    itemId: sku,
    supplierSku: "S-1",
    packQuantity: "1",
    baseUnit: "pc",
    packPrice: "5",
    minimumPacks: 1,
    delivery: "0",
    leadDays: 1,
    currency: "KZT",
    rate: null,
    rateDate: null,
    rateSource: "",
    tax: "included",
    taxPercent: null,
    dated: "2026-01-01",
    validUntil: "2030-12-31",
    characteristicsConfirmed: true,
    note: "Offer",
  });
  await new InsightService(db).setReorderPoint(owner, org, {
    warehouseId: warehouse,
    itemId: sku,
    minimum: "5",
    safety: "0",
    leadDays: 1,
    version: 0,
  });
  await drain();
  const created = await db.query<{
    id: string;
    links: { type: string }[];
    due_at: string | null;
  }>(
    "SELECT id,links,due_at FROM tasks WHERE organization_id=$1 AND source='automation'",
    [org],
  );
  expect(created).toHaveLength(1);
  expect(created[0].links[0].type).toBe("insight");
  expect(created[0].due_at).not.toBeNull();
  const proposals = await db.query<{ state: string; origin: string }>(
    "SELECT state,origin FROM action_proposals WHERE organization_id=$1",
    [org],
  );
  // Automation proposes; approval of the amount stays with a person.
  expect(proposals).toEqual([{ state: "pending", origin: "automation" }]);
  await db.query(
    "UPDATE domain_events SET dispatched_at=NULL WHERE organization_id=$1",
    [org],
  );
  await drain();
  expect(
    await db.query(
      "SELECT id FROM tasks WHERE organization_id=$1 AND source='automation'",
      [org],
    ),
  ).toHaveLength(1);
  const log = executionList.parse(
    JSON.parse(JSON.stringify(await a.executions(owner, org, { ruleId: id }))),
  );
  expect(log.items.filter((x) => x.state === "succeeded")).toHaveLength(1);
});
it("T025: two rules that react to each other stop at the depth limit with a visible reason", async () => {
  const def = (title: string) => ({
    trigger: { type: "event", topic: "task.created" },
    conditions: [
      { field: "source", op: "in", value: ["manual", "automation"] },
    ],
    actions: [{ type: "create_task", title }],
    limits: { maxPerHour: 100, maxDepth: 2 },
  });
  const r1 = await rule(owner, "Цикл A", def("Ответ A"));
  const r2 = await rule(owner, "Цикл B", def("Ответ B"));
  for (const id of [r1, r2])
    await activate(owner, id, {
      topic: "task.created",
      payload: { source: "manual" },
    });
  await tasks.create(owner, org, {
    key: key(),
    branchId: branch,
    title: "Исходная задача",
  });
  await drain();
  const generated = await db.query(
    "SELECT id FROM tasks WHERE organization_id=$1 AND title LIKE 'Ответ%'",
    [org],
  );
  expect(generated).toHaveLength(6);
  const skipped = await db.query<{ skip_reason: string }>(
    "SELECT skip_reason FROM automation_executions WHERE rule_id=ANY($1::uuid[]) AND state='skipped'",
    [[r1, r2]],
  );
  expect(skipped.length).toBeGreaterThan(0);
  expect(skipped.every((s) => s.skip_reason === "depth_limit")).toBe(true);
  for (const id of [r1, r2])
    await a.command(owner, org, id, {
      key: key(),
      version: await version(id),
      kind: "disable",
      note: "Цикл проверен",
    });
});
it("T025: a crashed worker's lease is fenced and the restarted worker acts exactly once", async () => {
  const id = await rule(owner, "Проверка перезапуска", {
    trigger: { type: "event", topic: "task.completed" },
    actions: [{ type: "create_task", title: "После выполнения" }],
  });
  await activate(owner, id, { topic: "task.completed", payload: {} });
  const t = (
    await tasks.create(owner, org, {
      key: key(),
      branchId: branch,
      title: "Работа",
      assigneeId: employeeId,
    })
  ).id;
  const v = async () => (await tasks.get(owner, org, t)).task.version;
  await tasks.command(owner, org, t, {
    key: key(),
    version: await v(),
    kind: "start",
  });
  await tasks.command(owner, org, t, {
    key: key(),
    version: await v(),
    kind: "complete",
    note: "Готово",
  });
  await a.dispatch();
  const stale = (await a.claim())!;
  // The worker dies; its lease expires; another worker reclaims and finishes the execution.
  await db.query(
    "UPDATE automation_executions SET lease_until=now()-interval '1 second' WHERE id=$1",
    [stale.id],
  );
  const fresh = (await a.claim())!;
  expect(fresh.id).toBe(stale.id);
  expect(await a.process(fresh)).toBe("succeeded");
  expect(await a.process(stale)).toBe("fenced");
  expect(
    await db.query(
      "SELECT id FROM tasks WHERE organization_id=$1 AND title='После выполнения'",
      [org],
    ),
  ).toHaveLength(1);
});
it("T025: business failures go to manual review, revoked author rights pause the rule, revisions need a new test", async () => {
  const id = await rule(manager, "Уведомить сотрудника", {
    trigger: { type: "event", topic: "knowledge.published" },
    actions: [
      {
        type: "create_task",
        title: "Прочитать инструкцию",
        assigneeId: employeeId,
      },
    ],
  });
  await activate(manager, id, { topic: "knowledge.published", payload: {} });
  // The assignee leaves: task creation is refused, the execution is parked for manual review.
  await p.removeMember(owner, org, employeeMember);
  const { KnowledgeService } = await import("../src/server/knowledge/service");
  const k = new KnowledgeService(db);
  const doc = (
    await k.create(owner, org, {
      key: key(),
      branchId: null,
      title: "Инструкция",
      category: "Общее",
      body: "Текст",
      changeNote: "Новая",
    })
  ).id;
  await k.publish(owner, org, doc, { key: key(), version: 1, number: 1 });
  await drain();
  let log = executionList.parse(
    JSON.parse(JSON.stringify(await a.executions(owner, org, { ruleId: id }))),
  );
  expect(log.items[0]).toMatchObject({
    state: "dead",
    error_code: "ASSIGNEE_SCOPE",
  });
  await a.retry(owner, org, log.items[0].id, {
    key: key(),
    version: log.items[0].version,
    kind: "retry",
  });
  log = executionList.parse(
    JSON.parse(JSON.stringify(await a.executions(owner, org, { ruleId: id }))),
  );
  expect(log.items[0].state).toBe("queued");
  // Revision of an active rule pauses it until the new version is tested.
  await a.revise(owner, org, id, {
    key: key(),
    version: await version(id),
    definition: {
      trigger: { type: "event", topic: "knowledge.published" },
      actions: [{ type: "create_task", title: "Прочитать новую инструкцию" }],
    },
    note: "Без исполнителя",
  });
  const d = ruleDetail.parse(
    JSON.parse(JSON.stringify(await a.get(owner, org, id))),
  );
  expect(d.rule).toMatchObject({
    state: "paused",
    current_version: 2,
    tested_version: 1,
  });
  // The author (manager) loses rights: the next execution is skipped and the rule paused.
  await a.test(owner, org, id, {
    sample: { topic: "knowledge.published", payload: {} },
  });
  await a.command(owner, org, id, {
    key: key(),
    version: await version(id),
    kind: "activate",
    note: "Снова",
  });
  const managerMember = (await p.workspace(owner, org)).members.find(
    (m) => m.role === "manager",
  )!;
  await p.removeMember(owner, org, managerMember.id);
  await drain();
  const after = ruleDetail.parse(
    JSON.parse(JSON.stringify(await a.get(owner, org, id))),
  );
  expect(after.rule).toMatchObject({
    state: "paused",
    paused_reason: "ACCESS_REVOKED",
  });
});
