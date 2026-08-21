import { randomUUID } from "node:crypto";
import { requireAuth } from "@/lib/auth/guard";
import type { Order } from "@/lib/types";
import {
  applyPaperFill,
  cancelPaperOrder,
  insertPaperOrder,
  paperAccountOverview,
} from "@/lib/db/paper";
import { executableFillPrice, markPriceMap } from "@/lib/market/marks";
import { recordAudit } from "@/lib/db/audit";
import {
  asObject,
  handleRouteError,
  jsonError,
  jsonOk,
  optionalPositive,
  optionalString,
  requireBoolean,
  requireCoin,
  requireExchange,
  requireLeverage,
  requireOrderType,
  requirePositive,
  requireSide,
  requireString,
  requireWatchedCoin,
  assertPriceSane,
} from "@/lib/api/validate";

// Simulated order entry. No exchange is contacted; fills are computed against
// live quotes so paper results track the real market.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const parsed = asObject(await request.json());
    const exchange = requireExchange(parsed.exchange);
    const coin = requireCoin(parsed.coin ?? parsed.pair);
    requireWatchedCoin(coin);
    const side = requireSide(parsed.side);
    const orderType = requireOrderType(parsed.orderType);
    const size = requirePositive(parsed.size, "size", 1e9);
    const leverage = requireLeverage(parsed.leverage);
    const reduceOnly = requireBoolean(parsed.reduceOnly);
    const hedgeId = optionalString(parsed.hedgeId, 64);

    const limitPrice = optionalPositive(parsed.price, "price");
    if (orderType === "limit") {
      if (limitPrice === undefined) {
        return jsonError("price is required for a limit order", 400);
      }
      assertPriceSane(coin, exchange, limitPrice);
    }

    const order: Order = {
      id: `PAP-${randomUUID().slice(0, 8)}`,
      time: Date.now(),
      pair: coin,
      exchange,
      side,
      marketType: "perp",
      orderType,
      price: limitPrice ?? 0,
      size,
      filled: 0,
      status: orderType === "market" ? "filled" : "open",
      leverage,
      reduceOnly,
      hedgeId,
    };

    if (orderType === "market") {
      // A market order needs a quote to fill against; refusing beats inventing
      // a price and reporting a PnL that never existed.
      const fillPrice = executableFillPrice(coin, exchange, side);
      if (fillPrice === null || fillPrice <= 0) {
        return jsonError(`No live ${exchange} quote for ${coin}; cannot fill a market order`, 409);
      }
      order.price = fillPrice;
      order.filled = size;
      insertPaperOrder(order);
      applyPaperFill({
        orderId: order.id,
        exchange,
        coin,
        side,
        price: fillPrice,
        size,
        leverage,
        hedgeId,
      });
    } else {
      insertPaperOrder(order);
    }

    recordAudit({
      action: "paper.order",
      accountType: "paper",
      exchange,
      coin,
      payload: { side, orderType, size, price: order.price, leverage, reduceOnly },
      outcome: order.status,
    });

    return jsonOk({ order, overview: paperAccountOverview(markPriceMap()) });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const parsed = asObject(await request.json());
    const id = requireString(parsed.id, "id", 64);
    const cancelled = cancelPaperOrder(id);
    if (!cancelled) return jsonError("Order not found or already settled", 404);

    recordAudit({
      action: "paper.cancel",
      accountType: "paper",
      payload: { id },
      outcome: "cancelled",
    });

    return jsonOk({ cancelled: true, overview: paperAccountOverview(markPriceMap()) });
  } catch (err) {
    return handleRouteError(err);
  }
}
