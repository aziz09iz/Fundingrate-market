import { requireAuth } from "@/lib/auth/guard";
import { OrderRejected, closeLivePosition } from "@/lib/private/orders";
import { getLiveRuntime } from "@/lib/private/runtime";
import {
  claimIdempotencyKey,
  releaseIdempotencyKey,
  storeIdempotentResponse,
} from "@/lib/db/audit";
import {
  asObject,
  handleRouteError,
  jsonError,
  jsonOk,
  optionalPositive,
  requireCoin,
  requireExchange,
  requirePositionSide,
  requireString,
} from "@/lib/api/validate";

/**
 * Closes an open position with a reduce-only market order.
 *
 * Reduce-only matters: it means an oversized request cannot flip the position
 * into the opposite direction. The service also validates size against the
 * venue's reported position.
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
    const cached = claimIdempotencyKey(idempotencyKey, "live.position.close");
    if (cached !== null) {
      return new Response(cached || JSON.stringify({ duplicate: true }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    const exchange = requireExchange(parsed.exchange);
    const coin = requireCoin(parsed.coin);
    const side = requirePositionSide(parsed.side);
    const size = optionalPositive(parsed.size, "size", 1e9);

    const result = await closeLivePosition({ exchange, coin, side, size });
    const payload = { order: result.order, exchangeOrderId: result.exchangeOrderId };
    storeIdempotentResponse(idempotencyKey, payload);
    return jsonOk({ ...payload, snapshot: getLiveRuntime().snapshot() });
  } catch (err) {
    if (idempotencyKey) releaseIdempotencyKey(idempotencyKey);
    if (err instanceof OrderRejected) return jsonError(err.message, 409);
    return handleRouteError(err);
  }
}
