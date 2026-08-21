import type { ExchangeAdapter, StreamUpdate, WsEndpointPlan } from "@/lib/exchanges/adapter";
import { decimalRateToPct, fetchJson, num, rankByAbsRate } from "@/lib/exchanges/adapter";

// Verified against live payloads:
//   REST /api/v4/futures/usdt/contracts -> { name, funding_rate, funding_interval }
//   WS   futures.tickers      -> result[] { contract, funding_rate, funding_interval,
//                                          funding_next_apply (seconds) }
//   WS   futures.book_ticker  -> result { s, b, a, t }
// Gate reports funding_interval in seconds, so the cadence is exact. Its
// tickers channel carries no bid/ask (confirmed against a live frame), so
// book_ticker is required for quotes; the manager throttles those writes.

interface GateContract {
  name?: string;
  funding_rate?: string;
  status?: string;
  in_delisting?: boolean;
}

interface GateTicker {
  contract?: string;
  funding_rate?: string;
  funding_interval?: number;
  funding_next_apply?: number;
}

interface GateBookTicker {
  s?: string;
  b?: string;
  a?: string;
  t?: number;
}

interface GateFrame {
  channel?: string;
  event?: string;
  time_ms?: number;
  result?: unknown;
}

const TICKER_PLAN: WsEndpointPlan = {
  key: "tickers",
  carries: ["funding"],
  maxTopicsPerConnection: 150,
};

const BOOK_PLAN: WsEndpointPlan = {
  key: "book_ticker",
  carries: ["book"],
  maxTopicsPerConnection: 150,
};

function contractName(coin: string): string {
  return `${coin}_USDT`;
}

function coinFromContract(name: string | undefined): string | null {
  if (!name) return null;
  const [base, quote] = name.split("_");
  if (quote !== "USDT" || !base) return null;
  return base;
}

export const gateioAdapter: ExchangeAdapter = {
  id: "gateio",
  defaultIntervalHours: 8,

  async fetchRanking(signal) {
    const rows = await fetchJson<GateContract[]>(
      "gateio/contracts",
      "https://api.gateio.ws/api/v4/futures/usdt/contracts",
      signal,
    );
    const pairs = rows.flatMap((c) => {
      if (c.in_delisting || (c.status && c.status !== "trading")) return [];
      const coin = coinFromContract(c.name);
      if (!coin) return [];
      return [{ coin, ratePct: decimalRateToPct(c.funding_rate) }];
    });
    return rankByAbsRate(pairs);
  },

  endpoints() {
    return [TICKER_PLAN, BOOK_PLAN];
  },

  async resolveConnection() {
    return {
      url: "wss://fx-ws.gateio.ws/v4/ws/usdt",
      heartbeat: {
        intervalMs: 20_000,
        message: { time: Math.floor(Date.now() / 1000), channel: "futures.ping" },
      },
    };
  },

  subscribeMessages(plan, coins) {
    return [{
      time: Math.floor(Date.now() / 1000),
      channel: `futures.${plan.key}`,
      event: "subscribe",
      payload: coins.map(contractName),
    }];
  },

  unsubscribeMessages(plan, coins) {
    return [{
      time: Math.floor(Date.now() / 1000),
      channel: `futures.${plan.key}`,
      event: "unsubscribe",
      payload: coins.map(contractName),
    }];
  },

  parseMessage(raw) {
    let frame: GateFrame;
    try {
      frame = JSON.parse(raw) as GateFrame;
    } catch {
      return [];
    }
    if (frame.event !== "update" || !frame.result) return [];
    const ts = num(frame.time_ms) ?? Date.now();

    if (frame.channel === "futures.tickers" && Array.isArray(frame.result)) {
      return frame.result.flatMap((entry): StreamUpdate[] => {
        const row = entry as GateTicker;
        const coin = coinFromContract(row.contract);
        const ratePct = decimalRateToPct(row.funding_rate);
        if (!coin || ratePct === null) return [];
        const intervalSec = num(row.funding_interval);
        const nextApplySec = num(row.funding_next_apply);
        return [{
          kind: "funding",
          exchange: "gateio",
          coin,
          ratePct,
          nextFundingTime: nextApplySec !== null ? nextApplySec * 1000 : null,
          intervalHours: intervalSec && intervalSec > 0 ? intervalSec / 3600 : null,
          ts,
        }];
      });
    }

    if (frame.channel === "futures.book_ticker") {
      const row = frame.result as GateBookTicker;
      const coin = coinFromContract(row.s);
      if (!coin) return [];
      const bid = num(row.b);
      const ask = num(row.a);
      if (bid === null && ask === null) return [];
      return [{
        kind: "book",
        exchange: "gateio",
        coin,
        bid,
        ask,
        ts: num(row.t) ?? ts,
      }];
    }

    return [];
  },
};
