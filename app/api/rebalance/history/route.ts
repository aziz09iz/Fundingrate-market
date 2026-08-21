import { requireAuth } from "@/lib/auth/guard";
import { transferEvents, transfers } from "@/lib/db/rebalance";
import { syncTransferHistory } from "@/lib/rebalance/wallets";
import { handleRouteError, jsonOk } from "@/lib/api/validate";

/**
 * Transfer history: our own records plus the venue-reported withdraw/deposit
 * events they are matched against.
 *
 * `?sync=1` polls the venues first. Without it the cached rows are returned,
 * which is what the periodic runtime sync keeps current.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const url = new URL(request.url);
    let syncErrors: string[] = [];
    if (url.searchParams.get("sync") === "1") {
      const result = await syncTransferHistory();
      syncErrors = result.errors;
    }
    return jsonOk({
      transfers: transfers(100),
      events: transferEvents(200),
      syncErrors,
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
