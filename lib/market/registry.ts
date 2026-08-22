import type { ExchangeId } from "@/lib/types";
import { ADAPTER_LIST } from "@/lib/exchanges";

/**
 * The instrument registry: every perpetual each venue lists.
 *
 * This replaces the REST ranking pass, and the difference is not a tuning change.
 * Ranking existed to answer "which sixty pairs deserve a subscription", which meant
 * the watch set rotated every minute and a pair leaving the top ten stopped being
 * observed at exactly the moment its funding gap collapsed. Now the answer is
 * "all of them", so the only question left is what each venue lists — and a listing
 * set changes on the scale of days.
 *
 * Two properties matter more than the shape:
 *
 *   · A failed refresh keeps the previous set. A venue timing out must not read as
 *     "this venue lists nothing", because the manager would then unsubscribe its
 *     entire market and the venue would go dark until the next successful poll.
 *   · Coins are recorded with a last-seen timestamp rather than deleted on first
 *     absence, so one truncated response cannot silently drop half a venue.
 */

const REFRESH_INTERVAL_MS = 5 * 60_000;
const REST_TIMEOUT_MS = 15_000;

/**
 * How long a coin survives after a venue stops listing it.
 *
 * Long enough that a partial response is corrected by the next poll rather than
 * acted on, short enough that a genuine delisting leaves within an hour.
 */
const STALE_AFTER_MS = 30 * 60_000;

export interface VenueInstruments {
  exchange: ExchangeId;
  /** Coins currently listed, sorted. */
  coins: string[];
  /** Epoch ms of the last successful refresh, null when it has never succeeded. */
  lastSuccessAt: number | null;
  /** Epoch ms of the last attempt, successful or not. */
  lastAttemptAt: number | null;
  lastError: string | null;
}

interface VenueState {
  /** coin → last time the venue reported it. */
  seen: Map<string, number>;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
}

export class InstrumentRegistry {
  private readonly venues = new Map<ExchangeId, VenueState>();
  private version = 0;

  constructor() {
    for (const adapter of ADAPTER_LIST) {
      this.venues.set(adapter.id, {
        seen: new Map(),
        lastSuccessAt: null,
        lastAttemptAt: null,
        lastError: null,
      });
    }
  }

  /** Bumps whenever the listing set changes, so callers can skip a re-sync. */
  getVersion(): number {
    return this.version;
  }

  /**
   * Refreshes every venue in parallel. Never throws: a venue that fails keeps the
   * coins it had, with the error recorded for the console to show.
   */
  async refresh(): Promise<void> {
    const now = Date.now();
    await Promise.all(
      ADAPTER_LIST.map(async (adapter) => {
        const state = this.venues.get(adapter.id);
        if (!state) return;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
        try {
          const coins = await adapter.fetchInstruments(controller.signal);
          state.lastAttemptAt = now;
          if (coins.length === 0) {
            // An empty list from a venue that lists hundreds of perps is a bad
            // response, not a delisting event. Treated as a failure so the previous
            // set stands.
            state.lastError = "instrument list came back empty";
            return;
          }
          for (const raw of coins) {
            const coin = raw.trim().toUpperCase();
            if (coin) state.seen.set(coin, now);
          }
          state.lastSuccessAt = now;
          state.lastError = null;
        } catch (err) {
          state.lastAttemptAt = now;
          state.lastError = err instanceof Error ? err.message : String(err);
        } finally {
          clearTimeout(timer);
        }
      }),
    );

    this.evictStale(now);
    this.version += 1;
  }

  /** Drops coins no venue has reported for a while. */
  private evictStale(now: number): void {
    for (const state of this.venues.values()) {
      // Nothing has ever succeeded for this venue, so there is nothing to age out
      // and every entry it holds is still the best information available.
      if (state.lastSuccessAt === null) continue;
      for (const [coin, at] of state.seen) {
        if (now - at > STALE_AFTER_MS) state.seen.delete(coin);
      }
    }
  }

  /** Coins one venue lists. */
  coinsFor(exchange: ExchangeId): string[] {
    const state = this.venues.get(exchange);
    if (!state) return [];
    return [...state.seen.keys()];
  }

  /** Every coin any venue lists, deduplicated. */
  allCoins(): Set<string> {
    const out = new Set<string>();
    for (const state of this.venues.values()) {
      for (const coin of state.seen.keys()) out.add(coin);
    }
    return out;
  }

  /** Venues listing a given coin. */
  venuesFor(coin: string): ExchangeId[] {
    const out: ExchangeId[] = [];
    for (const [exchange, state] of this.venues) {
      if (state.seen.has(coin)) out.push(exchange);
    }
    return out;
  }

  /** The desired funding subscription set: every venue's whole listing. */
  desiredFunding(): Map<ExchangeId, string[]> {
    const out = new Map<ExchangeId, string[]>();
    for (const [exchange, state] of this.venues) {
      if (state.seen.size === 0) continue;
      out.set(exchange, [...state.seen.keys()]);
    }
    return out;
  }

  /** Total (venue, coin) pairs tracked, for the fabric header. */
  pairCount(): number {
    let total = 0;
    for (const state of this.venues.values()) total += state.seen.size;
    return total;
  }

  status(): VenueInstruments[] {
    return ADAPTER_LIST.map((adapter) => {
      const state = this.venues.get(adapter.id)!;
      return {
        exchange: adapter.id,
        coins: [...state.seen.keys()].sort(),
        lastSuccessAt: state.lastSuccessAt,
        lastAttemptAt: state.lastAttemptAt,
        lastError: state.lastError,
      };
    });
  }
}

export { REFRESH_INTERVAL_MS as INSTRUMENT_REFRESH_INTERVAL_MS };
