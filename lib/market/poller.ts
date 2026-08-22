import type { ExchangeId } from "@/lib/types";
import type { StreamUpdate } from "@/lib/exchanges/adapter";
import { ADAPTER_LIST } from "@/lib/exchanges";
import type { MarketStore } from "@/lib/market/store";
import type { InstrumentRegistry } from "@/lib/market/registry";

const REST_TIMEOUT_MS = 15_000;

/**
 * Reads each venue's declared funding cadence from its contract metadata.
 *
 * This is a correctness fix, not a cosmetic one: Diff FR normalizes by dividing
 * the rate by the interval, so assuming 8h for a 4h contract halves that
 * venue's contribution. Most listings on KuCoin and Bitget are 4h, and Aster's
 * cadence is genuinely per-symbol, so assuming the venue default was wrong for the
 * majority of pairs.
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
 * Fills funding over REST.
 *
 * Two different jobs behind one pass, and the distinction matters:
 *
 *   · For a venue declaring `fundingSource: "rest"`, this *is* the funding source. It
 *     runs unconditionally, because there is no stream to defer to — Bitget publishes
 *     funding only inside a ticker channel whose volume gets the socket closed.
 *   · For every other venue it is a safety net, and it steps in only while the stream
 *     has produced nothing. A network can serve a venue's book channels while its
 *     mark-price channel opens and then stays silent, which would otherwise leave that
 *     venue with no rates at all.
 *
 * Values fetched here are flagged `fromRest` either way, so the UI can say where the
 * number came from rather than implying a live stream.
 *
 * The coin list comes from the registry rather than the store, because the store only
 * knows the coins it has *received* data for — asking it which coins a silent venue
 * should have would return nothing, which is precisely the case this covers.
 */
export async function pollFundingFallback(
  store: MarketStore,
  registry: InstrumentRegistry,
): Promise<void> {
  await Promise.all(
    ADAPTER_LIST.map(async (adapter) => {
      if (!adapter.fetchFundingSnapshot) return;
      const coins = registry.coinsFor(adapter.id);
      if (coins.length === 0) return;

      const restIsPrimary = adapter.fundingSource === "rest";
      if (!restIsPrimary && store.hasStreamFunding(adapter.id)) {
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

/** Venues whose funding can be filled from REST when their stream is silent. */
export function fundingFallbackVenues(): ExchangeId[] {
  return ADAPTER_LIST.filter((a) => typeof a.fetchFundingSnapshot === "function").map((a) => a.id);
}
