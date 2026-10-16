import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "../../../../server/db/database";
import { VideoService } from "../../../../server/video/service";
import { readLimited } from "../../../../server/integrations/common";
import { AppError } from "../../../../domain/errors";
export const runtime = "nodejs";
// Processing-device API (T035): authenticated by the source's device token, accepts
// configuration reads, run lifecycle, heartbeats and aggregated events. The only image data is
// the live-view frame (T057), sent only while someone is watching and kept in memory only.
async function handle(request: NextRequest, action: string) {
  const svc = new VideoService(await getDatabase());
  const token =
    /^Device ([a-f0-9]{64})$/.exec(
      request.headers.get("authorization") || "",
    )?.[1] || null;
  const source = await svc.device(
    request.headers.get("x-source-id") || "",
    token,
  );
  if (request.method === "GET" && action === "config")
    return svc.deviceConfig(source);
  if (request.method !== "POST") throw new AppError("NOT_FOUND", 404);
  let body: unknown;
  try {
    // A live-view frame (JPEG in base64) is the only large body.
    body = JSON.parse(
      await readLimited(
        request,
        action === "preview" ? 1024 * 1024 : 512 * 1024,
      ),
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("INVALID_INPUT", 400);
  }
  if (action === "runs") return svc.startRun(source, body);
  if (action === "heartbeat") return svc.heartbeat(source, body);
  if (action === "events") return svc.ingest(source, body);
  if (action === "end") return svc.endRun(source, body);
  if (action === "preview") return svc.preview(source, body);
  throw new AppError("NOT_FOUND", 404);
}
async function respond(
  request: NextRequest,
  params: Promise<{ action: string }>,
) {
  try {
    return NextResponse.json(await handle(request, (await params).action), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    return NextResponse.json(
      {
        error:
          error instanceof AppError
            ? error.code
            : error instanceof Error && error.name === "ZodError"
              ? "INVALID_INPUT"
              : "INTERNAL_ERROR",
      },
      {
        status:
          error instanceof Error && error.name === "ZodError" ? 400 : status,
      },
    );
  }
}
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ action: string }> },
) {
  return respond(request, params);
}
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ action: string }> },
) {
  return respond(request, params);
}
