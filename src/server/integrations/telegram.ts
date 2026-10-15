import { AppError } from "../../domain/errors";
import type { Fetch } from "./moysklad";

// Telegram Bot API adapter (T034). Contract checked 2026-10-15 against
// https://core.telegram.org/bots/api: https://api.telegram.org/bot<token>/<method>, JSON bodies,
// responses {ok, result | error_code, description, parameters.retry_after}, setWebhook with
// secret_token echoed in the X-Telegram-Bot-Api-Secret-Token header, getMe, sendMessage.
export const TELEGRAM_CONTRACT = "telegram-bot-api@2026-10-15";
export const TELEGRAM_BASE = "https://api.telegram.org";
export type TgUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number; type: string };
    from?: {
      id: number;
      first_name?: string;
      username?: string;
      is_bot?: boolean;
    };
    text?: string;
  };
};
export function validBotToken(token: string) {
  return /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(token);
}
export class TelegramClient {
  constructor(
    private token: string,
    private base = TELEGRAM_BASE,
    private fetcher: Fetch = fetch,
    private sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  // sendMessage is attempted once: a lost response cannot be told apart from a delivered message.
  async call<T>(method: string, body: Record<string, unknown>, once = false) {
    let last = "TELEGRAM_UNAVAILABLE";
    for (let attempt = 0; attempt < (once ? 1 : 3); attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(
          `${this.base}/bot${this.token}/${method}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            redirect: "error",
            signal: AbortSignal.timeout(20_000),
          },
        );
      } catch {
        last = "TELEGRAM_TIMEOUT";
        if (!once) await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      let r: {
        ok?: boolean;
        result?: T;
        error_code?: number;
        parameters?: { retry_after?: number };
      };
      try {
        r = (await response.json()) as typeof r;
      } catch {
        throw new AppError("TELEGRAM_INVALID_RESPONSE", 502);
      }
      if (r.ok) return r.result as T;
      const code = r.error_code || response.status;
      if (code === 429) {
        last = "TELEGRAM_RATE_LIMITED";
        const wait = Number(r.parameters?.retry_after || 1);
        if (once) throw new AppError(last, 503);
        await this.sleep(Math.min(Number.isFinite(wait) ? wait : 1, 30) * 1000);
        continue;
      }
      if (code >= 500) {
        last = `TELEGRAM_${code}`;
        if (!once) await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new AppError(
        code === 401 || code === 404
          ? "TELEGRAM_AUTH_FAILED"
          : code === 403
            ? "TELEGRAM_BLOCKED_BY_USER"
            : "TELEGRAM_REQUEST_REJECTED",
        502,
      );
    }
    throw new AppError(last, 503);
  }
  getMe() {
    return this.call<{ id: number; username?: string; is_bot: boolean }>(
      "getMe",
      {},
    );
  }
  setWebhook(url: string, secret: string) {
    return this.call<boolean>("setWebhook", {
      url,
      secret_token: secret,
      allowed_updates: ["message"],
      max_connections: 10,
    });
  }
  sendMessage(chatId: string, text: string) {
    return this.call<{ message_id: number }>(
      "sendMessage",
      { chat_id: chatId, text },
      true,
    );
  }
}
