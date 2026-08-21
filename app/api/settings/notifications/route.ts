import { requireAuth } from "@/lib/auth/guard";
import type { AccountType } from "@/lib/types";
import {
  maxExposureNotional,
  saveTelegramConfig,
  setMaxExposureNotional,
  telegramConfig,
  telegramStatus,
} from "@/lib/db/settings";
import { sendTelegramTest } from "@/lib/notify/telegram";
import { recordAudit } from "@/lib/db/audit";
import {
  asObject,
  handleRouteError,
  jsonError,
  jsonOk,
  optionalExactString,
  requireBoolean,
} from "@/lib/api/validate";

/**
 * Notification and account-limit settings.
 *
 * The bot token is write-only, like every other secret in this app: GET returns
 * whether one is stored and its last four characters, never the value. `test` takes
 * a token in the request rather than reading the stored one, so a typo can be caught
 * before it is saved — testing what is stored would make a bad paste
 * indistinguishable from a delivery problem.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function exposurePayload() {
  return {
    live: maxExposureNotional("live"),
    paper: maxExposureNotional("paper"),
  };
}

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    return jsonOk({ telegram: telegramStatus(), exposure: exposurePayload() });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const parsed = asObject(await request.json());
    const action = typeof parsed.action === "string" ? parsed.action : "save";

    if (action === "test") {
      /**
       * Prefer the supplied token, fall back to the stored one.
       *
       * Both paths are useful: testing a token before saving catches a paste error,
       * and testing without one re-checks a configuration that used to work.
       */
      const suppliedToken = optionalExactString(parsed.botToken, "botToken", 200);
      const suppliedChat = optionalExactString(parsed.chatId, "chatId", 64);
      const stored = telegramConfig();
      const botToken = suppliedToken ?? stored?.botToken;
      const chatId = suppliedChat ?? stored?.chatId;
      if (!botToken || !chatId) {
        return jsonError("A bot token and a chat id are both needed to send a test.", 400);
      }
      try {
        await sendTelegramTest(botToken, chatId, "Funding Rate Market");
        return jsonOk({ ok: true, telegram: telegramStatus() });
      } catch (err) {
        // 200 with ok:false — the request was valid, Telegram refused it, and the
        // message is what the operator needs to read.
        return jsonOk({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          telegram: telegramStatus(),
        });
      }
    }

    if (action === "exposure") {
      const account: AccountType = parsed.account === "live" ? "live" : "paper";
      const raw = parsed.maxNotional;
      const value = typeof raw === "number" ? raw : Number(raw);
      const saved = setMaxExposureNotional(account, Number.isFinite(value) ? value : 0);
      recordAudit({
        action: "settings.exposure",
        accountType: account,
        payload: { maxNotional: saved },
        outcome: "saved",
      });
      return jsonOk({ exposure: exposurePayload() });
    }

    // action === "save"
    const events = asObject(parsed.events ?? {});
    const status = saveTelegramConfig({
      enabled: parsed.enabled === undefined ? undefined : requireBoolean(parsed.enabled),
      // undefined keeps the stored token; "" clears it.
      botToken:
        parsed.botToken === undefined
          ? undefined
          : (optionalExactString(parsed.botToken, "botToken", 200) ?? ""),
      chatId: optionalExactString(parsed.chatId, "chatId", 64) ?? undefined,
      events: {
        opened: events.opened === undefined ? undefined : requireBoolean(events.opened),
        closed: events.closed === undefined ? undefined : requireBoolean(events.closed),
        failures: events.failures === undefined ? undefined : requireBoolean(events.failures),
        transfers: events.transfers === undefined ? undefined : requireBoolean(events.transfers),
      },
    });

    // The token is never in the payload; only whether one is now stored.
    recordAudit({
      action: "settings.notifications",
      payload: { enabled: status.enabled, tokenStored: status.tokenStored, events: status.events },
      outcome: "saved",
    });

    return jsonOk({ telegram: status });
  } catch (err) {
    return handleRouteError(err);
  }
}
