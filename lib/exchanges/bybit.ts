import type { ExchangeAdapter, StreamUpdate, WsEndpointPlan } from "@/lib/exchanges/adapter";
import { baseFromConcatSymbol, decimalRateToPct, fetchJson, num } from "@/lib/exchanges/adapter";

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

// One channel carries funding and book together, so subscribing Bybit's whole
// market inherently streams its books too — there is no funding-only variant to
// pick. Measured on a live socket: 400 topics were accepted on one connection with
// every ack `success: true`, so 200 leaves the margin the venue's own docs suggest.
const PLAN: WsEndpointPlan = {
  key: "linear",
  carries: ["funding", "book"],
  mode: "topics",
  maxTopicsPerConnection: 200,
};

export const bybitAdapter: ExchangeAdapter = {
  id: "bybit",
  defaultIntervalHours: 8,

  async fetchInstruments(signal) {
    const body = await fetchJson<BybitTickersResponse>(
      "bybit/tickers",
      "https://api.bybit.com/v5/market/tickers?category=linear",
      signal,
    );
    const list = body.result?.list ?? [];
    const coins = new Set<string>();
    for (const t of list) {
      if (!t.symbol) continue;
      const coin = baseFromConcatSymbol(t.symbol);
      if (coin) coins.add(coin);
    }
    return [...coins];
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
