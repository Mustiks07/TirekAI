import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { KnowledgeService } from "../src/server/knowledge/service";
import { knowledgeDetail, knowledgeSearch } from "../src/domain/knowledge";

let db: Database,
  p: Platform,
  k: KnowledgeService,
  org: string,
  otherOrg: string,
  branch: string,
  branch2: string,
  owner: string,
  employee: string,
  branchManager: string,
  otherOwner: string;
const key = () => randomUUID();
beforeAll(async () => {
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  k = new KnowledgeService(db);
  const user = () =>
    p.register({
      name: "Knowledge",
      email: `${key()}@example.test`,
      password: "Synthetic-Knowledge-661!",
    });
  owner = (await user()).token;
  org = (await p.createOrganization(owner, { name: "Know", profile: "food" }))
    .id;
  branch = (await p.workspace(owner, org)).branches[0].id;
  branch2 = (await p.createBranch(owner, org, { name: "Второй" })).id;
  const join = async (role: string, b: string) => {
    const u = await user(),
      i = await p.invite(owner, org, {
        email: u.user.email,
        role,
        branchId: b,
      });
    await p.acceptInvitation(u.token, { token: i.token });
    return u.token;
  };
  employee = await join("employee", branch);
  branchManager = await join("manager", branch2);
  otherOwner = (await user()).token;
  otherOrg = (
    await p.createOrganization(otherOwner, { name: "Other", profile: "food" })
  ).id;
});
afterAll(async () => {
  await db?.close();
});
const search = async (token: string, o: string, q: string) =>
  knowledgeSearch.parse(
    JSON.parse(JSON.stringify(await k.search(token, o, { q }))),
  );
it("T022: drafts stay private, publication is explicit and a new published version replaces the cited one", async () => {
  const id = (
    await k.create(owner, org, {
      key: key(),
      branchId: null,
      title: "Приёмка молока",
      category: "Склад",
      body: "Проверить температуру не выше 6 градусов. Ресми емес нұсқа.",
      changeNote: "Первая редакция",
    })
  ).id;
  expect((await search(employee, org, "температуру")).items).toHaveLength(0);
  await expect(k.get(employee, org, id)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await k.publish(owner, org, id, { key: key(), version: 1, number: 1 });
  let hits = (await search(employee, org, "температуру")).items;
  expect(hits).toMatchObject([{ document_id: id, version: 1, stale: false }]);
  await k.revise(owner, org, id, {
    key: key(),
    version: 2,
    title: "Приёмка молока",
    body: "Температура не выше 4 градусов, сверить партию.",
    changeNote: "Новый стандарт",
    reviewDue: "2020-01-01",
  });
  // Until publication the employee still sees version 1.
  let d = knowledgeDetail.parse(
    JSON.parse(JSON.stringify(await k.get(employee, org, id))),
  );
  expect(d.current?.number).toBe(1);
  expect(d.versions).toHaveLength(0);
  await k.publish(owner, org, id, { key: key(), version: 3, number: 2 });
  hits = (await search(employee, org, "партию")).items;
  expect(hits).toMatchObject([{ version: 2, stale: true }]);
  expect((await search(employee, org, "6 градусов")).items).toHaveLength(0);
  d = knowledgeDetail.parse(
    JSON.parse(JSON.stringify(await k.get(owner, org, id))),
  );
  expect(d.versions.map((v) => v.number)).toEqual([2, 1]);
  await expect(
    k.revise(owner, org, id, {
      key: key(),
      version: 3,
      title: "Stale",
      body: "Stale edit",
      changeNote: "Old version",
      reviewDue: null,
    }),
  ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
});
it("T022: documents of another organization, branch or audience never appear in search", async () => {
  const foreign = (
    await k.create(otherOwner, otherOrg, {
      key: key(),
      branchId: null,
      title: "Секретная инструкция",
      category: "Касса",
      body: "Код сейфа другой организации",
      changeNote: "Чужая организация",
    })
  ).id;
  await k.publish(otherOwner, otherOrg, foreign, {
    key: key(),
    version: 1,
    number: 1,
  });
  expect((await search(owner, org, "сейфа")).items).toHaveLength(0);
  await expect(k.get(owner, org, foreign)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  const branchDoc = (
    await k.create(branchManager, org, {
      key: key(),
      branchId: branch2,
      title: "Закрытие второго филиала",
      category: "Смена",
      body: "Только второй филиал: опломбировать кассу",
      changeNote: "Филиальная",
    })
  ).id;
  await k.publish(branchManager, org, branchDoc, {
    key: key(),
    version: 1,
    number: 1,
  });
  expect((await search(employee, org, "опломбировать")).items).toHaveLength(0);
  expect((await search(owner, org, "опломбировать")).items).toHaveLength(1);
  // A branch-scoped manager cannot create organization-wide instructions.
  await expect(
    k.create(branchManager, org, {
      key: key(),
      branchId: null,
      title: "Для всех",
      category: "Общее",
      body: "Текст",
      changeNote: "Попытка",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  const finance = (
    await k.create(owner, org, {
      key: key(),
      branchId: null,
      title: "Платёжный календарь",
      category: "Финансы",
      audience: ["owner", "finance"],
      body: "Порядок согласования платежей поставщикам",
      changeNote: "Для финансов",
    })
  ).id;
  await k.publish(owner, org, finance, { key: key(), version: 1, number: 1 });
  expect(
    (await search(employee, org, "согласования платежей")).items,
  ).toHaveLength(0);
  await expect(
    k.create(employee, org, {
      key: key(),
      branchId: branch,
      title: "Нельзя",
      category: "Нет",
      body: "Нет прав",
      changeNote: "Попытка",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("T022: uploaded text keeps the original and rejects disguised binaries", async () => {
  const id = (
    await k.upload(owner, org, {
      key: key(),
      branchId: branch,
      title: "Возврат товара",
      category: "Продажи",
      changeNote: "Загружено",
      filename: "returns.md",
      content: Buffer.from("# Возврат\nПринять товар только с чеком.").toString(
        "base64",
      ),
    })
  ).id;
  const original = await k.original(owner, org, id, 1);
  expect(Buffer.from(original.content, "base64").toString()).toContain("чеком");
  await expect(
    k.upload(owner, org, {
      key: key(),
      branchId: branch,
      title: "Бинарный",
      category: "Плохой",
      changeNote: "Попытка",
      filename: "binary.txt",
      content: Buffer.from([0, 1, 2, 3, 0x7f, 0x45, 0x4c, 0x46]).toString(
        "base64",
      ),
    }),
  ).rejects.toMatchObject({ code: "FILE_TYPE_UNSUPPORTED" });
});
