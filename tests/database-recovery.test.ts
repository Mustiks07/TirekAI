import { it, expect, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { getDatabase } from "../src/server/db/database";
import { migrations } from "../src/server/db/schema";
it("T050 retries configuration and checksum failures after releasing only its own database lock", async () => {
  const cache = globalThis as unknown as {
    smbDatabase?: ReturnType<typeof getDatabase>;
  };
  const dir = `.data/startup-recovery-${randomUUID()}`;
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("LOCAL_DATABASE", "0");
  vi.stubEnv("LOCAL_PREVIEW", "0");
  vi.stubEnv("PGLITE_DATA_DIR", dir);
  try {
    await expect(getDatabase()).rejects.toThrow("Configure DATABASE_URL");
    vi.stubEnv("LOCAL_DATABASE", "1");
    vi.stubEnv("LOCAL_PREVIEW", "1");
    const db = await getDatabase();
    await db.query(
      "UPDATE schema_migrations SET checksum='synthetic-invalid' WHERE version=1",
    );
    await db.close();
    delete cache.smbDatabase;
    await expect(getDatabase()).rejects.toThrow(
      "Applied migration was modified",
    );
    // Repair this isolated test's deliberately damaged metadata; released SQL files are unchanged.
    const repair = new PGlite(dir);
    await repair.query(
      "UPDATE schema_migrations SET checksum=$1 WHERE version=1",
      [createHash("sha256").update(migrations[0].sql).digest("hex")],
    );
    await repair.close();
    const recovered = await getDatabase();
    try {
      expect(
        await recovered.query("SELECT version FROM schema_migrations"),
      ).toHaveLength(migrations.length);
    } finally {
      await recovered.close();
    }
  } finally {
    delete cache.smbDatabase;
    vi.unstubAllEnvs();
  }
}, 30000);
