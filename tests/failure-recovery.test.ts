import { it, expect } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
const exec = promisify(execFile);
it("T050 kills only its own process mid-fulfillment, reopens durable storage, and replays a committed payment after a lost response", async () => {
  const env = {
    ...process.env,
    DATABASE_URL: "",
    LOCAL_DATABASE: "1",
    LOCAL_PREVIEW: "1",
    PGLITE_DATA_DIR: `.data/fault-${randomUUID()}`,
  };
  const args = ["--import", "tsx", "tests/helpers/operation-crash.ts"];
  const run = async (phase: string) =>
    (
      await exec(process.execPath, [...args, phase], {
        env,
        windowsHide: true,
        timeout: 25000,
      })
    ).stdout.trim();
  expect(await run("prepare")).toBe("prepared");
  const child = spawn(process.execPath, [...args, "crash"], {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Crash point timeout")),
        20000,
      );
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("transaction-open")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("Crash fixture exited before fault point"));
      });
    });
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
  expect(JSON.parse(await run("inspect"))).toMatchObject({
    state: "confirmed",
    revenue: "0",
    quantity: "10.000000",
    fulfillments: 0,
    payments: 0,
  });
  expect(JSON.parse(await run("recover"))).toMatchObject({
    state: "fulfilled",
    revenue: "1000",
    quantity: "9.000000",
    fulfillments: 1,
    payments: 0,
  });
  await expect(run("payment-lost")).rejects.toMatchObject({ code: 17 });
  for (let i = 0; i < 2; i++)
    expect(JSON.parse(await run("replay"))).toMatchObject({
      state: "fulfilled",
      paid: "1000",
      quantity: "9.000000",
      fulfillments: 1,
      payments: 1,
    });
}, 120000);
