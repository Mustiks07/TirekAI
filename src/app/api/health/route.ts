import { NextResponse } from "next/server";
import { getDatabase, migrationPlan } from "../../../server/db/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// T053 operations check for load balancers and monitoring. No authentication and no organization
// data: only whether the database answers, the schema state and the age of the worker heartbeat.
export async function GET() {
  try {
    const db = await getDatabase();
    const plan = await migrationPlan(db);
    const [beat] = await db.query<{ age: number | null }>(
      "SELECT extract(epoch FROM now()-max(seen_at))::int age FROM worker_heartbeat",
    );
    const schema =
      plan.pending.length || plan.unknown.length || plan.modified.length
        ? "mismatch"
        : "ok";
    const worker =
      beat?.age === null || beat?.age === undefined
        ? "unknown"
        : beat.age <= 30
          ? "ok"
          : "stale";
    return NextResponse.json(
      {
        status:
          schema === "ok" ? (worker === "ok" ? "ok" : "degraded") : "error",
        database: "ok",
        schema,
        migration: plan.applied.at(-1) ?? 0,
        pendingMigrations: plan.pending.length,
        worker,
        workerHeartbeatAgeSeconds: beat?.age ?? null,
      },
      {
        status: schema === "ok" ? 200 : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return NextResponse.json(
      { status: "error", database: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
