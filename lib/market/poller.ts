import type { ExchangeId, LayerAssignment } from "@/lib/types";
import type { RankedPair, StreamUpdate } from "@/lib/exchanges/adapter";
import { ADAPTERS, ADAPTER_LIST } from "@/lib/exchanges";
import { EXCHANGE_IDS } from "@/lib/utils";
import { MAX_COIN_UNIVERSE, type MarketStore } from "@/lib/market/store";
import { currentClaims, type MarketClaim } from "@/lib/market/claims";

const REST_TIMEOUT_MS = 15_000;

export interface PollResult {
  layers: LayerAssignment[];
  /** Venues whose ranking fetch failed this cycle. */
  failures: { exchange: ExchangeId; message: string }[];
}

/**
 * The REST pass exists only to choose which pairs to watch. Its funding numbers
 * rank candidates and are never displayed — every figure the UI shows comes
 * from the websocket streams, because rates and intervals can change at any
 * moment and a value polled a minute ago is already stale.
 */
export async function pollRanking(
  store: MarketStore,
  listedByVenue: Map<ExchangeId, Set<string>>,
): Promise<PollResult> {
  const { layer1CountPerExchange } = store.getConfig();
  const failures: PollResult["failures"] = [];
  const rankings = new Map<ExchangeId, RankedPair[]>();

  await Promise.all(
    ADAPTER_LIST.map(async (adapter) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
      try {
        const ranked = await adapter.fetchRanking(controller.signal);
        rankings.set(adapter.id, ranked);
        // Remember every listed coin so layer 2 knows where a coin also trades.
        listedByVenue.set(adapter.id, new Set(ranked.map((r) => r.coin)));
        store.markPoll(adapter.id, Date.now());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ exchange: adapter.id, message });
        store.markPoll(adapter.id, Date.now(), message);
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  // Claims are read here, in the same pass, so the layer set is always built from
  // ranking and exposure together rather than one overwriting the other.
  const claims = currentClaims();
  store.setClaims(claims);
  const layers = assignLayers(rankings, listedByVenue, layer1CountPerExchange, claims);
  return { layers, failures };
}

/**
 * Reads each venue's declared funding cadence from its contract metadata.
 *
 * This is a correctness fix, not a cosmetic one: Diff FR normalizes by dividing
 * the rate by the interval, so assuming 8h for a 4h contract halves that
 * venue's contribution. Most listings on Binance, KuCoin and Bitget are 4h, so
 * assuming the venue default was wrong for the majority of pairs.
 */
export async function pollIntervals(store: MarketStore): Promise<void> {
  await Promise.all(
    ADAPTER_LIST.map(async (adapter) => {
      if (!adapter.fetchIntervals) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
      try {
        const rows = await adapter.fetchIntervals(controller.signal);
        if (rows.length > 0) store.setIntervalMetadata(adapter.id, rows);
      } catch {
        // Missing metadata just means the previous cadence stands.
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

/**
 * Fills funding for venues whose funding stream never delivers. Some networks
 * serve Binance's book channels but nothing on its mark-price channel, which
 * would otherwise leave the venue with no rates at all. Values fetched here are
 * flagged `fromRest` so the UI can say where the number came from.
 */
export async function pollFundingFallback(store: MarketStore): Promise<void> {
  await Promise.all(
    ADAPTER_LIST.map(async (adapter) => {
      if (!adapter.fetchFundingSnapshot) return;
      const coins = store.coinsForVenue(adapter.id);
      if (coins.length === 0) return;

      // Only step in while the stream has produced nothing for this venue.
      if (store.hasStreamFunding(adapter.id)) {
        store.setFundingFromRest(adapter.id, false);
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
      try {
        const rows = await adapter.fetchFundingSnapshot(controller.signal, coins);
        if (rows.length === 0) return;
        const now = Date.now();
        const updates: StreamUpdate[] = rows.map((row) => ({
          kind: "funding" as const,
          exchange: adapter.id,
          coin: row.coin,
          ratePct: row.ratePct,
          nextFundingTime: row.nextFundingTime,
          intervalHours: row.intervalHours,
          ts: now,
          fromRest: true,
        }));
        store.applyUpdates(updates);
        store.setFundingFromRest(adapter.id, true);
      } catch (err) {
        store.markPoll(adapter.id, Date.now(), err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

/** Adapters that can serve funding over REST when their stream is silent. */
export function hasFundingFallback(exchange: ExchangeId): boolean {
  return typeof ADAPTERS[exchange]?.fetchFundingSnapshot === "function";
}

/**
 * Layer 1: each venue contributes its own top-N pairs by absolute funding rate.
 * Layer 2: for every coin any venue put in layer 1, subscribe the remaining
 * venues that also list it, so a row can be compared across the whole board.
 * Layer 3: pairs someone holds a position in, which must stay streamed even after
 * they drop out of the ranking.
 *
 * Claims are applied first and are not subject to the universe cap: a coin you
 * are exposed to is not a candidate competing for attention, it is a position
 * that has to be monitored.
 */
export function assignLayers(
  rankings: Map<ExchangeId, RankedPair[]>,
  listedByVenue: Map<ExchangeId, Set<string>>,
  layer1Count: number,
  claims: MarketClaim[] = [],
): LayerAssignment[] {
  const layer1 = new Map<ExchangeId, string[]>();
  for (const [exchange, ranked] of rankings) {
    layer1.set(exchange, ranked.slice(0, layer1Count).map((r) => r.coin));
  }

  const claimedCoins = new Set(claims.map((c) => c.coin));

  // Cap the universe, preferring coins that more venues flagged as hot. Claimed
  // coins are exempt: dropping one is what made the engine blind in the first
  // place.
  const interest = new Map<string, number>();
  for (const coins of layer1.values()) {
    for (const coin of coins) {
      interest.set(coin, (interest.get(coin) ?? 0) + 1);
    }
  }
  const rankedUniverse = [...interest.entries()]
    .filter(([coin]) => !claimedCoins.has(coin))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, MAX_COIN_UNIVERSE - claimedCoins.size))
    .map(([coin]) => coin);
  const universe = [...claimedCoins, ...rankedUniverse];
  const universeSet = new Set(universe);

  const out: LayerAssignment[] = [];
  const taken = new Set<string>();

  // Claims first, so a claimed pair is never displaced by ranking output.
  for (const claim of claims) {
    const key = `${claim.exchange}:${claim.coin}`;
    if (taken.has(key)) continue;
    taken.add(key);
    out.push({ exchange: claim.exchange, coin: claim.coin, layer: 3 });
  }

  for (const [exchange, coins] of layer1) {
    for (const coin of coins) {
      if (!universeSet.has(coin)) continue;
      const key = `${exchange}:${coin}`;
      if (taken.has(key)) continue;
      taken.add(key);
      out.push({ exchange, coin, layer: 1 });
    }
  }

  for (const coin of universe) {
    for (const exchange of EXCHANGE_IDS) {
      const key = `${exchange}:${coin}`;
      if (taken.has(key)) continue;
      if (!listedByVenue.get(exchange)?.has(coin)) continue;
      taken.add(key);
      out.push({ exchange, coin, layer: 2 });
    }
  }

  return out;
}
