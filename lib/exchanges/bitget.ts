import type {
  ExchangeAdapter,
  IntervalRow,
  StreamUpdate,
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
//   REST /api/v2/mix/market/tickers?productType=USDT-FUTURES
//        -> data[] { symbol, fundingRate, bidPr, askPr, nextFundingTime }
//   REST /api/v2/mix/market/contracts?productType=USDT-FUTURES
//        -> data[] { symbol, fundInterval }  (hours, as a string)
//   WS   channel "ticker" (instType USDT-FUTURES)
//        -> data[] { instId, fundingRate, nextFundingTime, bidPr, askPr, ts }
// One topic carries funding and best bid/ask together. Bitget expects the
// literal string "ping" as a heartbeat, not JSON. The ticker stream omits the
// cadence, so it is read from the contracts endpoint — roughly half of Bitget's
// listings are 4h rather than 8h.

interface BitgetResponse<T> {
  code?: string;
  data?: T;
}

interface BitgetTicker {
  symbol?: string;
  instId?: string;
  fundingRate?: string;
  nextFundingTime?: string;
  bidPr?: string;
  askPr?: string;
  ts?: string;
}

interface BitgetContract {
  symbol?: string;
  /** Funding interval in hours, sent as a string. */
  fundInterval?: string;
}

interface BitgetFrame {
  action?: string;
  event?: string;
  arg?: { channel?: string; instId?: string };
  data?: unknown[];
  ts?: number;
}

const PLAN: WsEndpointPlan = {
  key: "ticker",
  carries: ["funding", "book"],
  maxTopicsPerConnection: 120,
};

export const bitgetAdapter: ExchangeAdapter = {
  id: "bitget",
  defaultIntervalHours: 8,

  async fetchRanking(signal) {
    const body = await fetchJson<BitgetResponse<BitgetTicker[]>>(
      "bitget/tickers",
      "https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES",
      signal,
    );
    const rows = body.data ?? [];
    const pairs = rows.flatMap((t) => {
      const coin = baseFromConcatSymbol(t.symbol ?? "");
      if (!coin) return [];
      return [{ coin, ratePct: decimalRateToPct(t.fundingRate) }];
    });
    return rankByAbsRate(pairs);
  },

  async fetchIntervals(signal) {
    const body = await fetchJson<BitgetResponse<BitgetContract[]>>(
      "bitget/contracts",
      "https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES",
      signal,
    );
    const rows = body.data ?? [];
    return rows.flatMap((c): IntervalRow[] => {
      const coin = baseFromConcatSymbol(c.symbol ?? "");
      const hours = num(c.fundInterval);
      if (!coin || hours === null || hours <= 0) return [];
      return [{ coin, intervalHours: hours }];
    });
  },

  endpoints() {
    return [PLAN];
  },

  async resolveConnection() {
    return {
      url: "wss://ws.bitget.com/v2/ws/public",
      heartbeat: { intervalMs: 25_000, message: "ping" },
    };
  },

  subscribeMessages(_plan, coins) {
    return [{
      op: "subscribe",
      args: coins.map((coin) => ({
        instType: "USDT-FUTURES",
        channel: "ticker",
        instId: `${coin}USDT`,
      })),
    }];
  },

  unsubscribeMessages(_plan, coins) {
    return [{
      op: "unsubscribe",
      args: coins.map((coin) => ({
        instType: "USDT-FUTURES",
        channel: "ticker",
        instId: `${coin}USDT`,
      })),
    }];
  },

  parseMessage(raw) {
    if (raw === "pong") return [];
    let frame: BitgetFrame;
    try {
      frame = JSON.parse(raw) as BitgetFrame;
    } catch {
      return [];
    }
    if (frame.event || frame.arg?.channel !== "ticker" || !Array.isArray(frame.data)) {
      return [];
    }
    const frameTs = num(frame.ts) ?? Date.now();

    return frame.data.flatMap((entry): StreamUpdate[] => {
      const row = entry as BitgetTicker;
      const coin = baseFromConcatSymbol(row.instId ?? row.symbol ?? frame.arg?.instId ?? "");
      if (!coin) return [];
      const ts = num(row.ts) ?? frameTs;
      const out: StreamUpdate[] = [];

      const ratePct = decimalRateToPct(row.fundingRate);
      if (ratePct !== null) {
        out.push({
          kind: "funding",
          exchange: "bitget",
          coin,
          ratePct,
          nextFundingTime: num(row.nextFundingTime),
          intervalHours: null,
          ts,
        });
      }

      const bid = num(row.bidPr);
      const ask = num(row.askPr);
      if (bid !== null || ask !== null) {
        out.push({ kind: "book", exchange: "bitget", coin, bid, ask, ts });
      }

      return out;
    });
  },
};
