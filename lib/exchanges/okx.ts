import type { ExchangeAdapter, StreamUpdate, WsEndpointPlan } from "@/lib/exchanges/adapter";
import { decimalRateToPct, fetchJson, num, rankByAbsRate } from "@/lib/exchanges/adapter";

// Verified against live payloads:
//   REST /api/v5/public/funding-rate?instId=ANY returns every SWAP at once,
//        with fundingRate, fundingTime and nextFundingTime.
//   WS   funding-rate -> data[].fundingRate / fundingTime / nextFundingTime
//   WS   bbo-tbt      -> data[].asks[0][0], data[].bids[0][0]
// OKX gives fundingTime and nextFundingTime, so the cadence is derivable
// directly rather than inferred over multiple settlements.

interface OkxResponse<T> {
  code?: string;
  msg?: string;
  data?: T;
}

interface OkxFundingRow {
  instId?: string;
  fundingRate?: string;
  fundingTime?: string;
  nextFundingTime?: string;
  ts?: string;
}

interface OkxFrame {
  arg?: { channel?: string; instId?: string };
  data?: unknown[];
  event?: string;
}

interface OkxTickerRow {
  instId?: string;
  bidPx?: string;
  askPx?: string;
  ts?: string;
}

const FUNDING_PLAN: WsEndpointPlan = {
  key: "funding",
  carries: ["funding"],
  maxTopicsPerConnection: 120,
};

const BOOK_PLAN: WsEndpointPlan = {
  key: "tickers",
  carries: ["book"],
  maxTopicsPerConnection: 120,
};

function instId(coin: string): string {
  return `${coin}-USDT-SWAP`;
}

function coinFromInstId(id: string | undefined): string | null {
  if (!id) return null;
  const parts = id.split("-");
  if (parts.length < 3 || parts[1] !== "USDT" || parts[2] !== "SWAP") return null;
  return parts[0] || null;
}

export const okxAdapter: ExchangeAdapter = {
  id: "okx",
  defaultIntervalHours: 8,

  async fetchRanking(signal) {
    // instId is required but OKX returns the full SWAP set for any value.
    const body = await fetchJson<OkxResponse<OkxFundingRow[]>>(
      "okx/funding-rate",
      "https://www.okx.com/api/v5/public/funding-rate?instId=ANY",
      signal,
    );
    const rows = body.data ?? [];
    const pairs = rows.flatMap((r) => {
      const coin = coinFromInstId(r.instId);
      if (!coin) return [];
      return [{ coin, ratePct: decimalRateToPct(r.fundingRate) }];
    });
    return rankByAbsRate(pairs);
  },

  endpoints() {
    return [FUNDING_PLAN, BOOK_PLAN];
  },

  async resolveConnection() {
    return {
      url: "wss://ws.okx.com:8443/ws/v5/public",
      heartbeat: { intervalMs: 20_000, message: "ping" },
    };
  },

  subscribeMessages(plan, coins) {
    // `tickers` updates a few times per second, unlike `bbo-tbt` which fires on
    // every book change and floods the process when many pairs are watched.
    const channel = plan.key === "funding" ? "funding-rate" : "tickers";
    return [{
      op: "subscribe",
      args: coins.map((coin) => ({ channel, instId: instId(coin) })),
    }];
  },

  unsubscribeMessages(plan, coins) {
    const channel = plan.key === "funding" ? "funding-rate" : "tickers";
    return [{
      op: "unsubscribe",
      args: coins.map((coin) => ({ channel, instId: instId(coin) })),
    }];
  },

  parseMessage(raw) {
    if (raw === "pong") return [];
    let frame: OkxFrame;
    try {
      frame = JSON.parse(raw) as OkxFrame;
    } catch {
      return [];
    }
    if (frame.event || !frame.arg?.channel || !Array.isArray(frame.data)) return [];

    if (frame.arg.channel === "funding-rate") {
      return frame.data.flatMap((entry): StreamUpdate[] => {
        const row = entry as OkxFundingRow;
        const coin = coinFromInstId(row.instId ?? frame.arg?.instId);
        const ratePct = decimalRateToPct(row.fundingRate);
        if (!coin || ratePct === null) return [];
        const fundingTime = num(row.fundingTime);
        const nextFundingTime = num(row.nextFundingTime);
        // OKX reports both edges of the period, so the cadence is exact.
        const intervalHours =
          fundingTime !== null && nextFundingTime !== null && nextFundingTime > fundingTime
            ? Math.round((nextFundingTime - fundingTime) / 3_600_000)
            : null;
        return [{
          kind: "funding",
          exchange: "okx",
          coin,
          ratePct,
          nextFundingTime: fundingTime,
          intervalHours: intervalHours && intervalHours > 0 ? intervalHours : null,
          ts: num(row.ts) ?? Date.now(),
        }];
      });
    }

    if (frame.arg.channel === "tickers") {
      return frame.data.flatMap((entry): StreamUpdate[] => {
        const row = entry as OkxTickerRow;
        const coin = coinFromInstId(row.instId ?? frame.arg?.instId);
        if (!coin) return [];
        const bid = num(row.bidPx);
        const ask = num(row.askPx);
        if (bid === null && ask === null) return [];
        return [{
          kind: "book",
          exchange: "okx",
          coin,
          bid,
          ask,
          ts: num(row.ts) ?? Date.now(),
        }];
      });
    }

    return [];
  },
};
