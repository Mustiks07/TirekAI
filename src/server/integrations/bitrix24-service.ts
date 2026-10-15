import { z } from "zod";
import type { Database, Sql } from "../db/database";
import { sessionAccess, InternalActor, type Credential } from "../access";
import { AppError } from "../../domain/errors";
import { CrmService } from "../crm/service";
import {
  Bitrix24Client,
  BITRIX24_CONTRACT,
  contactFields,
  validWebhookUrl,
  type B24Contact,
} from "./bitrix24";
import type { Fetch } from "./moysklad";
import {
  connectionFor,
  credentialsOf,
  disconnectConnection,
  dueConnections,
  markChecked,
  pendingInbox,
  receiveInbound,
  recordConflict,
  sameHash,
  saveConnection,
  settleInbox,
  sha,
  trackRun,
  type ConnectionRow,
} from "./common";

export const bitrix24Input = z
  .object({
    key: z.uuid(),
    webhookUrl: z.string().trim().max(300),
    // Token shown by Bitrix24 for the outbound webhook; optional until events are configured.
    applicationToken: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{16,64}$/)
      .nullable(),
    branchId: z.uuid(),
  })
  .strict();
const eventBody = z
  .object({
    event: z.enum([
      "ONCRMCONTACTADD",
      "ONCRMCONTACTUPDATE",
      "ONCRMCONTACTDELETE",
    ]),
    data: z.object({
      FIELDS: z.object({ ID: z.union([z.string(), z.number()]) }),
    }),
    ts: z.union([z.string(), z.number()]),
    auth: z.object({ application_token: z.string().max(100) }).passthrough(),
  })
  .passthrough();
