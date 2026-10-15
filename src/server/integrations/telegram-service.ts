import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Sql } from "../db/database";
import {
  sessionAccess,
  actorAccess,
  audit,
  InternalActor,
  type Credential,
} from "../access";
import { AppError } from "../../domain/errors";
import { idSchema } from "../../domain/contracts";
import { idempotent } from "../execution/core";
import { CrmService } from "../crm/service";
import type { Fetch } from "./moysklad";
import {
  TelegramClient,
  TELEGRAM_BASE,
  TELEGRAM_CONTRACT,
  validBotToken,
  type TgUpdate,
} from "./telegram";
import {
  connectionFor,
  credentialsOf,
  disconnectConnection,
  markChecked,
  pendingInbox,
  receiveInbound,
  sameHash,
  saveConnection,
  settleInbox,
  sha,
  trackRun,
  type ConnectionRow,
} from "./common";

type Secrets = { botToken: string; headerSecret: string };
const ownership = {
  messages: "external",
  customers: "internal",
  consents: "internal",
};
export const telegramInput = z
  .object({
    key: z.uuid(),
    botToken: z.string().trim().max(100),
    branchId: z.uuid(),
  })
  .strict();
export const sendInput = z
  .object({
    key: z.uuid(),
    customerId: z.uuid(),
    text: z.string().trim().min(1).max(2000),
  })
  .strict();
