import type { AccountType } from "@/lib/types";
import { getDb, rowNum, rowStr } from "@/lib/db/client";
import { decryptSecret, encryptSecret, encryptionAvailable } from "@/lib/db/secrets";

/**
 * App-level settings: a small key/value store for things that belong to the whole
 * installation rather than to one strategy or venue.
 *
 * Values are opaque strings so a secret can be held encrypted without the table
 * knowing which ones are sensitive. Reads are cheap and uncached — every caller is
 * already touching the database in the same request.
 */

const KEY_MAX_EXPOSURE = (accountType: AccountType) => `exposure.max.${accountType}`;
const KEY_TELEGRAM = "notify.telegram";
const KEY_DEFAULT_ACCOUNT = "defaults.account";

function readSetting(key: string): string | null {
  const row = getDb()
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(key) as { value?: unknown } | undefined;
  const value = rowStr(row?.value, "");
  return value.length > 0 ? value : null;
}

function writeSetting(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .run(key, value, Date.now());
}

function deleteSetting(key: string): void {
  getDb().prepare("DELETE FROM app_settings WHERE key = ?").run(key);
}

// ─── Exposure ceiling ───────────────────────────────────────────────────────

/**
 * Total notional an account may have committed at once. Zero means no limit.
 *
 * This exists because deployments multiply exposure in a way a single strategy
 * could not: five deployments at three positions and $500 margin each is $7,500
 * committed, and nothing was counting that before. The default is 0 rather than a
 * guessed number — inventing a ceiling would either be too low to be useful or too
 * high to be a limit.
 */
export function maxExposureNotional(accountType: AccountType): number {
  const raw = readSetting(KEY_MAX_EXPOSURE(accountType));
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function setMaxExposureNotional(accountType: AccountType, value: number): number {
  const clamped = Number.isFinite(value) && value > 0 ? Math.min(value, 1e9) : 0;
  if (clamped <= 0) {
    deleteSetting(KEY_MAX_EXPOSURE(accountType));
    return 0;
  }
  writeSetting(KEY_MAX_EXPOSURE(accountType), String(Math.round(clamped)));
  return Math.round(clamped);
}

// ─── Default account ────────────────────────────────────────────────────────

/**
 * Which account the trade page opens on.
 *
 * Stored server-side rather than in the browser tab: the point of the setting is
 * that a reload lands where the operator expects, and a per-tab value cannot do
 * that. Defaults to paper — opening on live by default would mean a mis-click on a
 * fresh install sends a real order.
 */
export function defaultAccountType(): AccountType {
  return readSetting(KEY_DEFAULT_ACCOUNT) === "live" ? "live" : "paper";
}

export function setDefaultAccountType(accountType: AccountType): AccountType {
  writeSetting(KEY_DEFAULT_ACCOUNT, accountType === "live" ? "live" : "paper");
  return defaultAccountType();
}

// ─── Telegram notifications ─────────────────────────────────────────────────

/** Which events are worth a phone buzzing. */
export interface TelegramEvents {
  /** A hedge opened. High volume on an active account. */
  opened: boolean;
  /** A hedge closed, with its realized PnL. */
  closed: boolean;
  /** An order or transfer failed, or a hedge is half-unwound. */
  failures: boolean;
  /** A rebalance transfer was submitted. */
  transfers: boolean;
}

export const DEFAULT_TELEGRAM_EVENTS: TelegramEvents = {
  opened: false,
  closed: true,
  failures: true,
  transfers: true,
};

/** Stored Telegram configuration. The token never leaves the server. */
export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
  events: TelegramEvents;
}

/** What the browser is allowed to see: no token, only whether one is stored. */
export interface TelegramStatus {
  enabled: boolean;
  /** True when a bot token is stored. */
  tokenStored: boolean;
  /** Last 4 characters of the token, for recognition. */
  tokenTail: string | null;
  chatId: string;
  events: TelegramEvents;
  /** False when APP_PASSWORD is unset, so the token cannot be encrypted. */
  encryptionAvailable: boolean;
  lastError: string | null;
  lastSentAt: number | null;
}

interface StoredTelegram {
  enabled?: boolean;
  tokenCipher?: string;
  chatId?: string;
  events?: Partial<TelegramEvents>;
  lastError?: string | null;
  lastSentAt?: number | null;
}

