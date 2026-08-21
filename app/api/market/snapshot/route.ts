import { getMarketRuntime } from "@/lib/market/runtime";

// One-shot snapshot, used as a fallback when the SSE stream is unavailable.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const market = getMarketRuntime();
  return Response.json(market.snapshot(), {
    headers: { "cache-control": "no-store" },
  });
}
