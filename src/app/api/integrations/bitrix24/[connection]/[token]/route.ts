import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "../../../../../../server/db/database";
import { Bitrix24Service } from "../../../../../../server/integrations/bitrix24-service";
import { readLimited } from "../../../../../../server/integrations/common";
import { AppError } from "../../../../../../domain/errors";
export const runtime = "nodejs";
// Bitrix24 outbound webhook (T031): form-encoded event with auth[application_token]. Stored and
// acknowledged; the contact is re-read from the API by the worker.
function nested(form: URLSearchParams) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of form) {
    const path = key.replace(/\]/g, "").split("[");
    if (path.length > 4 || path.some((p) => !/^[A-Za-z0-9_]{1,40}$/.test(p)))
      continue;
    let node = out;
    path.forEach((p, i) => {
      if (i === path.length - 1) node[p] = value;
      else {
        if (typeof node[p] !== "object" || node[p] === null) node[p] = {};
        node = node[p] as Record<string, unknown>;
      }
    });
  }
  return out;
}
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connection: string; token: string }> },
) {
  const { connection, token } = await params;
  try {
    const raw = await readLimited(request);
    const type = request.headers.get("content-type") || "";
    let body: unknown;
    try {
      body = type.includes("application/json")
        ? JSON.parse(raw)
        : nested(new URLSearchParams(raw));
    } catch {
      throw new AppError("INVALID_INPUT", 400);
    }
    const result = await new Bitrix24Service(await getDatabase()).receiveEvent(
      connection,
      token,
      body,
    );
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    // Payloads and tokens are never echoed or logged.
    return NextResponse.json(
      { error: error instanceof AppError ? error.code : "INTERNAL_ERROR" },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}
