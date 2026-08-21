import type {
  ExchangeAdapter,
  IntervalRow,
  StreamUpdate,
  WsEndpointPlan,
} from "@/lib/exchanges/adapter";
import { decimalRateToPct, fetchJson, num, rankByAbsRate } from "@/lib/exchanges/adapter";

// Verified against live payloads:
//   REST /api/v1/contracts/active   -> { symbol, fundingFeeRate,
//                                        currentFundingRateGranularity (ms) }
//   POST /api/v1/bullet-public      -> { data: { token, instanceServers[] } }
//   WS   /contract/instrument:SYM   -> subject "funding.rate" { fundingRate, timestamp }
//   WS   /contractMarket/tickerV2   -> { bestBidPrice, bestAskPrice, ts (ns) }
//
// The stream sends the funding rate but neither the next settlement time nor
// the cadence, so the cadence is read from contract metadata instead — most
// KuCoin contracts are 4h, not the 8h default.

interface KucoinResponse<T> {
  code?: string;
  data?: T;
}

interface KucoinContract {
  symbol?: string;
  baseCurrency?: string;
  quoteCurrency?: string;
  status?: string;
  fundingFeeRate?: number;
  /** Funding period in milliseconds. */
  fundingRateGranularity?: number;
  currentFundingRateGranularity?: number;
  /** Epoch ms of the next settlement. */
  nextFundingRateDateTime?: number;
  /** Milliseconds until the next settlement, as a fallback. */
  nextFundingRateTime?: number;
}

interface BulletServer {
  endpoint?: string;
  pingInterval?: number;
  protocol?: string;
}

interface BulletData {
  token?: string;
  instanceServers?: BulletServer[];
}

interface KucoinFrame {
  type?: string;
  topic?: string;
  subject?: string;
  data?: {
    fundingRate?: number;
    timestamp?: number;
    symbol?: string;
    bestBidPrice?: string;
    bestAskPrice?: string;
    ts?: number;
  };
}

const INSTRUMENT_PLAN: WsEndpointPlan = {
  key: "instrument",
  carries: ["funding"],
  // KuCoin caps a connection at 100 topics; keep headroom for retries.
  maxTopicsPerConnection: 45,
};

const TICKER_PLAN: WsEndpointPlan = {
  key: "tickerV2",
  carries: ["book"],
  maxTopicsPerConnection: 45,
};

/** KuCoin futures symbols look like XBTUSDTM; XBT is their name for BTC. */
function venueSymbol(coin: string): string {
  const base = coin === "BTC" ? "XBT" : coin;
  return `${base}USDTM`;
}

function coinFromVenueSymbol(symbol: string | undefined): string | null {
  if (!symbol || !symbol.endsWith("USDTM")) return null;
  const base = symbol.slice(0, -"USDTM".length);
  if (!base) return null;
  return base === "XBT" ? "BTC" : base;
}

function coinFromTopic(topic: string | undefined): string | null {
  if (!topic) return null;
  const idx = topic.indexOf(":");
  if (idx === -1) return null;
  return coinFromVenueSymbol(topic.slice(idx + 1));
}

/**
 * Next settlement for a contract.
 *
 * KuCoin publishes two fields: `nextFundingRateDateTime` is an absolute epoch
 * and `nextFundingRateTime` is a countdown in milliseconds. The absolute value
 * is preferred; the countdown is a fallback for contracts that omit it. Values
 * already in the past are discarded rather than shown as a due countdown.
 */
function nextSettlement(contract: KucoinContract, now: number): number | null {
  const absolute = num(contract.nextFundingRateDateTime);
  if (absolute !== null && absolute > now) return absolute;
  const remaining = num(contract.nextFundingRateTime);
  if (remaining !== null && remaining > 0) return now + remaining;
  return null;
}

