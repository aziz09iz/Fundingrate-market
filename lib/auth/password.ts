import { scryptSync, timingSafeEqual } from "node:crypto";

/**
 * The app's single secret: one password, read from APP_PASSWORD.
 *
 * Everything else that used to need its own secret is derived from it — the
 * session signing key and the credential encryption key — so there is exactly
 * one value to set and exactly one to rotate. The trade-off is deliberate:
 * changing the password invalidates every session and makes credentials stored
 * in the database unreadable, which is the same failure mode a lost master key
 * always had.
 */

/** Domain separation, so the two derived keys can never coincide. */
const SESSION_SALT = "funding-rate-market/session/v1";
const CREDENTIALS_SALT = "funding-rate-market/credentials/v1";

/**
 * scrypt is intentionally slow, so derived keys are cached per password. The
 * cache is keyed by the password rather than being a single slot: it must not
 * hand back a stale key if the environment is reloaded with a different one.
 */
const keyCache = new Map<string, Buffer>();

function derive(password: string, salt: string): Buffer {
  const cacheKey = `${salt}\u0000${password}`;
  const hit = keyCache.get(cacheKey);
  if (hit) return hit;
  const key = scryptSync(password, salt, 32);
  keyCache.set(cacheKey, key);
  return key;
}

/** The configured password, or null when APP_PASSWORD is unset or blank. */
export function configuredPassword(): string | null {
  const value = process.env.APP_PASSWORD;
  if (typeof value !== "string") return null;
  // Not trimmed: a password is taken exactly as written, spaces included.
  return value.length > 0 ? value : null;
}

/** True when the server has a password set and can therefore accept a login. */
export function passwordConfigured(): boolean {
  return configuredPassword() !== null;
}

/** Constant-time compare, so a wrong password reveals nothing through timing. */
export function passwordMatches(provided: string): boolean {
  const expected = configuredPassword();
  if (expected === null) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Lengths differ visibly either way; the compare below needs equal lengths.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** HMAC key for session cookies. Null when no password is configured. */
export function sessionKey(): Buffer | null {
  const password = configuredPassword();
  return password === null ? null : derive(password, SESSION_SALT);
}

/**
 * AES key for credentials stored in the database. Null when no password is
 * configured, which makes stored credentials unreadable rather than exposed.
 */
export function credentialsKey(): Buffer | null {
  const password = configuredPassword();
  return password === null ? null : derive(password, CREDENTIALS_SALT);
}
