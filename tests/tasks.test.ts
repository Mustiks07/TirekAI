import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { TaskService } from "../src/server/tasks/service";
import { taskDetail, taskList } from "../src/domain/tasks";

let db: Database,
  p: Platform,
  s: TaskService,
  org: string,
  branch: string,
  owner: string,
  manager: string,
  employee: string,
  employeeId: string,
  other: string,
  otherId: string,
  observer: string,
  outsider: string;
const key = () => randomUUID();
const png = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.from("synthetic photo evidence"),
]).toString("base64");
beforeAll(async () => {
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  s = new TaskService(db);
  const user = () =>
    p.register({
      name: `Task ${key().slice(0, 4)}`,
      email: `${key()}@example.test`,
      password: "Synthetic-Task-Password-661!",
    });
  const o = await user();
  owner = o.token;
  org = (
    await p.createOrganization(owner, { name: "Task Lab", profile: "retail" })
  ).id;
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
  const e = await join("employee");
  employee = e.token;
  employeeId = e.user.id;
  const e2 = await join("employee");
  other = e2.token;
  otherId = e2.user.id;
  observer = (await join("observer")).token;
  outsider = (await user()).token;
});
afterAll(async () => {
  await db?.close();
});
const detail = async (token: string, id: string) =>
  taskDetail.parse(JSON.parse(JSON.stringify(await s.get(token, org, id))));
