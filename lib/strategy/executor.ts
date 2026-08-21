import { randomUUID } from "node:crypto";
import type {
  AccountType,
  ExchangeId,
  Order,
  StrategyPosition,
} from "@/lib/types";
import { applyPaperFill, insertPaperOrder, paperPositions } from "@/lib/db/paper";
import { livePositions } from "@/lib/db/live";
import { markPriceMap } from "@/lib/market/marks";
import { closeLivePosition, placeLiveOrder } from "@/lib/private/orders";
import { getCredentials } from "@/lib/db/credentials";
import { privateAdapter } from "@/lib/private";
import { exchangeName } from "@/lib/utils";

/**
 * Order execution for FundingSync.
 *
 * Both legs go through the same code paths a manual trade uses: paper fills
 * against live quotes via lib/db/paper, live orders via placeLiveOrder. Nothing
 * here talks to a venue directly.
 *
 * The rule that matters: legs are sent sequentially, never in parallel. If the
 * first leg is rejected the second must not be sent, because a single filled leg
 * is an unhedged directional position — the opposite of what this strategy is.
 */

export class ExecutionFailed extends Error {}

export interface LegQuote {
  /** Ask on the long venue — what opening the long leg pays. */
  longPrice: number;
  /** Bid on the short venue — what opening the short leg receives. */
  shortPrice: number;
  /** Bid on the long venue — what closing the long leg receives. */
  longExitPrice: number;
  /** Ask on the short venue — what closing the short leg pays. */
  shortExitPrice: number;
}

/**
 * Executable prices for both legs, on both sides of each book.
 *
 * Entry and exit are separate numbers on purpose. Closing a long means selling
 * into the *long venue's* bid, not the short venue's — an earlier version crossed
 * the venues here, which valued every close at the other exchange's price and
 * turned the reported PnL into nonsense.
 */
export function legQuotes(
  coin: string,
  longExchange: ExchangeId,
  shortExchange: ExchangeId,
  rows: { coin: string; tickers: Record<ExchangeId, { bid: number | null; ask: number | null } | null> }[],
): LegQuote | null {
  const row = rows.find((r) => r.coin === coin);
  if (!row) return null;
  const longAsk = row.tickers[longExchange]?.ask ?? null;
  const longBid = row.tickers[longExchange]?.bid ?? null;
  const shortBid = row.tickers[shortExchange]?.bid ?? null;
  const shortAsk = row.tickers[shortExchange]?.ask ?? null;
  const prices = [longAsk, longBid, shortBid, shortAsk];
  if (prices.some((p) => p === null || p <= 0)) return null;
  return {
    longPrice: longAsk!,
    shortPrice: shortBid!,
    longExitPrice: longBid!,
    shortExitPrice: shortAsk!,
  };
}

/** Spread paid to open, in percent. Positive means the entry starts in credit. */
export function entrySpreadPct(quote: LegQuote): number {
  return Number((((quote.shortPrice - quote.longPrice) / quote.longPrice) * 100).toFixed(4));
}

/**
 * Spread paid to close, in percent, quoted on the sides actually traded.
 *
 * Always worse than the entry spread at the same instant by both venues' bid-ask
 * widths, which is exactly the cost the old measurement hid.
 */
export function exitSpreadPct(quote: LegQuote): number {
  return Number(
    (((quote.shortExitPrice - quote.longExitPrice) / quote.longExitPrice) * 100).toFixed(4),
  );
}

/** Base-asset size for a notional at a given price. */
export function sizeForNotional(notional: number, price: number): number {
  if (price <= 0) return 0;
  // Eight decimals covers every venue's step size closely enough for a size the
  // venue will round to its own precision anyway.
  return Number((notional / price).toFixed(8));
}

/** Refuses a live venue that cannot trade, before either leg is attempted. */
function assertLiveTradable(exchange: ExchangeId): void {
  const adapter = privateAdapter(exchange);
  if (!adapter?.supportsTrading || typeof adapter.placeOrder !== "function") {
    throw new ExecutionFailed(`${exchangeName(exchange)} order placement is not implemented`);
  }
  const creds = getCredentials(exchange);
  if (!creds) throw new ExecutionFailed(`No credentials configured for ${exchangeName(exchange)}`);
  if (creds.readOnly) {
    throw new ExecutionFailed(`${exchangeName(exchange)} credentials are read-only`);
  }
}

export interface OpenHedgeInput {
  accountType: AccountType;
  coin: string;
  longExchange: ExchangeId;
  shortExchange: ExchangeId;
  notionalPerLeg: number;
  leverage: number;
  hedgeId: string;
  quote: LegQuote;
}

export interface OpenHedgeResult {
  size: number;
  longFill: number;
  shortFill: number;
}

/**
 * Opens both legs. Throws `ExecutionFailed` if the first leg fails, before the
 * second is attempted. If the *second* leg fails the first is unwound
 * immediately, because leaving it open is a naked position.
 */
