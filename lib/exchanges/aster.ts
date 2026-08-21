import type {
  ExchangeAdapter,
  FundingSnapshotRow,
  IntervalRow,
  StreamUpdate,
  WsConnectionTarget,
  WsEndpointPlan,
} from "@/lib/exchanges/adapter";
import {
  baseFromConcatSymbol,
  decimalRateToPct,
  fetchJson,
  num,
  rankByAbsRate,
} from "@/lib/exchanges/adapter";

// Verified against live payloads (2026-08-20):
//   REST /fapi/v1/premiumIndex        -> [{ symbol, lastFundingRate, nextFundingTime }]  702 rows
//   REST /fapi/v1/fundingInfo         -> [{ symbol, fundingIntervalHours }]              702 rows
//   REST /fapi/v1/ticker/bookTicker   -> [{ symbol, bidPrice, askPrice, time }]          538 rows
//   WS   <sym>@markPrice@1s -> { e:"markPriceUpdate", s, r, T, E }
//   WS   <sym>@bookTicker   -> { e:"bookTicker", s, b, a, E, T }
//
// Aster is a near-exact clone of Binance's USDⓈ-M futures API, so the shapes and
// field names below are Binance's. Two differences matter:
//
//   · Cadence is genuinely per-symbol. Of 702 symbols, 366 fund hourly, 260 every
//     8h, 73 every 4h and 3 every 2h. Diff FR divides by the interval, so
//     assuming one value would misscale the majority of this venue's rates —
//     `fetchIntervals` is load-bearing here, not a refinement.
//   · `premiumIndex` is a superset of `exchangeInfo`: 149 symbols (coin-margined
//     `*USD` and `SHIELD*` prefixed) appear in funding but never in the order
//     book. `baseFromConcatSymbol` rejects non-USDT quotes, which filters the
//     `*USD` set; the SHIELD names survive as their own coins and simply never
//     match another venue.
//
// Unlike Binance, Aster's mark-price stream is reachable, so funding arrives on
// the socket and the REST snapshot is only a fallback.

const REST = "https://fapi.asterdex.com";
const WS = "wss://fstream.asterdex.com/ws";

interface PremiumIndexRow {
  symbol?: string;
  lastFundingRate?: string;
  nextFundingTime?: number;
}

interface FundingInfoRow {
  symbol?: string;
  fundingIntervalHours?: number;
}

interface Frame {
  e?: string;
  s?: string;
  /** markPriceUpdate: funding rate as a decimal fraction. */
  r?: string;
  /** markPriceUpdate: next settlement, epoch ms. */
  T?: number;
  E?: number;
  /** bookTicker: best bid and ask. */
  b?: string;
  a?: string;
}

/**
 * One socket carries both topics.
 *
 * Aster allows 200 streams per connection and each coin needs two (mark price
 * and book ticker), so the cap is set at 90 coins to stay clear of the limit.
 */
const PLAN: WsEndpointPlan = {
  key: "combined",
  carries: ["funding", "book"],
  maxTopicsPerConnection: 90,
};

function streamNames(coins: string[]): string[] {
  return coins.flatMap((coin) => {
    const symbol = `${coin}usdt`.toLowerCase();
    return [`${symbol}@markPrice@1s`, `${symbol}@bookTicker`];
  });
}

export const asterAdapter: ExchangeAdapter = {
  id: "aster",
  defaultIntervalHours: 8,

  async fetchRanking(signal) {
    const rows = await fetchJson<PremiumIndexRow[]>(
      "aster/premiumIndex",
      `${REST}/fapi/v1/premiumIndex`,
      signal,
    );
    const pairs = rows.flatMap((r) => {
      const coin = baseFromConcatSymbol(r.symbol ?? "");
      if (!coin) return [];
      return [{ coin, ratePct: decimalRateToPct(r.lastFundingRate) }];
    });
    return rankByAbsRate(pairs);
  },

  async fetchFundingSnapshot(signal, coins) {
    const wanted = new Set(coins);
    const rows = await fetchJson<PremiumIndexRow[]>(
      "aster/premiumIndex",
      `${REST}/fapi/v1/premiumIndex`,
      signal,
    );
    return rows.flatMap((r): FundingSnapshotRow[] => {
      const coin = baseFromConcatSymbol(r.symbol ?? "");
      if (!coin || !wanted.has(coin)) return [];
      const ratePct = decimalRateToPct(r.lastFundingRate);
      if (ratePct === null) return [];
      return [{
        coin,
        ratePct,
        nextFundingTime: num(r.nextFundingTime),
        // The cadence comes from fetchIntervals; leaving it null here keeps one
        // source of truth for it rather than two that can disagree.
        intervalHours: null,
      }];
    });
  },

  async fetchIntervals(signal) {
    const rows = await fetchJson<FundingInfoRow[]>(
      "aster/fundingInfo",
      `${REST}/fapi/v1/fundingInfo`,
      signal,
    );
    return rows.flatMap((r): IntervalRow[] => {
      const coin = baseFromConcatSymbol(r.symbol ?? "");
      const hours = num(r.fundingIntervalHours);
      if (!coin || hours === null || hours <= 0) return [];
      return [{ coin, intervalHours: hours }];
    });
  },

  endpoints() {
    return [PLAN];
  },

  async resolveConnection(): Promise<WsConnectionTarget> {
    return { url: WS };
  },

  subscribeMessages(_plan, coins) {
    if (coins.length === 0) return [];
    return [{ method: "SUBSCRIBE", params: streamNames(coins), id: Date.now() }];
  },

  unsubscribeMessages(_plan, coins) {
    if (coins.length === 0) return [];
    return [{ method: "UNSUBSCRIBE", params: streamNames(coins), id: Date.now() }];
  },

  parseMessage(raw) {
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      return [];
    }
    // Subscribe acks look like { id, result: null } and carry no symbol.
    if (!frame.s) return [];
    const coin = baseFromConcatSymbol(frame.s);
    if (!coin) return [];

    if (frame.e === "markPriceUpdate") {
      const ratePct = decimalRateToPct(frame.r);
      if (ratePct === null) return [];
      return [{
        kind: "funding",
        exchange: "aster",
        coin,
        ratePct,
        nextFundingTime: num(frame.T),
        // Per-symbol cadence arrives through fetchIntervals.
        intervalHours: null,
        ts: num(frame.E) ?? Date.now(),
      } satisfies StreamUpdate];
    }

    if (frame.e === "bookTicker") {
      const bid = num(frame.b);
      const ask = num(frame.a);
      if (bid === null && ask === null) return [];
      return [{
        kind: "book",
        exchange: "aster",
        coin,
        bid,
        ask,
        ts: num(frame.E) ?? Date.now(),
      } satisfies StreamUpdate];
    }

    return [];
  },
};