const run = async (
  token: string,
  id: string,
  kind: string,
  extra: Record<string, unknown> = {},
) => {
  const version = (await detail(owner, id)).task.version;
  return s.command(token, org, id, { key: key(), version, kind, ...extra });
};
it("T021: assignment, checklist, photo evidence, return and independent verification keep history", async () => {
  const input = {
    key: key(),
    branchId: branch,
    title: "Принять поставку чая",
    description: "Проверить упаковки",
    kind: "receiving",
    priority: "high",
    assigneeId: employeeId,
    due: { date: "2030-01-01", time: "12:00" },
    requiresVerification: true,
    evidence: "photo",
    checklist: ["Пересчитать коробки", "Проверить сроки"],
  };
  const id = (await s.create(manager, org, input)).id;
  expect((await s.create(manager, org, input)).reused).toBe(true);
  await expect(
    s.create(manager, org, { ...input, title: "Changed payload" }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  let d = await detail(employee, id);
  expect(d.task).toMatchObject({ state: "assigned", overdue: false });
  expect(d.permissions).toMatchObject({ act: true, verify: false });
  await run(employee, id, "start");
  await expect(
    run(employee, id, "complete", { note: "Готово без чеклиста" }),
  ).rejects.toMatchObject({ code: "CHECKLIST_INCOMPLETE" });
  await run(employee, id, "check", { position: 0, done: true });
  await run(employee, id, "check", { position: 1, done: true });
  await expect(
    run(employee, id, "complete", { note: "Готово без фото" }),
  ).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED" });
  await expect(
    s.attach(employee, org, id, {
      key: key(),
      filename: "fake.png",
      content: Buffer.from("not an image").toString("base64"),
    }),
  ).rejects.toMatchObject({ code: "FILE_TYPE_UNSUPPORTED" });
  await s.attach(employee, org, id, {
    key: key(),
    filename: "boxes.png",
    content: png,
  });
  await run(employee, id, "complete", { note: "Коробки пересчитаны" });
  // The person who completed the work cannot accept it; the observer cannot either.
  await expect(
    run(employee, id, "verify", { note: "Self" }),
  ).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await run(manager, id, "return", { note: "Фото не читается" });
  d = await detail(employee, id);
  expect(d.task).toMatchObject({ state: "in_progress", completion: null });
  await run(employee, id, "complete", { note: "Новое фото приложено" });
  await run(owner, id, "verify", { note: "Проверено управляющим" });
  d = await detail(manager, id);
  expect(d.task.state).toBe("verified");
  expect(d.task.completion?.attachments).toHaveLength(1);
  expect(d.events.map((e) => e.kind)).toEqual([
    "created",
    "start",
    "check",
    "check",
    "attachment",
    "complete",
    "return",
    "complete",
    "verify",
  ]);
  const cmd = {
    key: key(),
    version: d.task.version,
    kind: "cancel",
    note: "Late",
  };
  await expect(s.command(owner, org, id, cmd)).rejects.toMatchObject({
    code: "TASK_STATE",
  });
  const events = await db.query<{ topic: string }>(
    "SELECT topic FROM domain_events WHERE entity_id=$1 ORDER BY created_at",
    [id],
  );
  expect(events.map((e) => e.topic)).toEqual(
    expect.arrayContaining([
      "task.created",
      "task.completed",
      "task.returned",
      "task.verified",
    ]),
  );
});
it("T021: visibility, roles and organization isolation are enforced on the server", async () => {
  const id = (
    await s.create(manager, org, {
      key: key(),
      branchId: branch,
      title: "Закрыть смену",
      assigneeId: employeeId,
    })
  ).id;
  await expect(s.get(other, org, id)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(
    taskList
      .parse(JSON.parse(JSON.stringify(await s.list(other, org, {}))))
      .items.some((t) => t.id === id),
  ).toBe(false);
  await expect(s.get(outsider, org, id)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(
    s.create(observer, org, { key: key(), branchId: branch, title: "Нельзя" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  // Another employee cannot act on a task assigned to someone else.
  await expect(run(other, id, "start")).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(
    s.create(manager, org, {
      key: key(),
      branchId: branch,
      title: "Чужой исполнитель",
      assigneeId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "ASSIGNEE_SCOPE" });
  await expect(
    s.create(manager, org, {
      key: key(),
      branchId: branch,
      title: "Ссылка на чужой заказ",
      links: [{ type: "purchase_order", id: randomUUID() }],
    }),
  ).rejects.toMatchObject({ code: "LINK_NOT_FOUND" });
});
it("T021: operation evidence must point to an operation that actually reached a result state", async () => {
  const id = (
    await s.create(manager, org, {
      key: key(),
      branchId: branch,
      title: "Проверить по операции",
      assigneeId: employeeId,
      evidence: "operation",
    })
  ).id;
  await run(employee, id, "start");
  await expect(
    run(employee, id, "complete", { note: "Без операции" }),
  ).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED" });
  await expect(
    run(employee, id, "complete", {
      note: "Несуществующая операция",
      operation: { type: "purchase_order", id: randomUUID() },
    }),
  ).rejects.toMatchObject({ code: "EVIDENCE_NOT_MET" });
});
it("T021: periodic templates create one task per local day and stop when the author loses rights", async () => {
  const tpl = (
    await s.createTemplate(manager, org, {
      key: key(),
      branchId: branch,
      name: "Открытие смены",
      kind: "shift_open",
      checklist: ["Касса", "Витрина"],
      requiresVerification: false,
      evidence: "comment",
      priority: "normal",
      assigneeId: employeeId,
      deputyId: null,
      recurrence: "daily",
      dueTime: "09:30",
      weekday: null,
    })
  ).id;
  const before = await db.query("SELECT id FROM tasks WHERE template_id=$1", [
    tpl,
  ]);
  await s.generatePeriodic();
  await s.generatePeriodic();
  const created = await db.query<{ recurrence_key: string }>(
    "SELECT recurrence_key FROM tasks WHERE template_id=$1",
    [tpl],
  );
  expect(created).toHaveLength(before.length + 1);
  // The manager who authored the template is removed: the schedule is suspended, not executed.
  const ws = await p.workspace(owner, org);
  const managerMember = ws.members.find((m) => m.role === "manager")!;
  await p.removeMember(owner, org, managerMember.id);
  // Simulate the next business day: yesterday's task keeps its own recurrence key.
  await db.query(
    "UPDATE tasks SET recurrence_key=recurrence_key||':previous' WHERE template_id=$1",
    [tpl],
  );
  await s.generatePeriodic();
  const [row] = await db.query<{ active: boolean }>(
    "SELECT active FROM task_templates WHERE id=$1",
    [tpl],
  );
  expect(row.active).toBe(false);
  expect(
    await db.query("SELECT id FROM tasks WHERE template_id=$1", [tpl]),
  ).toHaveLength(1);
});
it("T021: overdue tasks escalate once to the deputy within working hours", async () => {
  await s.saveSchedule(owner, org, {
    version: 0,
    startTime: "00:00",
    endTime: "23:59",
    days: [1, 2, 3, 4, 5, 6, 7],
    escalateAfterMinutes: 0,
  });
  const id = (
    await s.create(owner, org, {
      key: key(),
      branchId: branch,
      title: "Просроченная задача",
      assigneeId: employeeId,
      deputyId: otherId,
      due: { date: "2020-01-01", time: "09:00" },
    })
  ).id;
  // Before escalation the deputy sees the task but cannot act on it.
  await expect(run(other, id, "start")).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(await s.escalate()).toBeGreaterThanOrEqual(1);
  expect(await s.escalate()).toBe(0);
  const d = await detail(other, id);
  expect(d.task.escalated_at).not.toBeNull();
  expect(d.task.overdue).toBe(true);
  expect(d.permissions.act).toBe(true);
  await run(other, id, "start");
  const notes = await s.notifications(other, org);
  expect(notes.items.some((n) => n.kind === "task.escalated")).toBe(true);
  expect(
    await db.query(
      "SELECT id FROM domain_events WHERE topic='task.overdue' AND entity_id=$1",
      [id],
    ),
  ).toHaveLength(1);
});
