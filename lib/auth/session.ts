import { createHmac, timingSafeEqual } from "node:crypto";
import { sessionKey } from "@/lib/auth/password";

/**
 * Session cookies, signed rather than stored.
 *
 * A session is `issuedAt.expiresAt.hmac`, signed with a key derived from
 * APP_PASSWORD. Nothing is persisted server-side, which means changing the
 * password invalidates every outstanding session for free — the signing key
 * changes with it, so old cookies stop verifying.
 */

export const SESSION_COOKIE = "frs_session";

/** A week. Long enough not to be a nuisance on a personal tool. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** Builds a signed cookie value valid for SESSION_TTL_MS from now. */
export function issueSession(nowMs: number = Date.now()): string | null {
  const key = sessionKey();
  if (!key) return null;
  const payload = `${nowMs}.${nowMs + SESSION_TTL_MS}`;
  return `${payload}.${sign(payload, key)}`;
}

/**
 * True when the token is well-formed, correctly signed and unexpired.
 *
 * Signature is checked before expiry so a tampered timestamp cannot be used to
 * extend a session.
 */
export function sessionValid(token: string | undefined, nowMs: number = Date.now()): boolean {
  if (!token) return false;
  const key = sessionKey();
  if (!key) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [issuedAt, expiresAt, signature] = parts;

  const expected = sign(`${issuedAt}.${expiresAt}`, key);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;

  const expiry = Number(expiresAt);
  return Number.isFinite(expiry) && expiry > nowMs;
}

/** Cookie attributes shared by the set and clear paths. */
export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure,
  };
}
