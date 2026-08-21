import type {
  ExchangeAdapter,
  FundingSnapshotRow,
  IntervalRow,
  StreamUpdate,
  WsConnectionTarget,
  WsEndpointPlan,
} from "@/lib/exchanges/adapter";
import { fetchJson, num, rankByAbsRate } from "@/lib/exchanges/adapter";

// Verified against live payloads (2026-08-20):
//   REST /api/v2/public/meta/getMetaData
//        -> data.contractList[] { contractId, contractName, fundingRateIntervalMin }  155 rows
//   REST /api/v2/public/quote/getTicker?contractId=30000001
//        -> data[0] { fundingRate, fundingTime, nextFundingTime, ... }
//   WS   subscribe { type:"subscribe", channel:"ticker.{contractId}" }
//        -> { type:"quote-event", content:{ data:[{ contractId, fundingRate,
//             nextFundingTime, bestBidPrice, bestAskPrice }] } }
//
// Notes that shaped this adapter:
//
//  · Markets are keyed by a numeric `contractId` string ("30000001"), so the
//    id↔coin map has to be built from metadata before anything can be subscribed.
//    Live mainnet contracts are USDC-quoted in the 3000000x range; the ids in the
//    published docs (1000000x, USDT-quoted) return an empty array.
//
//  · `getTicker` refuses to serve more than one contract. Omitting `contractId`
//    returns `{"code":"SUCCESS","data":[]}` — success with nothing in it, which is
//    the worst kind of failure to build on. So the REST fallback fans out one
//    request per coin and is deliberately capped.
//
//  · Cadence is 4h for all 155 contracts, stated as `fundingRateIntervalMin:"240"`.
//    The prose docs contradict themselves (one page says hourly, another 8h); the
//    number the live API returns is what is trusted here, and it is read per
//    contract rather than hardcoded so a venue change surfaces on its own.
//
//  · `bestBidPrice`/`bestAskPrice` arrive on the WS ticker but are absent from the
//    documented model and from the REST ticker. They are used because they are the
//    cheapest correct source, and their absence is handled rather than assumed
//    away — a frame without them simply yields no book update.

const REST = "https://edgex-prod-v2.edgex.exchange";
const WS = "wss://edgex-quote-prod-v2.edgex.exchange/api/v1/public/ws";

/** REST fan-out ceiling for the funding fallback, to keep one cycle bounded. */
const MAX_FALLBACK_REQUESTS = 40;

interface Contract {
  contractId?: string;
  contractName?: string;
  fundingRateIntervalMin?: string;
  enableTrade?: boolean;
  enableDisplay?: boolean;
}

interface MetaResponse {
  data?: { contractList?: Contract[] };
}

interface TickerRow {
  contractId?: string;
  fundingRate?: string;
  nextFundingTime?: string;
  bestBidPrice?: string;
  bestAskPrice?: string;
}

interface TickerResponse {
  data?: TickerRow[];
}

interface Frame {
  type?: string;
  channel?: string;
  content?: { channel?: string; dataType?: string; data?: TickerRow[] };
}

const PLAN: WsEndpointPlan = {
  key: "ticker",
  carries: ["funding", "book"],
  maxTopicsPerConnection: 120,
};

interface Market {
  contractId: string;
  coin: string;
  intervalHours: number;
}

/** coin → market, and contractId → coin, rebuilt by every ranking pass. */
const byCoin = new Map<string, Market>();
const coinByContract = new Map<string, string>();

/**
 * "BTCUSDC" → "BTC". edgeX quotes in USDC while the rest of the app is
 * USDT-denominated; for a perpetual on a dollar stablecoin the base asset is what
 * matters for comparison, so the quote is stripped rather than the market skipped.
 */
function coinFromContractName(name: string): string | null {
  const upper = name.trim().toUpperCase();
  for (const quote of ["USDC", "USDT", "USD"]) {
    if (!upper.endsWith(quote)) continue;
    const base = upper.slice(0, -quote.length);
    return base.length > 0 ? base : null;
  }
  return null;
}

async function refreshMarkets(signal: AbortSignal): Promise<void> {
  const body = await fetchJson<MetaResponse>(
    "edgex/getMetaData",
    `${REST}/api/v2/public/meta/getMetaData`,
    signal,
  );
  const rows = body.data?.contractList ?? [];
  if (rows.length === 0) return;

  byCoin.clear();
  coinByContract.clear();
  for (const row of rows) {
    const contractId = row.contractId?.trim();
    const coin = coinFromContractName(row.contractName ?? "");
    if (!contractId || !coin) continue;
    if (row.enableDisplay === false) continue;
    const minutes = num(row.fundingRateIntervalMin);
    // An unparseable cadence is not guessed at: the venue default stands, and
    // fetchIntervals reports nothing for that coin.
    const intervalHours = minutes !== null && minutes > 0 ? minutes / 60 : 4;
    byCoin.set(coin, { contractId, coin, intervalHours });
    coinByContract.set(contractId, coin);
  }
}

