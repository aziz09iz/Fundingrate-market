import { requireAuth } from "@/lib/auth/guard";
import { OrderRejected, placeLiveOrder } from "@/lib/private/orders";
import { getLiveRuntime } from "@/lib/private/runtime";
import {
  claimIdempotencyKey,
  releaseIdempotencyKey,
  storeIdempotentResponse,
} from "@/lib/db/audit";
import {
  asObject,
  assertPriceSane,
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
} from "@/lib/api/validate";

/**
 * Places a real order on a real venue.
 *
 * Requires an Idempotency-Key header: a retry or a double-clicked button must
 * not become two positions.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  let idempotencyKey: string | null = null;
  try {
    const parsed = asObject(await request.json());

    idempotencyKey = requireString(
      request.headers.get("idempotency-key") ?? parsed.idempotencyKey,
      "Idempotency-Key",
      120,
    );
    const cached = claimIdempotencyKey(idempotencyKey, "live.order.place");
    if (cached !== null) {
      // Already handled: return the original outcome rather than sending again.
      return new Response(cached || JSON.stringify({ duplicate: true }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    const exchange = requireExchange(parsed.exchange);
    const coin = requireCoin(parsed.coin ?? parsed.pair);
    requireWatchedCoin(coin);
    const side = requireSide(parsed.side);
    const orderType = requireOrderType(parsed.orderType);
    const size = requirePositive(parsed.size, "size", 1e9);
    const leverage = requireLeverage(parsed.leverage);
    const reduceOnly = requireBoolean(parsed.reduceOnly);
    const hedgeId = optionalString(parsed.hedgeId, 64);
    const price = optionalPositive(parsed.price, "price");

    if (orderType === "limit") {
      if (price === undefined) {
        releaseIdempotencyKey(idempotencyKey);
        return jsonError("price is required for a limit order", 400);
      }
      // Guards against a fat-fingered price far from the market.
      assertPriceSane(coin, exchange, price);
    }

    const result = await placeLiveOrder({
      exchange,
      coin,
      side,
      orderType,
      size,
      price,
      leverage,
      reduceOnly,
      hedgeId,
    });

    const payload = { order: result.order, exchangeOrderId: result.exchangeOrderId };
    storeIdempotentResponse(idempotencyKey, payload);
    return jsonOk({ ...payload, snapshot: getLiveRuntime().snapshot() });
  } catch (err) {
    // Freeing the key lets the caller retry the same intent after a failure.
    if (idempotencyKey) releaseIdempotencyKey(idempotencyKey);
    if (err instanceof OrderRejected) return jsonError(err.message, 409);
    return handleRouteError(err);
  }
}
