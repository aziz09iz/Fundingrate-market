import { requireAuth } from "@/lib/auth/guard";
import type { RebalanceOverview } from "@/lib/types";
import { getRebalanceConfig } from "@/lib/db/rebalance";
import { destinationStatuses } from "@/lib/db/destinations";
import { rebalanceSuggestions } from "@/lib/rebalance/engine";
import { exchangeBalances, unsupportedWalletVenues } from "@/lib/rebalance/wallets";
import { getRebalanceRuntime } from "@/lib/rebalance/runtime";
import { handleRouteError, jsonOk } from "@/lib/api/validate";

/**
 * Rebalancing overview: balances split into derivatives collateral and funding
 * wallet, live recommendations, saved guard rails, configured destinations, and
 * the automation's real state including whether the env arm is set.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    // Starting the runtime here keeps the history cache warm without a
    // dedicated trigger; it does not send anything unless armed and enabled.
    const automation = getRebalanceRuntime().status();
    const config = getRebalanceConfig();
    const balances = await exchangeBalances();

    const payload: RebalanceOverview = {
      balances,
      suggestions: rebalanceSuggestions(balances, config),
      config,
      automation,
      // Unconfirmed rows are included so the UI can show what still needs arming;
      // addresses are masked, and the allowlist is what refuses to use them.
      destinations: destinationStatuses(),
      unsupportedVenues: unsupportedWalletVenues(),
      updatedAt: Date.now(),
    };
    return jsonOk(payload);
  } catch (err) {
    return handleRouteError(err);
  }
}
