import { it, expect } from "vitest";
import {
  createMemoryDatabase,
  migrate,
  migrationPlan,
} from "../src/server/db/database";
import { migrations } from "../src/server/db/schema";

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
