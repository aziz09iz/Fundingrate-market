import { requireAuth } from "@/lib/auth/guard";
import { transferNetworks } from "@/lib/rebalance/wallets";
import {
  handleRouteError,
  jsonOk,
  requireExchange,
  ValidationError,
} from "@/lib/api/validate";
import { isTransferToken } from "@/lib/rebalance/chains";

/**
 * Withdrawal chains for a route, as the source venue currently reports them.
 *
 * Fees and minimums come from the venue on every request rather than from a
 * table in this codebase: a stale fee produces a transfer the venue rejects, or
 * one that arrives short.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const url = new URL(request.url);
    const from = requireExchange(url.searchParams.get("from"));
    const to = requireExchange(url.searchParams.get("to"));
    const token = url.searchParams.get("token") ?? "USDT";
    if (!isTransferToken(token)) {
      throw new ValidationError("token must be USDT or USDC");
    }
    if (from === to) throw new ValidationError("from and to must be different venues");

    const networks = await transferNetworks({ from, to, token });
    return jsonOk({ networks });
  } catch (err) {
    return handleRouteError(err);
  }
}
