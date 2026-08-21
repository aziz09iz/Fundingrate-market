import { requireAuth } from "@/lib/auth/guard";
import { appendStrategyLog } from "@/lib/db/strategy";
import { deploymentById, setDeploymentEnabled } from "@/lib/db/deployments";
import { autoTradingArmed, getStrategyRuntime } from "@/lib/strategy/runtime";
import { recordAudit } from "@/lib/db/audit";
import {
  asObject,
  handleRouteError,
  jsonError,
  jsonOk,
  requireBoolean,
  requireString,
} from "@/lib/api/validate";

/**
 * Starts and stops a deployment, and triggers a manual evaluation.
 *
 * Enabling a live deployment here is not sufficient to send orders — the server also
 * needs AUTO_TRADING=true. The response reports both so the UI can say which lock is
 * missing rather than implying the deployment is running.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const parsed = asObject(await request.json());
    const id = requireString(parsed.deployment, "deployment", 40);
    const deployment = deploymentById(id);
    if (!deployment) return jsonError("No such deployment", 404);

    const action = typeof parsed.action === "string" ? parsed.action : "toggle";
    const strategyRuntime = getStrategyRuntime();
    const account = deployment.accountType;

    if (action === "run") {
      // Same code path as the scheduled loop, guard rails included.
      const result = await strategyRuntime.tick(id);
      return jsonOk({ ...result, deploymentId: id, state: strategyRuntime.snapshot(id) });
    }

    const enabled = requireBoolean(parsed.enabled);
    setDeploymentEnabled(id, enabled);

    const armed = account === "paper" || autoTradingArmed();
    appendStrategyLog({
      strategy: deployment.strategy,
      accountType: account,
      level: "INFO",
      message: enabled
        ? armed
          ? `[${deployment.label}] started on the ${account} account`
          : `[${deployment.label}] switched on, but AUTO_TRADING is not set — evaluating without sending orders`
        : `[${deployment.label}] stopped on the ${account} account`,
    });
    recordAudit({
      action: "strategy.control",
      accountType: account,
      payload: {
        deployment: id,
        label: deployment.label,
        strategy: deployment.strategy,
        enabled,
        armed,
      },
      outcome: enabled ? "started" : "stopped",
    });

    return jsonOk({ deploymentId: id, state: strategyRuntime.snapshot(id) });
  } catch (err) {
    return handleRouteError(err);
  }
}
