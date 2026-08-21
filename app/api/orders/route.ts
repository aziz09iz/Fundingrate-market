import { requireAuth } from "@/lib/auth/guard";
import { openPaperOrders, paperOrderHistory } from "@/lib/db/paper";
import { liveOpenOrders, liveOrderHistory } from "@/lib/db/live";
import { getLiveRuntime } from "@/lib/private/runtime";
import { handleRouteError, jsonOk } from "@/lib/api/validate";

/**
 * Order book for the trade page: resting orders and recent history for both
 * accounts. Reading live orders starts the private runtime so the list reflects
 * what the venues actually report, not only what this app submitted.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    getLiveRuntime();
    return jsonOk({
      paper: { open: openPaperOrders(), history: paperOrderHistory(50) },
      live: { open: liveOpenOrders(), history: liveOrderHistory(50) },
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
