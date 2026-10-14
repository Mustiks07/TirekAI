import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, unlink, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { Client } from "pg";
const exec = promisify(execFile);
const bin =
  process.env.PG_BIN ||
  (process.platform === "win32"
    ? "C:/Program Files/PostgreSQL/18/bin"
    : "/usr/lib/postgresql/18/bin");
const binary = (name: string) =>
  join(bin, `${name}${process.platform === "win32" ? ".exe" : ""}`);
await exec(binary("postgres"), ["--version"], { windowsHide: true });
await mkdir(".data", { recursive: true });
await mkdir(".local", { recursive: true });
const dir = await mkdtemp(resolve(".data/postgres-tests-"));
const password = randomBytes(32).toString("hex"),
  passwordFile = resolve(
    `.local/pg-password-${randomBytes(8).toString("hex")}`,
  );
const socket = createServer();
await new Promise<void>((done, fail) => {
  socket.once("error", fail);
  socket.listen(0, "127.0.0.1", done);
});
const port = (socket.address() as { port: number }).port;
await new Promise<void>((done, fail) =>
  socket.close((e) => (e ? fail(e) : done())),
);
await writeFile(passwordFile, password, { mode: 0o600 });
try {
  await exec(
    binary("initdb"),
    [
      "-D",
      dir,
      "--username=smb_test",
      "--auth=scram-sha-256",
      `--pwfile=${passwordFile}`,
      "--encoding=UTF8",
      "--locale=C",
    ],
    { windowsHide: true },
  );
} finally {
  await unlink(passwordFile);
}
let stopPromise: Promise<void> | undefined;
function stop() {
  return (stopPromise ??= (async () => {
    const running = await exec(binary("pg_ctl"), ["-D", dir, "status"], {
      windowsHide: true,
    }).then(
      () => true,
      (error: unknown) => {
        if ((error as { code?: number }).code === 3) return false;
        throw error;
      },
    );
    if (!running) return;
    await exec(binary("pg_ctl"), ["-D", dir, "-m", "fast", "-w", "stop"], {
      windowsHide: true,
    });
  })());
}
let interrupted = false;
let child: ReturnType<typeof spawn> | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    interrupted = true;
    child?.kill();
  });
const connectionString = `postgresql://smb_test:${password}@127.0.0.1:${port}/postgres`;
try {
  // pg_ctl uses a restricted Windows token; direct postgres rejects admin tokens.
  await new Promise<void>((done, fail) => {
    const launcher = spawn(
      binary("pg_ctl"),
      [
        "-D",
        dir,
        "-l",
        join(dir, "server.log"),
        "-w",
        "-t",
        "30",
        "-o",
        // Linux packages default the Unix socket to a system directory; keep it inside the temporary cluster.
        `-h 127.0.0.1 -p ${port} -c max_connections=30${process.platform === "win32" ? "" : ` -k ${dir}`}`,
        "start",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    launcher.once("error", fail);
    launcher.once("exit", (code) =>
      code === 0
        ? done()
        : fail(
            Error(
              `TEST_DATABASE_START_FAILED: inspect ${join(dir, "server.log")}`,
            ),
          ),
    );
  });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (interrupted) throw Error("TEST_INTERRUPTED");
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: 500,
    });
    try {
      await client.connect();
      ready = true;
    } catch {
      // The server may still be accepting its first connection.
    } finally {
      await client.end();
    }
    if (ready) break;
    await setTimeout(250);
  }
  if (!ready) throw Error("TEST_DATABASE_NOT_READY");
  const pid = (await readFile(join(dir, "postmaster.pid"), "utf8")).split(
    /\r?\n/,
  )[0];
  if (interrupted) throw Error("TEST_INTERRUPTED");
  console.log(
    `Isolated PostgreSQL test cluster: PID ${pid}, loopback port ${port}. It will stop when tests finish.`,
  );
  child = spawn(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "vitest.postgres.config.ts",
    ],
    {
      windowsHide: true,
      stdio: "inherit",
      env: { ...process.env, SMB_POSTGRES_TEST_URL: connectionString },
    },
  );
  const code = await new Promise<number>((done) =>
    child!.once("exit", (code) => done(code ?? 1)).once("error", () => done(1)),
  );
  process.exitCode = code;
} finally {
  await stop();
  console.log(
    "Isolated PostgreSQL test cluster stopped; synthetic data retained under .data/postgres-tests-*.",
  );
}