type Secrets = { webhookUrl: string; applicationToken: string | null };
const ownership = { customers_imported: "external", deals: "internal" };
export class Bitrix24Service {
  constructor(
    private db: Database,
    private client: (url: string) => Bitrix24Client = (url) =>
      new Bitrix24Client(url),
    private live = true,
  ) {}
  // Tests point the client at a local contract server; such checks never count as live.
  static forContractServer(
    db: Database,
    fetcher: Fetch,
    sleep?: (ms: number) => Promise<void>,
  ) {
    return new Bitrix24Service(
      db,
      (url) => new Bitrix24Client(url, fetcher, sleep),
      false,
    );
  }
  async configure(secret: Credential, org: string, input: unknown) {
    const c = bitrix24Input.parse(input);
    if (!validWebhookUrl(c.webhookUrl))
      throw new AppError("BITRIX24_URL_INVALID", 422);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      const [branch] = await tx.query(
        "SELECT id FROM branches WHERE organization_id=$1 AND id=$2",
        [org, c.branchId],
      );
      if (!branch) throw new AppError("NOT_FOUND", 404);
      return saveConnection(tx, {
        org,
        actorId: s.actorId,
        key: c.key,
        provider: "bitrix24",
        credentials: {
          webhookUrl: c.webhookUrl,
          applicationToken: c.applicationToken,
        },
        // Only the portal host is shown; the secret code never leaves the server.
        hint: new URL(c.webhookUrl).host,
        settings: { branchId: c.branchId, events: Boolean(c.applicationToken) },
        ownership,
        contract: BITRIX24_CONTRACT,
        inbound: true,
      });
    });
  }
  private async load(
    secret: Credential,
    org: string,
    id: string,
    write: boolean,
  ) {
    return this.db.transaction(async (tx) => {
      await sessionAccess(
        tx,
        secret,
        org,
        write ? "integrations:write" : "integrations:read",
      );
      return connectionFor(tx, org, id, "bitrix24");
    });
  }
  async check(secret: Credential, org: string, id: string) {
    const conn = await this.load(secret, org, id, true);
    const client = this.client(credentialsOf<Secrets>(conn).webhookUrl);
    const r = await trackRun(this.db, conn, "check", async () =>
      client.profile(),
    );
    await markChecked(this.db, conn, r.runId, this.live, client.host);
    return { ok: true };
  }
  async syncNow(secret: Credential, org: string, id: string) {
    const conn = await this.load(secret, org, id, true);
    return (await this.syncContacts(conn)).stats;
  }
  // Incremental by updatedTime with a 5-minute overlap; each page commits with its cursor.
  async syncContacts(conn: ConnectionRow) {
    const [cursor] = await this.db.query<{ cursor: string }>(
      "SELECT cursor FROM sync_cursors WHERE connection_id=$1 AND entity_type='contact'",
      [conn.id],
    );
    const client = this.client(credentialsOf<Secrets>(conn).webhookUrl);
    return trackRun(
      this.db,
      conn,
      cursor ? "incremental" : "initial",
      async (stats) => {
        const from = cursor
          ? new Date(
              new Date(cursor.cursor).getTime() - 5 * 60_000,
            ).toISOString()
          : null;
        for await (const page of client.contacts(from)) {
          let max = cursor?.cursor || "";
          await this.db.transaction(async (tx) => {
            for (const c of page) {
              const outcome = await this.apply(tx, conn, c);
              stats[outcome] = (stats[outcome] || 0) + 1;
              const t = new Date(c.updatedTime).toISOString();
              if (t > max) max = t;
            }
            if (max)
              await tx.query(
                "INSERT INTO sync_cursors(connection_id,entity_type,cursor) VALUES($1,'contact',$2) ON CONFLICT(connection_id,entity_type) DO UPDATE SET cursor=greatest(sync_cursors.cursor,$2),updated_at=now()",
                [conn.id, max],
              );
          });
        }
      },
    );
  }
  private async apply(tx: Sql, conn: ConnectionRow, c: B24Contact) {
    if (!Number.isInteger(c.id) || c.id <= 0) return "skipped";
    const org = conn.organization_id,
      external = String(c.id),
      actor = new InternalActor(conn.created_by, "integration"),
      crm = new CrmService(this.db),
      fields = contactFields(c),
      updated = new Date(c.updatedTime).toISOString(),
      remote = { id: c.id, ...fields, updatedTime: updated };
    const [m] = await tx.query<{
      internal_id: string;
      external_updated: string | null;
      local_version: number | null;
      state: string;
    }>(
      "SELECT internal_id,external_updated,local_version,state FROM integration_mappings WHERE connection_id=$1 AND entity_type='contact' AND external_id=$2 FOR UPDATE",
      [conn.id, external],
    );
    if (m && m.external_updated && updated <= m.external_updated)
      return "unchanged";
    const branch = String(conn.settings.branchId || "");
    if (!m) {
      // A local customer with the same e-mail or phone is never merged silently.
      const [same] =
        fields.email || fields.phone
          ? await tx.query<{ id: string }>(
              "SELECT id FROM customers WHERE organization_id=$1 AND branch_id=$2 AND ((email<>'' AND email=$3) OR (phone<>'' AND phone=$4)) LIMIT 1",
              [org, branch, fields.email, fields.phone],
            )
          : [];
      if (same)
        return recordConflict(
          tx,
          conn,
          "contact",
          external,
          same.id,
          "possible_duplicate",
          null,
          remote,
        );
      const created = await crm.importCustomerInTransaction(tx, actor, org, {
        branchId: branch,
        externalId: `bitrix24:${external}`,
        ...fields,
        note: "Импорт из Битрикс24 / Битрикс24-тен импорт",
      });
      await tx.query(
        "INSERT INTO integration_mappings(organization_id,connection_id,entity_type,external_id,internal_id,external_updated,local_version,state) VALUES($1,$2,'contact',$3,$4,$5,$6,'active')",
        [org, conn.id, external, created.id, updated, created.version],
      );
      return "created";
    }
    const [local] = await tx.query<{
      version: number;
      name: string;
      email: string;
      phone: string;
    }>(
      "SELECT version,name,email,phone FROM customers WHERE organization_id=$1 AND id=$2 FOR UPDATE",
      [org, m.internal_id],
    );
    // A local edit since the last sync wins until a person decides.
    if (!local || local.version !== m.local_version)
      return recordConflict(
        tx,
        conn,
        "contact",
        external,
        m.internal_id,
        "local_modified",
        local && {
          name: local.name,
          email: local.email,
          phone: local.phone,
          version: local.version,
        },
        remote,
      );
    const next = await crm.updateImportedInTransaction(
      tx,
      actor,
      org,
      m.internal_id,
      local.version,
      { ...fields, note: "Изменено в Битрикс24 / Битрикс24-те өзгертілді" },
    );
    await tx.query(
      "UPDATE integration_mappings SET external_updated=$3,local_version=$4,state='active',updated_at=now() WHERE connection_id=$1 AND entity_type='contact' AND external_id=$2",
      [conn.id, external, updated, next.version],
    );
    return "updated";
  }
  // Outbound webhook handler: secret path token plus the application token Bitrix24 shows.
  async receiveEvent(connectionId: string, token: string, body: unknown) {
    const parsed = eventBody.safeParse(body);
    if (!parsed.success) throw new AppError("INVALID_INPUT", 400);
    const e = parsed.data,
      id = String(e.data.FIELDS.ID);
    if (!/^\d{1,12}$/.test(id)) throw new AppError("INVALID_INPUT", 400);
    const r = await receiveInbound(
      this.db,
      "bitrix24",
      connectionId,
      token,
      sha(`${e.event}:${id}:${e.ts}`),
      { event: e.event, id: Number(id), ts: String(e.ts) },
      (conn) => {
        const expected = credentialsOf<Secrets>(conn).applicationToken;
        return (
          Boolean(expected) &&
          sameHash(sha(expected!), e.auth.application_token)
        );
      },
    );
    return { accepted: true, duplicate: r.duplicate };
  }
  async processInbox() {
    const items = await pendingInbox<{ event: string; id: number }>(
      this.db,
      "bitrix24",
    );
    let processed = 0;
    for (const item of items) {
      try {
        const [conn] = await this.db.query<ConnectionRow>(
          "SELECT * FROM integration_connections WHERE id=$1",
          [item.connection_id],
        );
        const client = this.client(credentialsOf<Secrets>(conn).webhookUrl);
        await trackRun(this.db, conn, "webhook", async (stats) => {
          const external = String(item.payload.id);
          if (item.payload.event === "ONCRMCONTACTDELETE") {
            await this.db.transaction(async (tx) => {
              const [m] = await tx.query<{ internal_id: string }>(
                "UPDATE integration_mappings SET state='deleted',updated_at=now() WHERE connection_id=$1 AND entity_type='contact' AND external_id=$2 AND state<>'deleted' RETURNING internal_id",
                [conn.id, external],
              );
              // The local customer and its history stay; the deletion is recorded, not mirrored.
              if (m)
                await new CrmService(this.db).noteExternalInTransaction(
                  tx,
                  new InternalActor(conn.created_by, "integration"),
                  conn.organization_id,
                  m.internal_id,
                  "customer.external_deleted",
                  "Удалён в Битрикс24 / Битрикс24-те жойылды",
                );
            });
            stats.deleted = 1;
            return;
          }
          // The event carries only an id: the contact is re-read from the API.
          const contact = await client.contact(item.payload.id);
          const outcome = await this.db.transaction((tx) =>
            this.apply(tx, conn, contact),
          );
          stats[outcome] = 1;
        });
        await settleInbox(this.db, item.id, null);
        processed++;
      } catch (error) {
        await settleInbox(this.db, item.id, error);
      }
    }
    return processed;
  }
  async resolve(
    secret: Credential,
    org: string,
    conflictId: string,
    input: unknown,
  ) {
    const c = z
      .object({
        key: z.uuid(),
        decision: z.enum(["kept_local", "took_remote"]),
      })
      .strict()
      .parse(input);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      const [x] = await tx.query<{
        connection_id: string;
        external_id: string;
        internal_id: string | null;
        reason: string;
        remote: {
          name: string;
          email: string;
          phone: string;
          updatedTime: string;
        };
      }>(
        "SELECT x.connection_id,x.external_id,x.internal_id,x.reason,x.remote FROM sync_conflicts x JOIN integration_connections c ON c.id=x.connection_id AND c.provider='bitrix24' WHERE x.organization_id=$1 AND x.id=$2 AND x.state='open' FOR UPDATE OF x",
        [org, conflictId],
      );
      if (!x) throw new AppError("NOT_FOUND", 404);
      if (x.reason === "local_modified" && x.internal_id) {
        const [local] = await tx.query<{ version: number }>(
          "SELECT version FROM customers WHERE organization_id=$1 AND id=$2 FOR UPDATE",
          [org, x.internal_id],
        );
        let version = local.version;
        if (c.decision === "took_remote")
          version = (
            await new CrmService(this.db).updateImportedInTransaction(
              tx,
              secret,
              org,
              x.internal_id,
              local.version,
              {
                name: x.remote.name,
                email: x.remote.email,
                phone: x.remote.phone,
                note: "Принята версия Битрикс24 / Битрикс24 нұсқасы қабылданды",
              },
            )
          ).version;
        await tx.query(
          "UPDATE integration_mappings SET local_version=$3,external_updated=$4,updated_at=now() WHERE connection_id=$1 AND entity_type='contact' AND external_id=$2",
          [x.connection_id, x.external_id, version, x.remote.updatedTime],
        );
      } else if (c.decision === "took_remote")
        throw new AppError("CONFLICT_NEEDS_CATALOG_ACTION", 422);
      await tx.query(
        "UPDATE sync_conflicts SET state=$3,resolved_by=$4,resolved_at=now() WHERE organization_id=$1 AND id=$2",
        [org, conflictId, c.decision, s.actorId],
      );
      return { ok: true };
    });
  }
  async disconnect(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      await disconnectConnection(
        tx,
        org,
        s.actorId,
        await connectionFor(tx, org, id, "bitrix24", true),
      );
      return { ok: true };
    });
  }
  async runOnce() {
    for (const conn of await dueConnections(this.db, "bitrix24", 15))
      await this.syncContacts(conn).catch(() => undefined);
    return { inbox: await this.processInbox() };
  }
}
