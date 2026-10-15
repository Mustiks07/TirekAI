import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { actorFromSession } from "../src/server/access";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  createMemoryDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { CrmService } from "../src/server/crm/service";
import { TelegramService } from "../src/server/integrations/telegram-service";

// Local server with the documented Bot API shapes (/bot<token>/<method>, {ok,result} or
// {ok:false,error_code,description,parameters.retry_after}). No real message is sent.
const TOKEN = "123456789:AAH-synthetic-token-for-contract-tests_0";
const state = {
  calls: [] as { method: string; body: Record<string, unknown> }[],
  next: [] as ("429" | "403" | "timeout")[],
};
let server: Server, base: string;
let db: Database,
  p: Platform,
  org: string,
  branch: string,
  owner: string,
  manager: string,
  seller: string,
  customer: string,
  svc: TelegramService,
  connection: string,
  path = "",
  header = "";
const key = () => randomUUID();
const update = (id: number, text: string, chat = 555) => ({
  update_id: id,
  message: {
    message_id: id * 10,
    date: 1760500000,
    chat: { id: chat, type: "private" },
    from: { id: chat, is_bot: false, first_name: "Айгерим" },
    text,
  },
});
beforeAll(async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url || "");
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (!m || m[1] !== TOKEN)
        return send(401, {
          ok: false,
          error_code: 401,
          description: "Unauthorized",
        });
      const body = JSON.parse(raw || "{}");
      state.calls.push({ method: m[2], body });
      if (m[2] === "getMe")
        return send(200, {
          ok: true,
          result: { id: 123456789, is_bot: true, username: "taraz_lab_bot" },
        });
      if (m[2] === "setWebhook") return send(200, { ok: true, result: true });
      if (m[2] === "sendMessage") {
        const fault = state.next.shift();
        if (fault === "429")
          return send(429, {
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 3 },
          });
        if (fault === "403")
          return send(403, {
            ok: false,
            error_code: 403,
            description: "Forbidden: bot was blocked by the user",
          });
        if (fault === "timeout") return req.socket.destroy();
        return send(200, {
          ok: true,
          result: {
            message_id: state.calls.length,
            chat: { id: body.chat_id },
          },
        });
      }
      send(404, { ok: false, error_code: 404, description: "Not Found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  db = await createMemoryDatabase();
  await migrate(db);
  p = new Platform(db);
  const user = () =>
    p.register({
      name: "TG",
      email: `${key()}@example.test`,
      password: "Synthetic-Telegram-661!",
    });
  owner = (await user()).token;
  org = (
    await p.createOrganization(owner, { name: "TG Lab", profile: "retail" })
  ).id;
  branch = (await p.workspace(owner, org)).branches[0].id;
  for (const role of ["manager", "sales"]) {
    const u = await user(),
      inv = await p.invite(owner, org, {
        email: u.user.email,
        role,
        branchId: branch,
      });
    await p.acceptInvitation(u.token, { token: inv.token });
    if (role === "manager") manager = u.token;
    else seller = u.token;
  }
  customer = (
    await new CrmService(db).createCustomer(owner, org, {
      key: key(),
      branchId: branch,
      name: "Айгерим",
      email: "",
      phone: "+77000000001",
      kind: "person",
      responsibleId: null,
      consents: { email: false, sms: false, messenger: false },
      consentNote: "Создано вручную",
    })
  ).id;
  svc = TelegramService.forContractServer(db, base);
});
afterAll(async () => {
  await db?.close();
  await new Promise((r) => server.close(r));
});
const consent = async () =>
  (
    await db.query<{ m: boolean }>(
      "SELECT (consents->>'messenger')::boolean m FROM customers WHERE id=$1",
      [customer],
    )
  )[0].m;