export const kucoinAdapter: ExchangeAdapter = {
  id: "kucoin",
  defaultIntervalHours: 8,

  async fetchRanking(signal) {
    const body = await fetchJson<KucoinResponse<KucoinContract[]>>(
      "kucoin/contracts",
      "https://api-futures.kucoin.com/api/v1/contracts/active",
      signal,
    );
    const rows = body.data ?? [];
    const pairs = rows.flatMap((c) => {
      if (c.status !== "Open" || c.quoteCurrency !== "USDT") return [];
      const coin = coinFromVenueSymbol(c.symbol);
      if (!coin) return [];
      return [{ coin, ratePct: decimalRateToPct(c.fundingFeeRate) }];
    });
    return rankByAbsRate(pairs);
  },

  async fetchIntervals(signal) {
    const body = await fetchJson<KucoinResponse<KucoinContract[]>>(
      "kucoin/contracts",
      "https://api-futures.kucoin.com/api/v1/contracts/active",
      signal,
    );
    const rows = body.data ?? [];
    const now = Date.now();
    return rows.flatMap((c): IntervalRow[] => {
      if (c.quoteCurrency !== "USDT") return [];
      const coin = coinFromVenueSymbol(c.symbol);
      // Granularity is the funding period in milliseconds.
      const ms = num(c.currentFundingRateGranularity) ?? num(c.fundingRateGranularity);
      if (!coin || ms === null || ms <= 0) return [];
      return [{ coin, intervalHours: ms / 3_600_000, nextFundingTime: nextSettlement(c, now) }];
    });
  },

  endpoints() {
    return [INSTRUMENT_PLAN, TICKER_PLAN];
  },

  async resolveConnection(_plan, signal) {
    const body = await fetchJson<KucoinResponse<BulletData>>(
      "kucoin/bullet-public",
      "https://api-futures.kucoin.com/api/v1/bullet-public",
      signal,
      { method: "POST" },
    );
    const server = body.data?.instanceServers?.[0];
    const token = body.data?.token;
    if (!server?.endpoint || !token) {
      throw new Error("kucoin/bullet-public: missing endpoint or token");
    }
    const connectId = `frw-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const pingInterval = server.pingInterval ?? 18_000;
    return {
      url: `${server.endpoint}?token=${token}&connectId=${connectId}`,
      heartbeat: {
        intervalMs: Math.max(5_000, pingInterval - 3_000),
        message: { id: connectId, type: "ping" },
      },
    };
  },

  subscribeMessages(plan, coins) {
    const prefix = plan.key === "instrument" ? "/contract/instrument" : "/contractMarket/tickerV2";
    // KuCoin accepts comma-separated symbols, but batching keeps frames small.
    return chunk(coins, 20).map((group, i) => ({
      id: `sub-${plan.key}-${Date.now()}-${i}`,
      type: "subscribe",
      topic: `${prefix}:${group.map(venueSymbol).join(",")}`,
      response: true,
    }));
  },

  unsubscribeMessages(plan, coins) {
    const prefix = plan.key === "instrument" ? "/contract/instrument" : "/contractMarket/tickerV2";
    return chunk(coins, 20).map((group, i) => ({
      id: `unsub-${plan.key}-${Date.now()}-${i}`,
      type: "unsubscribe",
      topic: `${prefix}:${group.map(venueSymbol).join(",")}`,
      response: true,
    }));
  },

  parseMessage(raw) {
    let frame: KucoinFrame;
    try {
      frame = JSON.parse(raw) as KucoinFrame;
    } catch {
      return [];
    }
    if (frame.type !== "message" || !frame.data) return [];

    if (frame.subject === "funding.rate") {
      const coin = coinFromTopic(frame.topic);
      const ratePct = decimalRateToPct(frame.data.fundingRate);
      if (!coin || ratePct === null) return [];
      return [{
        kind: "funding",
        exchange: "kucoin",
        coin,
        ratePct,
        // The stream omits the settlement clock for this venue.
        nextFundingTime: null,
        intervalHours: null,
        ts: num(frame.data.timestamp) ?? Date.now(),
      }];
    }

    if (frame.subject === "tickerV2") {
      const coin = coinFromVenueSymbol(frame.data.symbol) ?? coinFromTopic(frame.topic);
      if (!coin) return [];
      const bid = num(frame.data.bestBidPrice);
      const ask = num(frame.data.bestAskPrice);
      if (bid === null && ask === null) return [];
      // KuCoin sends nanoseconds here.
      const rawTs = num(frame.data.ts);
      const ts = rawTs && rawTs > 1e15 ? Math.round(rawTs / 1e6) : (rawTs ?? Date.now());
      return [{ kind: "book", exchange: "kucoin", coin, bid, ask, ts }];
    }

    return [];
  },
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type { StreamUpdate };
