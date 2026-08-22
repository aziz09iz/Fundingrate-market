import type {
  ExchangeAdapter,
  FundingSnapshotRow,
  StreamUpdate,
  WsConnectionTarget,
  WsEndpointPlan,
} from "@/lib/exchanges/adapter";
import { fetchJson, num } from "@/lib/exchanges/adapter";

// Verified against live payloads (2026-08-20):
//   REST /api/v1/orderBookDetails?filter=perp
//        -> { order_book_details: [{ market_id, symbol, market_type, status }] }  229 perps
//   REST /api/v1/funding-rates
//        -> { funding_rates: [{ market_id, exchange, symbol, rate }] }            723 rows
//   WS   subscribe { type:"subscribe", channel:"market_stats/{market_id}" }
//        -> { channel:"market_stats:1", market_stats:{ symbol, current_funding_rate,
//             best_bid_price, best_ask_price, funding_timestamp }, type:"update/market_stats" }
//
// Three things about this venue need care:
//
//  1. Markets are addressed by a numeric `market_id`, not a symbol, and the WS API
//     accepts nothing else. The id→symbol map has to be fetched before a
//     subscription can be built, which is what `refreshMarkets` is for. ETH is id
//     0, so a falsy check on the id would silently drop it.
//
//  2. Funding units differ between Lighter's own two sources, which is the easiest
//     way to be wrong here. `market_stats.current_funding_rate` is a **percentage
//     per hour** ("0.0012" = 0.0012%/h), while REST `/funding-rates.rate` is a
//     **decimal fraction normalised to 8 hours** (0.000096). They agree exactly
//     as `rate / 8 * 100`, confirmed live across all markets. This app quotes
//     percentages at the venue's own cadence, so the socket value is used as-is
//     and the REST value is converted.
//
//  3. `/funding-rates` is a cross-venue table: every market appears up to four
//     times with `exchange` in {binance, bybit, hyperliquid, lighter}. Reading it
//     without filtering would attribute Binance's rate to Lighter.
//
// Lighter publishes no next-settlement timestamp anywhere — `funding_timestamp` is
// the *last* one. It funds on the hour, so the next boundary is derived.

const REST = "https://mainnet.zklighter.elliot.ai";
const WS = "wss://mainnet.zklighter.elliot.ai/stream";

interface OrderBookDetail {
  market_id?: number;
  symbol?: string;
  status?: string;
}

interface OrderBookDetailsResponse {
  order_book_details?: OrderBookDetail[];
}

interface FundingRateRow {
  market_id?: number;
  exchange?: string;
  symbol?: string;
  rate?: number;
}

interface FundingRatesResponse {
  funding_rates?: FundingRateRow[];
}

interface MarketStats {
  symbol?: string;
  market_id?: number;
  current_funding_rate?: string;
  funding_rate?: string;
  best_bid_price?: string;
  best_ask_price?: string;
}

interface Frame {
  type?: string;
  channel?: string;
  market_stats?: MarketStats | Record<string, MarketStats>;
  timestamp?: number;
}

// `market_stats/all` is a true firehose and the parser already handles its keyed-map
// shape: one socket, every market, funding and best bid/ask together. Confirmed live
// at 21 frames covering 229 symbols in ten seconds. That also removes the dependency
// on the coin → market_id map for subscribing, though the map is still what tells the
// registry which markets exist.
const PLAN: WsEndpointPlan = {
  key: "market_stats",
  carries: ["funding", "book"],
  mode: "firehose",
  maxTopicsPerConnection: 1,
};

/**
 * coin → market_id, refreshed by every instrument pass.
 *
 * Module state rather than a field because the adapter is a plain object shared
 * across the process, matching how the other adapters are written.
 */
const marketIds = new Map<string, number>();

/** Lighter settles on the hour. */
function nextHourBoundary(now = Date.now()): number {
  const hourMs = 3_600_000;
  return Math.floor(now / hourMs) * hourMs + hourMs;
}

/** Convert `/funding-rates.rate` (8h fraction) to a percentage per hour. */
function eightHourFractionToHourlyPct(rate: number | null): number | null {
  return rate === null ? null : (rate / 8) * 100;
}

