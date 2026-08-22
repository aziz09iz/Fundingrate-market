import { requireAuth } from "@/lib/auth/guard";
import { getMarketRuntime } from "@/lib/market/runtime";
import {
  asObject,
  handleRouteError,
  jsonError,
  jsonOk,
  requireString,
} from "@/lib/api/validate";

// Drops and reopens one websocket shard.
//
// Authenticated because it is a write: it disconnects a live socket, and a venue's
// funding briefly stops arriving while it reconnects. Reading the same telemetry is
// harmless, but acting on it should require the same session that can place an order.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const body = asObject(await request.json());
    const shardId = requireString(body.shardId, "shardId", 120);
    if (!getMarketRuntime().reconnectShard(shardId)) {
      // A shard id that no longer exists usually means the subscription set moved on
      // between the page loading and the click, so it is a stale request rather than
      // a server fault.
      return jsonError(`No shard named ${shardId} is currently connected.`, 404);
    }
    return jsonOk({ shardId, reconnecting: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
