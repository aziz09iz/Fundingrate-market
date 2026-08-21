import type {
  ExchangeId,
  FundingDirection,
  FundingRateRow,
  FundingRateValue,
  PairScope,
  PriceSide,
  PriceSpread,
  Ticker,
} from "@/lib/types";
import { EXCHANGE_IDS, exchangeInfo, pairInScope } from "@/lib/utils";

/** Per-venue readings for one coin, as held by the store. */
export interface CoinReadings {
  funding: Partial<Record<ExchangeId, FundingRateValue>>;
  tickers: Partial<Record<ExchangeId, Ticker>>;
}

/**
 * Normalize each venue's rate to the smallest funding interval among the venues
 * that list this coin, so an hourly venue is comparable with an 8-hourly one.
 */
export function normalizeRates(
  rates: Record<ExchangeId, FundingRateValue>,
): { normalizedRates: Record<ExchangeId, number | null>; smallestInterval: number | null } {
  const listed = EXCHANGE_IDS.map((id) => rates[id]).filter((v) => v.rate !== null);
  if (listed.length === 0) {
    return {
      normalizedRates: emptyNormalized(),
      smallestInterval: null,
    };
  }
  const smallestInterval = Math.min(...listed.map((v) => v.intervalHours));
  const normalizedRates = EXCHANGE_IDS.reduce((acc, id) => {
    const value = rates[id];
    acc[id] =
      value.rate === null || !value.intervalHours
        ? null
        : Number(((value.rate * smallestInterval) / value.intervalHours).toFixed(6));
    return acc;
  }, {} as Record<ExchangeId, number | null>);
  return { normalizedRates, smallestInterval };
}

function emptyNormalized(): Record<ExchangeId, number | null> {
  return EXCHANGE_IDS.reduce((acc, id) => {
    acc[id] = null;
    return acc;
  }, {} as Record<ExchangeId, number | null>);
}

/**
 * Long the venue paying the least funding, short the venue paying the most.
 * Diff FR is the gap between them after normalization.
 */
export function deriveDirection(
  normalizedRates: Record<ExchangeId, number | null>,
  smallestInterval: number | null,
  allowed?: ExchangeId[],
): { diffFr: number | null; direction: FundingDirection | null } {
  const pool = (allowed ?? EXCHANGE_IDS)
    .map((exchange) => ({ exchange, rate: normalizedRates[exchange] }))
    .filter((v): v is { exchange: ExchangeId; rate: number } => v.rate !== null);
  if (pool.length < 2 || smallestInterval === null) {
    return { diffFr: null, direction: null };
  }
  const lowest = pool.reduce((a, b) => (b.rate < a.rate ? b : a));
  const highest = pool.reduce((a, b) => (b.rate > a.rate ? b : a));
  const diffFr = Number((highest.rate - lowest.rate).toFixed(6));
  return {
    diffFr,
    direction: {
      longExchange: lowest.exchange,
      shortExchange: highest.exchange,
      longRate: lowest.rate,
      shortRate: highest.rate,
      intervalHours: smallestInterval,
      diff: diffFr,
    },
  };
}

/**
 * Same as `deriveDirection`, but the two legs must satisfy a pair scope.
 *
 * The unconstrained version takes the global minimum and maximum, which on a
 * cross-venue view can land both legs on the same side of the split and produce
 * a pair the page is not about. Here the best pair is searched under the
 * constraint instead: for a cross scope that means the cheapest venue of one
 * kind against the most expensive of the other, checked in both orientations
 * because either can win.
 */
export function deriveScopedDirection(
  normalizedRates: Record<ExchangeId, number | null>,
  smallestInterval: number | null,
  scope: PairScope,
  allowed?: ExchangeId[],
): { diffFr: number | null; direction: FundingDirection | null } {
  if (smallestInterval === null) return { diffFr: null, direction: null };
  const pool = (allowed ?? EXCHANGE_IDS)
    .map((exchange) => ({ exchange, rate: normalizedRates[exchange] }))
    .filter((v): v is { exchange: ExchangeId; rate: number } => v.rate !== null);
  if (pool.length < 2) return { diffFr: null, direction: null };

  let best: { long: ExchangeId; short: ExchangeId; longRate: number; shortRate: number } | null =
    null;
  // Seven venues at most, so the pair search is 21 comparisons — not worth an
  // index to avoid.
  for (const a of pool) {
    for (const b of pool) {
      if (a.exchange === b.exchange) continue;
      if (!pairInScope(scope, a.exchange, b.exchange)) continue;
      // Long the cheaper leg, short the dearer one; skip the reversed ordering.
      if (a.rate > b.rate) continue;
      if (best === null || b.rate - a.rate > best.shortRate - best.longRate) {
        best = { long: a.exchange, short: b.exchange, longRate: a.rate, shortRate: b.rate };
      }
    }
  }
  if (best === null) return { diffFr: null, direction: null };

  const diffFr = Number((best.shortRate - best.longRate).toFixed(6));
  return {
    diffFr,
    direction: {
      longExchange: best.long,
      shortExchange: best.short,
      longRate: best.longRate,
      shortRate: best.shortRate,
      intervalHours: smallestInterval,
      diff: diffFr,
    },
  };
}

