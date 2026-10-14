import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
it("persists and resumes an unfinished import across independent OS processes", async () => {
  const env = {
    ...process.env,
    DATABASE_URL: "",
    LOCAL_DATABASE: "1",
    LOCAL_PREVIEW: "1",
    PGLITE_DATA_DIR: `.data/restart-${randomUUID()}`,
  };
  const run = async (phase: string) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          ["--import", "tsx", "tests/helpers/import-restart.ts", phase],
          { env },
        )
      ).stdout.trim(),
    );
  expect(await run("prepare")).toEqual({ customers: 25, state: "running" });
  expect(await run("resume")).toEqual({ customers: 31, state: "completed" });
  expect(await run("resume")).toEqual({ customers: 31, state: "completed" });
}, 30000);
