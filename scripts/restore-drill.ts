import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, platform, release } from "node:os";
import { Client } from "pg";
import {
  createPostgresDatabase,
  migrate,
  migrationPlan,
} from "../src/server/db/database";
import { Platform } from "../src/server/platform";
import { CommerceService } from "../src/server/commerce/service";
import { TelegramService } from "../src/server/integrations/telegram-service";
import {
  credentialsOf,
  type ConnectionRow,
} from "../src/server/integrations/common";
import { startCluster, pgBin } from "./pg-cluster";
import { seedLoadSet } from "./load/dataset";
import { backup, restore } from "./backup-lib";

// T053 / AC 17 restore drill on an isolated cluster: a real database is backed up (once while
// orders keep being written, once encrypted), corrupted/foreign targets and wrong keys are refused,
// the source database is dropped, and the backup is restored into a new database that is verified
// table by table (row count + md5 of every row) and used by the application again.
const steps: Record<string, unknown> = {};
const expectFail = async (
  name: string,
  fn: () => Promise<unknown>,
  code: string,
) => {
  try {
    await fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (!message.startsWith(code))
      throw Error(`${name}: expected ${code}, got ${message}`);
    steps[name] = `refused (${code})`;
    return;
  }
  throw Error(`${name}: expected ${code}, succeeded`);
};
const seconds = (t: number) => Math.round((Date.now() - t) / 100) / 10;
async function main() {
  process.env.INTEGRATION_ENCRYPTION_KEY ||= randomBytes(32).toString("base64");
  const cluster = await startCluster("restore-drill", { maxConnections: 60 });
  const admin = new Client({ connectionString: cluster.url() });
  await admin.connect();
  const dbUrl = (name: string) => cluster.url(name);
  try {
    for (const name of ["source", "restored", "busy", "recovered", "wrongkey"])
      await admin.query(`CREATE DATABASE ${name}`);
    let src = createPostgresDatabase(dbUrl("source"));
    await migrate(src);
    let t = Date.now();
    const set = await seedLoadSet(src, {
      skus: 300,
      orders: 400,
      concurrency: 6,
    });
    steps.seed = { seconds: seconds(t), counts: set.counts };
    // Encrypted integration credentials must survive and stay decryptable with the same key.
    const ownerUser = set.users.find((u) => u.role === "owner")!;
    const p = new Platform(src);
    const session = await p.login({
      email: ownerUser.email,
      password: ownerUser.password,
    });
    const telegram = await new TelegramService(src).configure(
      session.token,
      set.organizationId,
      {
        key: randomUUID(),
        botToken: "123456789:AAH-synthetic-token-restore-drill-0001",
        branchId: set.branches[0],
      },
    );
    // Backup 1 while orders keep being written: the manifest must describe the snapshot.
    const commerce = new CommerceService(src);
    let writing = true,
      written = 0;
    const writer = (async () => {
      while (writing) {
        await commerce.create(session.token, set.organizationId, {
          key: randomUUID(),
          branchId: set.branches[0],
          customerId: set.customers[0][written % set.customers[0].length],
          warehouseId: set.warehouses[0],
          dueDate: "2026-12-31",
          delivery: "pickup",
          note: "Запись во время резервного копирования",
          taxMode: "excluded",
          lines: [
            {
              itemId: set.items[written % 300],
              quantity: "1",
              unit: "pc",
              price: "100",
              discount: "0",
            },
          ],
        });
        written++;
      }
    })();
    t = Date.now();
    const live = await backup(dbUrl("source"), ".data/restore-drill-backups", {
      bin: pgBin,
    });
    steps.backupDuringWrites = {
      seconds: seconds(t),
      bytes: live.manifest.bytes,
      tables: Object.keys(live.manifest.tables).length,
    };
    writing = false;
    await writer;
    steps.ordersWrittenDuringBackup = written;
    // Quiescent state, reference figures, encrypted backup 2.
    const summary = await commerce.summary(
      session.token,
      set.organizationId,
      {},
    );
    const key = randomBytes(32);
    t = Date.now();
    const sealed = await backup(
      dbUrl("source"),
      ".data/restore-drill-backups",
      { bin: pgBin, key },
    );
    steps.encryptedBackup = {
      seconds: seconds(t),
      bytes: sealed.manifest.bytes,
      encrypted: sealed.manifest.encrypted,
    };
    // Refusals: non-empty target, tampered file, wrong key.
    const busy = createPostgresDatabase(dbUrl("busy"));
    await migrate(busy);
    await busy.close();
    await expectFail(
      "nonEmptyTarget",
      () => restore(live.file, dbUrl("busy"), { bin: pgBin }),
      "RESTORE_TARGET_NOT_EMPTY",
    );
    const tampered = `${sealed.file}.tampered`;
    await copyFile(sealed.file, tampered);
    await copyFile(`${sealed.file}.manifest.json`, `${tampered}.manifest.json`);
    const bytes = await readFile(tampered);
    bytes[bytes.length >> 1] ^= 0xff;
    await writeFile(tampered, bytes);
    await expectFail(
      "tamperedFile",
      () => restore(tampered, dbUrl("wrongkey"), { bin: pgBin, key }),
      "BACKUP_CHECKSUM_MISMATCH",
    );
    await expectFail(
      "wrongKey",
      () =>
        restore(sealed.file, dbUrl("wrongkey"), {
          bin: pgBin,
          key: randomBytes(32),
        }),
      "BACKUP_DECRYPT_FAILED",
    );
    // Restore of the backup taken under writes.
    t = Date.now();
    steps.restoreOfLiveBackup = {
      ...(await restore(live.file, dbUrl("restored"), { bin: pgBin })),
      seconds: seconds(t),
    };
    // Disaster: the source database is lost.
    await src.close();
    src = undefined as never;
    await admin.query("DROP DATABASE source WITH (FORCE)");
    steps.sourceDropped = true;
    t = Date.now();
    steps.restoreOfEncryptedBackup = {
      ...(await restore(sealed.file, dbUrl("recovered"), { bin: pgBin, key })),
      seconds: seconds(t),
    };
    // The application works on the recovered database.
    const recovered = createPostgresDatabase(dbUrl("recovered"));
    try {
      const plan = await migrationPlan(recovered);
      if (plan.pending.length || plan.unknown.length || plan.modified.length)
        throw Error("MIGRATION_STATE");
      await migrate(recovered);
      const p2 = new Platform(recovered);
      const s2 = await p2.login({
        email: ownerUser.email,
        password: ownerUser.password,
      });
      const summary2 = await new CommerceService(recovered).summary(
        s2.token,
        set.organizationId,
        {},
      );
      if (JSON.stringify(summary2) !== JSON.stringify(summary))
        throw Error("SUMMARY_MISMATCH");
      const [conn] = await recovered.query<ConnectionRow>(
        "SELECT * FROM integration_connections WHERE id=$1",
        [telegram.id],
      );
      const secret = credentialsOf<{ botToken: string }>(conn);
      if (
        secret.botToken !== "123456789:AAH-synthetic-token-restore-drill-0001"
      )
        throw Error("CREDENTIALS_MISMATCH");
      // A new business operation succeeds after recovery.
      await new CommerceService(recovered).create(
        s2.token,
        set.organizationId,
        {
          key: randomUUID(),
          branchId: set.branches[0],
          customerId: set.customers[0][0],
          warehouseId: set.warehouses[0],
          dueDate: "2026-12-31",
          delivery: "pickup",
          note: "Первая операция после восстановления",
          taxMode: "excluded",
          lines: [
            {
              itemId: set.items[1],
              quantity: "1",
              unit: "pc",
              price: "100",
              discount: "0",
            },
          ],
        },
      );
      steps.applicationAfterRecovery = {
        migrationsPending: 0,
        ownerLogin: "ok",
        financeSummaryEqualsSource: true,
        encryptedCredentialsReadable: true,
        newOrderAfterRecovery: "ok",
      };
    } finally {
      await recovered.close();
    }
    const report = {
      task: "T053",
      acceptance: "AC 17",
      date: new Date().toISOString(),
      environment: {
        os: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model,
        cores: cpus().length,
        node: process.version,
        postgres: live.manifest.server,
        pgDump: live.manifest.pgDump,
      },
      backups: {
        live: {
          file: live.manifest.file,
          bytes: live.manifest.bytes,
          migrations: live.manifest.migrations.length,
        },
        encrypted: { file: sealed.manifest.file, bytes: sealed.manifest.bytes },
      },
      steps,
      result: "PASS",
    };
    await mkdir("docs/evidence", { recursive: true });
    const out = `docs/evidence/restore-drill-${new Date().toISOString().slice(0, 10)}.json`;
    await writeFile(out, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(steps, null, 2));
    console.log(`Restore drill PASS. Report: ${out}`);
  } finally {
    await admin.end().catch(() => {});
    await cluster.stop();
    console.log(
      "Isolated cluster stopped; synthetic backups under .data/restore-drill-backups (ignored by git).",
    );
  }
}
main().catch((e) => {
  console.error(
    `RESTORE_DRILL_FAILED: ${e instanceof Error ? e.message : "unknown"}`,
  );
  process.exitCode = 1;
});
