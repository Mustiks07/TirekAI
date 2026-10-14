import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
const port = process.env.PORT || "3000";
const mode = process.argv[2] === "start" ? "start" : "dev";
const env = {
  ...process.env,
  LOCAL_DATABASE: process.env.DATABASE_URL ? "0" : "1",
  LOCAL_PREVIEW: "1",
  APP_ORIGIN: `http://127.0.0.1:${port}`,
  LOCAL_WORKER_SECRET: randomBytes(32).toString("hex"),
};
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    mode,
    "--hostname",
    "127.0.0.1",
    "--port",
    port,
  ],
  {
    stdio: "inherit",
    env,
  },
);
const worker =
  process.env.WORKER_DISABLED === "1"
    ? null
    : spawn(process.execPath, ["--import", "tsx", "scripts/worker.ts"], {
        stdio: "inherit",
        env,
      });
let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
  worker?.kill(signal);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => stop(signal));
child.on("exit", () => stop());
worker?.on("exit", () => stop());