const updateBody = z
  .object({
    update_id: z.number().int().nonnegative(),
    message: z
      .object({
        message_id: z.number().int(),
        date: z.number().int(),
        chat: z.object({ id: z.number().int(), type: z.string().max(20) }),
        from: z
          .object({ id: z.number().int(), is_bot: z.boolean().optional() })
          .passthrough()
          .optional(),
        text: z.string().max(4096).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export class TelegramService {
  constructor(
    private db: Database,
    private client: (token: string) => TelegramClient = (token) =>
      new TelegramClient(token),
    private live = true,
  ) {}
  static forContractServer(db: Database, base: string, fetcher: Fetch = fetch) {
    return new TelegramService(
      db,
      (token) => new TelegramClient(token, base, fetcher, async () => {}),
      false,
    );
  }
  async configure(secret: Credential, org: string, input: unknown) {
    const c = telegramInput.parse(input);
    if (!validBotToken(c.botToken))
      throw new AppError("TELEGRAM_TOKEN_INVALID", 422);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      const [branch] = await tx.query(
        "SELECT id FROM branches WHERE organization_id=$1 AND id=$2",
        [org, c.branchId],
      );
      if (!branch) throw new AppError("NOT_FOUND", 404);
      const r = await saveConnection(tx, {
        org,
        actorId: s.actorId,
        key: c.key,
        provider: "telegram",
        requestCredentials: { botToken: c.botToken },
        credentials: {
          botToken: c.botToken,
          headerSecret: randomBytes(32).toString("base64url"),
        },
        hint: `…${c.botToken.slice(-4)}`,
        // Outbound messages stay off until the owner turns them on.
        settings: { branchId: c.branchId, outbound: false, username: null },
        ownership,
        contract: TELEGRAM_CONTRACT,
        inbound: true,
      });
      return { id: r.id, reused: r.reused };
    });
  }
  private async load(
    tx: Sql,
    secret: Credential,
    org: string,
    id: string,
    perm: "integrations:write" | "integrations:read",
  ) {
    await sessionAccess(tx, secret, org, perm);
    return connectionFor(tx, org, id, "telegram");
  }
  async check(secret: Credential, org: string, id: string) {
    const conn = await this.db.transaction((tx) =>
      this.load(tx, secret, org, id, "integrations:write"),
    );
    const r = await trackRun(this.db, conn, "check", () =>
      this.client(credentialsOf<Secrets>(conn).botToken).getMe(),
    );
    if (!r.result.is_bot) throw new AppError("TELEGRAM_NOT_A_BOT", 422);
    await this.db.query(
      "UPDATE integration_connections SET settings=jsonb_set(settings,'{username}',to_jsonb($2::text)) WHERE id=$1",
      [conn.id, r.result.username || ""],
    );
    await markChecked(
      this.db,
      conn,
      r.runId,
      this.live,
      new URL(TELEGRAM_BASE).host,
    );
    return { ok: true };
  }
  // Explicit owner action: a fresh path token is issued and Telegram is told where to deliver.
  async registerWebhook(
    secret: Credential,
    org: string,
    id: string,
    origin: string,
  ) {
    const url = new URL(origin);
    if (url.protocol !== "https:")
      throw new AppError("PUBLIC_HTTPS_REQUIRED", 409);
    const conn = await this.db.transaction((tx) =>
      this.load(tx, secret, org, id, "integrations:write"),
    );
    const s = credentialsOf<Secrets>(conn),
      token = randomBytes(32).toString("hex");
    await trackRun(this.db, conn, "check", () =>
      this.client(s.botToken).setWebhook(
        `${url.origin}/api/integrations/telegram/${conn.id}/${token}`,
        s.headerSecret,
      ),
    );
    await this.db.query(
      "UPDATE integration_connections SET webhook_token_hash=$2 WHERE id=$1",
      [conn.id, sha(token)],
    );
    return { ok: true };
  }
  async setOutbound(
    secret: Credential,
    org: string,
    id: string,
    input: unknown,
  ) {
    const c = z
      .object({
        key: z.uuid(),
        version: z.number().int().positive(),
        enabled: z.boolean(),
      })
      .strict()
      .parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      const conn = await connectionFor(tx, org, id, "telegram", true);
      const r = await idempotent(tx, org, c.key, {
        operation: "telegram.outbound",
        id,
        ...c,
      });
      if (r.reused) return r;
      if (conn.version !== c.version)
        throw new AppError("VERSION_CONFLICT", 409);
      await tx.query(
        "UPDATE integration_connections SET settings=jsonb_set(settings,'{outbound}',to_jsonb($3::boolean)),version=version+1 WHERE organization_id=$1 AND id=$2",
        [org, id, c.enabled],
      );
      await audit(tx, org, s.actorId, "messaging.outbound", null, {
        connectionId: id,
        enabled: String(c.enabled),
      });
      return r;
    });
  }
  // Staff issue a one-time code; the customer sends it to the bot with /start, which links the
  // chat and records the customer's own messenger consent.
  async createLink(
    secret: Credential,
    org: string,
    id: string,
    input: unknown,
  ) {
    const c = z.object({ customerId: z.uuid() }).strict().parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "customers:write");
      const conn = await connectionFor(tx, org, id, "telegram");
      const [customer] = await tx.query(
        "SELECT id FROM customers WHERE organization_id=$1 AND id=$2 AND erased_at IS NULL AND ($3::uuid IS NULL OR branch_id=$3)",
        [org, c.customerId, s.branchId],
      );
      if (!customer) throw new AppError("NOT_FOUND", 404);
      const code = randomBytes(12).toString("base64url");
      await tx.query(
        "INSERT INTO messaging_links(id,organization_id,connection_id,customer_id,code_hash,expires_at,created_by) VALUES($1,$2,$3,$4,$5,now()+interval '7 days',$6)",
        [randomUUID(), org, conn.id, c.customerId, sha(code), s.actorId],
      );
      const username = String(conn.settings.username || "");
      return {
        code,
        link: username ? `https://t.me/${username}?start=${code}` : null,
      };
    });
  }
  async receiveUpdate(
    connectionId: string,
    token: string,
    header: string | null,
    body: unknown,
  ) {
    const parsed = updateBody.safeParse(body);
    if (!parsed.success) throw new AppError("INVALID_INPUT", 400);
    const r = await receiveInbound(
      this.db,
      "telegram",
      connectionId,
      token,
      String(parsed.data.update_id),
      parsed.data,
      (conn) =>
        Boolean(header) &&
        sameHash(sha(credentialsOf<Secrets>(conn).headerSecret), header!),
    );
    return { accepted: true, duplicate: r.duplicate };
  }
  async processInbox() {
    let processed = 0;
    for (const item of await pendingInbox<TgUpdate>(this.db, "telegram")) {
      try {
        const [conn] = await this.db.query<ConnectionRow>(
          "SELECT * FROM integration_connections WHERE id=$1",
          [item.connection_id],
        );
        await trackRun(this.db, conn, "webhook", async (stats) => {
          const m = item.payload.message;
          // Only private chats with people; groups, channels and bots are ignored.
          if (!m || m.chat.type !== "private" || m.from?.is_bot) {
            stats.ignored = 1;
            return;
          }
          await this.db.transaction((tx) => this.handle(tx, conn, m, stats));
        });
        await settleInbox(this.db, item.id, null);
        processed++;
      } catch (error) {
        await settleInbox(this.db, item.id, error);
      }
    }
    return processed;
  }
  private async handle(
    tx: Sql,
    conn: ConnectionRow,
    m: NonNullable<TgUpdate["message"]>,
    stats: Record<string, number>,
  ) {
    const org = conn.organization_id,
      chat = String(m.chat.id),
      actor = new InternalActor(conn.created_by, "integration"),
      crm = new CrmService(this.db),
      text = (m.text || "").trim();
    const [mapped] = await tx.query<{ internal_id: string; state: string }>(
      "SELECT internal_id,state FROM integration_mappings WHERE connection_id=$1 AND entity_type='chat' AND external_id=$2 FOR UPDATE",
      [conn.id, chat],
    );
    const start = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{8,64})$/.exec(text);
    if (start) {
      const [link] = await tx.query<{ id: string; customer_id: string }>(
        "SELECT id,customer_id FROM messaging_links WHERE connection_id=$1 AND code_hash=$2 AND used_at IS NULL AND expires_at>now() FOR UPDATE",
        [conn.id, sha(start[1])],
      );
      if (!link) {
        stats.link_invalid = 1;
        return;
      }
      await tx.query("UPDATE messaging_links SET used_at=now() WHERE id=$1", [
        link.id,
      ]);
      await tx.query(
        "INSERT INTO integration_mappings(organization_id,connection_id,entity_type,external_id,internal_id,state) VALUES($1,$2,'chat',$3,$4,'active') ON CONFLICT(connection_id,entity_type,external_id) DO UPDATE SET internal_id=$4,state='active',updated_at=now()",
        [org, conn.id, chat, link.customer_id],
      );
      await crm.setMessengerConsentInTransaction(
        tx,
        actor,
        org,
        link.customer_id,
        true,
        "Клиент сам подключил Telegram (/start) / Клиент Telegram-ды өзі қосты (/start)",
      );
      stats.linked = 1;
      return;
    }
    if (/^\/stop(?:@\w+)?$/.test(text) && mapped) {
      await tx.query(
        "UPDATE integration_mappings SET state='archived',updated_at=now() WHERE connection_id=$1 AND entity_type='chat' AND external_id=$2",
        [conn.id, chat],
      );
      await crm.setMessengerConsentInTransaction(
        tx,
        actor,
        org,
        mapped.internal_id,
        false,
        "Клиент отказался от сообщений (/stop) / Клиент хабарламалардан бас тартты (/stop)",
      );
      stats.unsubscribed = 1;
      return;
    }
    const customer = mapped?.state === "active" ? mapped.internal_id : null;
    const added = await tx.query(
      "INSERT INTO messaging_messages(id,organization_id,connection_id,chat_id,customer_id,direction,external_id,text,state) VALUES($1,$2,$3,$4,$5,'in',$6,$7,'received') ON CONFLICT DO NOTHING RETURNING id",
      [
        randomUUID(),
        org,
        conn.id,
        chat,
        customer,
        String(m.message_id),
        text.slice(0, 4096) || "[без текста]",
      ],
    );
    if (added.length && customer)
      await crm.noteMessageInTransaction(
        tx,
        actor,
        org,
        customer,
        `Telegram: ${text}`,
      );
    stats.messages = 1;
  }
  async send(secret: Credential, org: string, id: string, input: unknown) {
    const c = sendInput.parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "customers:write");
      const conn = await connectionFor(tx, org, id, "telegram");
      const r = await idempotent(tx, org, c.key, {
        operation: "telegram.send",
        id,
        ...c,
      });
      if (r.reused) return r;
      if (conn.disconnected_at || !conn.settings.outbound)
        throw new AppError("MESSAGING_DISABLED", 409);
      const queued = await this.queueInTransaction(
        tx,
        org,
        s.actorId,
        conn,
        c.customerId,
        c.text,
        { id: r.id, branchId: s.branchId },
      );
      if (queued === "not_found") throw new AppError("NOT_FOUND", 404);
      if (queued === "not_linked")
        throw new AppError("MESSENGER_NOT_LINKED", 409);
      if (queued === "no_consent") throw new AppError("NO_CONSENT", 409);
      await audit(tx, org, s.actorId, "messaging.queued", null, {
        messageId: r.id,
      });
      return r;
    });
  }
  // Composition for other services (T039 campaign publication): the same consent and chat checks
  // as send, inside the caller's transaction. The worker repeats them before sending.
  async queueInTransaction(
    tx: Sql,
    org: string,
    actorId: string,
    conn: ConnectionRow,
    customerId: string,
    text: string,
    options: {
      id?: string;
      branchId?: string | null;
      publicationId?: string;
    } = {},
  ): Promise<"queued" | "not_found" | "not_linked" | "no_consent"> {
    if (conn.disconnected_at || !conn.settings.outbound)
      throw new AppError("MESSAGING_DISABLED", 409);
    const [customer] = await tx.query<{ messenger: boolean }>(
      "SELECT (consents->>'messenger')::boolean messenger FROM customers WHERE organization_id=$1 AND id=$2 AND erased_at IS NULL AND ($3::uuid IS NULL OR branch_id=$3)",
      [org, customerId, options.branchId ?? null],
    );
    if (!customer) return "not_found";
    const [chat] = await tx.query<{ external_id: string }>(
      "SELECT external_id FROM integration_mappings WHERE connection_id=$1 AND entity_type='chat' AND internal_id=$2 AND state='active' ORDER BY updated_at DESC LIMIT 1",
      [conn.id, customerId],
    );
    if (!chat) return "not_linked";
    // No consent, no message: the check repeats when the worker sends.
    if (!customer.messenger) return "no_consent";
    await tx.query(
      "INSERT INTO messaging_messages(id,organization_id,connection_id,chat_id,customer_id,direction,text,state,created_by,publication_id) VALUES($1,$2,$3,$4,$5,'out',$6,'queued',$7,$8)",
      [
        options.id ?? randomUUID(),
        org,
        conn.id,
        chat.external_id,
        customerId,
        text,
        actorId,
        options.publicationId ?? null,
      ],
    );
    return "queued";
  }
  async processOutbox(limit = 20) {
    const due = await this.db.query<{
      id: string;
      organization_id: string;
      connection_id: string;
      chat_id: string;
      customer_id: string;
      text: string;
      attempts: number;
      created_by: string | null;
      publication_id: string | null;
    }>(
      "SELECT id,organization_id,connection_id,chat_id,customer_id,text,attempts,created_by,publication_id FROM messaging_messages WHERE direction='out' AND state='queued' AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT $1",
      [limit],
    );
    let sent = 0;
    for (const m of due) {
      const claimed = await this.db.query(
        "UPDATE messaging_messages SET state='unknown',error_code='DELIVERY_UNCONFIRMED',attempts=attempts+1,next_attempt_at=now()+interval '5 minutes' WHERE id=$1 AND state='queued' AND attempts=$2 RETURNING id",
        [m.id, m.attempts],
      );
      if (!claimed.length) continue;
      const [conn] = await this.db.query<ConnectionRow>(
        "SELECT * FROM integration_connections WHERE id=$1",
        [m.connection_id],
      );
      const [ok] = await this.db.query<{ ok: boolean; branch_id: string }>(
        "SELECT c.branch_id,((c.consents->>'messenger')::boolean AND EXISTS(SELECT 1 FROM integration_mappings x WHERE x.connection_id=$2 AND x.entity_type='chat' AND x.external_id=$3 AND x.internal_id=c.id AND x.state='active')) ok FROM customers c WHERE c.organization_id=$1 AND c.id=$4",
        [m.organization_id, m.connection_id, m.chat_id, m.customer_id],
      );
      if (!conn.settings.outbound || conn.disconnected_at || !ok?.ok) {
        await this.db.query(
          "UPDATE messaging_messages SET state='blocked',error_code=$2 WHERE id=$1",
          [m.id, !ok?.ok ? "NO_CONSENT" : "MESSAGING_DISABLED"],
        );
        continue;
      }
      try {
        if (!m.created_by) throw new AppError("FORBIDDEN", 403);
        await this.db.transaction((tx) =>
          actorAccess(
            tx,
            m.created_by!,
            m.organization_id,
            m.publication_id ? "marketing:approve" : "customers:write",
            ok.branch_id,
          ),
        );
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        await this.db.query(
          "UPDATE messaging_messages SET state='blocked',error_code='AUTHOR_ACCESS_REVOKED' WHERE id=$1",
          [m.id],
        );
        continue;
      }
      try {
        const r = await trackRun(this.db, conn, "export", () =>
          this.client(credentialsOf<Secrets>(conn).botToken).sendMessage(
            m.chat_id,
            m.text,
          ),
        );
        await this.db.query(
          "UPDATE messaging_messages SET state='sent',external_id=$2,sent_at=now(),error_code=NULL WHERE id=$1",
          [m.id, String(r.result.message_id)],
        );
        sent++;
      } catch (error) {
        const code =
          error instanceof AppError ? error.code : "TELEGRAM_UNAVAILABLE";
        // A timeout may have delivered the message: it is not resent automatically.
        const state =
          code === "TELEGRAM_TIMEOUT" ||
          code === "TELEGRAM_UNAVAILABLE" ||
          code === "INTEGRATION_FAILED"
            ? "unknown"
            : code === "TELEGRAM_RATE_LIMITED"
              ? "queued"
              : "failed";
        await this.db.query(
          "UPDATE messaging_messages SET state=$2,error_code=$3 WHERE id=$1",
          [m.id, state, code],
        );
      }
    }
    return sent;
  }
  async conversations(secret: Credential, org: string, id: string) {
    idSchema.parse(id);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "customers:read");
      await connectionFor(tx, org, id, "telegram");
      return {
        items: await tx.query(
          "SELECT m.id,m.chat_id,m.customer_id,c.name customer_name,m.direction,m.text,m.state,m.error_code,m.created_at FROM messaging_messages m LEFT JOIN customers c ON c.organization_id=m.organization_id AND c.id=m.customer_id WHERE m.organization_id=$1 AND m.connection_id=$2 AND ($3::uuid IS NULL OR c.branch_id=$3 OR (m.customer_id IS NULL AND $4::boolean)) ORDER BY m.created_at DESC LIMIT 50",
          [org, id, s.branchId, s.role === "owner"],
        ),
      };
    });
  }
  async disconnect(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      await disconnectConnection(
        tx,
        org,
        s.actorId,
        await connectionFor(tx, org, id, "telegram", true),
      );
      return { ok: true };
    });
  }
  async runOnce() {
    return {
      inbox: await this.processInbox(),
      sent: await this.processOutbox(),
    };
  }
}
