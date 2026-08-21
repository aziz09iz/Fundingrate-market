import { randomUUID } from "node:crypto";
import { requireAuth } from "@/lib/auth/guard";
import type { Order } from "@/lib/types";
import { applyPaperFill, insertPaperOrder, paperAccountOverview, paperPositions } from "@/lib/db/paper";
import { executableFillPrice, markPriceMap } from "@/lib/market/marks";
import { recordAudit } from "@/lib/db/audit";
import {
  asObject,
  handleRouteError,
  jsonError,
  jsonOk,
  optionalPositive,
  requireCoin,
  requireExchange,
  requirePositionSide,
} from "@/lib/api/validate";

/**
 * Closes a simulated position with a market fill against the live quote.
 *
 * The paper account had no close path at all: a manual position could be opened
 * from the trade page but only unwound by placing the opposite order by hand and
 * getting the size right, or by resetting the whole account. Both are worse than a
 * close button — the first invites a fat-finger, the second destroys history.
 *
 * Sizing is validated against the stored position rather than trusted, so a
 * request cannot flip a long into a short by overshooting. That mirrors the
 * reduce-only guarantee the live close relies on.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const parsed = asObject(await request.json());
    const exchange = requireExchange(parsed.exchange);
    const coin = requireCoin(parsed.coin);
    const side = requirePositionSide(parsed.side);
    const requested = optionalPositive(parsed.size, "size", 1e9);

    const open = paperPositions(markPriceMap()).find(
      (p) => p.exchange === exchange && p.coin === coin && p.side === side,
    );
    if (!open) {
      return jsonError(`No open ${side} ${coin} position on ${exchange}`, 404);
    }

    // Capped rather than rejected: a UI computing a percentage can land a hair
    // above the stored size through float arithmetic, and refusing a close for
    // that is worse than closing the whole leg the user asked for.
    const size = Math.min(requested ?? open.size, open.size);
    if (!(size > 0)) return jsonError("size must be greater than zero", 400);

    // Closing a long is a sell, closing a short is a buy.
    const fillSide = side === "long" ? "sell" : "buy";
    const fillPrice = executableFillPrice(coin, exchange, fillSide);
    if (fillPrice === null || fillPrice <= 0) {
      return jsonError(
        `No live ${exchange} quote for ${coin}; refusing to close at an invented price`,
        409,
      );
    }

    const order: Order = {
      id: `PAP-${randomUUID().slice(0, 8)}`,
      time: Date.now(),
      pair: coin,
      exchange,
      side: fillSide,
      marketType: "perp",
      orderType: "market",
      price: fillPrice,
      size,
      filled: size,
      status: "filled",
      leverage: open.leverage,
      reduceOnly: true,
      hedgeId: open.hedgeId,
    };

    insertPaperOrder(order);
    const { realizedPnl, fee } = applyPaperFill({
      orderId: order.id,
      exchange,
      coin,
      side: fillSide,
      price: fillPrice,
      size,
      leverage: open.leverage,
      hedgeId: open.hedgeId,
      // The close inherits what opened the position, so a strategy leg closed by
      // hand still reads as that strategy's in history rather than turning manual.
      source: open.source,
    });

    recordAudit({
      action: "paper.position.close",
      accountType: "paper",
      exchange,
      coin,
      payload: { side, size, price: fillPrice, realizedPnl, fee, hedgeId: open.hedgeId },
      outcome: "filled",
    });

    return jsonOk({
      order,
      realizedPnl,
      fee,
      overview: paperAccountOverview(markPriceMap()),
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
