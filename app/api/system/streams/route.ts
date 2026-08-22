import { requireAuth } from "@/lib/auth/guard";
import { getMarketRuntime } from "@/lib/market/runtime";
import { jsonOk } from "@/lib/api/validate";

// Stream Fabric telemetry: every websocket shard, per-venue coverage, and what the
// Book Focus set currently holds.
//
// Behind `requireAuth` unlike the rest of the market API. The data is not itself
// sensitive, but it enumerates this server's upstream connections and error strings,
// which is operational detail about the host rather than public market data.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;
  return jsonOk(getMarketRuntime().fabricStatus());
}
