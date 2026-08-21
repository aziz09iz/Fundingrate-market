import { requireAuth } from "@/lib/auth/guard";
import { defaultAccountType, setDefaultAccountType } from "@/lib/db/settings";
import { recordAudit } from "@/lib/db/audit";
import { asObject, handleRouteError, jsonOk, requireAccountType } from "@/lib/api/validate";

/**
 * Application defaults that belong to the installation rather than a browser tab.
 *
 * Only the default account lives here so far. The two "safety" switches that used
 * to sit beside it in the UI were removed rather than persisted: withdrawals
 * already confirm unconditionally and the paper badge already always renders, so
 * storing a toggle for either would have implied a choice the code does not honour.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    return jsonOk({ defaultAccount: defaultAccountType() });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const parsed = asObject(await request.json());
    const defaultAccount = setDefaultAccountType(requireAccountType(parsed.defaultAccount));

    recordAudit({
      action: "settings.defaults.update",
      accountType: defaultAccount,
      payload: { defaultAccount },
      outcome: "saved",
    });

    return jsonOk({ defaultAccount });
  } catch (err) {
    return handleRouteError(err);
  }
}
