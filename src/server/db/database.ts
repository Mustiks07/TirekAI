import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { migrations } from "./schema";

export interface Sql {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
}
export interface Database extends Sql {
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function migrate(db: Database) {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const migration of migrations) {
    const checksum = createHash("sha256").update(migration.sql).digest("hex");
    const [existing] = await db.query<{ checksum: string }>(
      "SELECT checksum FROM schema_migrations WHERE version=$1",
      [migration.version],
    );
    if (existing && existing.checksum !== checksum)
      throw new Error(
        "Applied migration was modified. Add a new migration instead.",
      );
    if (!existing)
      await db.transaction(async (tx) => {
        await tx.query(migration.sql);
        await tx.query(
          "INSERT INTO schema_migrations(version, checksum) VALUES($1,$2)",
          [migration.version, checksum],
        );
      });
  }
}
export async function createMemoryDatabase(): Promise<Database> {
  return wrapPglite(new PGlite());
}
function wrapPglite(pg: PGlite, release?: () => Promise<void>): Database {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      if (
        !params.length &&
        sql
          .trim()
          .split(";")
          .filter((v) => v.trim()).length > 1
      ) {
        await pg.exec(sql);
        return [] as T[];
      }
      return (await pg.query<T>(sql, params)).rows;
    },
    transaction: (fn) =>
      pg.transaction((tx) =>
        fn({
          async query<T>(sql: string, params: unknown[] = []) {
            if (
              !params.length &&
              sql
                .trim()
                .split(";")
                .filter((v) => v.trim()).length > 1
            ) {
              await tx.exec(sql);
              return [] as T[];
            }
            return (await tx.query<T>(sql, params)).rows;
          },
        }),
      ),
    async close() {
      await pg.close();
      await release?.();
    },
  };
}
export function createPostgresDatabase(url: string): Database {
  const pool = new Pool({ connectionString: url, max: 10 });
  const wrap = (client: Pool | PoolClient): Sql => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await client.query(sql, params);
      return (Array.isArray(result) ? [] : result.rows) as T[];
    },
  });
  return {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(wrap(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
async function createLocalDatabase(): Promise<Database> {
  const dir = resolve(
    /* turbopackIgnore: true */ process.env.PGLITE_DATA_DIR || ".data/local",
  );
  await mkdir(dir, { recursive: true });
  const lockPath = resolve(dir, ".process-lock");
  try {
    const lock = await open(lockPath, "wx");
    await lock.writeFile(String(process.pid));
    await lock.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(await readFile(lockPath, "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === "ESRCH") alive = false;
    }
    if (alive)
      throw new Error(
        "Local database is already open. Stop its server before starting another process.",
      );
    await unlink(lockPath);
    const lock = await open(lockPath, "wx");
    await lock.writeFile(String(process.pid));
    await lock.close();
  }
  const db = wrapPglite(new PGlite(dir), () => unlink(lockPath));
  await migrate(db);
  return db;
}
const globalDb = globalThis as unknown as { smbDatabase?: Promise<Database> };
export function getDatabase(): Promise<Database> {
  if (!globalDb.smbDatabase) {
    globalDb.smbDatabase = (async () => {
      if (process.env.DATABASE_URL)
        return createPostgresDatabase(process.env.DATABASE_URL);
      if (
        process.env.LOCAL_DATABASE === "1" &&
        process.env.LOCAL_PREVIEW === "1"
      )
        return createLocalDatabase();
      throw new Error(
        "Configure DATABASE_URL or start the explicit local preview.",
      );
    })();
  }
  return globalDb.smbDatabase;
}
