import { requireAuth } from "@/lib/auth/guard";
import { getRebalanceRuntime } from "@/lib/rebalance/runtime";
import { recordAudit } from "@/lib/db/audit";
import { asObject, handleRouteError, jsonOk } from "@/lib/api/validate";

/**
 * Automation status, and a manual "evaluate now".
 *
 * The evaluation applies every guard rail the scheduled loop applies, including
 * the REBALANCE_AUTOMATION arm — so triggering it here cannot send a transfer
 * the loop would have refused.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    return jsonOk({ automation: getRebalanceRuntime().status() });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const parsed = asObject(await request.json().catch(() => ({})));
    const action = typeof parsed.action === "string" ? parsed.action : "evaluate";
    const runtimeRef = getRebalanceRuntime();

    if (action === "evaluate") {
      // `manual` so the operator sees what the venues actually report, even when
      // the arm is unset — the scheduled loop skips that work rather than doing it
      // and discarding the answer.
      const result = await runtimeRef.evaluate({ manual: true });
      recordAudit({
        action: "rebalance.evaluate",
        payload: { evaluated: result.evaluated, executed: result.executed },
        outcome: result.executed > 0 ? "executed" : "no-action",
        error: result.reason ?? undefined,
      });
      return jsonOk({ ...result, automation: runtimeRef.status() });
    }

    return jsonOk({ automation: runtimeRef.status() });
  } catch (err) {
    return handleRouteError(err);
  }
}
