import { NextResponse } from "next/server";
import { passwordConfigured, passwordMatches } from "@/lib/auth/password";
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
 * Brute-force throttle, in two stages.
 *
 * One password and no user list is exactly the shape brute force likes, so the cost
 * of a wrong guess rises in two steps rather than one:
 *
 *   · Every wrong password enforces a 10 second gap before the next attempt. That
 *     alone caps an attacker at 6 guesses a minute, which is the difference between
 *     a dictionary run finishing this week and never.
 *   · Three consecutive wrong passwords lock sign-in for 6 hours. Three is enough
 *     for a typo and a retry; it is not enough to search anything.
 *
 * Held in memory on purpose, and that has a property worth stating: a restart clears
 * both timers, and **only the operator can restart the process**. So the lockout is
 * absolute to anyone attacking over the network, while the person with server access
 * — who could read APP_PASSWORD from .env.local anyway — always has a way back in
 * without a recovery flow to attack.
 *
 * The counter is deliberately global rather than per-IP. There is one password, so
 * "somebody guessed wrong three times" is the whole signal; keying by address would
 * let a distributed attacker get three attempts per host for free.
 */
const ATTEMPT_LIMIT = 3;
const RETRY_DELAY_MS = 10_000;
const LOCKOUT_MS = 6 * 60 * 60 * 1_000;

let consecutiveFailures = 0;
/** Earliest time another attempt is accepted, from the 10 second gap. */
let nextAttemptAt = 0;
/** Earliest time sign-in reopens, from the 6 hour lockout. */
let lockedUntil = 0;

/** "6 hours", "48 minutes", "9 seconds" — whichever unit reads naturally. */
function describeWait(ms: number): string {
  const seconds = Math.ceil(ms / 1_000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const head = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rest === 0 ? head : `${head} ${rest} min`;
}

/**
 * Refuses an attempt and tells the client exactly how long to wait.
 *
 * `retryAfterMs` lets the page run a countdown and keep its button disabled, so the
 * wait is visible rather than looking like a broken form. `Retry-After` carries the
 * same figure in the standard header, in seconds, for anything that is not the page.
 *
 * Nothing here sleeps. A server-side delay would hold a connection open for the full
 * wait, which turns the throttle into its own denial-of-service — an attacker could
 * pin a Node handle per attempt. Refusing immediately costs the attacker the same
 * time and costs the server nothing.
 */
function refuse(message: string, waitMs: number) {
  return NextResponse.json(
    { error: message, retryAfterMs: waitMs },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(Math.ceil(waitMs / 1_000)),
      },
    },
  );
}

export async function POST(request: Request) {
  if (!passwordConfigured()) {
    return NextResponse.json(
      { error: "APP_PASSWORD is not set on the server. Add it to .env.local and restart." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const now = Date.now();

  if (now < lockedUntil) {
    const wait = lockedUntil - now;
    return refuse(
      `Sign-in is locked after ${ATTEMPT_LIMIT} wrong passwords. Try again in ${describeWait(wait)}.`,
      wait,
    );
  }

  if (now < nextAttemptAt) {
    const wait = nextAttemptAt - now;
    return refuse(`Wait ${describeWait(wait)} before trying again.`, wait);
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
    consecutiveFailures += 1;
    nextAttemptAt = now + RETRY_DELAY_MS;

    if (consecutiveFailures >= ATTEMPT_LIMIT) {
      lockedUntil = now + LOCKOUT_MS;
      consecutiveFailures = 0;
      // The lockout supersedes the short gap; keeping both would report the
      // shorter one first and read as though the wait were nearly over.
      nextAttemptAt = 0;
      return NextResponse.json(
        {
          error: `Incorrect password. Sign-in is now locked for ${describeWait(LOCKOUT_MS)}.`,
          retryAfterMs: LOCKOUT_MS,
        },
        {
          status: 429,
          headers: {
            "cache-control": "no-store",
            "retry-after": String(Math.ceil(LOCKOUT_MS / 1_000)),
          },
        },
      );
    }

    const remaining = ATTEMPT_LIMIT - consecutiveFailures;
    return NextResponse.json(
      {
        // Saying how many attempts are left is not a hint an attacker can use —
        // they can count — and without it the sudden 6 hour lock looks like a bug.
        error: `Incorrect password. ${remaining} attempt${remaining === 1 ? "" : "s"} left before a ${describeWait(LOCKOUT_MS)} lockout.`,
        retryAfterMs: RETRY_DELAY_MS,
      },
      {
        status: 401,
        headers: {
          "cache-control": "no-store",
          "retry-after": String(Math.ceil(RETRY_DELAY_MS / 1_000)),
        },
      },
    );
  }

  // A correct password clears both stages: the point of counting *consecutive*
  // failures is that getting in proves the earlier ones were typos.
  consecutiveFailures = 0;
  nextAttemptAt = 0;
  lockedUntil = 0;

  const token = issueSession(now);
  if (!token) {
    return NextResponse.json(
      { error: "Server could not create a session." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }

  const response = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    ...sessionCookieOptions(new URL(request.url).protocol === "https:"),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return response;
}
