import { spawn } from "node:child_process";
import { startCluster } from "./pg-cluster";

let interrupted = false;
let child: ReturnType<typeof spawn> | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    interrupted = true;
    child?.kill();
  });
const cluster = await startCluster("postgres-tests", {
  isInterrupted: () => interrupted,
});
try {
  if (interrupted) throw Error("TEST_INTERRUPTED");
  console.log(
    `Isolated PostgreSQL test cluster: PID ${cluster.pid}, loopback port ${cluster.port}. It will stop when tests finish.`,
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
      env: { ...process.env, SMB_POSTGRES_TEST_URL: cluster.url() },
    },
  );
  const code = await new Promise<number>((done) =>
    child!.once("exit", (code) => done(code ?? 1)).once("error", () => done(1)),
  );
  process.exitCode = code;
} finally {
  await cluster.stop();
  console.log(
    "Isolated PostgreSQL test cluster stopped; synthetic data retained under .data/postgres-tests-*.",
  );
}
