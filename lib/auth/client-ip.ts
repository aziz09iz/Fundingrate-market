import { headers } from "next/headers";

/**
 * Client IP resolution, for the auth log that fail2ban reads.
 *
 * The whole value of a ban log is that the address in it is the address that
 * actually made the request, so this is deliberately explicit rather than
 * convenient. `x-forwarded-for` is a header, which means a client can send it —
 * and if it is trusted blindly an attacker gains two abilities that are worse
 * than having no log at all: evading their own ban by rotating a fake header, and
 * getting an arbitrary third party banned by claiming to be them.
 *
 * So the number of proxy hops to trust is configuration, not a guess:
 *
 *   · `TRUST_PROXY_HOPS` unset or 0 — no forwarding headers are trusted. Correct
 *     when the app is exposed directly. The log records `direct`, and fail2ban
 *     should read the reverse proxy's own log instead if there is one.
 *   · `TRUST_PROXY_HOPS=1` — one reverse proxy in front (the usual nginx or Caddy
 *     setup). The client is the *last* entry the proxy appended, not the first.
 *   · Higher values — that many trusted hops, e.g. Cloudflare in front of nginx.
 *
 * Reading from the right end matters. `x-forwarded-for` is `client, proxy1,
 * proxy2` where everything before the trusted hops is attacker-controlled, so the
 * entry to believe is counted back from the end.
 */

/** Configured number of trusted proxy hops. 0 means trust nothing. */
function trustedHops(): number {
  const raw = process.env.TRUST_PROXY_HOPS?.trim();
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 8) return 0;
  return n;
}

/** IPv4 dotted quad or a plausible IPv6 literal, with no port or brackets. */
function normalizeAddress(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;

  // Strip an IPv6 bracket form, with or without a port: [::1]:443 → ::1
  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) value = bracketed[1];
  // An IPv4 with a port: 1.2.3.4:5678 → 1.2.3.4. Only when there is exactly one
  // colon, so an unbracketed IPv6 is not mangled.
  else if ((value.match(/:/g)?.length ?? 0) === 1 && value.includes(".")) {
    value = value.slice(0, value.lastIndexOf(":"));
  }

  // IPv4-mapped IPv6, which is how a v4 client often arrives on a dual-stack
  // socket. Unwrapped so one client cannot appear as two addresses.
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) value = mapped[1];

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split(".").every((o) => Number(o) <= 255) ? value : null;
  }
  // Deliberately loose on IPv6: this string is written to a log and matched by a
  // regex, never used to open a connection, so the cost of accepting an odd-looking
  // literal is a useless log line rather than a request to somewhere unintended.
  if (/^[0-9a-f:]{2,45}$/i.test(value) && value.includes(":")) return value;
  return null;
}

/**
 * The client's address as a string safe to write into a log line, or `direct`
 * when no forwarding header is trusted.
 *
 * Never returns something with a newline or a space in it — a log line an attacker
 * can inject into is a log line fail2ban can be lied to with.
 */
export async function clientIp(): Promise<string> {
  const hops = trustedHops();
  if (hops === 0) return "direct";

  const store = await headers();

  const forwarded = store.get("x-forwarded-for");
  if (forwarded) {
    const chain = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
    // Count back from the end: the last `hops` entries were appended by proxies we
    // trust, so the one before them is the furthest we can believe.
    const index = chain.length - hops;
    const candidate = normalizeAddress(chain[index] ?? chain[0] ?? "");
    if (candidate) return candidate;
  }

  // Single-value alternatives, used by some proxies instead of the chain.
  for (const name of ["x-real-ip", "cf-connecting-ip", "true-client-ip"]) {
    const value = store.get(name);
    if (!value) continue;
    const candidate = normalizeAddress(value);
    if (candidate) return candidate;
  }

  return "unknown";
}
