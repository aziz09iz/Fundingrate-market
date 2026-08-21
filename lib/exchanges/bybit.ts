import type { ExchangeAdapter, StreamUpdate, WsEndpointPlan } from "@/lib/exchanges/adapter";
import {
  baseFromConcatSymbol,
  decimalRateToPct,
  fetchJson,
  num,
  rankByAbsRate,
} from "@/lib/exchanges/adapter";

// Verified against live payloads: one `tickers.SYMBOL` topic carries funding
// rate, nextFundingTime, fundingIntervalHour, bid1Price and ask1Price together.
// Deltas omit unchanged fields, so partial frames are normal and expected.

interface BybitTickersResponse {
  result?: { list?: BybitTicker[] };
}

interface BybitTicker {
  symbol?: string;
  fundingRate?: string;
  nextFundingTime?: string;
  fundingIntervalHour?: string;
  bid1Price?: string;
  ask1Price?: string;
}

interface BybitFrame {
  topic?: string;
  ts?: number;
  data?: BybitTicker;
}

const PLAN: WsEndpointPlan = {
  key: "linear",
  carries: ["funding", "book"],
  // Bybit allows up to 10 args per subscribe frame but many topics per socket.
  maxTopicsPerConnection: 180,
};

export const bybitAdapter: ExchangeAdapter = {
  id: "bybit",
  defaultIntervalHours: 8,

  async fetchRanking(signal) {
    const body = await fetchJson<BybitTickersResponse>(
      "bybit/tickers",
      "https://api.bybit.com/v5/market/tickers?category=linear",
      signal,
    );
    const list = body.result?.list ?? [];
    const pairs = list.flatMap((t) => {
      if (!t.symbol) return [];
      const coin = baseFromConcatSymbol(t.symbol);
      if (!coin) return [];
      return [{ coin, ratePct: decimalRateToPct(t.fundingRate) }];
    });
    return rankByAbsRate(pairs);
  },

  endpoints() {
    return [PLAN];
  },

  async resolveConnection() {
    return {
      url: "wss://stream.bybit.com/v5/public/linear",
      heartbeat: { intervalMs: 20_000, message: { op: "ping" } },
    };
  },

  subscribeMessages(_plan, coins) {
    // Keep frames small; Bybit caps args per message.
    return chunk(coins, 10).map((group) => ({
      op: "subscribe",
      args: group.map((coin) => `tickers.${coin}USDT`),
    }));
  },

  unsubscribeMessages(_plan, coins) {
    return chunk(coins, 10).map((group) => ({
      op: "unsubscribe",
      args: group.map((coin) => `tickers.${coin}USDT`),
    }));
  },

  parseMessage(raw) {
    let frame: BybitFrame;
    try {
      frame = JSON.parse(raw) as BybitFrame;
    } catch {
      return [];
    }
    if (!frame.topic?.startsWith("tickers.") || !frame.data) return [];
    const symbol = frame.data.symbol ?? frame.topic.slice("tickers.".length);
    const coin = baseFromConcatSymbol(symbol);
    if (!coin) return [];

    const ts = num(frame.ts) ?? Date.now();
    const out: StreamUpdate[] = [];

    const ratePct = decimalRateToPct(frame.data.fundingRate);
    if (ratePct !== null) {
      const hours = num(frame.data.fundingIntervalHour);
      out.push({
        kind: "funding",
        exchange: "bybit",
        coin,
        ratePct,
        nextFundingTime: num(frame.data.nextFundingTime),
        intervalHours: hours && hours > 0 ? hours : null,
        ts,
      });
    }

    const bid = num(frame.data.bid1Price);
    const ask = num(frame.data.ask1Price);
    if (bid !== null || ask !== null) {
      out.push({ kind: "book", exchange: "bybit", coin, bid, ask, ts });
    }

    return out;
  },
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
