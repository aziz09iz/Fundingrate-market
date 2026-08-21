import type {
  AccountType,
  ExchangeId,
  ExecutionMode,
  MarketSnapshot,
  Order,
  OrderSide,
  OrderStatus,
  OrderType,
  MarketType,
} from "@/lib/types";

// Order plumbing for the manual trade page. Prices and spreads come from the
// live market snapshot; submission goes through the paper or live order API,
// which is the only place an exchange is contacted.

let orderSeq = 1000;

export function nextOrderId(): string {
  return `ORD-${++orderSeq}`;
}

/** Coins currently streamed, i.e. the union of layer 1 and layer 2. */
export function tradablePairs(snapshot: MarketSnapshot | null): string[] {
  return snapshot?.coins ?? [];
}

/** Best ask on a venue — the price a long entry fills at. */
export function venueAsk(
  snapshot: MarketSnapshot | null,
  coin: string,
  exchange: ExchangeId,
): number | null {
  return findRow(snapshot, coin)?.tickers[exchange]?.ask ?? null;
}

/** Best bid on a venue — the price a short entry fills at. */
export function venueBid(
  snapshot: MarketSnapshot | null,
  coin: string,
  exchange: ExchangeId,
): number | null {
  return findRow(snapshot, coin)?.tickers[exchange]?.bid ?? null;
}

/** Mid of the venue's own book, used only to seed a limit price field. */
export function venueReferencePrice(
  snapshot: MarketSnapshot | null,
  coin: string,
  exchange: ExchangeId,
): number | null {
  const ticker = findRow(snapshot, coin)?.tickers[exchange];
  if (!ticker) return null;
  if (ticker.bid !== null && ticker.ask !== null) return (ticker.bid + ticker.ask) / 2;
  return ticker.ask ?? ticker.bid ?? null;
}

/** First venue quoting this coin, so a form can pick a sensible default. */
export function anyQuotedPrice(
  snapshot: MarketSnapshot | null,
  coin: string,
): number | null {
  const row = findRow(snapshot, coin);
  if (!row) return null;
  for (const ticker of Object.values(row.tickers)) {
    if (!ticker) continue;
    if (ticker.ask !== null) return ticker.ask;
    if (ticker.bid !== null) return ticker.bid;
  }
  return null;
}

export function findRow(snapshot: MarketSnapshot | null, coin: string) {
  return snapshot?.rows.find((r) => r.coin === coin) ?? null;
}

/**
 * Entry spread for a hedge using executable prices: the long leg lifts the ask
 * on its venue, the short leg hits the bid on the other. Returns null when
 * either quote is missing rather than guessing.
 */
export function hedgeEntrySpreadPct(
  snapshot: MarketSnapshot | null,
  coin: string,
  longExchange: ExchangeId,
  shortExchange: ExchangeId,
): number | null {
  const longAsk = venueAsk(snapshot, coin, longExchange);
  const shortBid = venueBid(snapshot, coin, shortExchange);
  if (longAsk === null || shortBid === null || longAsk <= 0) return null;
  return Number((((shortBid - longAsk) / longAsk) * 100).toFixed(4));
}

/** A delayed order releases once the two venues are within this many percent. */
export const SPREAD_RELEASE_THRESHOLD_PCT = 0.02;

/**
 * What the form hands to the page for submission. Ids, fills and status come
 * back from the server, so an intent deliberately has none of them.
 */
export interface OrderIntent {
  pair: string;
  exchange: ExchangeId;
  side: OrderSide;
  orderType: OrderType;
  /** Limit price, or the expected fill price for a market order. */
  price: number;
  size: number;
  leverage: number;
  reduceOnly?: boolean;
  hedgeId?: string;
  executionMode: ExecutionMode;
  waitLongExchange?: ExchangeId;
  waitShortExchange?: ExchangeId;
}

/**
 * A delayed intent parked client-side until the two venues converge. It has an
 * id so the table can show and cancel it, but nothing has been sent yet.
 */
export interface QueuedIntent extends OrderIntent {
  id: string;
  time: number;
  /** Account the intent was queued for, so release submits to the right one. */
  accountType: AccountType;
}

/** Strips the queue bookkeeping so only the submittable intent remains. */
export function intentOf(queued: QueuedIntent): OrderIntent {
  return {
    pair: queued.pair,
    exchange: queued.exchange,
    side: queued.side,
    orderType: queued.orderType,
    price: queued.price,
    size: queued.size,
    leverage: queued.leverage,
    reduceOnly: queued.reduceOnly,
    hedgeId: queued.hedgeId,
    executionMode: queued.executionMode,
    waitLongExchange: queued.waitLongExchange,
    waitShortExchange: queued.waitShortExchange,
  };
}

/** Renders a queued intent as an Order row so one table can show both. */
export function queuedToOrder(queued: QueuedIntent): Order {
  return {
    id: queued.id,
    time: queued.time,
    pair: queued.pair,
    exchange: queued.exchange,
    side: queued.side,
    marketType: "perp",
    orderType: queued.orderType,
    price: queued.price,
    size: queued.size,
    filled: 0,
    status: "pending",
    leverage: queued.leverage,
    reduceOnly: queued.reduceOnly,
    hedgeId: queued.hedgeId,
    executionMode: queued.executionMode,
    waitLongExchange: queued.waitLongExchange,
    waitShortExchange: queued.waitShortExchange,
  };
}

/** True once a queued hedge's two venues are close enough to submit. */
export function intentReleasable(
  snapshot: MarketSnapshot | null,
  queued: QueuedIntent,
): boolean {
  if (!queued.waitLongExchange || !queued.waitShortExchange) return true;
  const spread = hedgeEntrySpreadPct(
    snapshot,
    queued.pair,
    queued.waitLongExchange,
    queued.waitShortExchange,
  );
  return spread !== null && Math.abs(spread) <= SPREAD_RELEASE_THRESHOLD_PCT;
}

export function buildOrder(input: {
  pair: string;
  exchange: ExchangeId;
  side: OrderSide;
  marketType: MarketType;
  orderType: OrderType;
  price: number;
  size: number;
  leverage: number;
  reduceOnly?: boolean;
  hedgeId?: string;
  executionMode?: ExecutionMode;
  waitLongExchange?: ExchangeId;
  waitShortExchange?: ExchangeId;
}): Order {
  // A delayed order parks as `pending` until the two venues' prices converge;
  // only then does it behave like a freshly submitted order.
  const delayed = input.executionMode === "delay";
  const status: OrderStatus = delayed
    ? "pending"
    : input.orderType === "market"
      ? "filled"
      : "open";
  return {
    id: nextOrderId(),
    time: Date.now(),
    pair: input.pair,
    exchange: input.exchange,
    side: input.side,
    marketType: input.marketType,
    orderType: input.orderType,
    price: input.price,
    size: input.size,
    filled: !delayed && input.orderType === "market" ? input.size : 0,
    status,
    leverage: input.leverage,
    reduceOnly: input.reduceOnly,
    hedgeId: input.hedgeId,
    realizedPnl: status === "filled" ? null : undefined,
    executionMode: input.executionMode,
    waitLongExchange: input.waitLongExchange,
    waitShortExchange: input.waitShortExchange,
  };
}
