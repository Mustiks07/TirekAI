import type { Database } from "../db/database";
import { Bitrix24Service } from "./bitrix24-service";

// Worker entry for the T031–T034 adapters. One failing adapter never stops the others; its
// failure is already recorded in sync_runs and on the connection.
export async function runConnectors(db: Database) {
  const out: Record<string, unknown> = {};
  for (const [name, run] of [
    ["bitrix24", () => new Bitrix24Service(db).runOnce()],
  ] as const)
    out[name] = await run().catch(() => "failed");
  return out;
}
