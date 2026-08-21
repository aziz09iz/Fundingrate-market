import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The authentication log fail2ban reads.
 *
 * A single-password app with no user list is the exact shape brute force likes.
 * The in-process throttle in the login route slows an attacker down but cannot
 * stop them: it lives in memory, so a restart clears it, and it cannot drop a
 * packet before Node has already accepted the connection and derived a key.
 * fail2ban can, at the firewall, and it stays banned across restarts.
 *
 * The contract with fail2ban is this line format, one per failed sign-in:
 *
 *   2026-08-21T09:14:03.114Z auth: failed password for frs from 203.0.113.9
 *
 * Two properties of that line are load-bearing rather than cosmetic:
 *
 *   · **Nothing in it is attacker-controlled.** The address comes from
 *     `clientIp()`, which validates it as an IP and never returns a value
 *     containing a space or a newline. The password is never logged, not even its
 *     length — a log an attacker can write arbitrary text into is a log they can
 *     forge ban entries in, getting a third party blocked.
 *   · **Successes are logged too**, so the file also answers "did anyone get in",
 *     which is the question that matters after a ban fires.
 *
 * Writes are appended and never rotated here; rotation is logrotate's job and the
 * file is a few dozen bytes per attempt. A failed write is swallowed: an auth log
 * that cannot be written must not become a way to prevent logging in.
 */

/** Where the log is written. Unset disables logging entirely. */
function logPath(): string | null {
  const configured = process.env.AUTH_LOG_PATH?.trim();
  if (configured) return configured;
  // No default path outside the project: a file the app creates in an unexpected
  // place is worse than no file. `data/` is already gitignored.
  return null;
}

export type AuthOutcome = "failed" | "success" | "locked";

const MESSAGES: Record<AuthOutcome, string> = {
  failed: "failed password",
  success: "accepted password",
  // Emitted while the in-process throttle is holding an attempt off. Distinct from
  // `failed` so a fail2ban filter can choose whether a rate-limited attempt should
  // count towards the ban — by default it should not, since the app already
  // refused it.
  locked: "rate-limited attempt",
};

/**
 * Appends one line. Never throws.
 *
 * `ip` must already be validated by `clientIp()`; this asserts the shape again
 * rather than trusting the caller, because the whole point of the file is that a
 * line in it can be believed.
 */
export async function recordAuthAttempt(outcome: AuthOutcome, ip: string): Promise<void> {
  const path = logPath();
  if (!path) return;

  const safeIp = /^[0-9a-fA-F.:]{1,45}$/.test(ip) ? ip : ip === "direct" ? "direct" : "unknown";
  const line = `${new Date().toISOString()} auth: ${MESSAGES[outcome]} for frs from ${safeIp}\n`;

  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line, { encoding: "utf8", mode: 0o640 });
  } catch {
    // Logging is best-effort by design; see the note above.
  }
}

/** The default path suggested in the docs, for the setup instructions to match. */
export const SUGGESTED_AUTH_LOG_PATH = join("data", "auth.log");
