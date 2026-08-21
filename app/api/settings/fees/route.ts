import { requireAuth } from "@/lib/auth/guard";
import {
  DEFAULT_TAKER_FEES,
  FeeConfigError,
  getFeeRates,
  saveFeeRates,
} from "@/lib/db/fees";
import { recordAudit } from "@/lib/db/audit";
import { asObject, handleRouteError, jsonError, jsonOk } from "@/lib/api/validate";

/**
 * Paper-account trading fees, per venue, in percent.
 *
 * Behind requireAuth like every other write: these values change what a paper
 * result claims, so they should not be editable by anything that can reach the
 * port.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    return jsonOk({ rates: getFeeRates(), defaults: DEFAULT_TAKER_FEES });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const parsed = asObject(await request.json());
    const rates = saveFeeRates(asObject(parsed.rates ?? parsed));

    recordAudit({
      action: "fees.update",
      accountType: "paper",
      payload: rates,
      outcome: "saved",
    });

    return jsonOk({ rates, defaults: DEFAULT_TAKER_FEES });
  } catch (err) {
    if (err instanceof FeeConfigError) return jsonError(err.message, 400);
    return handleRouteError(err);
  }
}
