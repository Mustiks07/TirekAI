import { it, expect } from "vitest";
import {
  createMemoryDatabase,
  migrate,
  migrationPlan,
} from "../src/server/db/database";
import { migrations } from "../src/server/db/schema";
import { randomUUID } from "node:crypto";
import { Platform } from "../src/server/platform";
import { ImportService } from "../src/server/imports/service";
import { batchViewSchema } from "../src/domain/import-contracts";

// T053: migrations are atomic per version, forward-only and checked against released SQL.
it("T053: a failing migration leaves no partial schema and no version row; a fixed release applies", async () => {
  const db = await createMemoryDatabase();
  try {
    const good = { version: 1, sql: "CREATE TABLE a (id int PRIMARY KEY);" },
      broken = {
        version: 2,
        sql: "CREATE TABLE b (id int PRIMARY KEY); INSERT INTO missing_table VALUES (1);",
      };
    await expect(migrate(db, [good, broken])).rejects.toThrow();
    const tables = async () =>
      (
        await db.query<{ t: string }>(
          "SELECT table_name t FROM information_schema.tables WHERE table_schema='public' ORDER BY 1",
        )
      ).map((r) => r.t);
    expect(await tables()).toEqual(["a", "schema_migrations"]);
    expect(await migrationPlan(db, [good, broken])).toEqual({
      applied: [1],
      pending: [2],
      modified: [],
      unknown: [],
    });
    const fixed = { version: 2, sql: "CREATE TABLE b (id int PRIMARY KEY);" };
    await migrate(db, [good, fixed]);
    expect(await tables()).toEqual(["a", "b", "schema_migrations"]);
    // A released migration must not change; a database ahead of the code is reported.
    await expect(
      migrate(db, [{ version: 1, sql: "CREATE TABLE a2 (id int);" }, fixed]),
    ).rejects.toThrow("Applied migration was modified");
    expect(await migrationPlan(db, [good])).toMatchObject({
      modified: [],
      unknown: [2],
    });
  } finally {
    await db.close();
  }
});
it("T053: migration 25 repairs the raw CSV and unreadable row left by pre-25 erasure", async () => {
  const db = await createMemoryDatabase();
  try {
    await migrate(
      db,
      migrations.filter((m) => m.version <= 24),
    );
    const p = new Platform(db);
    const user = await p.register({
      name: "Upgrade test",
      email: `${randomUUID()}@example.test`,
      password: "Synthetic-Upgrade-661!",
    });
    const org = (
      await p.createOrganization(user.token, {
        name: "Upgrade",
        profile: "retail",
      })
    ).id;
    const branch = (await p.workspace(user.token, org)).branches[0].id;
    const batch = randomUUID(),
      customer = randomUUID();
    await db.query(
      "INSERT INTO import_batches(id,organization_id,branch_id,created_by,filename,file_hash,source_content,state) VALUES($1,$2,$3,$4,'old.csv','old-hash','private-upgrade@example.test','completed')",
      [batch, org, branch, user.user.id],
    );
    await db.query(
      "INSERT INTO customers(id,organization_id,branch_id,external_id,name,email,phone,source_batch_id,source_row,erased_at) VALUES($1,$2,$3,$4,'Removed','','',$5,2,now())",
      [customer, org, branch, `erased:${customer}`, batch],
    );
    await db.query(
      "INSERT INTO import_rows(organization_id,batch_id,row_number,data,status,customer_id) VALUES($1,$2,2,'{}','imported',$3)",
      [org, batch, customer],
    );
    await migrate(db);
    const view = batchViewSchema.parse(
      JSON.parse(
        JSON.stringify(await new ImportService(db).get(user.token, org, batch)),
      ),
    );
    expect(view.rows[0]).toMatchObject({
      status: "imported",
      values: { external_id: "", name: "", email: "", phone: "" },
      errors: ["SUBJECT_ERASED"],
    });
    expect(
      await db.query(
        "SELECT source_content,file_hash FROM import_batches WHERE id=$1",
        [batch],
      ),
    ).toEqual([{ source_content: "", file_hash: "old-hash" }]);
  } finally {
    await db.close();
  }
});
it("T053: the real migration chain applies from scratch and a second run is a no-op", async () => {
  const db = await createMemoryDatabase();
  try {
    await migrate(db);
    const plan = await migrationPlan(db);
    expect(plan.pending).toEqual([]);
    expect(plan.applied).toEqual(migrations.map((m) => m.version));
    // Versions are contiguous; each release adds the next number.
    expect(plan.applied).toEqual(
      Array.from({ length: migrations.length }, (_, i) => i + 1),
    );
    await migrate(db);
    expect((await migrationPlan(db)).applied).toEqual(plan.applied);
  } finally {
    await db.close();
  }
});
