import { backup, encryptionKey } from "./backup-lib";

// `npm run db:backup [-- --out <dir>]`: consistent backup of DATABASE_URL with a verified manifest.
// With BACKUP_ENCRYPTION_KEY (32 bytes, base64) the dump is encrypted with AES-256-GCM.
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw Error("DATABASE_URL_REQUIRED");
  const i = process.argv.indexOf("--out");
  const out = i >= 0 ? process.argv[i + 1] : ".data/backups";
  const started = Date.now();
  const r = await backup(url, out, {
    bin: process.env.PG_BIN,
    key: encryptionKey(),
  });
  const rows = Object.values(r.manifest.tables).reduce((a, t) => a + t.rows, 0);
  console.log(
    `Backup ${r.manifest.file}: ${r.manifest.bytes} bytes, ${Object.keys(r.manifest.tables).length} tables, ${rows} rows, migrations up to ${r.manifest.migrations.at(-1)?.version ?? 0}, ${r.manifest.encrypted ? "encrypted" : "NOT encrypted"}, ${Math.round((Date.now() - started) / 100) / 10} s.`,
  );
}
main().catch((e) => {
  console.error(
    `BACKUP_FAILED: ${e instanceof Error ? e.message.split(" ")[0] : "unknown"}`,
  );
  process.exitCode = 1;
});
