import { requireAuth } from "@/lib/auth/guard";
import { getStrategyRuntime } from "@/lib/strategy/runtime";
import { handleRouteError, jsonError, jsonOk, ValidationError } from "@/lib/api/validate";
import type { AccountType } from "@/lib/types";

/**
 * Automation state for one account.
 *
 * Without `deployment` it returns the list summary for every deployment plus the
 * account's exposure — what the list view needs. With `deployment` it returns that
 * one deployment's full detail: run status, config, open hedges, recent results, and
 * the candidates the last cycle considered including why any were rejected.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function accountFrom(params: URLSearchParams): AccountType {
  const value = params.get("account");
  if (value === "live" || value === "paper") return value;
  throw new ValidationError("account must be live or paper");
}

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const params = new URL(request.url).searchParams;
    const accountType = accountFrom(params);
    const deploymentId = params.get("deployment")?.trim() || null;
    // Touching the runtime starts the loop, which is how the engines boot after a
    // server restart without needing a separate trigger.
    const strategyRuntime = getStrategyRuntime();

    if (deploymentId === null) {
      return jsonOk({
        accountType,
        deployments: strategyRuntime.list(accountType),
        exposure: strategyRuntime.exposure(accountType),
      });
    }

    const snapshot = strategyRuntime.snapshot(deploymentId);
    // A deployment can be deleted while a browser still polls it; 404 rather than
    // an empty snapshot, so the UI drops the selection instead of showing a blank
    // panel that looks like a broken engine.
    if (!snapshot) return jsonError("No such deployment", 404);
    return jsonOk(snapshot);
  } catch (err) {
    return handleRouteError(err);
  }
}
