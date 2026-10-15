import type { Database } from "../db/database";
import { Bitrix24Service } from "./bitrix24-service";
import { OneCService } from "./onec-service";
import { TelegramService } from "./telegram-service";
import { KaspiService } from "./kaspi-service";

// Worker entry for the T031–T034 adapters. One failing adapter never stops the others; its
// failure is already recorded in sync_runs and on the connection.
export async function runConnectors(db: Database) {
  const out: Record<string, unknown> = {};
  for (const [name, run] of [
    ["bitrix24", () => new Bitrix24Service(db).runOnce()],
    ["onec", () => new OneCService(db).runOnce()],
    ["telegram", () => new TelegramService(db).runOnce()],
    ["kaspi", () => new KaspiService(db).runOnce()],
  ] as const)
    out[name] = await run().catch(() => "failed");
  return out;
}
