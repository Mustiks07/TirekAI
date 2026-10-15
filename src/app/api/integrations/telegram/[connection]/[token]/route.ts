import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "../../../../../../server/db/database";
import { TelegramService } from "../../../../../../server/integrations/telegram-service";
import { readLimited } from "../../../../../../server/integrations/common";
import { AppError } from "../../../../../../domain/errors";
export const runtime = "nodejs";
// Telegram webhook (T034): secret path + X-Telegram-Bot-Api-Secret-Token, deduplicated by
// update_id, acknowledged at once; the worker links chats and records consent.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connection: string; token: string }> },
) {
  const { connection, token } = await params;
  try {
    let body: unknown;
    try {
      body = JSON.parse(await readLimited(request));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("INVALID_INPUT", 400);
    }
    const result = await new TelegramService(await getDatabase()).receiveUpdate(
      connection,
      token,
      request.headers.get("x-telegram-bot-api-secret-token"),
      body,
    );
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof AppError ? error.code : "INTERNAL_ERROR" },
      { status: error instanceof AppError ? error.status : 500 },
    );
  }
}
