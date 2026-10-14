import { spawn } from "node:child_process";
const port = process.env.PORT || "3000";
const mode = process.argv[2] === "start" ? "start" : "dev";
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
    env: {
      ...process.env,
      LOCAL_DATABASE: process.env.DATABASE_URL ? "0" : "1",
      LOCAL_PREVIEW: "1",
      APP_ORIGIN: `http://127.0.0.1:${port}`,
    },
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