async function refreshMarkets(signal: AbortSignal): Promise<void> {
  const body = await fetchJson<OrderBookDetailsResponse>(
    "lighter/orderBookDetails",
    `${REST}/api/v1/orderBookDetails?filter=perp`,
    signal,
  );
  const rows = body.order_book_details ?? [];
  if (rows.length === 0) return;
  // Rebuilt wholesale rather than merged: a delisted market should disappear
  // rather than linger with a stale id.
  marketIds.clear();
  for (const row of rows) {
    const coin = row.symbol?.trim().toUpperCase();
    const id = row.market_id;
    // Explicit null/undefined check: ETH is market 0.
    if (!coin || id === undefined || id === null) continue;
    if (row.status && row.status !== "active") continue;
    marketIds.set(coin, id);
  }
}

/** Lighter's own rows from the cross-venue funding table, as hourly percentages. */
async function lighterRates(signal: AbortSignal): Promise<Map<string, number>> {
  const body = await fetchJson<FundingRatesResponse>(
    "lighter/funding-rates",
    `${REST}/api/v1/funding-rates`,
    signal,
  );
  const out = new Map<string, number>();
  for (const row of body.funding_rates ?? []) {
    if (row.exchange !== "lighter") continue;
    const coin = row.symbol?.trim().toUpperCase();
    const ratePct = eightHourFractionToHourlyPct(num(row.rate));
    if (!coin || ratePct === null) continue;
    out.set(coin, ratePct);
  }
  return out;
}

export const lighterAdapter: ExchangeAdapter = {
  id: "lighter",
  defaultIntervalHours: 1,

  async fetchInstruments(signal) {
    await refreshMarkets(signal);
    return [...marketIds.keys()];
  },

  async fetchFundingSnapshot(signal, coins) {
    const wanted = new Set(coins);
    const rates = await lighterRates(signal);
    const out: FundingSnapshotRow[] = [];
    for (const [coin, ratePct] of rates) {
      if (!wanted.has(coin)) continue;
      out.push({
        coin,
        ratePct,
        nextFundingTime: nextHourBoundary(),
        intervalHours: 1,
      });
    }
    return out;
  },

  endpoints() {
    return [PLAN];
  },

  async resolveConnection(): Promise<WsConnectionTarget> {
    return {
      url: WS,
      // The server drops a connection that sends nothing for two minutes.
      heartbeat: { intervalMs: 30_000, message: { type: "ping" } },
    };
  },

  subscribeMessages() {
    return [{ type: "subscribe", channel: "market_stats/all" }];
  },

  unsubscribeMessages() {
    return [{ type: "unsubscribe", channel: "market_stats/all" }];
  },

  parseMessage(raw) {
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      return [];
    }
    if (!frame.type?.endsWith("/market_stats")) return [];
    const payload = frame.market_stats;
    if (!payload || typeof payload !== "object") return [];

    // `market_stats/all` returns a map keyed by market id; a single-market
    // subscription returns one object. Both shapes are handled so switching
    // channels later does not need a parser change.
    const stats: MarketStats[] =
      typeof (payload as MarketStats).symbol === "string"
        ? [payload as MarketStats]
        : Object.values(payload as Record<string, MarketStats>);

    const ts = num(frame.timestamp) ?? Date.now();
    const out: StreamUpdate[] = [];
    for (const row of stats) {
      const coin = row.symbol?.trim().toUpperCase();
      if (!coin) continue;

      // Already a percentage, and already per hour — no scaling.
      const ratePct = num(row.current_funding_rate ?? row.funding_rate);
      if (ratePct !== null) {
        out.push({
          kind: "funding",
          exchange: "lighter",
          coin,
          ratePct,
          nextFundingTime: nextHourBoundary(ts),
          intervalHours: 1,
          ts,
        });
      }

      const bid = num(row.best_bid_price);
      const ask = num(row.best_ask_price);
      if (bid !== null || ask !== null) {
        out.push({ kind: "book", exchange: "lighter", coin, bid, ask, ts });
      }
    }
    return out;
  },
};
