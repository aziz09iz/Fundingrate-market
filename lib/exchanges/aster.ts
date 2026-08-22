import type {
  ExchangeAdapter,
  FundingSnapshotRow,
  IntervalRow,
  StreamUpdate,
  WsConnectionTarget,
  WsEndpointPlan,
} from "@/lib/exchanges/adapter";
import {
  baseFromConcatSymbol,
  decimalRateToPct,
  fetchJson,
  num,
} from "@/lib/exchanges/adapter";

// Verified against live payloads (2026-08-20):
//   REST /fapi/v1/premiumIndex        -> [{ symbol, lastFundingRate, nextFundingTime }]  702 rows
//   REST /fapi/v1/fundingInfo         -> [{ symbol, fundingIntervalHours }]              702 rows
//   REST /fapi/v1/ticker/bookTicker   -> [{ symbol, bidPrice, askPrice, time }]          538 rows
//   WS   <sym>@markPrice@1s -> { e:"markPriceUpdate", s, r, T, E }
//   WS   <sym>@bookTicker   -> { e:"bookTicker", s, b, a, E, T }
//
// Aster implements the widely cloned USDⓈ-M futures API, so the shapes and field
// names below follow that convention. Two differences matter:
//
//   · Cadence is genuinely per-symbol. Of 702 symbols, 366 fund hourly, 260 every
//     8h, 73 every 4h and 3 every 2h. Diff FR divides by the interval, so
//     assuming one value would misscale the majority of this venue's rates —
//     `fetchIntervals` is load-bearing here, not a refinement.
//   · `premiumIndex` is a superset of `exchangeInfo`: 149 symbols (coin-margined
//     `*USD` and `SHIELD*` prefixed) appear in funding but never in the order
//     book. `baseFromConcatSymbol` rejects non-USDT quotes, which filters the
//     `*USD` set; the SHIELD names survive as their own coins and simply never
//     match another venue.
//
// Aster's mark-price stream is reachable, so funding arrives on the socket and the
// REST snapshot is only a fallback.

const REST = "https://fapi.asterdex.com";
const WS = "wss://fstream.asterdex.com/ws";

interface PremiumIndexRow {
  symbol?: string;
  lastFundingRate?: string;
  nextFundingTime?: number;
}

interface FundingInfoRow {
  symbol?: string;
  fundingIntervalHours?: number;
}

interface Frame {
  e?: string;
  s?: string;
  /** markPriceUpdate: funding rate as a decimal fraction. */
  r?: string;
  /** markPriceUpdate: next settlement, epoch ms. */
  T?: number;
  E?: number;
  /** bookTicker: best bid and ask. */
  b?: string;
  a?: string;
}

/**
 * Two firehose sockets, one per data kind.
 *
 * Aster publishes both all-market channels and both were confirmed live: `!markPrice@arr@1s`
 * delivered every one of 699 symbols in a single array frame each second, and
 * `!bookTicker` delivered 362 symbols individually. That replaces what used to be
 * eight sharded sockets of 90 coins each with exactly two, so the whole venue costs
 * two connections however many pairs it lists.
 *
 * They are separate plans rather than one because the book half is the expensive
 * half: keeping it on its own socket means it can be dropped without disturbing
 * funding.
 */
const FUNDING_PLAN: WsEndpointPlan = {
  key: "markPriceAll",
  carries: ["funding"],
  mode: "firehose",
  maxTopicsPerConnection: 1,
};

const BOOK_PLAN: WsEndpointPlan = {
  key: "bookTickerAll",
  carries: ["book"],
  mode: "firehose",
  maxTopicsPerConnection: 1,
};

function firehoseStream(plan: WsEndpointPlan): string {
  return plan.key === "markPriceAll" ? "!markPrice@arr@1s" : "!bookTicker";
}

export const asterAdapter: ExchangeAdapter = {
  id: "aster",
  defaultIntervalHours: 8,

  async fetchInstruments(signal) {
    const rows = await fetchJson<PremiumIndexRow[]>(
      "aster/premiumIndex",
      `${REST}/fapi/v1/premiumIndex`,
      signal,
    );
    const coins = new Set<string>();
    for (const r of rows) {
      const coin = baseFromConcatSymbol(r.symbol ?? "");
      if (coin) coins.add(coin);
    }
    return [...coins];
  },

  async fetchFundingSnapshot(signal, coins) {
    const wanted = new Set(coins);
    const rows = await fetchJson<PremiumIndexRow[]>(
      "aster/premiumIndex",
      `${REST}/fapi/v1/premiumIndex`,
      signal,
    );
    return rows.flatMap((r): FundingSnapshotRow[] => {
      const coin = baseFromConcatSymbol(r.symbol ?? "");
      if (!coin || !wanted.has(coin)) return [];
      const ratePct = decimalRateToPct(r.lastFundingRate);
      if (ratePct === null) return [];
      return [{
        coin,
        ratePct,
        nextFundingTime: num(r.nextFundingTime),
        // The cadence comes from fetchIntervals; leaving it null here keeps one
        // source of truth for it rather than two that can disagree.
        intervalHours: null,
      }];
    });
  },

  async fetchIntervals(signal) {
    const rows = await fetchJson<FundingInfoRow[]>(
      "aster/fundingInfo",
      `${REST}/fapi/v1/fundingInfo`,
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
    return [FUNDING_PLAN, BOOK_PLAN];
  },

  async resolveConnection(): Promise<WsConnectionTarget> {
    return { url: WS };
  },

  subscribeMessages(plan) {
    return [{ method: "SUBSCRIBE", params: [firehoseStream(plan)], id: Date.now() }];
  },

  unsubscribeMessages(plan) {
    return [{ method: "UNSUBSCRIBE", params: [firehoseStream(plan)], id: Date.now() }];
  },

  parseMessage(raw) {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return [];
    }
    // `!markPrice@arr` delivers one array frame holding every symbol, where the
    // per-symbol stream delivered one object. Both shapes are handled so a change
    // of channel does not silently stop producing updates.
    const frames: Frame[] = Array.isArray(payload) ? (payload as Frame[]) : [payload as Frame];
    const out: StreamUpdate[] = [];
    for (const frame of frames) {
      // Subscribe acks look like { id, result: null } and carry no symbol.
      if (!frame?.s) continue;
      const coin = baseFromConcatSymbol(frame.s);
      if (!coin) continue;

      if (frame.e === "markPriceUpdate") {
        const ratePct = decimalRateToPct(frame.r);
        if (ratePct === null) continue;
        out.push({
          kind: "funding",
          exchange: "aster",
          coin,
          ratePct,
          nextFundingTime: num(frame.T),
          // Per-symbol cadence arrives through fetchIntervals.
          intervalHours: null,
          ts: num(frame.E) ?? Date.now(),
        });
        continue;
      }

      if (frame.e === "bookTicker") {
        const bid = num(frame.b);
        const ask = num(frame.a);
        if (bid === null && ask === null) continue;
        out.push({
          kind: "book",
          exchange: "aster",
          coin,
          bid,
          ask,
          ts: num(frame.E) ?? Date.now(),
        });
      }
    }
    return out;
  },
};
