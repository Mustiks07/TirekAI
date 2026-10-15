import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, unlink, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { Client } from "pg";

// Isolated PostgreSQL cluster for checks (test:postgres, load test T051, restore drill T053).
// It lives under .data/<prefix>-*, listens on loopback with a random SCRAM password and is
// stopped with `pg_ctl -D <own dir>` — never a system service or another cluster.
export const exec = promisify(execFile);
export const pgBin =
  process.env.PG_BIN ||
  (process.platform === "win32"
    ? "C:/Program Files/PostgreSQL/18/bin"
    : "/usr/lib/postgresql/18/bin");
export const pgBinary = (name: string) =>
  join(pgBin, `${name}${process.platform === "win32" ? ".exe" : ""}`);
export async function freePort() {
  const socket = createServer();
  await new Promise<void>((done, fail) => {
    socket.once("error", fail);
    socket.listen(0, "127.0.0.1", done);
  });
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((done, fail) =>
    socket.close((e) => (e ? fail(e) : done())),
  );
  return port;
}
export type Cluster = {
  dir: string;
  port: number;
  pid: string;
  user: string;
  password: string;
  url: (database?: string) => string;
  stop: () => Promise<void>;
};
export async function startCluster(
  prefix: string,
  options: { maxConnections?: number; isInterrupted?: () => boolean } = {},
): Promise<Cluster> {
  await exec(pgBinary("postgres"), ["--version"], { windowsHide: true });
  await mkdir(".data", { recursive: true });
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(`.data/${prefix}-`));
  const user = "smb_test",
    password = randomBytes(32).toString("hex"),
    passwordFile = resolve(
      `.local/pg-password-${randomBytes(8).toString("hex")}`,
    );
  const port = await freePort();
  await writeFile(passwordFile, password, { mode: 0o600 });
  try {
    await exec(
      pgBinary("initdb"),
      [
        "-D",
        dir,
        `--username=${user}`,
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
  const stop = () =>
    (stopPromise ??= (async () => {
      const running = await exec(pgBinary("pg_ctl"), ["-D", dir, "status"], {
        windowsHide: true,
      }).then(
        () => true,
        (error: unknown) => {
          if ((error as { code?: number }).code === 3) return false;
          throw error;
        },
      );
      if (!running) return;
      await exec(pgBinary("pg_ctl"), ["-D", dir, "-m", "fast", "-w", "stop"], {
        windowsHide: true,
      });
    })());
  const url = (database = "postgres") =>
    `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;
  try {
    // pg_ctl uses a restricted Windows token; direct postgres rejects admin tokens.
    await new Promise<void>((done, fail) => {
      const launcher = spawn(
        pgBinary("pg_ctl"),
        [
          "-D",
          dir,
          "-l",
          join(dir, "server.log"),
          "-w",
          "-t",
          "30",
          "-o",
          // Linux packages default the Unix socket to a system directory; keep it inside the cluster.
          `-h 127.0.0.1 -p ${port} -c max_connections=${options.maxConnections ?? 30}${process.platform === "win32" ? "" : ` -k ${dir}`}`,
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
      if (options.isInterrupted?.()) throw Error("TEST_INTERRUPTED");
      const client = new Client({
        connectionString: url(),
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
    return { dir, port, pid, user, password, url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
