import { requireAuth } from "@/lib/auth/guard";
import { paperAccountOverview, getPaperState } from "@/lib/db/paper";
import { markPriceMap } from "@/lib/market/marks";
import { handleRouteError, jsonOk } from "@/lib/api/validate";

// Paper account snapshot. Behind auth because it exposes account state, even
// though the money is simulated.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    // Positions are valued against live marks from the market stream, so paper
    // PnL moves with the real market rather than being invented.
    const overview = paperAccountOverview(markPriceMap());
    return jsonOk({ overview, state: getPaperState() });
  } catch (err) {
    return handleRouteError(err);
  }
}
