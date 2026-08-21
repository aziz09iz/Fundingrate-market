import type { ExchangeId } from "@/lib/types";
import { getMarketRuntime } from "@/lib/market/runtime";

/**
 * Mark prices for valuing open positions, keyed both as `exchange:coin` and by
 * bare coin so a lookup falls back to any venue quoting that coin.
 */
export function markPriceMap(): Map<string, number> {
  const marks = new Map<string, number>();
  for (const row of getMarketRuntime().snapshot().rows) {
    for (const [exchange, ticker] of Object.entries(row.tickers)) {
      if (!ticker) continue;
      const mid =
        ticker.bid !== null && ticker.ask !== null
          ? (ticker.bid + ticker.ask) / 2
          : (ticker.ask ?? ticker.bid);
      if (mid === null) continue;
      marks.set(`${exchange as ExchangeId}:${row.coin}`, mid);
      if (!marks.has(row.coin)) marks.set(row.coin, mid);
    }
  }
  return marks;
}

/**
 * Executable price for a simulated fill: a buy lifts the ask, a sell hits the
 * bid. Returns null when the venue has no quote, so the caller can refuse
 * rather than invent a price.
 */
export function executableFillPrice(
  coin: string,
  exchange: ExchangeId,
  side: "buy" | "sell",
): number | null {
  const row = getMarketRuntime().snapshot().rows.find((r) => r.coin === coin);
  const ticker = row?.tickers[exchange] ?? null;
  if (!ticker) return null;
  return side === "buy" ? ticker.ask : ticker.bid;
}
