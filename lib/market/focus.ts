import type { ExchangeId, PairScope } from "@/lib/types";
import { EXCHANGE_IDS, scopeVenues } from "@/lib/utils";
import type { MarketStore } from "@/lib/market/store";
import { currentClaims } from "@/lib/market/claims";

/**
 * Book Focus: where best bid/ask is actually streamed.
 *
 * Funding is subscribed for every pair on every venue, which is cheap — a rate moves
 * a few times an hour. Order books are not: a top-of-book channel fires many times a
 * second per pair, and subscribing several thousand of them would spend the whole
 * event loop parsing quotes nobody is looking at. So book coverage is leased.
 *
 * Three sources, and the distinction between them is the point:
 *
 *   · Leases — the rows a client currently has on screen, renewed on every push and
 *     expiring shortly after the client goes away. Attention-driven and transient.
 *   · Claims — every pair something holds a position in. Never leased, never expires
 *     while the position is open. A position needs a quote to be valued and closed
 *     whether or not a browser is watching, and this is the same guarantee the old
 *     layer-3 pinning gave.
 *   · Top gaps — the widest funding differences per scope, so the rows most likely to
 *     be looked at next already have a quote when they are.
 *
 * Venues whose funding and book share one channel (Bybit, Bitget) are unaffected:
 * their books arrive regardless, and nothing here can or should stop that.
 */

/** How long a lease survives without renewal. */
const LEASE_TTL_MS = 45_000;

/** Coins per scope kept warm by funding gap, independent of any viewer. */
const TOP_GAP_PER_SCOPE = 40;

/** A lease is refused above this size, so one client cannot demand the market. */
const MAX_LEASE_COINS = 400;

export type FocusReason = "on-screen" | "position" | "top-gap";

export interface FocusEntry {
  coin: string;
  reason: FocusReason;
  /** Venues this coin needs a book on. Empty means every venue listing it. */
  venues: ExchangeId[];
}

interface Lease {
  coins: Set<string>;
  expiresAt: number;
}

export class BookFocus {
  private readonly leases = new Map<string, Lease>();

  /**
   * Records or renews one viewer's interest.
   *
   * Called on every SSE push rather than on connect, so a client that stops reading
   * releases its coins without needing to say goodbye — which a closed laptop lid
   * never does.
   */
  lease(viewerId: string, coins: string[], now = Date.now()): void {
    if (coins.length === 0) {
      this.leases.delete(viewerId);
      return;
    }
    const capped = coins.length > MAX_LEASE_COINS ? coins.slice(0, MAX_LEASE_COINS) : coins;
    this.leases.set(viewerId, {
      coins: new Set(capped),
      expiresAt: now + LEASE_TTL_MS,
    });
  }

  release(viewerId: string): void {
    this.leases.delete(viewerId);
  }

  private prune(now: number): void {
    for (const [id, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(id);
    }
  }

  /** Live lease count, for the console. */
  viewerCount(now = Date.now()): number {
    this.prune(now);
    return this.leases.size;
  }

  /**
   * The desired book subscription set, per venue.
   *
   * A leased or top-gap coin is subscribed on every venue that lists it, because the
   * point of the quote is to compare venues. A claimed pair is subscribed on the venue
   * that holds it, and that alone — the other legs of a coin someone happens to hold
   * are not more interesting than any other row.
   */
  desired(store: MarketStore, now = Date.now()): Map<ExchangeId, string[]> {
    this.prune(now);
    const perVenue = new Map<ExchangeId, Set<string>>();
    const add = (exchange: ExchangeId, coin: string) => {
      let set = perVenue.get(exchange);
      if (!set) {
        set = new Set();
        perVenue.set(exchange, set);
      }
      set.add(coin);
    };

    // Positions first: these are not negotiable and must not be crowded out by a
    // busy viewer holding a large lease.
    for (const claim of currentClaims()) {
      add(claim.exchange, claim.coin);
    }

    const wide = new Set<string>();
    for (const lease of this.leases.values()) {
      for (const coin of lease.coins) wide.add(coin);
    }
    for (const coin of topGapCoins(store)) wide.add(coin);

    for (const coin of wide) {
      for (const exchange of store.venuesListing(coin)) add(exchange, coin);
    }

    const out = new Map<ExchangeId, string[]>();
    for (const exchange of EXCHANGE_IDS) {
      out.set(exchange, [...(perVenue.get(exchange) ?? [])]);
    }
    return out;
  }

  /**
   * Why each covered coin is covered, for the console.
   *
   * "This row has no spread" is the first question the Stream Fabric page has to
   * answer, and it is unanswerable without saying what the focus set contains.
   */
  explain(store: MarketStore, now = Date.now()): FocusEntry[] {
    this.prune(now);
    const byCoin = new Map<string, FocusEntry>();

    for (const claim of currentClaims()) {
      const existing = byCoin.get(claim.coin);
      if (existing) {
        if (!existing.venues.includes(claim.exchange)) existing.venues.push(claim.exchange);
        continue;
      }
      byCoin.set(claim.coin, {
        coin: claim.coin,
        reason: "position",
        venues: [claim.exchange],
      });
    }

    for (const lease of this.leases.values()) {
      for (const coin of lease.coins) {
        if (byCoin.has(coin)) continue;
        byCoin.set(coin, { coin, reason: "on-screen", venues: [] });
      }
    }

    for (const coin of topGapCoins(store)) {
      if (byCoin.has(coin)) continue;
      byCoin.set(coin, { coin, reason: "top-gap", venues: [] });
    }

    return [...byCoin.values()].sort((a, b) => a.coin.localeCompare(b.coin));
  }
}

/** Widest funding gaps per scope, so the rows most likely to be opened stay warm. */
function topGapCoins(store: MarketStore): string[] {
  const out = new Set<string>();
  for (const scope of ["cross", "cex-cex", "dex-dex"] as PairScope[]) {
    for (const coin of store.topCoinsByDiff(scope, scopeVenues(scope), TOP_GAP_PER_SCOPE)) {
      out.add(coin);
    }
  }
  return [...out];
}

export { LEASE_TTL_MS as BOOK_LEASE_TTL_MS };
