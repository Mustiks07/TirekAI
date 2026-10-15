import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Client } from "pg";

// T053 backup/restore. A backup is a pg_dump (custom format) taken from an exported snapshot;
// inside the same snapshot every table is fingerprinted (row count + md5 of all rows), so the
// manifest describes exactly what the dump contains even while the application keeps writing.
// Restore goes only into an empty database and is accepted when every fingerprint matches.
// Passwords travel in the child environment (PGPASSWORD), never in arguments or logs.
const MAGIC = Buffer.from("BSQBKP1\n");
export type TableFingerprint = { rows: number; md5: string };
export type Manifest = {
  format: 1;
  createdAt: string;
  file: string;
  bytes: number;
  sha256: string;
  encrypted: boolean;
  server: string;
  pgDump: string;
  migrations: { version: number; checksum: string }[];
  tables: Record<string, TableFingerprint>;
};
export function pgEnv(url: string, bin?: string) {
  const u = new URL(url);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1) || "postgres"),
    ...(bin ? { PATH: `${bin}:${process.env.PATH}` } : {}),
  };
}
const tool = (name: string, bin?: string) =>
  bin
    ? join(bin, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<string>((done, fail) => {
    const child = spawn(cmd, args, { env, windowsHide: true });
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.once("error", fail);
    child.once("exit", (code) =>
      code === 0
        ? done(out)
        : // stderr of pg tools has no password (it is in the environment); keep only the first line.
          fail(
            Error(
              `${basename(cmd)}_FAILED ${err.split("\n")[0].slice(0, 200)}`,
            ),
          ),
    );
  });
}
export async function fingerprints(client: Client) {
  // Text form of timestamps must not depend on the session settings.
  await client.query("SET TIME ZONE 'UTC'");
  await client.query("SET DateStyle = 'ISO, YMD'");
  const tables = (
    await client.query<{ t: string }>(
      "SELECT tablename t FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows.map((r) => r.t);
  const out: Record<string, TableFingerprint> = {};
  for (const t of tables) {
    const [r] = (
      await client.query<{ n: string; h: string }>(
        `SELECT count(*)::text n, md5(coalesce(string_agg(x::text, E'\\n' ORDER BY x::text), '')) h FROM public."${t.replace(/"/g, '""')}" x`,
      )
    ).rows;
    out[t] = { rows: Number(r.n), md5: r.h };
  }
  return out;
}
export function encryptionKey() {
  const raw = process.env.BACKUP_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw Error("BACKUP_ENCRYPTION_KEY_INVALID");
  return key;
}
async function sha256(file: string) {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}
export async function backup(
  url: string,
  outDir: string,
  options: { bin?: string; key?: Buffer | null } = {},
) {
  await mkdir(outDir, { recursive: true });
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const [{ snapshot }] = (
      await client.query<{ snapshot: string }>(
        "SELECT pg_export_snapshot() snapshot",
      )
    ).rows;
    const [{ server }] = (
      await client.query<{ server: string }>("SELECT version() server")
    ).rows;
    const migrations = (
      await client.query<{ version: number; checksum: string }>(
        "SELECT version,checksum FROM schema_migrations ORDER BY version",
      )
    ).rows;
    const tables = await fingerprints(client);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const top = migrations.at(-1)?.version ?? 0;
    const plain = resolve(outDir, `basqaru-${stamp}-m${top}.dump`);
    const env = pgEnv(url, options.bin);
    const pgDump = (
      await run(tool("pg_dump", options.bin), ["--version"], env)
    ).trim();
    await run(
      tool("pg_dump", options.bin),
      [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        `--snapshot=${snapshot}`,
        `--file=${plain}`,
      ],
      env,
    );
    await client.query("COMMIT");
    let file = plain;
    if (options.key) {
      file = `${plain}.enc`;
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", options.key, iv),
        out = createWriteStream(file, { mode: 0o600 });
      out.write(Buffer.concat([MAGIC, iv]));
      await pipeline(createReadStream(plain), cipher, out, { end: false });
      await new Promise<void>((done, fail) =>
        out.end(cipher.getAuthTag(), () => done()).once("error", fail),
      );
      await unlink(plain);
    }
    const manifest: Manifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      file: basename(file),
      bytes: (await stat(file)).size,
      sha256: await sha256(file),
      encrypted: Boolean(options.key),
      server: server.split(",")[0],
      pgDump,
      migrations,
      tables,
    };
    await writeFile(
      `${file}.manifest.json`,
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600 },
    );
    return { file, manifest };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
async function decrypt(file: string, key: Buffer, target: string) {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size,
      head = Buffer.alloc(MAGIC.length + 12),
      tag = Buffer.alloc(16);
    await handle.read(head, 0, head.length, 0);
    await handle.read(tag, 0, 16, size - 16);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC))
      throw Error("BACKUP_FORMAT");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      head.subarray(MAGIC.length),
    );
    decipher.setAuthTag(tag);
    const input: ReadStream = createReadStream(file, {
      start: head.length,
      end: size - 17,
    });
    await pipeline(input, decipher, createWriteStream(target, { mode: 0o600 }));
  } catch (error) {
    await unlink(target).catch(() => {});
    throw (error as Error).message?.startsWith("BACKUP_")
      ? error
      : Error("BACKUP_DECRYPT_FAILED");
  } finally {
    await handle.close();
  }
}
export async function restore(
  file: string,
  targetUrl: string,
  options: { bin?: string; key?: Buffer | null } = {},
) {
  const manifest = JSON.parse(
    await readFile(`${file}.manifest.json`, "utf8"),
  ) as Manifest;
  if ((await sha256(file)) !== manifest.sha256)
    throw Error("BACKUP_CHECKSUM_MISMATCH");
  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  let plain = file,
    temporary = false;
  try {
    // Never overwrite data: the target must be an empty database.
    const [{ n }] = (
      await client.query<{ n: string }>(
        "SELECT count(*)::text n FROM pg_tables WHERE schemaname='public'",
      )
    ).rows;
    if (n !== "0") throw Error("RESTORE_TARGET_NOT_EMPTY");
    if (manifest.encrypted) {
      if (!options.key) throw Error("BACKUP_ENCRYPTION_KEY_REQUIRED");
      await mkdir(".local", { recursive: true });
      plain = resolve(`.local/restore-${randomBytes(8).toString("hex")}.dump`);
      temporary = true;
      await decrypt(file, options.key, plain);
    }
    await run(
      tool("pg_restore", options.bin),
      [
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "--single-transaction",
        `--dbname=${pgEnv(targetUrl).PGDATABASE}`,
        plain,
      ],
      pgEnv(targetUrl, options.bin),
    );
    const restored = await fingerprints(client);
    const mismatched = [
      ...new Set([...Object.keys(manifest.tables), ...Object.keys(restored)]),
    ].filter(
      (t) =>
        restored[t]?.rows !== manifest.tables[t]?.rows ||
        restored[t]?.md5 !== manifest.tables[t]?.md5,
    );
    const migrations = (
      await client.query<{ version: number; checksum: string }>(
        "SELECT version,checksum FROM schema_migrations ORDER BY version",
      )
    ).rows;
    const migrationsMatch =
      JSON.stringify(migrations) === JSON.stringify(manifest.migrations);
    if (mismatched.length || !migrationsMatch)
      throw Error(`RESTORE_VERIFY_FAILED ${mismatched.join(",")}`);
    return {
      tables: Object.keys(restored).length,
      rows: Object.values(restored).reduce((a, t) => a + t.rows, 0),
      migrations: migrations.length,
    };
  } finally {
    if (temporary) await unlink(plain).catch(() => {});
    await client.end();
  }
}