/**
 * Entry cost of the hedge using executable prices:
 * the long leg lifts the ask, the short leg hits the bid.
 * Positive means the entry starts in credit.
 */
export function derivePriceSpread(
  direction: FundingDirection | null,
  tickers: Record<ExchangeId, Ticker | null>,
): PriceSpread | null {
  if (!direction) return null;
  const longAsk = tickers[direction.longExchange]?.ask ?? null;
  const shortBid = tickers[direction.shortExchange]?.bid ?? null;
  if (longAsk === null || shortBid === null || longAsk <= 0) return null;
  return {
    longExchange: direction.longExchange,
    shortExchange: direction.shortExchange,
    longAsk,
    shortBid,
    pct: Number((((shortBid - longAsk) / longAsk) * 100).toFixed(4)),
  };
}

/**
 * Cost of *unwinding* the same hedge, which uses the other side of both books:
 * the long leg is sold into the long venue's bid, the short leg is bought back at
 * the short venue's ask.
 *
 * This is a separate number from the entry spread and always the worse of the
 * two at any single instant, by the sum of both venues' bid-ask widths. Measuring
 * an exit against the entry-side spread is what made the strategy report gains it
 * never earned: profit is `entry spread − exit spread`, and both have to be
 * quoted on the side actually traded.
 */
export function deriveExitSpread(
  direction: FundingDirection | null,
  tickers: Record<ExchangeId, Ticker | null>,
): PriceSpread | null {
  if (!direction) return null;
  const longBid = tickers[direction.longExchange]?.bid ?? null;
  const shortAsk = tickers[direction.shortExchange]?.ask ?? null;
  if (longBid === null || shortAsk === null || longBid <= 0) return null;
  return {
    longExchange: direction.longExchange,
    shortExchange: direction.shortExchange,
    // Named for the entry orientation on the shared type; here they hold the
    // exit side, which is why this function exists separately.
    longAsk: longBid,
    shortBid: shortAsk,
    pct: Number((((shortAsk - longBid) / longBid) * 100).toFixed(4)),
  };
}

/**
 * Which side of the book to show under a venue's funding rate.
 *
 * The two Direction venues show the side they would actually trade. For every
 * other venue the funding sign decides: a negative rate pays longs, so the
 * interesting entry is a long (ask); a positive rate pays shorts (bid).
 */
export function executablePriceSide(
  exchange: ExchangeId,
  ratePct: number | null,
  direction: FundingDirection | null,
): PriceSide {
  if (direction) {
    if (exchange === direction.longExchange) return "ask";
    if (exchange === direction.shortExchange) return "bid";
  }
  if (ratePct !== null && ratePct > 0) return "bid";
  return "ask";
}

export function priceForSide(ticker: Ticker | null, side: PriceSide): number | null {
  if (!ticker) return null;
  return side === "bid" ? ticker.bid : ticker.ask;
}

/** Build one dashboard row from the store's readings for a coin. */
export function buildRow(coin: string, readings: CoinReadings): FundingRateRow {
  const rates = EXCHANGE_IDS.reduce((acc, id) => {
    const existing = readings.funding[id];
    acc[id] = existing ?? {
      exchange: id,
      rate: null,
      intervalHours: exchangeInfo(id).defaultIntervalHours,
      nextFundingTime: 0,
      intervalConfirmed: false,
    };
    return acc;
  }, {} as Record<ExchangeId, FundingRateValue>);

  const tickers = EXCHANGE_IDS.reduce((acc, id) => {
    acc[id] = readings.tickers[id] ?? null;
    return acc;
  }, {} as Record<ExchangeId, Ticker | null>);

  const { normalizedRates, smallestInterval } = normalizeRates(rates);
  const { diffFr, direction } = deriveDirection(normalizedRates, smallestInterval);
  const priceSpread = derivePriceSpread(direction, tickers);

  return {
    coin,
    // Live data has no display name beyond the ticker symbol.
    name: coin,
    rates,
    normalizedRates,
    tickers,
    spread: diffFr,
    diffFr,
    direction,
    priceSpread,
  };
}
