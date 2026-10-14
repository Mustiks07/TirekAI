import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  createPostgresDatabase,
  migrate,
  type Database,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { InventoryService } from "../src/server/inventory/service";
import { ImportService } from "../src/server/imports/service";
import { ImportWorker } from "../src/server/jobs/worker";
const url = process.env.SMB_POSTGRES_TEST_URL;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  new URL(url).username !== "smb_test"
)
  throw Error("Use npm run test:postgres to create an isolated cluster");
let db: Database,
  other: Database,
  p: Platform,
  owner: Awaited<ReturnType<Platform["register"]>>,
  org: string,
  branch: string,
  warehouse: string;
beforeAll(async () => {
  db = createPostgresDatabase(url!);
  other = createPostgresDatabase(url!);
  await migrate(db);
  p = new Platform(db);
  owner = await p.register({
    name: "Postgres Test",
    email: "pg@example.test",
    password: "Synthetic-Postgres-Password-661!",
  });
  org = (
    await p.createOrganization(owner.token, {
      name: "Concurrent Test",
      profile: "retail",
    })
  ).id;
  branch = (await p.workspace(owner.token, org)).branches[0].id;
  warehouse = (
    await new InventoryService(db).createWarehouse(owner.token, org, {
      name: "Concurrent warehouse",
      branchId: branch,
    })
  ).id;
});
afterAll(async () => {
  await db?.close();
  await other?.close();
});
const item = async () =>
  (
    await new InventoryService(db).saveItem(owner.token, org, {
      sku: randomUUID(),
      name_ru: "Postgres item",
      kind: "goods",
      base_unit: "pc",
      purchase_price: "100",
      sale_price: "200",
    })
  ).id!;
const command = (
  itemId: string,
  kind: string,
  extra: Record<string, unknown> = {},
) => ({
  key: randomUUID(),
  warehouseId: warehouse,
  itemId,
  kind,
  quantity: "1",
  unit: "pc",
  note: "Concurrent PostgreSQL test",
  ...extra,
});
it("runs all migrations on PostgreSQL without modifying applied history", async () => {
  await migrate(other);
  expect(
    await db.query("SELECT version FROM schema_migrations ORDER BY version"),
  ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
});
it("allows one reservation of the final unit through independent pools", async () => {
  const id = await item();
  await new InventoryService(db).execute(
    owner.token,
    org,
    command(id, "receipt", { unitCost: "100" }),
  );
  const results = await Promise.allSettled([
    new InventoryService(db).execute(owner.token, org, command(id, "reserve")),
    new InventoryService(other).execute(
      owner.token,
      org,
      command(id, "reserve"),
    ),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { code: "INSUFFICIENT_STOCK" },
  });
  const [b] = await db.query(
    "SELECT quantity::text,reserved::text FROM stock_balances WHERE item_id=$1",
    [id],
  );
  expect(b).toEqual({ quantity: "1.000000", reserved: "1.000000" });
});
it("deduplicates simultaneous receipt delivery across connections", async () => {
  const id = await item(),
    c = command(id, "receipt", { unitCost: "100" });
  const results = await Promise.all([
    new InventoryService(db).execute(owner.token, org, c),
    new InventoryService(other).execute(owner.token, org, c),
  ]);
  expect(results[0].id).toBe(results[1].id);
  expect(results.map((r) => r.reused).sort()).toEqual([false, true]);
  expect(
    await db.query("SELECT id FROM stock_movements WHERE item_id=$1", [id]),
  ).toHaveLength(1);
});
it("prevents stale inventory counts while another connection changes stock", async () => {
  const id = await item(),
    service = new InventoryService(db);
  await service.execute(
    owner.token,
    org,
    command(id, "receipt", { unitCost: "100" }),
  );
  const b = await service.snapshot(owner.token, org, {
    warehouseId: warehouse,
    itemId: id,
  });
  await new InventoryService(other).execute(
    owner.token,
    org,
    command(id, "receipt", { unitCost: "200" }),
  );
  await expect(
    service.execute(
      owner.token,
      org,
      command(id, "count", { version: b.version, quantity: "0" }),
    ),
  ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
});
async function queued(prefix: string) {
  const service = new ImportService(db);
  const batch = await service.upload(owner.token, org, {
    branchId: branch,
    filename: `${prefix}.csv`,
    delimiter: ",",
    content:
      "external_id,name,email,phone\n" +
      Array.from(
        { length: 31 },
        (_, i) => `${prefix}${i},Клиент ${i},${prefix}${i}@example.test,\n`,
      ).join(""),
  });
  await service.confirm(owner.token, org, batch.batch.id, {
    version: batch.batch.version,
  });
  return batch.batch.id;
}
it("dispatches and processes outbox jobs concurrently without duplicate customers", async () => {
  const a = await queued("alpha"),
    b = await queued("beta"),
    w1 = new ImportWorker(db),
    w2 = new ImportWorker(other);
  await Promise.all([w1.dispatch(), w2.dispatch()]);
  expect(
    await db.query("SELECT id FROM jobs WHERE batch_id=ANY($1::uuid[])", [
      [a, b],
    ]),
  ).toHaveLength(2);
  for (let i = 0; i < 4; i++) await Promise.all([w1.runOnce(), w2.runOnce()]);
  const result = await db.query(
    "SELECT source_batch_id,count(*)::int total FROM customers WHERE source_batch_id=ANY($1::uuid[]) GROUP BY source_batch_id",
    [[a, b]],
  );
  expect(result).toHaveLength(2);
  expect(result.every((r) => r.total === 31)).toBe(true);
  expect(
    await db.query(
      "SELECT id FROM outbox_events WHERE topic='import.completed' AND batch_id=ANY($1::uuid[])",
      [[a, b]],
    ),
  ).toHaveLength(2);
});
it("fences a stale lease when another connection reclaims the job", async () => {
  const id = await queued("lease"),
    w1 = new ImportWorker(db),
    w2 = new ImportWorker(other);
  await w1.dispatch();
  const old = await w1.claim();
  await other.query(
    "UPDATE jobs SET lease_until=now()-interval '1 second' WHERE batch_id=$1",
    [id],
  );
  const current = await w2.claim();
  expect(current?.lease_token).not.toBe(old?.lease_token);
  expect(await w1.process(old!)).toBe(false);
  await w2.process(current!);
  await w2.runOnce();
  expect(
    (await new ImportService(db).get(owner.token, org, id)).batch.imported,
  ).toBe(31);
});
it("rolls back an in-flight business write after terminating its database backend", async () => {
  const id = await item();
  const client = new Client({ connectionString: url });
  client.on("error", () => {});
  await client.connect();
  try {
    await client.query("BEGIN");
    const pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await client.query(
      "INSERT INTO stock_balances(organization_id,warehouse_id,item_id,quantity,value_minor) VALUES($1,$2,$3,7,70000)",
      [org, warehouse, id],
    );
    await other.query("SELECT pg_terminate_backend($1)", [pid]);
  } finally {
    await client.end().catch(() => {});
  }
  expect(
    await db.query("SELECT * FROM stock_balances WHERE item_id=$1", [id]),
  ).toHaveLength(0);
  await new InventoryService(db).execute(
    owner.token,
    org,
    command(id, "receipt", { unitCost: "100" }),
  );
  expect(
    await db.query(
      "SELECT quantity::text FROM stock_balances WHERE item_id=$1",
      [id],
    ),
  ).toEqual([{ quantity: "1.000000" }]);
});