function readStored(): StoredTelegram {
  const raw = readSetting(KEY_TELEGRAM);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as StoredTelegram) : {};
  } catch {
    return {};
  }
}

function writeStored(next: StoredTelegram): void {
  writeSetting(KEY_TELEGRAM, JSON.stringify(next));
}

/**
 * Merges an event patch over a base, ignoring keys whose value is undefined.
 *
 * The `undefined` filter is load-bearing rather than defensive. Route handlers build
 * a patch with every key present and unspecified ones set to `undefined`, and a plain
 * object spread would let those overwrite real values — so saving a bot token would
 * silently reset event toggles the operator had changed. Absent means "leave alone",
 * not "restore the default".
 */
function mergeEvents(
  patch?: Partial<TelegramEvents>,
  base: TelegramEvents = DEFAULT_TELEGRAM_EVENTS,
): TelegramEvents {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (typeof value === "boolean") out[key as keyof TelegramEvents] = value;
  }
  return out;
}

/**
 * The full configuration including the decrypted token. Server-only — callers must
 * never pass the result to the client.
 */
export function telegramConfig(): TelegramConfig | null {
  const stored = readStored();
  if (!stored.tokenCipher || !stored.chatId) return null;
  let botToken: string;
  try {
    botToken = decryptSecret(stored.tokenCipher);
  } catch {
    // A changed APP_PASSWORD makes the token unreadable, which disables
    // notifications rather than crashing the caller.
    return null;
  }
  return {
    enabled: stored.enabled === true,
    botToken,
    chatId: stored.chatId,
    events: mergeEvents(stored.events),
  };
}

export function telegramStatus(): TelegramStatus {
  const stored = readStored();
  let tokenTail: string | null = null;
  if (stored.tokenCipher) {
    try {
      const token = decryptSecret(stored.tokenCipher);
      tokenTail = token.length <= 4 ? "••••" : token.slice(-4);
    } catch {
      tokenTail = null;
    }
  }
  return {
    enabled: stored.enabled === true,
    tokenStored: Boolean(stored.tokenCipher),
    tokenTail,
    chatId: stored.chatId ?? "",
    events: mergeEvents(stored.events),
    encryptionAvailable: encryptionAvailable(),
    lastError: stored.lastError ?? null,
    lastSentAt: stored.lastSentAt ?? null,
  };
}

export interface SaveTelegramInput {
  enabled?: boolean;
  /** Omit to keep the stored token. Empty string clears it. */
  botToken?: string | null;
  chatId?: string;
  events?: Partial<TelegramEvents>;
}

export function saveTelegramConfig(input: SaveTelegramInput): TelegramStatus {
  const stored = readStored();
  const next: StoredTelegram = { ...stored };

  if (input.botToken !== undefined) {
    const token = input.botToken?.trim() ?? "";
    if (token.length === 0) {
      delete next.tokenCipher;
    } else {
      if (!encryptionAvailable()) {
        throw new Error("APP_PASSWORD is not set, so the bot token cannot be encrypted.");
      }
      next.tokenCipher = encryptSecret(token);
    }
    // A new token invalidates whatever the last error was about.
    next.lastError = null;
  }
  if (input.chatId !== undefined) next.chatId = input.chatId.trim();
  if (input.events !== undefined) {
    // Patch over what is stored, not over the defaults: a request carrying one
    // toggle must leave the others exactly as they were.
    next.events = mergeEvents(input.events, mergeEvents(stored.events));
  }

  if (input.enabled !== undefined) {
    // Enabling without a token or chat id would look configured and send nothing.
    if (input.enabled && (!next.tokenCipher || !next.chatId)) {
      throw new Error("A bot token and a chat id are both needed before notifications can be enabled.");
    }
    next.enabled = input.enabled;
  }

  writeStored(next);
  return telegramStatus();
}

/** Records the outcome of a send, so the UI can show a delivery failure. */
export function recordTelegramResult(error: string | null): void {
  const stored = readStored();
  writeStored({
    ...stored,
    lastError: error,
    lastSentAt: error === null ? Date.now() : (stored.lastSentAt ?? null),
  });
}

/** Timestamp helper, exported for the UI's "last sent" line. */
export function telegramLastSentAt(): number | null {
  return readStored().lastSentAt ?? null;
}

/** Raw read, for diagnostics. */
export function appSettingCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS c FROM app_settings").get() as
    | { c?: unknown }
    | undefined;
  return rowNum(row?.c, 0);
}