it("T034: bot token validated and sealed, owner only, getMe check, webhook needs public HTTPS and carries a secret header", async () => {
  await expect(
    svc.configure(owner, org, {
      key: key(),
      botToken: "not-a-token",
      branchId: branch,
    }),
  ).rejects.toMatchObject({
    code: "TELEGRAM_TOKEN_INVALID",
  });
  await expect(
    svc.configure(manager, org, {
      key: key(),
      botToken: TOKEN,
      branchId: branch,
    }),
  ).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  connection = (
    await svc.configure(owner, org, {
      key: key(),
      botToken: TOKEN,
      branchId: branch,
    })
  ).id;
  const [row] = await db.query<{ credentials: Uint8Array }>(
    "SELECT credentials FROM integration_connections WHERE id=$1",
    [connection],
  );
  expect(Buffer.from(row.credentials).toString("utf8")).not.toContain(TOKEN);
  await svc.check(owner, org, connection);
  const [c] = await db.query<{
    settings: { username: string; outbound: boolean };
    verification: { scope: string };
  }>("SELECT settings,verification FROM integration_connections WHERE id=$1", [
    connection,
  ]);
  expect(c).toMatchObject({
    settings: { username: "taraz_lab_bot", outbound: false },
    verification: { scope: "contract_server" },
  });
  await expect(
    svc.registerWebhook(owner, org, connection, "http://127.0.0.1:3000"),
  ).rejects.toMatchObject({
    code: "PUBLIC_HTTPS_REQUIRED",
  });
  await svc.registerWebhook(owner, org, connection, "https://app.example.kz");
  const set = state.calls.find((x) => x.method === "setWebhook")!.body as {
    url: string;
    secret_token: string;
    allowed_updates: string[];
  };
  expect(set.url).toMatch(
    new RegExp(
      `^https://app\\.example\\.kz/api/integrations/telegram/${connection}/[a-f0-9]{64}$`,
    ),
  );
  expect(set.allowed_updates).toEqual(["message"]);
  path = set.url.split("/").pop()!;
  header = set.secret_token;
});
it("T034: updates need the path and header secrets; /start with a staff code links the chat and records the customer's consent", async () => {
  await expect(
    svc.receiveUpdate(connection, path, "wrong-header", update(1, "hi")),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    svc.receiveUpdate(connection, path, null, update(1, "hi")),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(
    await db.query("SELECT id FROM integration_inbox WHERE connection_id=$1", [
      connection,
    ]),
  ).toHaveLength(0);
  await expect(
    svc.createLink(seller, org, connection, { customerId: customer }),
  ).resolves.toBeTruthy();
  const { code, link } = await svc.createLink(owner, org, connection, {
    customerId: customer,
  });
  expect(link).toBe(`https://t.me/taraz_lab_bot?start=${code}`);
  expect(
    await svc.receiveUpdate(
      connection,
      path,
      header,
      update(2, `/start ${code}`),
    ),
  ).toEqual({ accepted: true, duplicate: false });
  expect(
    await svc.receiveUpdate(
      connection,
      path,
      header,
      update(2, `/start ${code}`),
    ),
  ).toEqual({ accepted: true, duplicate: true });
  expect(await consent()).toBe(false);
  await svc.processInbox();
  expect(await consent()).toBe(true);
  const [ev] = await db.query<{ kind: string }>(
    "SELECT kind FROM crm_events WHERE customer_id=$1 AND kind='consent.granted'",
    [customer],
  );
  expect(ev.kind).toBe("consent.granted");
  // A used code cannot link another chat.
  await svc.receiveUpdate(
    connection,
    path,
    header,
    update(3, `/start ${code}`, 777),
  );
  await svc.processInbox();
  expect(
    await db.query(
      "SELECT internal_id FROM integration_mappings WHERE connection_id=$1 AND entity_type='chat' AND external_id='777'",
      [connection],
    ),
  ).toHaveLength(0);
  await svc.receiveUpdate(
    connection,
    path,
    header,
    update(4, "Здравствуйте, заказ готов?"),
  );
  await svc.processInbox();
  const msgs = (await svc.conversations(owner, org, connection)).items as {
    direction: string;
    customer_id: string;
    text: string;
  }[];
  expect(msgs.find((m) => m.text.startsWith("Здравствуйте"))).toMatchObject({
    direction: "in",
    customer_id: customer,
  });
});
it("T034: nothing is sent until the owner enables outbound and the customer consented; failures are not hidden or resent blindly", async () => {
  await expect(
    svc.send(seller, org, connection, {
      key: key(),
      customerId: customer,
      text: "Ваш заказ готов",
    }),
  ).rejects.toMatchObject({
    code: "MESSAGING_DISABLED",
  });
  const [c] = await db.query<{ version: number }>(
    "SELECT version FROM integration_connections WHERE id=$1",
    [connection],
  );
  await expect(
    svc.setOutbound(manager, org, connection, {
      key: key(),
      version: c.version,
      enabled: true,
    }),
  ).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await svc.setOutbound(owner, org, connection, {
    key: key(),
    version: c.version,
    enabled: true,
  });
  const k = key();
  await svc.send(seller, org, connection, {
    key: k,
    customerId: customer,
    text: "Ваш заказ готов",
  });
  expect(
    (
      await svc.send(seller, org, connection, {
        key: k,
        customerId: customer,
        text: "Ваш заказ готов",
      })
    ).reused,
  ).toBe(true);
  state.next = ["429"];
  expect(await svc.processOutbox()).toBe(0);
  await db.query(
    "UPDATE messaging_messages SET next_attempt_at=now() WHERE direction='out'",
  );
  expect(await svc.processOutbox()).toBe(1);
  const sends = state.calls.filter((x) => x.method === "sendMessage");
  expect(sends.at(-1)!.body).toEqual({
    chat_id: "555",
    text: "Ваш заказ готов",
  });
  await svc.send(seller, org, connection, {
    key: key(),
    customerId: customer,
    text: "Второе",
  });
  state.next = ["timeout"];
  await svc.processOutbox();
  await svc.send(seller, org, connection, {
    key: key(),
    customerId: customer,
    text: "Третье",
  });
  state.next = ["403"];
  await svc.processOutbox();
  const states = await db.query<{
    text: string;
    state: string;
    error_code: string | null;
  }>(
    "SELECT text,state,error_code FROM messaging_messages WHERE direction='out' ORDER BY created_at",
  );
  expect(states).toEqual([
    { text: "Ваш заказ готов", state: "sent", error_code: null },
    { text: "Второе", state: "unknown", error_code: "TELEGRAM_TIMEOUT" },
    { text: "Третье", state: "failed", error_code: "TELEGRAM_BLOCKED_BY_USER" },
  ]);
});
it("T034 review: revoked sender rights block queued delivery and a lost local confirmation never resends", async () => {
  const actor = await actorFromSession(db, seller);
  const denied = await svc.send(seller, org, connection, {
    key: key(),
    customerId: customer,
    text: "Revoked sender",
  });
  await db.query(
    "UPDATE memberships SET role='observer' WHERE organization_id=$1 AND user_id=$2",
    [org, actor],
  );
  const before = state.calls.filter((x) => x.method === "sendMessage").length;
  await svc.processOutbox();
  expect(state.calls.filter((x) => x.method === "sendMessage")).toHaveLength(
    before,
  );
  expect(
    (
      await db.query(
        "SELECT state,error_code FROM messaging_messages WHERE id=$1",
        [denied.id],
      )
    )[0],
  ).toMatchObject({ state: "blocked", error_code: "AUTHOR_ACCESS_REVOKED" });
  await db.query(
    "UPDATE memberships SET role='sales' WHERE organization_id=$1 AND user_id=$2",
    [org, actor],
  );
  const uncertain = await svc.send(seller, org, connection, {
    key: key(),
    customerId: customer,
    text: "Lost confirmation",
  });
  const original = db.query.bind(db);
  const spy = vi.spyOn(db, "query").mockImplementation(async (sql, params) => {
    if (sql.includes("SET state='sent'"))
      throw new Error("synthetic local commit failure");
    return original(sql, params);
  });
  try {
    await svc.processOutbox();
  } finally {
    spy.mockRestore();
  }
  expect(
    (
      await db.query("SELECT state FROM messaging_messages WHERE id=$1", [
        uncertain.id,
      ])
    )[0],
  ).toMatchObject({ state: "unknown" });
  await db.query(
    "UPDATE messaging_messages SET next_attempt_at=now() WHERE id=$1",
    [uncertain.id],
  );
  expect(await svc.processOutbox()).toBe(0);
  expect(state.calls.filter((x) => x.method === "sendMessage")).toHaveLength(
    before + 1,
  );
});
it("T034: /stop withdraws consent; queued messages are blocked at send time and new ones are refused", async () => {
  await svc.send(seller, org, connection, {
    key: key(),
    customerId: customer,
    text: "Акция",
  });
  await svc.receiveUpdate(connection, path, header, update(9, "/stop"));
  await svc.processInbox();
  expect(await consent()).toBe(false);
  const before = state.calls.filter((x) => x.method === "sendMessage").length;
  await svc.processOutbox();
  expect(state.calls.filter((x) => x.method === "sendMessage").length).toBe(
    before,
  );
  const [blocked] = await db.query<{ state: string }>(
    "SELECT state FROM messaging_messages WHERE text='Акция'",
  );
  expect(blocked.state).toBe("blocked");
  await expect(
    svc.send(seller, org, connection, {
      key: key(),
      customerId: customer,
      text: "Ещё",
    }),
  ).rejects.toMatchObject({
    code: "MESSENGER_NOT_LINKED",
  });
});
it("T029 review: reconfiguration replay returns the existing connection ID", async () => {
  const input = { key: key(), botToken: TOKEN, branchId: branch };
  expect((await svc.configure(owner, org, input)).id).toBe(connection);
  expect(await svc.configure(owner, org, input)).toMatchObject({
    id: connection,
    reused: true,
  });
});
