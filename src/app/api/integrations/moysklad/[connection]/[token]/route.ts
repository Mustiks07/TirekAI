import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "../../../../../../server/db/database";
import { IntegrationService } from "../../../../../../server/integrations/service";
import { AppError } from "../../../../../../domain/errors";
export const runtime = "nodejs";
// Inbound MoySklad webhook (T030). The official contract has no signature, so the URL carries a
// per-connection secret; events are stored and acknowledged, processing happens in the worker.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connection: string; token: string }> },
) {
  const { connection, token } = await params;
  try {
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65_536) {
          await reader.cancel();
          return NextResponse.json({ error: "TOO_LARGE" }, { status: 413 });
        }
        chunks.push(value);
      }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
    }
    const result = await new IntegrationService(
      await getDatabase(),
    ).receiveWebhook(
      connection,
      token,
      request.nextUrl.searchParams.get("requestId"),
      body,
    );
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    // Never echo payloads or tokens into logs.
    return NextResponse.json(
      { error: error instanceof AppError ? error.code : "INTERNAL_ERROR" },
      { status },
    );
  }
}
