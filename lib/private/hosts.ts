/**
 * Outbound host allowlist.
 *
 * Every request this server makes to an exchange goes through here first. The
 * rebalancing work introduces wallet and withdrawal endpoints that live on
 * different hosts than the futures APIs, and one of them (KuCoin) hands us a
 * websocket URL inside a JSON response. That is the moment a response body
 * starts choosing a destination, so the destination needs a gate.
 *
 * Rules, in order of strictness:
 *   - https only (wss for sockets); no http, no file, no data.
 *   - the host must be an exact match in ALLOWED_HOSTS below.
 *   - loopback, private, link-local and reserved addresses are refused even if
 *     they somehow appear in the list, so a DNS answer pointing inward cannot
 *     turn into a request against this machine.
 */

/**
 * Exact hosts, grouped by venue. Adding a venue endpoint means adding its host
 * here deliberately — that is the point.
 */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  // Binance: futures trading, spot/wallet (withdraw + capital config), streams.
  "fapi.binance.com",
  "api.binance.com",
  "fstream.binance.com",
  // Bybit: unified v5 covers trading and asset transfer on one host.
  "api.bybit.com",
  "stream.bybit.com",
  // OKX.
  "www.okx.com",
  "ws.okx.com",
  // KuCoin: futures and spot are separate hosts, and both mint socket URLs.
  "api-futures.kucoin.com",
  "api.kucoin.com",
  "ws-api-futures.kucoin.com",
  "ws-api-spot.kucoin.com",
  // Gate.io.
  "api.gateio.ws",
  "fx-ws.gateio.ws",
  // Bitget.
  "api.bitget.com",
  "ws.bitget.com",
  // Hyperliquid: /info reads and /exchange signed actions on one host.
  "api.hyperliquid.xyz",
  // Aster: a Binance-shaped futures API. Its V3 private endpoints and the user
  // data stream are on the same hosts as the public ones.
  "fapi.asterdex.com",
  "fstream.asterdex.com",
  // Lighter: one host serves REST and the socket. Market data only.
  "mainnet.zklighter.elliot.ai",
  // edgeX: quotes live on a separate host from the REST API, which also carries
  // the signed private endpoints.
  "edgex-prod-v2.edgex.exchange",
  "edgex-quote-prod-v2.edgex.exchange",
  // Telegram, for outbound notifications. Not an exchange, but it goes through the
  // same gate: a corrupted setting must not be able to redirect alerts — which carry
  // position and PnL detail — to another host.
  "api.telegram.org",
]);

const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(["https:", "wss:"]);

export class BlockedHostError extends Error {}

/** IPv4 ranges that must never be a request target, whatever the list says. */
function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateIpv6(host: string): boolean {
  // URL keeps IPv6 literals in brackets; strip them before comparing.
  const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const lower = inner.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  // fc00::/7 unique-local, fe80::/10 link-local.
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true;
  }
  // ::ffff:127.0.0.1 style mapped addresses.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

function isBlockedAddress(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower.includes(":") || lower.startsWith("[")) return isPrivateIpv6(lower);
  return isPrivateIpv4(lower);
}

/**
 * Validates a URL and returns it unchanged, or throws. Returning the same
 * string keeps call sites honest: `fetch(assertAllowedUrl(url))` cannot be
 * written in a way that validates one URL and requests another.
 */
export function assertAllowedUrl(raw: string, label = "request"): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedHostError(`${label}: not a valid absolute URL`);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedHostError(`${label}: protocol ${url.protocol} is not allowed`);
  }
  const host = url.hostname;
  if (isBlockedAddress(host)) {
    throw new BlockedHostError(`${label}: host ${host} resolves to a reserved address`);
  }
  if (!ALLOWED_HOSTS.has(host.toLowerCase())) {
    throw new BlockedHostError(`${label}: host ${host} is not in the exchange allowlist`);
  }
  return raw;
}

/** True when the host is allowed, for callers that prefer a boolean. */
export function isAllowedUrl(raw: string): boolean {
  try {
    assertAllowedUrl(raw);
    return true;
  } catch {
    return false;
  }
}

/** Exposed for tests and diagnostics; do not mutate. */
export function allowedHosts(): string[] {
  return [...ALLOWED_HOSTS].sort();
}
