import { getMarketRuntime } from "@/lib/market/runtime";

// Coins each venue lists, for pair pickers that need the whole universe rather than
// the page currently on screen.
//
// Public like the rest of the market API: a listing set is what the venues publish
// themselves. Cheap enough to serve uncached — the registry holds it in memory and
// refreshes it every five minutes.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const market = getMarketRuntime();
  const venues = market.instruments();
  const all = new Set<string>();
  for (const venue of venues) {
    for (const coin of venue.coins) all.add(coin);
  }
  return Response.json(
    { venues, coins: [...all].sort() },
    { headers: { "cache-control": "no-store" } },
  );
}
