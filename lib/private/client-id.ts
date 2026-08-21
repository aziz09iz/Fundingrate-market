import { randomUUID } from "node:crypto";
import type { TradeSource } from "@/lib/types";

/**
 * Client order ids, with the source encoded in the prefix.
 *
 * The source lives in the id itself rather than in a lookup table because a fill
 * can arrive on the private stream before the REST call that placed the order
 * has returned — at that moment there is no local order row to read a source
 * from. An in-process map would also not survive a restart. The prefix travels
 * to the venue and comes back on every frame that mentions the order.
 *
 * This sits in its own module so `lib/db/live.ts` can decode a source without
 * importing `lib/private/orders.ts`, which already imports `lib/db/live.ts`.
 */

const PREFIX: Record<TradeSource, string> = {
  manual: "frw",
  auto: "fra",
};

export function clientOrderIdFor(source: TradeSource): string {
  return `${PREFIX[source]}${Date.now().toString(36)}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/**
 * Recovers the source from an id we generated, or null when the id is not ours.
 * Venues mangle these: OKX strips punctuation, Gate.io prepends `t-`, so the
 * prefix is looked for near the head rather than at exactly index 0.
 */
export function sourceFromClientOrderId(clientOrderId?: string | null): TradeSource | null {
  if (!clientOrderId) return null;
  const head = clientOrderId.slice(0, 6);
  if (head.includes(PREFIX.auto)) return "auto";
  if (head.includes(PREFIX.manual)) return "manual";
  return null;
}
