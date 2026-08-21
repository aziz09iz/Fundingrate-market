import type { AccountType, ExchangeId } from "@/lib/types";
import { accountActivePositions } from "@/lib/db/strategy";
import { livePositions } from "@/lib/db/live";
import { getDb, rowStr } from "@/lib/db/client";

/**
 * Market data claims: pairs that must stay streamed because something is holding
 * a position in them.
 *
 * The problem this solves: the watch set used to have a single owner, the REST
 * ranking, and ranking knows nothing about your exposure. A coin entered on a
 * high funding difference leaves the top pairs precisely when that difference
 * collapses — which is when the exit rules need to see it. The engine went blind
 * exactly at the moment it had to act.
 *
 * So the desired subscription set becomes `union(ranking, claims)`. A claim is
 * `(exchange, coin)`, the same granularity as a layer assignment, and it is
 * derived from what is actually held rather than registered and remembered:
 * nothing can leak a claim by forgetting to release it, and a restart rebuilds
 * the set correctly from the database.
 *
 * Only the venues actually involved are claimed — a hedge needs its two legs, not
 * all seven venues — because the exit rules read only those legs.
 */

export interface MarketClaim {
  exchange: ExchangeId;
  coin: string;
  /** Human-readable holder, for the UI and logs. */
  reason: string;
}

/** Paper positions still open, which the account values from live quotes. */
function paperClaims(): MarketClaim[] {
  const rows = getDb()
    .prepare("SELECT DISTINCT exchange, coin, source FROM paper_positions")
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    exchange: rowStr(row.exchange) as ExchangeId,
    coin: rowStr(row.coin),
    reason: rowStr(row.source, "manual") === "auto" ? "paper auto position" : "paper manual position",
  }));
}

/** Live positions as the venues report them, including ones opened elsewhere. */
function liveClaims(): MarketClaim[] {
  return livePositions().map((p) => ({
    exchange: p.exchange,
    coin: p.coin,
    reason: p.source === "auto" ? "live auto position" : "live manual position",
  }));
}

/**
 * Hedges any deployment is managing, including `queued` and `closing`.
 *
 * Queued matters: a queued delay entry is waiting for its spread to converge, and
 * dropping its quote would strand it until the window closes. Closing matters
 * because a close that was refused still needs a quote to retry.
 *
 * Read per account rather than per deployment: a leg has to stay streamed whoever
 * owns it, and querying the account once avoids re-reading the table for every
 * deployment.
 */
function strategyClaims(): MarketClaim[] {
  const out: MarketClaim[] = [];
  for (const accountType of ["paper", "live"] as AccountType[]) {
    for (const position of accountActivePositions(accountType)) {
      const reason = `${accountType} ${position.strategy} ${position.id} (${position.status})`;
      out.push({ exchange: position.longExchange, coin: position.coin, reason });
      out.push({ exchange: position.shortExchange, coin: position.coin, reason });
    }
  }
  return out;
}

/**
 * Every (venue, coin) that must stay streamed, deduplicated. Reading straight
 * from the tables means a claim cannot outlive the position that justified it.
 */
export function currentClaims(): MarketClaim[] {
  const byKey = new Map<string, MarketClaim>();
  for (const claim of [...strategyClaims(), ...paperClaims(), ...liveClaims()]) {
    if (!claim.coin || !claim.exchange) continue;
    const key = `${claim.exchange}:${claim.coin}`;
    const existing = byKey.get(key);
    if (existing) {
      // Several holders for one pair is normal — a hedge leg is also a position.
      if (!existing.reason.includes(claim.reason)) {
        existing.reason = `${existing.reason}, ${claim.reason}`;
      }
      continue;
    }
    byKey.set(key, { ...claim });
  }
  return [...byKey.values()];
}

/** Claimed coins, for callers that only need the coin set. */
export function claimedCoins(): Set<string> {
  return new Set(currentClaims().map((c) => c.coin));
}
