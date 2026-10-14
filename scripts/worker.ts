import { setTimeout } from "node:timers/promises";
import { createPostgresDatabase } from "../src/server/db/database";
import { ImportWorker } from "../src/server/jobs/worker";
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
  });
const local = process.env.LOCAL_DATABASE === "1";
if (!local && !process.env.DATABASE_URL)
  throw new Error("DATABASE_URL required");
if (
  local &&
  (!process.env.LOCAL_WORKER_SECRET ||
    !process.env.APP_ORIGIN ||
    !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(process.env.APP_ORIGIN))
)
  throw new Error("Local supervisor required");
const db = local ? null : createPostgresDatabase(process.env.DATABASE_URL!);
const worker = db ? new ImportWorker(db) : null;
console.log(`Import worker started (PID ${process.pid}); stop with Ctrl+C.`);
let unavailable = false;
while (!stopping) {
  try {
    if (worker) await worker.runOnce();
    else {
      const response = await fetch(
        `${process.env.APP_ORIGIN}/api/internal/worker`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${process.env.LOCAL_WORKER_SECRET}`,
          },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) throw new Error("WORKER_UNAVAILABLE");
    }
    if (unavailable) console.log("Import worker connection restored.");
    unavailable = false;
  } catch {
    if (!unavailable)
      console.warn(
        "Import worker unavailable; retrying locally. No job data logged.",
      );
    unavailable = true;
  }
  if (!stopping) await setTimeout(1000);
}
await db?.close();
