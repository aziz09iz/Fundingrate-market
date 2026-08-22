import type {
  ExchangeAdapter,
  FundingSnapshotRow,
  IntervalRow,
  StreamUpdate,
  WsEndpointPlan,
} from "@/lib/exchanges/adapter";
import {
  baseFromConcatSymbol,
  decimalRateToPct,
  fetchJson,
  num,
} from "@/lib/exchanges/adapter";

// Verified against live payloads:
//   REST /api/v2/mix/market/tickers?productType=USDT-FUTURES
//        -> data[] { symbol, fundingRate, bidPr, askPr, nextFundingTime }  759 rows
//   REST /api/v2/mix/market/contracts?productType=USDT-FUTURES
//        -> data[] { symbol, fundInterval }  (hours, as a string)
//   WS   channel "ticker" (instType USDT-FUTURES)
//        -> data[] { instId, fundingRate, nextFundingTime, bidPr, askPr, ts }
//
// Bitget expects the literal string "ping" as a heartbeat, not JSON. The ticker stream
// omits the cadence, so it is read from the contracts endpoint — roughly half of
// Bitget's listings are 4h rather than 8h.
//
// Funding comes from REST here, and that is a deliberate reversal. Bitget publishes no
// funding-only channel (`funding-time` is refused with code 30016), so funding arrives
// bundled into the per-symbol ticker — measured live at 729 frames and 412 KB per second
// for 200 symbols, which projects to ~2,800 frames and 1.5 MB/s across all 759. Sockets
// carrying that were closed by the venue with code 1006 within 40–80 seconds, every
// shard, repeatedly. One REST call returns all 759 rates, so funding is polled and the
// ticker channel is reserved for the pairs Book Focus actually wants a quote on.

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

const TICKERS_URL = "https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES";

// Book only, and narrow. A live socket accepted 400 topics, but the volume rather than
// the count is the constraint, so this is sized for the focus set rather than the market.
const PLAN: WsEndpointPlan = {
  key: "ticker",
  carries: ["book"],
  mode: "topics",
  maxTopicsPerConnection: 120,
};

export const bitgetAdapter: ExchangeAdapter = {
  id: "bitget",
  defaultIntervalHours: 8,
  fundingSource: "rest",

  async fetchInstruments(signal) {
    const body = await fetchJson<BitgetResponse<BitgetTicker[]>>(
      "bitget/tickers",
      TICKERS_URL,
      signal,
    );
    const coins = new Set<string>();
    for (const t of body.data ?? []) {
      const coin = baseFromConcatSymbol(t.symbol ?? "");
      if (coin) coins.add(coin);
    }
    return [...coins];
  },

  /**
   * Every symbol's funding rate in one request.
   *
   * The primary source for this venue, not a fallback. `coins` is ignored: the endpoint
   * returns the whole market anyway, and filtering it would only discard rows the store
   * is about to want.
   */
  async fetchFundingSnapshot(signal) {
    const body = await fetchJson<BitgetResponse<BitgetTicker[]>>(
      "bitget/tickers",
      TICKERS_URL,
      signal,
    );
    return (body.data ?? []).flatMap((row): FundingSnapshotRow[] => {
      const coin = baseFromConcatSymbol(row.symbol ?? "");
      const ratePct = decimalRateToPct(row.fundingRate);
      if (!coin || ratePct === null) return [];
      return [{
        coin,
        ratePct,
        nextFundingTime: num(row.nextFundingTime),
        // The cadence comes from fetchIntervals; one source of truth for it.
        intervalHours: null,
      }];
    });
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
      const bid = num(row.bidPr);
      const ask = num(row.askPr);
      // Funding is deliberately dropped even though the frame carries it: REST is this
      // venue's funding source, and letting the stream also write it would leave the
      // store's `fromRest` flag flipping with whichever arrived last.
      if (bid === null && ask === null) return [];
      return [{ kind: "book", exchange: "bitget", coin, bid, ask, ts }];
    });
  },
};