async function fetchTicker(contractId: string, signal: AbortSignal): Promise<TickerRow | null> {
  const body = await fetchJson<TickerResponse>(
    "edgex/getTicker",
    `${REST}/api/v2/public/quote/getTicker?contractId=${encodeURIComponent(contractId)}`,
    signal,
  );
  return body.data?.[0] ?? null;
}

export const edgexAdapter: ExchangeAdapter = {
  id: "edgex",
  defaultIntervalHours: 4,

  /**
   * Ranking without funding rates.
   *
   * Every other venue ranks candidates by absolute funding, but edgeX would need
   * 155 sequential REST calls to produce that — one per contract, because the
   * ticker endpoint takes exactly one id. That is not worth doing every cycle, so
   * the whole listing is returned unranked instead: `rankByAbsRate` keeps them at
   * rate 0, layer 1 admits them in name order, and the funding numbers arrive on
   * the socket moments later. The trade-off is that this venue does not contribute
   * its own "hottest pairs" to the universe, only coverage of coins other venues
   * flagged.
   */
  async fetchRanking(signal) {
    await refreshMarkets(signal);
    return rankByAbsRate([...byCoin.keys()].map((coin) => ({ coin, ratePct: 0 })));
  },

  async fetchFundingSnapshot(signal, coins) {
    const targets = coins
      .map((coin) => byCoin.get(coin))
      .filter((m): m is Market => m !== undefined)
      .slice(0, MAX_FALLBACK_REQUESTS);

    const rows = await Promise.all(
      targets.map(async (market): Promise<FundingSnapshotRow | null> => {
        try {
          const row = await fetchTicker(market.contractId, signal);
          if (!row) return null;
          const ratePct = num(row.fundingRate);
          if (ratePct === null) return null;
          return {
            coin: market.coin,
            // Decimal fraction per interval, like the CEX venues.
            ratePct: ratePct * 100,
            nextFundingTime: num(row.nextFundingTime),
            intervalHours: market.intervalHours,
          };
        } catch {
          // One failed contract must not lose the rest of the batch.
          return null;
        }
      }),
    );
    return rows.filter((r): r is FundingSnapshotRow => r !== null);
  },

  async fetchIntervals() {
    // Already known from the metadata the ranking pass fetched, so this is a map
    // read rather than a second request.
    return [...byCoin.values()].map(
      (m): IntervalRow => ({ coin: m.coin, intervalHours: m.intervalHours }),
    );
  },

  endpoints() {
    return [PLAN];
  },

  async resolveConnection(): Promise<WsConnectionTarget> {
    return { url: WS };
  },

  subscribeMessages(_plan, coins) {
    return coins.flatMap((coin) => {
      const market = byCoin.get(coin);
      if (!market) return [];
      return [{ type: "subscribe", channel: `ticker.${market.contractId}` }];
    });
  },

  unsubscribeMessages(_plan, coins) {
    return coins.flatMap((coin) => {
      const market = byCoin.get(coin);
      if (!market) return [];
      return [{ type: "unsubscribe", channel: `ticker.${market.contractId}` }];
    });
  },

  parseMessage(raw) {
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      return [];
    }
    if (frame.type !== "quote-event") return [];
    const rows = frame.content?.data;
    if (!Array.isArray(rows)) return [];

    const ts = Date.now();
    const out: StreamUpdate[] = [];
    for (const row of rows) {
      const contractId = row.contractId?.trim();
      if (!contractId) continue;
      const coin = coinByContract.get(contractId);
      if (!coin) continue;
      const intervalHours = byCoin.get(coin)?.intervalHours ?? 4;

      const rate = num(row.fundingRate);
      if (rate !== null) {
        out.push({
          kind: "funding",
          exchange: "edgex",
          coin,
          ratePct: rate * 100,
          nextFundingTime: num(row.nextFundingTime),
          intervalHours,
          ts,
        });
      }

      const bid = num(row.bestBidPrice);
      const ask = num(row.bestAskPrice);
      if (bid !== null || ask !== null) {
        out.push({ kind: "book", exchange: "edgex", coin, bid, ask, ts });
      }
    }
    return out;
  },
};
