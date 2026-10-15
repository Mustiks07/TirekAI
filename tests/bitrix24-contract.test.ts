import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { CrmService } from "../src/server/crm/service";
import { Bitrix24Service } from "../src/server/integrations/bitrix24-service";
import { validWebhookUrl } from "../src/server/integrations/bitrix24";

// Local contract server built from the documented Bitrix24 REST shapes (crm.item.list/get with
// entityTypeId=3, pages of 50 with next/total, error bodies {error,error_description}, 503
// QUERY_LIMIT_EXCEEDED, 429 OPERATION_TIME_LIMIT, 401 INVALID_CREDENTIALS). Not a live portal.
const PORTAL = "https://lab-taraz.bitrix24.kz",
  CODE = "a1b2c3d4e5f6g7h8",
  WEBHOOK = `${PORTAL}/rest/1/${CODE}/`,
  APP_TOKEN = "51856fefc120afa4b628cc82d3935cce";
type C = {
  id: number;
  name: string;
  lastName: string;
  updatedTime: string;
  email: string;
  phone: string;
};
const state = {
  contacts: [] as C[],
  fail: { rate: 0, time: false },
  requests: [] as string[],
};
let server: Server, base: string;
const item = (c: C) => ({
  id: c.id,
  name: c.name,
  lastName: c.lastName,
  secondName: null,
  updatedTime: c.updatedTime,
  fm: [
    ...(c.email
      ? [{ id: c.id * 10, typeId: "EMAIL", valueType: "WORK", value: c.email }]
      : []),
    ...(c.phone
      ? [
          {
            id: c.id * 10 + 1,
            typeId: "PHONE",
            valueType: "WORK",
            value: c.phone,
          },
        ]
      : []),
  ],
});
const fetcher = ((url: string | URL | Request, init?: RequestInit) =>
  fetch(String(url).replace(PORTAL, base), init)) as typeof fetch;
let db: Database,
  p: Platform,
  org: string,
  branch: string,
  owner: string,
  manager: string,
  svc: Bitrix24Service,
  connection: string,
  inbound: string;
