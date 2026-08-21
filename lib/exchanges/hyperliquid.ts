import type { ExchangeAdapter, StreamUpdate, WsEndpointPlan } from "@/lib/exchanges/adapter";
import { decimalRateToPct, num, rankByAbsRate } from "@/lib/exchanges/adapter";

// Verified against live payloads:
//   POST /info { type: "metaAndAssetCtxs" } -> [ { universe: [{name}] },
//                                               [ { funding, midPx, impactPxs } ] ]
//   WS   activeAssetCtx -> { coin, ctx: { funding, impactPxs: [bid, ask] } }
//   WS   l2Book         -> { coin, levels: [bids[], asks[]] } (top of book is [0])
//
// Hyperliquid funds hourly and does not publish a settlement clock on the
// stream, so nextFundingTime is derived from the top of the next hour.

interface HlUniverseEntry {
  name?: string;
}

interface HlAssetCtx {
  funding?: string;
  midPx?: string;
  impactPxs?: string[];
}

interface HlFrame {
  channel?: string;
  data?: {
    coin?: string;
    ctx?: HlAssetCtx;
    time?: number;
    levels?: { px?: string; sz?: string }[][];
  };
}

const CTX_PLAN: WsEndpointPlan = {
  key: "activeAssetCtx",
  carries: ["funding"],
  maxTopicsPerConnection: 120,
};

const BOOK_PLAN: WsEndpointPlan = {
  key: "l2Book",
  carries: ["book"],
  maxTopicsPerConnection: 120,
};

/** Hyperliquid settles every hour on the hour. */
function nextHourBoundary(now = Date.now()): number {
  const hourMs = 3_600_000;
  return Math.floor(now / hourMs) * hourMs + hourMs;
}

export const hyperliquidAdapter: ExchangeAdapter = {
  id: "hyperliquid",
  defaultIntervalHours: 1,

  async fetchRanking(signal) {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      signal,
    });
    if (!res.ok) throw new Error(`hyperliquid/info: HTTP ${res.status}`);
    const body = (await res.json()) as [{ universe?: HlUniverseEntry[] }, HlAssetCtx[]];
    const universe = body?.[0]?.universe ?? [];
    const ctxs = body?.[1] ?? [];
    const pairs = universe.flatMap((entry, i) => {
      const coin = entry.name;
      if (!coin) return [];
      return [{ coin, ratePct: decimalRateToPct(ctxs[i]?.funding) }];
    });
    return rankByAbsRate(pairs);
  },

  endpoints() {
    return [CTX_PLAN, BOOK_PLAN];
  },

  async resolveConnection() {
    return {
      url: "wss://api.hyperliquid.xyz/ws",
      heartbeat: { intervalMs: 30_000, message: { method: "ping" } },
    };
  },

  subscribeMessages(plan, coins) {
    return coins.map((coin) => ({
      method: "subscribe",
      subscription: { type: plan.key, coin },
    }));
  },

  unsubscribeMessages(plan, coins) {
    return coins.map((coin) => ({
      method: "unsubscribe",
      subscription: { type: plan.key, coin },
    }));
  },

  parseMessage(raw) {
    let frame: HlFrame;
    try {
      frame = JSON.parse(raw) as HlFrame;
    } catch {
      return [];
    }
    const coin = frame.data?.coin;
    if (!coin) return [];

    if (frame.channel === "activeAssetCtx") {
      const ctx = frame.data?.ctx;
      const ratePct = decimalRateToPct(ctx?.funding);
      if (ratePct === null) return [];
      const out: StreamUpdate[] = [{
        kind: "funding",
        exchange: "hyperliquid",
        coin,
        ratePct,
        nextFundingTime: nextHourBoundary(),
        intervalHours: 1,
        ts: Date.now(),
      }];
      // impactPxs is [bid-side, ask-side]; useful as a fallback quote before
      // the l2Book subscription delivers its first snapshot.
      const impactBid = num(ctx?.impactPxs?.[0]);
      const impactAsk = num(ctx?.impactPxs?.[1]);
      if (impactBid !== null || impactAsk !== null) {
        out.push({
          kind: "book",
          exchange: "hyperliquid",
          coin,
          bid: impactBid,
          ask: impactAsk,
          ts: Date.now(),
        });
      }
      return out;
    }

    if (frame.channel === "l2Book") {
      const levels = frame.data?.levels;
      const bid = num(levels?.[0]?.[0]?.px);
      const ask = num(levels?.[1]?.[0]?.px);
      if (bid === null && ask === null) return [];
      return [{
        kind: "book",
        exchange: "hyperliquid",
        coin,
        bid,
        ask,
        ts: num(frame.data?.time) ?? Date.now(),
      }];
    }

    return [];
  },
};
