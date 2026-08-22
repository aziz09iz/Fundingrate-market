import { getMarketRuntime } from "@/lib/market/runtime";
import { parseViewQuery, parseViewerId } from "@/lib/market/query";

// One page of the market, for callers that cannot hold an SSE connection open.
//
// This returns the same paged view the stream pushes rather than the whole market: the
// unpaged snapshot exists for server-side callers that genuinely need every row, and
// serving it over HTTP would mean several megabytes per request once every pair is
// subscribed.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const market = getMarketRuntime();
  const url = new URL(request.url);
  const view = market.viewFor(parseViewerId(url), parseViewQuery(url));
  return Response.json(view, { headers: { "cache-control": "no-store" } });
}
