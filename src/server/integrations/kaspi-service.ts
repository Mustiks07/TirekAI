import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database, Sql } from "../db/database";
import { sessionAccess, type Credential } from "../access";
import { AppError } from "../../domain/errors";
import type { Fetch } from "./moysklad";
import {
  KaspiClient,
  KASPI_BASE,
  KASPI_CONTRACT,
  KASPI_STATES,
  tengeToMinor,
  validKaspiToken,
  type KaspiOrder,
} from "./kaspi";
import {
  connectionFor,
  credentialsOf,
  disconnectConnection,
  dueConnections,
  markChecked,
  saveConnection,
  trackRun,
  type ConnectionRow,
} from "./common";

type Secrets = { token: string };
export const kaspiInput = z
  .object({
    key: z.uuid(),
    token: z.string().trim().max(200),
    branchId: z.uuid(),
    warehouseId: z.uuid(),
  })
  .strict();
const ownership = {
  channel_orders: "external",
  fulfilment: "internal",
  money: "internal",
};
const DAY = 86_400_000;
// T034: Kaspi orders are read and kept as channel orders with their status history. They do not
// touch stock or money here; T040 turns them into sales orders by explicit actions.
export class KaspiService {
  constructor(
    private db: Database,
    public client: (token: string) => KaspiClient = (token) =>
      new KaspiClient(token),
    private live = true,
    private now = () => Date.now(),
  ) {}
  static forContractServer(
    db: Database,
    base: string,
    fetcher: Fetch = fetch,
    now?: () => number,
  ) {
    return new KaspiService(
      db,
      (token) => new KaspiClient(token, base, fetcher, async () => {}),
      false,
      now,
    );
  }
  async configure(secret: Credential, org: string, input: unknown) {
    const c = kaspiInput.parse(input);
    if (!validKaspiToken(c.token))
      throw new AppError("KASPI_TOKEN_INVALID", 422);
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "integrations:write");
      const [w] = await tx.query(
        "SELECT id FROM warehouses WHERE organization_id=$1 AND id=$2 AND branch_id=$3",
        [org, c.warehouseId, c.branchId],
      );
      if (!w) throw new AppError("NOT_FOUND", 404);
      const r = await saveConnection(tx, {
        org,
        actorId: s.actorId,
        key: c.key,
        provider: "kaspi",
        credentials: { token: c.token },
        hint: `…${c.token.slice(-4)}`,
        // Status changes in Kaspi are real actions for buyers: off until the owner enables them.
        settings: {
          branchId: c.branchId,
          warehouseId: c.warehouseId,
          writes: false,
        },
        ownership,
        contract: KASPI_CONTRACT,
        inbound: false,
      });
      return { id: r.id, reused: r.reused };
    });
  }
  async load(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      await sessionAccess(tx, secret, org, "integrations:write");
      return connectionFor(tx, org, id, "kaspi");
    });
  }
  async check(secret: Credential, org: string, id: string) {
    const conn = await this.load(secret, org, id);
    const client = this.client(credentialsOf<Secrets>(conn).token),
      now = this.now();
    const r = await trackRun(this.db, conn, "check", async () => {
      for await (const page of client.orders("NEW", now - DAY, now, 1))
        return page.length;
    });
    await markChecked(
      this.db,
      conn,
      r.runId,
      this.live,
      new URL(KASPI_BASE).host,
    );
    return { ok: true };
  }
  async syncNow(secret: Credential, org: string, id: string) {
    return (await this.syncOrders(await this.load(secret, org, id))).stats;
  }
  // Orders change status long after creation, so every run rescans the recent window per state
  // (14 days, 30 on the first run); unchanged orders are skipped, changes extend the history.
  async syncOrders(conn: ConnectionRow) {
    const client = this.client(credentialsOf<Secrets>(conn).token);
    const [cursor] = await this.db.query<{ cursor: string }>(
      "SELECT cursor FROM sync_cursors WHERE connection_id=$1 AND entity_type='order'",
      [conn.id],
    );
    const to = this.now(),
      from = to - (cursor ? 14 : 30) * DAY;
    return trackRun(
      this.db,
      conn,
      cursor ? "incremental" : "initial",
      async (stats) => {
        for (const state of KASPI_STATES)
          for (let start = from; start < to; start += 14 * DAY)
            for await (const page of client.orders(
              state,
              start,
              Math.min(start + 14 * DAY - 1, to),
            ))
              for (const o of page) {
                const outcome = await this.apply(conn, client, o);
                stats[outcome] = (stats[outcome] || 0) + 1;
              }
        await this.db.query(
          "INSERT INTO sync_cursors(connection_id,entity_type,cursor) VALUES($1,'order',$2) ON CONFLICT(connection_id,entity_type) DO UPDATE SET cursor=$2,updated_at=now()",
          [conn.id, new Date(to).toISOString()],
        );
      },
    );
  }
  private async apply(conn: ConnectionRow, client: KaspiClient, o: KaspiOrder) {
    const a = o.attributes;
    if (!o.id || !a?.code || typeof a.creationDate !== "number")
      return "skipped";
    const total = tengeToMinor(a.totalPrice),
      delivery =
        a.deliveryCost === undefined || a.deliveryCost === null
          ? null
          : tengeToMinor(a.deliveryCost);
    if (total === null) return "skipped";
    const [known] = await this.db.query<{ status: string; state: string }>(
      "SELECT status,state FROM channel_orders WHERE connection_id=$1 AND external_id=$2",
      [conn.id, o.id],
    );
    if (known && known.status === a.status && known.state === a.state)
      return "unchanged";
    // Lines are read once, outside the transaction (network), for a new order only.
    const lines = known ? null : await this.lines(client, o.id);
    return this.db.transaction(async (tx: Sql) => {
      const [row] = await tx.query<{
        id: string;
        status: string;
        state: string;
      }>(
        "SELECT id,status,state FROM channel_orders WHERE connection_id=$1 AND external_id=$2 FOR UPDATE",
        [conn.id, o.id],
      );
      const entry = {
        at: new Date(this.now()).toISOString(),
        status: a.status,
        state: a.state,
      };
      if (row) {
        await tx.query(
          "UPDATE channel_orders SET status=$3,state=$4,history=history||$5::jsonb,version=version+1,updated_at=now() WHERE connection_id=$1 AND external_id=$2",
          [conn.id, o.id, a.status, a.state, JSON.stringify([entry])],
        );
        return "updated";
      }
      const name = [a.customer?.firstName, a.customer?.lastName]
        .filter(Boolean)
        .join(" ")
        .trim();
      await tx.query(
        "INSERT INTO channel_orders(id,organization_id,connection_id,channel,external_id,code,status,state,delivery_mode,payment_mode,total_minor,delivery_minor,customer_name,customer_phone,created_external,lines,history) VALUES($1,$2,$3,'kaspi',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
        [
          randomUUID(),
          conn.organization_id,
          conn.id,
          o.id,
          a.code.slice(0, 60),
          a.status,
          a.state,
          (a.deliveryMode || "").slice(0, 60),
          (a.paymentMode || "").slice(0, 60),
          total.toString(),
          delivery?.toString() ?? null,
          (name || "Покупатель Kaspi").slice(0, 120),
          (a.customer?.cellPhone || "").slice(0, 30),
          new Date(a.creationDate).toISOString(),
          JSON.stringify(lines),
          JSON.stringify([entry]),
        ],
      );
      return "created";
    });
  }
  private async lines(client: KaspiClient, orderId: string) {
    const out = [];
    for (const e of await client.entries(orderId)) {
      const p = await client.product(e.id);
      const price = tengeToMinor(e.attributes.basePrice),
        total = tengeToMinor(e.attributes.totalPrice);
      out.push({
        entryId: e.id,
        productCode: String(p.attributes.code).slice(0, 60),
        name: String(p.attributes.name).slice(0, 200),
        quantity: String(e.attributes.quantity),
        price_minor: price?.toString() ?? null,
        total_minor: total?.toString() ?? null,
      });
    }
    return out;
  }
  async orders(secret: Credential, org: string, id: string) {
    return this.db.transaction(async (tx) => {
      const s = await sessionAccess(tx, secret, org, "orders:read");
      const conn = await connectionFor(tx, org, id, "kaspi");
      if (s.branchId && s.branchId !== conn.settings.branchId)
        throw new AppError("FORBIDDEN", 403);
      return {
        items: await tx.query(
          "SELECT id,external_id,code,status,state,delivery_mode,payment_mode,total_minor::text,delivery_minor::text,customer_name,created_external,lines,history,sales_order_id,version FROM channel_orders WHERE organization_id=$1 AND connection_id=$2 ORDER BY created_external DESC LIMIT 100",
          [org, id],
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
        await connectionFor(tx, org, id, "kaspi", true),
      );
      return { ok: true };
    });
  }
  async runOnce() {
    for (const conn of await dueConnections(this.db, "kaspi", 15))
      await this.syncOrders(conn).catch(() => undefined);
    return {};
  }
}
