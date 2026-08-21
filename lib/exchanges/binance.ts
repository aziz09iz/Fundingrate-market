import type {
  ExchangeAdapter,
  FundingSnapshotRow,
  IntervalRow,
  RankedPair,
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

// Verified against live payloads:
//   REST  /fapi/v1/premiumIndex -> { symbol, lastFundingRate, nextFundingTime }
//   WS    <sym>@depth5@500ms    -> { e:"depthUpdate", s, b:[[px,qty]], a:[[px,qty]] }
//
// Important caveat found while testing: on some networks Binance's futures
// stream serves the book channels but delivers nothing on `@markPrice`,
// `@aggTrade`, `@ticker` or `!markPrice@arr` — the socket opens and stays
// silent. Book data therefore comes from the stream, while funding falls back
// to `fetchFundingSnapshot` below. That fallback is flagged so the UI can say
// the number came from REST instead of implying it is a live stream value.

interface PremiumIndexRow {
  symbol: string;
  lastFundingRate: string;
  nextFundingTime: number;
  time?: number;
}

interface FundingInfoRow {
  symbol?: string;
  fundingIntervalHours?: number;
}

interface CombinedFrame {
  stream?: string;
  data?: {
    e?: string;
    s?: string;
    r?: string;
    T?: number;
    E?: number;
    b?: string | string[][];
    a?: string | string[][];
  };
}

const PLAN: WsEndpointPlan = {
  key: "book",
  carries: ["book"],
  // Binance allows 1024 streams per connection; stay well under it.
  maxTopicsPerConnection: 180,
};

const PREMIUM_INDEX_URL = "https://fapi.binance.com/fapi/v1/premiumIndex";

export const binanceAdapter: ExchangeAdapter = {
  id: "binance",
  defaultIntervalHours: 8,
  urlCarriesTopics: true,

  async fetchRanking(signal) {
    const rows = await fetchJson<PremiumIndexRow[]>(
      "binance/premiumIndex",
      PREMIUM_INDEX_URL,
      signal,
    );
    const pairs = rows.map((r) => {
      const coin = baseFromConcatSymbol(r.symbol);
      return coin ? { coin, ratePct: decimalRateToPct(r.lastFundingRate) } : null;
    });
    return rankByAbsRate(pairs.filter((p): p is { coin: string; ratePct: number | null } => p !== null));
  },

  async fetchFundingSnapshot(signal, coins) {
    const wanted = new Set(coins);
    const rows = await fetchJson<PremiumIndexRow[]>(
      "binance/premiumIndex",
      PREMIUM_INDEX_URL,
      signal,
    );
    return rows.flatMap((r): FundingSnapshotRow[] => {
      const coin = baseFromConcatSymbol(r.symbol);
      if (!coin || !wanted.has(coin)) return [];
      const ratePct = decimalRateToPct(r.lastFundingRate);
      if (ratePct === null) return [];
      return [{
        coin,
        ratePct,
        nextFundingTime: num(r.nextFundingTime),
        // Binance does not state the cadence here; the store infers it from
        // successive settlement timestamps.
        intervalHours: null,
      }];
    });
  },

  async fetchIntervals(signal) {
    // /fapi/v1/fundingInfo states the real cadence per symbol. Most listings
    // are 4h rather than the 8h default, so this is load-bearing for Diff FR.
    const rows = await fetchJson<FundingInfoRow[]>(
      "binance/fundingInfo",
      "https://fapi.binance.com/fapi/v1/fundingInfo",
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
    // Real URL is built per-subscription set by buildTopicUrl.
    return { url: "wss://fstream.binance.com/stream" };
  },

  buildTopicUrl(_plan, coins) {
    const streams = coins.map((coin) => `${coin}usdt`.toLowerCase() + "@depth5@500ms");
    return `wss://fstream.binance.com/stream?streams=${streams.join("/")}`;
  },

  subscribeMessages() {
    return [];
  },

  unsubscribeMessages() {
    return [];
  },

  parseMessage(raw) {
    let frame: CombinedFrame;
    try {
      frame = JSON.parse(raw) as CombinedFrame;
    } catch {
      return [];
    }
    const data = frame.data;
    if (!data?.s) return [];
    const coin = baseFromConcatSymbol(data.s);
    if (!coin) return [];

    if (data.e === "markPriceUpdate") {
      // Kept in case the channel becomes reachable again on another network.
      const ratePct = decimalRateToPct(data.r);
      if (ratePct === null) return [];
      return [{
        kind: "funding",
        exchange: "binance",
        coin,
        ratePct,
        nextFundingTime: num(data.T),
        intervalHours: null,
        ts: num(data.E) ?? Date.now(),
      }];
    }

    if (data.e === "depthUpdate") {
      // Partial depth frames carry arrays of [price, qty]; index 0 is the top.
      const bids = Array.isArray(data.b) ? data.b : null;
      const asks = Array.isArray(data.a) ? data.a : null;
      const bid = num(bids?.[0]?.[0]);
      const ask = num(asks?.[0]?.[0]);
      if (bid === null && ask === null) return [];
      return [{
        kind: "book",
        exchange: "binance",
        coin,
        bid,
        ask,
        ts: num(data.E) ?? Date.now(),
      }];
    }

    return [];
  },
};

export type { RankedPair, StreamUpdate };
