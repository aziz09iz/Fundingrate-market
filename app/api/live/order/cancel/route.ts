import { requireAuth } from "@/lib/auth/guard";
import { OrderRejected, cancelLiveOrder } from "@/lib/private/orders";
import { getLiveRuntime } from "@/lib/private/runtime";
import {
  asObject,
  handleRouteError,
  jsonError,
  jsonOk,
  requireString,
} from "@/lib/api/validate";

// Cancels a resting order. Cancelling twice is harmless, so no idempotency key
// is required here — unlike placing, a repeated cancel cannot cost money.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const parsed = asObject(await request.json());
    const id = requireString(parsed.id, "id", 64);
    await cancelLiveOrder({ id });
    return jsonOk({ cancelled: true, snapshot: getLiveRuntime().snapshot() });
  } catch (err) {
    if (err instanceof OrderRejected) return jsonError(err.message, 409);
    return handleRouteError(err);
  }
}