const key = () => randomUUID();
beforeAll(async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const m = /^\/rest\/(\d+)\/([A-Za-z0-9]+)\/([a-z.]+)\.json$/.exec(
        req.url || "",
      );
      state.requests.push(`${req.method} ${m?.[3] || req.url}`);
      if (!m || req.method !== "POST")
        return send(404, { error: "ERROR_METHOD_NOT_FOUND" });
      if (m[2] !== CODE)
        return send(401, {
          error: "INVALID_CREDENTIALS",
          error_description: "Invalid request credentials",
        });
      if (state.fail.rate > 0) {
        state.fail.rate--;
        return send(503, {
          error: "QUERY_LIMIT_EXCEEDED",
          error_description: "Too many requests",
        });
      }
      if (state.fail.time) {
        state.fail.time = false;
        return send(429, {
          error: "OPERATION_TIME_LIMIT",
          error_description: "Method is blocked",
        });
      }
      const body = JSON.parse(raw || "{}");
      if (m[3] === "profile")
        return send(200, { result: { ID: "1", NAME: "Админ" } });
      if (m[3] === "crm.item.list") {
        if (body.entityTypeId !== 3) return send(400, { error: "NOT_FOUND" });
        const from = body.filter?.[">=updatedTime"];
        const rows = state.contacts
          .filter((c) => !from || new Date(c.updatedTime) >= new Date(from))
          .sort(
            (a, b) => a.updatedTime.localeCompare(b.updatedTime) || a.id - b.id,
          );
        const start = Number(body.start || 0),
          page = rows.slice(start, start + 50);
        return send(200, {
          result: { items: page.map(item) },
          total: rows.length,
          ...(start + 50 < rows.length ? { next: start + 50 } : {}),
          time: { start: 0, finish: 0, duration: 0.01 },
        });
      }
      if (m[3] === "crm.item.get") {
        const c = state.contacts.find((x) => x.id === Number(body.id));
        return c
          ? send(200, { result: { item: item(c) } })
          : send(400, {
              error: "NOT_FOUND",
              error_description: "Item not found",
            });
      }
      send(404, { error: "ERROR_METHOD_NOT_FOUND" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (let i = 1; i <= 120; i++)
    state.contacts.push({
      id: i,
      name: `Клиент${i}`,
      lastName: "Тестов",
      updatedTime: `2026-10-01T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}+05:00`,
      email:
        i === 5
          ? "local@example.test"
          : i === 6
            ? "not-an-email"
            : `c${i}@example.test`,
      phone: i % 2 ? `+7700000${String(i).padStart(4, "0")}` : "",
    });
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  const user = () =>
    p.register({
      name: "B24",
      email: `${key()}@example.test`,
      password: "Synthetic-Bitrix-661!",
    });
  owner = (await user()).token;
  org = (
    await p.createOrganization(owner, { name: "B24 Lab", profile: "retail" })
  ).id;
  branch = (await p.workspace(owner, org)).branches[0].id;
  const u = await user(),
    inv = await p.invite(owner, org, {
      email: u.user.email,
      role: "manager",
      branchId: branch,
    });
  await p.acceptInvitation(u.token, { token: inv.token });
  manager = u.token;
  // A local customer with the same e-mail as contact 5 must not be merged silently.
  await new CrmService(db).createCustomer(owner, org, {
    key: key(),
    branchId: branch,
    name: "Локальный клиент",
    email: "local@example.test",
    phone: "",
    kind: "person",
    responsibleId: null,
    consents: { email: true, sms: false, messenger: false },
    consentNote: "Согласие получено лично",
  });
  svc = Bitrix24Service.forContractServer(db, fetcher, async () => {});
});
afterAll(async () => {
  await db?.close();
  await new Promise((r) => server.close(r));
});
it("T031: only cloud HTTPS webhook URLs, only the owner, credentials sealed, contract check is not live", async () => {
  for (const bad of [
    "http://lab.bitrix24.kz/rest/1/a1b2c3d4e5f6/",
    "https://crm.example.local/rest/1/a1b2c3d4e5f6/",
    "https://10.0.0.5/rest/1/a1b2c3d4e5f6/",
    "https://lab.bitrix24.kz.evil.test/rest/1/a1b2c3d4e5f6/",
  ])
    expect(validWebhookUrl(bad)).toBe(false);
  await expect(
    svc.configure(owner, org, {
      key: key(),
      webhookUrl: "https://intranet.local/rest/1/a1b2c3d4e5f6/",
      applicationToken: null,
      branchId: branch,
    }),
  ).rejects.toMatchObject({ code: "BITRIX24_URL_INVALID" });
  await expect(
    svc.configure(manager, org, {
      key: key(),
      webhookUrl: WEBHOOK,
      applicationToken: APP_TOKEN,
      branchId: branch,
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  const saved = await svc.configure(owner, org, {
    key: key(),
    webhookUrl: WEBHOOK,
    applicationToken: APP_TOKEN,
    branchId: branch,
  });
  connection = saved.id;
  inbound = saved.webhookToken!;
  const [row] = await db.query<{
    credentials: Uint8Array;
    credentials_hint: string;
  }>(
    "SELECT credentials,credentials_hint FROM integration_connections WHERE id=$1",
    [connection],
  );
  const stored = Buffer.from(row.credentials).toString("utf8");
  expect(stored).not.toContain(CODE);
  expect(stored).not.toContain(APP_TOKEN);
  expect(row.credentials_hint).toBe("lab-taraz.bitrix24.kz");
  await svc.check(owner, org, connection);
  const [c] = await db.query<{
    status: string;
    verification: { scope: string };
  }>("SELECT status,verification FROM integration_connections WHERE id=$1", [
    connection,
  ]);
  expect(c).toMatchObject({
    status: "configured",
    verification: { scope: "contract_server" },
  });
});
it("T031: initial import pages by start/next, retries 503 rate limits, never merges duplicates and is idempotent", async () => {
  state.fail.rate = 2;
  const stats = await svc.syncNow(owner, org, connection);
  expect(stats).toMatchObject({ created: 119, conflicts: 1 });
  expect(
    state.requests.filter((r) => r.endsWith("crm.item.list")).length,
  ).toBeGreaterThanOrEqual(3);
  const [dup] = await db.query<{ reason: string; external_id: string }>(
    "SELECT reason,external_id FROM sync_conflicts WHERE connection_id=$1",
    [connection],
  );
  expect(dup).toEqual({ reason: "possible_duplicate", external_id: "5" });
  const imported = await db.query<{
    email: string;
    consents: Record<string, boolean>;
    external_id: string;
  }>(
    "SELECT email,consents,external_id FROM customers WHERE organization_id=$1 AND external_id LIKE 'bitrix24:%' ORDER BY external_id",
    [org],
  );
  expect(imported).toHaveLength(119);
  // Imported people get no marketing consent; an invalid e-mail is dropped, not stored.
  expect(
    imported.every((x) => !x.consents.email && !x.consents.messenger),
  ).toBe(true);
  expect(imported.find((x) => x.external_id === "bitrix24:6")!.email).toBe("");
  const again = await svc.syncNow(owner, org, connection);
  expect(again.created || 0).toBe(0);
  expect(
    (
      await db.query(
        "SELECT id FROM customers WHERE organization_id=$1 AND external_id LIKE 'bitrix24:%'",
        [org],
      )
    ).length,
  ).toBe(119);
});
it("T031: a local edit is kept until a person decides; the remote version can then be taken", async () => {
  const crm = new CrmService(db);
  const [m] = await db.query<{ internal_id: string }>(
    "SELECT internal_id FROM integration_mappings WHERE connection_id=$1 AND entity_type='contact' AND external_id='10'",
    [connection],
  );
  const [local] = await db.query<{ version: number }>(
    "SELECT version FROM customers WHERE id=$1",
    [m.internal_id],
  );
  await crm.profile(owner, org, m.internal_id, {
    key: key(),
    version: local.version,
    name: "Исправлено у нас",
    email: "c10@example.test",
    phone: "",
    kind: "person",
    responsibleId: null,
    consents: { email: false, sms: false, messenger: false },
    consentNote: "Правка менеджера",
  });
  const remote = state.contacts.find((c) => c.id === 10)!;
  remote.lastName = "Изменён";
  remote.updatedTime = "2026-10-02T09:00:00+05:00";
  await svc.syncNow(owner, org, connection);
  let [c] = await db.query<{ name: string }>(
    "SELECT name FROM customers WHERE id=$1",
    [m.internal_id],
  );
  expect(c.name).toBe("Исправлено у нас");
  const [x] = await db.query<{ id: string }>(
    "SELECT id FROM sync_conflicts WHERE connection_id=$1 AND reason='local_modified' AND state='open'",
    [connection],
  );
  await svc.resolve(owner, org, x.id, { key: key(), decision: "took_remote" });
  [c] = await db.query<{ name: string }>(
    "SELECT name FROM customers WHERE id=$1",
    [m.internal_id],
  );
  expect(c.name).toBe("Клиент10 Изменён");
});
it("T031: events need the path token and the application token, deduplicate, re-read by id and record deletions", async () => {
  const event = (
    id: number,
    name = "ONCRMCONTACTUPDATE",
    token = APP_TOKEN,
    ts = "1760500000",
  ) => ({
    event: name,
    event_handler_id: "12",
    data: { FIELDS: { ID: String(id) } },
    ts,
    auth: {
      domain: "lab-taraz.bitrix24.kz",
      member_id: "x",
      application_token: token,
    },
  });
  await expect(
    svc.receiveEvent(connection, "0".repeat(64), event(20)),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    svc.receiveEvent(
      connection,
      inbound,
      event(20, "ONCRMCONTACTUPDATE", "f".repeat(32)),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(
    await db.query("SELECT id FROM integration_inbox WHERE connection_id=$1", [
      connection,
    ]),
  ).toHaveLength(0);
  const c20 = state.contacts.find((c) => c.id === 20)!;
  c20.name = "Обновлён";
  c20.updatedTime = "2026-10-03T12:00:00+05:00";
  expect(await svc.receiveEvent(connection, inbound, event(20))).toEqual({
    accepted: true,
    duplicate: false,
  });
  expect(await svc.receiveEvent(connection, inbound, event(20))).toEqual({
    accepted: true,
    duplicate: true,
  });
  const before = state.requests.length;
  expect(await svc.processInbox()).toBe(1);
  expect(
    state.requests.slice(before).filter((r) => r.endsWith("crm.item.get")),
  ).toHaveLength(1);
  const [u] = await db.query<{ name: string }>(
    "SELECT name FROM customers WHERE organization_id=$1 AND external_id='bitrix24:20'",
    [org],
  );
  expect(u.name).toBe("Обновлён Тестов");
  await svc.receiveEvent(
    connection,
    inbound,
    event(21, "ONCRMCONTACTDELETE", APP_TOKEN, "1760500100"),
  );
  await svc.processInbox();
  const [m] = await db.query<{ state: string; internal_id: string }>(
    "SELECT state,internal_id FROM integration_mappings WHERE connection_id=$1 AND entity_type='contact' AND external_id='21'",
    [connection],
  );
  expect(m.state).toBe("deleted");
  const [kept] = await db.query<{ n: number }>(
    "SELECT count(*)::int n FROM crm_events WHERE customer_id=$1 AND kind='customer.external_deleted'",
    [m.internal_id],
  );
  expect(kept.n).toBe(1);
});
it("T031: time limit and auth errors are recorded as failures; disconnect erases the webhook", async () => {
  state.fail.time = true;
  await expect(svc.syncNow(owner, org, connection)).rejects.toMatchObject({
    code: "BITRIX24_OPERATION_TIME_LIMIT",
  });
  const [run] = await db.query<{ state: string; error_code: string }>(
    "SELECT state,error_code FROM sync_runs WHERE connection_id=$1 ORDER BY started_at DESC LIMIT 1",
    [connection],
  );
  expect(run).toEqual({
    state: "failed",
    error_code: "BITRIX24_OPERATION_TIME_LIMIT",
  });
  const bad = await svc.configure(owner, org, {
    key: key(),
    webhookUrl: `${PORTAL}/rest/1/wrongcode1234/`,
    applicationToken: null,
    branchId: branch,
  });
  expect(bad.id).toBe(connection);
  await expect(svc.check(owner, org, connection)).rejects.toMatchObject({
    code: "BITRIX24_AUTH_FAILED",
  });
  const [c] = await db.query<{ status: string }>(
    "SELECT status FROM integration_connections WHERE id=$1",
    [connection],
  );
  expect(c.status).toBe("degraded");
  await svc.disconnect(owner, org, connection);
  const [gone] = await db.query<{
    credentials: unknown;
    webhook_token_hash: unknown;
  }>(
    "SELECT credentials,webhook_token_hash FROM integration_connections WHERE id=$1",
    [connection],
  );
  expect(gone).toEqual({ credentials: null, webhook_token_hash: null });
  await expect(svc.syncNow(owner, org, connection)).rejects.toMatchObject({
    code: "INTEGRATION_NOT_CONFIGURED",
  });
});
