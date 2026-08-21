import { assertAllowedUrl } from "@/lib/private/hosts";
import { recordTelegramResult, telegramConfig } from "@/lib/db/settings";

/**
 * Telegram delivery.
 *
 * A bot token is a bearer credential for the bot, so it is stored encrypted and read
 * only here. Nothing in this module logs or returns it, and the only outbound host is
 * Telegram's own — validated through the same allowlist every venue request goes
 * through, so a corrupted setting cannot redirect messages elsewhere.
 *
 * Failures are deliberately quiet. An alert that cannot be delivered must not stop a
 * hedge from closing or a transfer from being recorded, so every send is
 * fire-and-forget and the error is stored for the settings page to surface.
 */

const API_HOST = "api.telegram.org";
const SEND_TIMEOUT_MS = 10_000;

export class TelegramError extends Error {}

/**
 * Escapes text for Telegram's MarkdownV2.
 *
 * Every reserved character has to be escaped or the whole message is rejected with a
 * 400 — and the messages here contain venue names, PnL figures and coin symbols, all
 * of which routinely include `.`, `-` and `(`.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

interface TelegramResponse {
  ok?: boolean;
  description?: string;
}

/**
 * Sends one message. Throws on failure so `sendTelegram` can record it; callers
 * outside this module should use `sendTelegram` instead.
 */
async function post(botToken: string, chatId: string, text: string): Promise<void> {
  const url = assertAllowedUrl(`https://${API_HOST}/bot${botToken}/sendMessage`, "telegram/send");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as TelegramResponse | null;
    if (!res.ok || body?.ok !== true) {
      // The description is Telegram's own wording and is the only useful diagnostic
      // — "chat not found", "unauthorized" and so on. The token is not in it.
      throw new TelegramError(body?.description ?? `Telegram returned HTTP ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends a message using the stored configuration, if notifications are on.
 *
 * Never throws: an undeliverable alert is recorded and forgotten. The alternative —
 * letting a Telegram outage propagate into the trading loop — would be strictly
 * worse than a missing message.
 */
export async function sendTelegram(text: string): Promise<boolean> {
  const config = telegramConfig();
  if (!config || !config.enabled) return false;
  try {
    await post(config.botToken, config.chatId, text);
    recordTelegramResult(null);
    return true;
  } catch (err) {
    recordTelegramResult(err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Sends a test message with an explicitly supplied token and chat id.
 *
 * Takes them as arguments rather than reading the stored config so the settings page
 * can verify a token before saving it — testing what is stored would make a typo
 * indistinguishable from a real delivery problem. Throws, because here the caller
 * wants the error.
 */
export async function sendTelegramTest(
  botToken: string,
  chatId: string,
  label: string,
): Promise<void> {
  await post(
    botToken,
    chatId,
    [
      `*${escapeMarkdown(label)}*`,
      escapeMarkdown("Telegram notifications are connected."),
      escapeMarkdown("If you can read this, alerts will arrive here."),
    ].join("\n"),
  );
}

/** Formats a notification: bold title, then plain detail lines. */
export function formatMessage(title: string, lines: string[]): string {
  return [`*${escapeMarkdown(title)}*`, ...lines.map(escapeMarkdown)].join("\n");
}

export { escapeMarkdown };