export async function openHedge(input: OpenHedgeInput): Promise<OpenHedgeResult> {
  const size = sizeForNotional(input.notionalPerLeg, input.quote.longPrice);
  if (size <= 0) throw new ExecutionFailed("computed size is zero");

  if (input.accountType === "live") {
    assertLiveTradable(input.longExchange);
    assertLiveTradable(input.shortExchange);

    // Long leg first.
    await placeLiveOrder({
      exchange: input.longExchange,
      coin: input.coin,
      side: "buy",
      orderType: "market",
      size,
      leverage: input.leverage,
      hedgeId: input.hedgeId,
      source: "auto",
    });

    // Short leg. A failure here leaves the long leg exposed, so unwind it.
    try {
      await placeLiveOrder({
        exchange: input.shortExchange,
        coin: input.coin,
        side: "sell",
        orderType: "market",
        size,
        leverage: input.leverage,
        hedgeId: input.hedgeId,
        source: "auto",
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      try {
        await closeLivePosition({
          exchange: input.longExchange,
          coin: input.coin,
          side: "long",
          size,
          source: "auto",
        });
        throw new ExecutionFailed(
          `Short leg failed (${detail}); the long leg was closed again to avoid a naked position.`,
        );
      } catch (unwindErr) {
        const unwindDetail = unwindErr instanceof Error ? unwindErr.message : String(unwindErr);
        // The worst case, and it must be stated plainly rather than logged as a
        // generic failure: one leg is open with no hedge against it.
        throw new ExecutionFailed(
          `Short leg failed (${detail}) AND unwinding the long leg failed (${unwindDetail}). ` +
            `A naked ${input.coin} long is open on ${exchangeName(input.longExchange)} — close it manually.`,
        );
      }
    }

    return { size, longFill: input.quote.longPrice, shortFill: input.quote.shortPrice };
  }

  // Paper: fills against the same executable prices the live path would pay.
  recordPaperLeg({
    coin: input.coin,
    exchange: input.longExchange,
    side: "buy",
    price: input.quote.longPrice,
    size,
    leverage: input.leverage,
    hedgeId: input.hedgeId,
  });
  recordPaperLeg({
    coin: input.coin,
    exchange: input.shortExchange,
    side: "sell",
    price: input.quote.shortPrice,
    size,
    leverage: input.leverage,
    hedgeId: input.hedgeId,
  });

  return { size, longFill: input.quote.longPrice, shortFill: input.quote.shortPrice };
}

interface PaperLegInput {
  coin: string;
  exchange: ExchangeId;
  side: "buy" | "sell";
  price: number;
  size: number;
  leverage: number;
  hedgeId: string;
}

/** Writes a paper order plus its fill, matching what the trade page produces. */
function recordPaperLeg(input: PaperLegInput): { realizedPnl: number | null } {
  const order: Order = {
    id: `PAP-${randomUUID().slice(0, 8)}`,
    time: Date.now(),
    pair: input.coin,
    exchange: input.exchange,
    side: input.side,
    marketType: "perp",
    orderType: "market",
    price: input.price,
    size: input.size,
    filled: input.size,
    status: "filled",
    leverage: input.leverage,
    hedgeId: input.hedgeId,
    source: "auto",
  };
  insertPaperOrder(order);
  return applyPaperFill({
    orderId: order.id,
    exchange: input.exchange,
    coin: input.coin,
    side: input.side,
    price: input.price,
    size: input.size,
    leverage: input.leverage,
    hedgeId: input.hedgeId,
    source: "auto",
  });
}

export interface CloseHedgeResult {
  realizedPnl: number | null;
  /** Legs that could not be closed, so the caller can report them precisely. */
  failures: string[];
  /** Legs that did close. Zero with failures present means nothing was touched. */
  closed: number;
}

/**
 * Closes both legs of a hedge. Unlike opening, closing continues after a
 * failure: a partially closed hedge is less exposed than an untouched one, and
 * the remaining leg is reported so it can be dealt with.
 */
export async function closeHedge(
  position: StrategyPosition,
  quote: LegQuote | null,
): Promise<CloseHedgeResult> {
  const failures: string[] = [];
  let closed = 0;

  if (position.accountType === "live") {
    const open = livePositions();
    for (const leg of [
      { exchange: position.longExchange, side: "long" as const },
      { exchange: position.shortExchange, side: "short" as const },
    ]) {
      const held = open.find(
        (p) => p.exchange === leg.exchange && p.coin === position.coin && p.side === leg.side,
      );
      if (!held) continue;
      try {
        await closeLivePosition({
          exchange: leg.exchange,
          coin: position.coin,
          side: leg.side,
          size: Math.min(position.size, held.size),
          source: "auto",
        });
        closed += 1;
      } catch (err) {
        failures.push(
          `${exchangeName(leg.exchange)} ${leg.side}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { realizedPnl: null, failures, closed };
  }

  // Paper: close whatever is actually open, valued at executable prices.
  const marks = markPriceMap();
  const open = paperPositions(marks);
  let realized = 0;
  let sawFill = false;

  for (const leg of [
    { exchange: position.longExchange, side: "long" as const, closeSide: "sell" as const },
    { exchange: position.shortExchange, side: "short" as const, closeSide: "buy" as const },
  ]) {
    const held = open.find(
      (p) => p.exchange === leg.exchange && p.coin === position.coin && p.side === leg.side,
    );
    if (!held) continue;
    // Each leg closes against its OWN venue's opposite side: a long is sold into
    // the long venue's bid, a short is bought back at the short venue's ask.
    // `held.markPrice` is only a fallback for a leg the strategy no longer has a
    // quote for, and it falls back to the entry price when stale — using it then
    // would book a fabricated PnL, so a stale mark is refused instead.
    const quoted = leg.side === "long" ? quote?.longExitPrice : quote?.shortExitPrice;
    const price = quoted ?? (held.markStale ? null : held.markPrice);
    if (!price || price <= 0) {
      failures.push(
        `${exchangeName(leg.exchange)} ${leg.side}: no live quote to close against — ` +
          `${position.coin} is not being streamed, so closing would book an invented price`,
      );
      continue;
    }
    const result = recordPaperLeg({
      coin: position.coin,
      exchange: leg.exchange,
      side: leg.closeSide,
      price,
      size: held.size,
      leverage: position.leverage,
      hedgeId: position.id,
    });
    if (result.realizedPnl !== null) {
      realized += result.realizedPnl;
      sawFill = true;
    }
    closed += 1;
  }

  return { realizedPnl: sawFill ? Number(realized.toFixed(6)) : null, failures, closed };
}
