import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, totalmem, platform, release } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { createPostgresDatabase, migrate } from "../src/server/db/database";
import { startCluster, freePort, exec, pgBinary } from "./pg-cluster";
import { seedLoadSet, type LoadSet, type LoadUser } from "./load/dataset";
import { can } from "../src/domain/permissions";
import type { Role } from "../src/domain/contracts";

// T051 load measurement (SPECIFICATION §21): production build (`next start`) + worker against an
// isolated PostgreSQL cluster with the load set, N concurrent users (closed loop, no think time
// unless --think is given), each also polling the change cursor once a second like an open
// browser tab. Targets: reads p95 ≤ 1 s, internal commands p95 ≤ 2 s at 20 users. The numbers are
// measured here; nothing is assumed.
const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const DURATION = arg("duration", 60),
  USERS = arg("users", 20),
  SKUS = arg("skus", 1000),
  ORDERS = arg("orders", 2150),
  THINK = arg("think", 0);
type Sample = {
  name: string;
  kind: "read" | "command";
  ms: number;
  status: number;
};
const samples: Sample[] = [];
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b),
    q = (p: number) =>
      s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null;
  return {
    count: s.length,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: s.length ? s[s.length - 1] : null,
    mean: s.length
      ? Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10
      : null,
  };
};
async function main() {
  try {
    await access(".next/BUILD_ID");
  } catch {
    throw Error(
      "Run `npm run build` first; the load test uses the production build.",
    );
  }
  let server: ChildProcess | undefined, worker: ChildProcess | undefined;
  const cluster = await startCluster("load-tests", { maxConnections: 80 });
  const db = createPostgresDatabase(cluster.url());
  let set: LoadSet;
  const report: Record<string, unknown> = {};
  try {
    const [{ version: pgVersion }] = await db.query<{ version: string }>(
      "SELECT version()",
    );
    await migrate(db);
    console.log(`Seeding load set (${SKUS} SKU, ${ORDERS} orders)…`);
    set = await seedLoadSet(db, { skus: SKUS, orders: ORDERS });
    console.log(`Seeded in ${set.seconds} s:`, set.counts);
    const port = await freePort(),
      origin = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      NODE_ENV: "production" as const,
      DATABASE_URL: cluster.url(),
      DATABASE_POOL_MAX: "20",
      APP_ORIGIN: origin,
      LOCAL_PREVIEW: "",
      LOCAL_DATABASE: "",
    };
    server = spawn(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      { env, stdio: "ignore" },
    );
    worker = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "scripts/worker.ts"],
      {
        env,
        stdio: "ignore",
      },
    );
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${origin}/api/v1/session`)).ok) break;
      } catch {
        // starting
      }
      if (i > 120) throw Error("SERVER_NOT_READY");
      await sleep(500);
    }
    const sessions = await Promise.all(
      set.users
        .slice(0, USERS)
        .map(async (u) => ({ u, cookie: await login(origin, u) })),
    );
    // Orders created during the run, handed to managers (issue) and finance (payment).
    type Queued = { id: string; branch: number };
    const confirmed: Queued[][] = [[], []],
      issued: Queued[][] = [[], []];
    // Org-wide users take work from any branch; branch staff only from their own.
    const take = (queues: Queued[][], u: LoadUser, b: number) =>
      u.branchId ? queues[b].shift() : (queues[0].shift() ?? queues[1].shift());
    const deadline = performance.now() + DURATION * 1000;
    let stop = false;
    const call = async (
      cookie: string,
      name: string,
      kind: "read" | "command",
      path: string,
      body?: unknown,
    ) => {
      const t0 = performance.now();
      let status = 0,
        data: unknown = null;
      try {
        const r = await fetch(
          `${origin}/api/v1/organizations/${set.organizationId}/${path}`,
          {
            method: body === undefined ? "GET" : "POST",
            headers: {
              cookie,
              origin,
              ...(body === undefined
                ? {}
                : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
        );
        status = r.status;
        data = ((await r.json()) as { data?: unknown }).data ?? null;
      } catch {
        status = 0;
      }
      samples.push({ name, kind, ms: performance.now() - t0, status });
      return status >= 200 && status < 300
        ? (data as Record<string, unknown>)
        : null;
    };
    const branchOf = (u: LoadUser) =>
      u.branchId ? set.branches.indexOf(u.branchId) : 0;
    const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
    const scenario = async ({ u, cookie }: { u: LoadUser; cookie: string }) => {
      const b = branchOf(u),
        branch = set.branches[b],
        wh = set.warehouses[b];
      // Reads are chosen from what the role may actually see (server rights, not a guess).
      const role = u.role as Role,
        reads: [string, string][] = [];
      if (can(role, "orders:read"))
        reads.push([
          "orders.list",
          `orders?branchId=${branch}&page=${1 + Math.floor(Math.random() * 20)}`,
        ]);
      if (can(role, "catalog:read"))
        reads.push([
          "catalog.search",
          `catalog?q=${encodeURIComponent(`${1 + Math.floor(Math.random() * 99)}`)}&limit=25`,
        ]);
      if (can(role, "inventory:read"))
        reads.push([
          "inventory.balances",
          `inventory/balances?warehouseId=${wh}&page=${1 + Math.floor(Math.random() * 20)}`,
        ]);
      if (can(role, "finance:read"))
        reads.push(
          ["finance.summary", `finance/summary?branchId=${branch}`],
          ["finance.ledger", `finance/ledger?branchId=${branch}&page=1`],
          ["finance.calendar", `finance/calendar?branchId=${branch}&days=30`],
        );
      if (can(role, "insights:read")) reads.push(["today", "today"]);
      if (can(role, "customers:read"))
        reads.push(["customers.list", `customers?branchId=${branch}&page=1`]);
      if (can(role, "tasks:read")) reads.push(["tasks.list", "tasks"]);
      if (can(role, "knowledge:read"))
        reads.push(["knowledge.list", "knowledge"]);
      while (!stop && performance.now() < deadline) {
        const commandTurn = Math.random() < 0.3;
        if (commandTurn && ["sales", "owner"].includes(u.role)) {
          const lines = Array.from(
            { length: 1 + Math.floor(Math.random() * 2) },
            () => {
              const x =
                b === 1
                  ? 2 * Math.floor(Math.random() * (set.items.length / 2))
                  : Math.floor(Math.random() * set.items.length);
              return {
                itemId: set.items[x],
                quantity: "1",
                unit: "pc",
                price: "1000",
                discount: "0",
              };
            },
          ).filter(
            (l, i, a) => a.findIndex((m) => m.itemId === l.itemId) === i,
          );
          const o = await call(cookie, "order.create", "command", "orders", {
            key: randomUUID(),
            branchId: branch,
            customerId: pick(set.customers[b]),
            warehouseId: wh,
            dueDate: "2026-12-31",
            delivery: "pickup",
            note: "Нагрузка: заказ",
            taxMode: "excluded",
            lines,
          });
          if (o) {
            const c = await call(
              cookie,
              "order.confirm",
              "command",
              `orders/${o.id}/commands`,
              {
                key: randomUUID(),
                version: 1,
                kind: "confirm",
                note: "Нагрузка: резерв",
              },
            );
            if (c) confirmed[b].push({ id: String(o.id), branch: b });
          }
        } else if (
          commandTurn &&
          u.role === "manager" &&
          (u.branchId ? confirmed[b].length : confirmed.flat().length)
        ) {
          const o = take(confirmed, u, b)!;
          const view = await call(
            cookie,
            "order.get",
            "read",
            `orders/${o.id}`,
          );
          const order = view?.order as { version: number } | undefined,
            line = (
              view?.lines as { id: string; quantity: string }[] | undefined
            )?.[0];
          if (order && line) {
            const r = await call(
              cookie,
              "order.issue",
              "command",
              `orders/${o.id}/commands`,
              {
                key: randomUUID(),
                version: order.version,
                kind: "fulfill",
                lineId: line.id,
                quantity: line.quantity,
                note: "Нагрузка: выдача",
              },
            );
            if (r) issued[o.branch].push(o);
          }
        } else if (
          commandTurn &&
          u.role === "finance" &&
          (u.branchId ? issued[b].length : issued.flat().length)
        ) {
          const o = take(issued, u, b)!;
          await call(cookie, "money.payment", "command", "finance/commands", {
            key: randomUUID(),
            accountId: set.accounts[o.branch],
            orderId: o.id,
            kind: "payment",
            amount: "500",
            note: "Нагрузка: оплата",
          });
        } else if (commandTurn && u.role === "purchasing") {
          await call(cookie, "stock.receipt", "command", "stock-commands", {
            key: randomUUID(),
            kind: "receipt",
            warehouseId: wh,
            itemId: pick(
              b === 1 ? set.items.filter((_, i) => i % 2 === 0) : set.items,
            ),
            quantity: "10",
            unit: "pc",
            unitCost: "600",
            note: "Нагрузка: приход",
          });
        } else {
          const [name, path] = pick(reads);
          await call(cookie, name, "read", path);
        }
        if (THINK) await sleep(Math.random() * THINK * 2);
      }
    };
    // Open-tab polling: one change-cursor request per user per second.
    const pollers = sessions.map(async ({ cookie }) => {
      while (!stop && performance.now() < deadline) {
        await call(cookie, "changes", "read", "changes");
        await sleep(1000);
      }
    });
    const t0 = performance.now();
    await Promise.all([...sessions.map(scenario), ...pollers]);
    stop = true;
    const elapsed = (performance.now() - t0) / 1000;
    const ok = samples.filter((s) => s.status >= 200 && s.status < 300);
    const errors = samples.filter((s) => !(s.status >= 200 && s.status < 300));
    const byName: Record<string, unknown> = {};
    for (const name of [...new Set(samples.map((s) => s.name))].sort())
      byName[name] = {
        ...stats(ok.filter((s) => s.name === name).map((s) => s.ms)),
        errors: errors.filter((s) => s.name === name).length,
        statuses: [
          ...new Set(
            errors.filter((s) => s.name === name).map((s) => s.status),
          ),
        ],
      };
    const reads = stats(ok.filter((s) => s.kind === "read").map((s) => s.ms)),
      commands = stats(ok.filter((s) => s.kind === "command").map((s) => s.ms));
    const [{ n: auditRows }] = await db.query<{ n: string }>(
      "SELECT count(*)::text n FROM audit_events WHERE organization_id=$1",
      [set.organizationId],
    );
    const [check] = await db.query<{ negative: string; mismatch: string }>(
      "SELECT (SELECT count(*) FROM stock_balances WHERE organization_id=$1 AND (quantity<0 OR reserved>quantity))::text negative,(SELECT count(*) FROM money_accounts a WHERE a.organization_id=$1 AND a.balance_minor<>(SELECT coalesce(sum(amount_minor),0) FROM money_entries e WHERE e.organization_id=a.organization_id AND e.account_id=a.id))::text mismatch",
      [set.organizationId],
    );
    Object.assign(report, {
      task: "T051",
      date: new Date().toISOString(),
      environment: {
        os: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model,
        cores: cpus().length,
        memoryGb: Math.round(totalmem() / 2 ** 30),
        node: process.version,
        postgres: pgVersion.split(",")[0],
        pgBin: (await exec(pgBinary("postgres"), ["--version"])).stdout.trim(),
        app: "next start (production build), 1 web process, DATABASE_POOL_MAX=20; 1 worker process",
        network: "loopback; load generator on the same host",
        next: JSON.parse(
          await readFile("node_modules/next/package.json", "utf8"),
        ).version,
      },
      dataset: {
        skus: SKUS,
        branches: 2,
        warehouses: 2,
        users: set.users.length,
        customers: set.customers.flat().length,
        historyDays: 90,
        counts: set.counts,
        auditRowsAfterRun: Number(auditRows),
        seedSeconds: set.seconds,
        note: "Operations via application services; timestamps shifted back over 90 days afterwards (fixture backdating).",
      },
      run: {
        users: USERS,
        durationSeconds: Math.round(elapsed),
        thinkMs: THINK,
        mode: THINK
          ? "closed loop with think time"
          : "closed loop, no think time",
        changePollingPerUserSeconds: 1,
      },
      totals: {
        requests: samples.length,
        errors: errors.length,
        requestsPerSecond: Math.round((samples.length / elapsed) * 10) / 10,
      },
      reads,
      commands,
      byName,
      invariants: {
        negativeOrOverReservedBalances: Number(check.negative),
        accountsNotEqualToEntries: Number(check.mismatch),
      },
      targets: {
        readsP95Ms: 1000,
        commandsP95Ms: 2000,
        readsMet: reads.p95 !== null && reads.p95 <= 1000,
        commandsMet: commands.p95 !== null && commands.p95 <= 2000,
      },
    });
    await mkdir("docs/evidence", { recursive: true });
    const file = `docs/evidence/load-${new Date().toISOString().slice(0, 10)}-${USERS}u.json`;
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
    console.log(
      JSON.stringify(
        {
          reads,
          commands,
          totals: report.totals,
          invariants: report.invariants,
          targets: report.targets,
        },
        null,
        2,
      ),
    );
    console.log(`Report: ${file}`);
    const targets = report.targets as {
      readsMet: boolean;
      commandsMet: boolean;
    };
    if (!targets.readsMet || !targets.commandsMet || errors.length)
      process.exitCode = 2;
  } finally {
    server?.kill("SIGTERM");
    worker?.kill("SIGTERM");
    await db.close().catch(() => {});
    await cluster.stop();
    console.log(
      "Load server, worker and the isolated cluster stopped; synthetic data under .data/load-tests-*.",
    );
  }
}
async function login(origin: string, u: LoadUser) {
  const r = await fetch(`${origin}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: u.email, password: u.password }),
  });
  const cookie = r.headers.get("set-cookie")?.split(";")[0];
  if (!r.ok || !cookie) throw Error(`LOGIN_FAILED ${r.status}`);
  return cookie;
}
main().catch((error) => {
  console.error(
    "LOAD_TEST_FAILED:",
    error instanceof Error ? error.message : "unknown",
  );
  process.exitCode = 1;
});
