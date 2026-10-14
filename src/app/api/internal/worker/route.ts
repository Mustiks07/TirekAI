import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "../../../../server/db/database";
import { ImportWorker } from "../../../../server/jobs/worker";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const expected = process.env.LOCAL_WORKER_SECRET || "";
  const actual =
    request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
  if (
    process.env.LOCAL_PREVIEW !== "1" ||
    process.env.LOCAL_DATABASE !== "1" ||
    !expected ||
    !["localhost", "127.0.0.1", "[::1]"].includes(request.nextUrl.hostname) ||
    Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  )
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  try {
    return NextResponse.json(
      await new ImportWorker(await getDatabase()).runOnce(),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "WORKER_UNAVAILABLE" }, { status: 503 });
  }
}
