const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Reconnect delay: exponential, capped, and jittered into the lower half of the
 * window.
 *
 * The jitter is the point. A network blip drops every shard within the same event
 * loop turn, so without it all of them retry at exactly the same moment — a
 * synchronized burst of TLS handshakes at t+1s, t+2s, t+4s. KuCoin amplifies that
 * further: it runs four shards and mints a fresh connection token over REST on
 * every attempt, so a lockstep retry means four simultaneous authenticated POSTs
 * escalating into its rate limiter precisely when the network is already unhealthy.
 *
 * Spreading each shard across [0.5, 1.0) of its computed delay de-synchronizes them
 * without ever retrying sooner than half the intended backoff.
 *
 * `Math.random` is correct here and must not be "upgraded" to a CSPRNG: this
 * schedules a retry, and a predictable retry time is not a vulnerability. The
 * cryptographic randomness in this app is in lib/private/eip712.ts.
 */
export function backoffDelay(attempts: number): number {
  const capped = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(capped * (0.5 + Math.random() * 0.5));
}
