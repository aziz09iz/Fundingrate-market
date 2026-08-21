import { requireAuth } from "@/lib/auth/guard";
import { getLiveRuntime } from "@/lib/private/runtime";
import { credentialStatuses } from "@/lib/db/credentials";
import { handleRouteError, jsonOk } from "@/lib/api/validate";

// Live account snapshot: positions, open orders, fills and balances as reported
// by the venues' private streams.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const snapshot = getLiveRuntime().snapshot();
    // Credential status travels alongside so the UI can explain an empty view
    // (no keys configured) instead of implying a flat account.
    return jsonOk({ snapshot, credentials: credentialStatuses() });
  } catch (err) {
    return handleRouteError(err);
  }
}
