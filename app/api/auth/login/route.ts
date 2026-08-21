import { NextResponse } from "next/server";
import { passwordConfigured, passwordMatches } from "@/lib/auth/password";
import { clientIp } from "@/lib/auth/client-ip";
import { recordAuthAttempt } from "@/lib/auth/auth-log";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  issueSession,
  sessionCookieOptions,
} from "@/lib/auth/session";

/**
 * Password login. Exchanges the password for a signed session cookie.
 *
 * The cookie is httpOnly, so the password never persists anywhere the page's
 * JavaScript can read — including sessionStorage, which is what the old app
 * token used.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Failed-attempt throttle, per process.
 *
 * A single password with no user list is exactly the shape brute force likes, so
 * attempts are slowed after a handful of failures. In-memory is enough here: the
 * app is one process, and a restart clearing the counter costs an attacker the
 * same restart.
 *
 * This is the inner of two layers and cannot be the only one. It only reacts after
 * Node has accepted the connection, and a restart clears it. Every attempt is also
 * written to the auth log so fail2ban can drop the source at the firewall, where a
 * ban survives a restart and costs the app nothing. See the README.
 */
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;
let failures = 0;
let lockedUntil = 0;

export async function POST(request: Request) {
  if (!passwordConfigured()) {
    return NextResponse.json(
      { error: "APP_PASSWORD is not set on the server. Add it to .env.local and restart." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const now = Date.now();
  const ip = await clientIp();

  if (now < lockedUntil) {
    const seconds = Math.ceil((lockedUntil - now) / 1000);
    // Logged separately from a failure: the app already refused this one, so a
    // fail2ban filter can decide for itself whether it should count.
    void recordAuthAttempt("locked", ip);
    return NextResponse.json(
      { error: `Too many failed attempts. Try again in ${seconds}s.` },
      { status: 429, headers: { "cache-control": "no-store" } },
    );
  }

  let password = "";
  try {
    const body = (await request.json()) as unknown;
    if (body && typeof body === "object" && "password" in body) {
      const value = (body as { password: unknown }).password;
      if (typeof value === "string") password = value;
    }
  } catch {
    // Malformed body is treated as a wrong password, not a separate error.
  }

  if (!password || !passwordMatches(password)) {
    failures += 1;
    if (failures >= MAX_ATTEMPTS) {
      lockedUntil = now + LOCKOUT_MS;
      failures = 0;
    }
    void recordAuthAttempt("failed", ip);
    return NextResponse.json(
      { error: "Incorrect password." },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  failures = 0;
  const token = issueSession(now);
  if (!token) {
    return NextResponse.json(
      { error: "Server could not create a session." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }

  // Logged as well as the failures: after a ban fires, "did anyone actually get
  // in" is the question that matters, and a file with only failures cannot answer
  // it.
  void recordAuthAttempt("success", ip);

  const response = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    ...sessionCookieOptions(new URL(request.url).protocol === "https:"),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return response;
}
