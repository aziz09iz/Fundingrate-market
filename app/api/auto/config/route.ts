import { requireAuth } from "@/lib/auth/guard";
import type {
  FundingBridgeConfig,
  FundingYieldConfig,
  PerpBridgeConfig,
  StrategyConfig,
} from "@/lib/types";
import { appendStrategyLog } from "@/lib/db/strategy";
import { deploymentById, saveDeploymentConfig } from "@/lib/db/deployments";
import { StrategyConfigError, parseStrategyConfig } from "@/lib/strategy/config";
import {
  PerpBridgeConfigError,
  parsePerpBridgeConfig,
} from "@/lib/strategy/perpbridge-config";
import {
  FundingBridgeConfigError,
  parseFundingBridgeConfig,
} from "@/lib/strategy/fundingbridge-config";
import {
  FundingYieldConfigError,
  parseFundingYieldConfig,
} from "@/lib/strategy/fundingyield-config";
import { getStrategyRuntime } from "@/lib/strategy/runtime";
import { recordAudit } from "@/lib/db/audit";
import {
  asObject,
  handleRouteError,
  jsonError,
  jsonOk,
  requireString,
} from "@/lib/api/validate";

/**
 * Deployment configuration.
 *
 * Stored server-side because the engines enforce these values with no browser
 * attached. Validation rejects rather than clamps: a number that silently becomes
 * something else is worse than an error the user can see.
 *
 * The strategy is read from the deployment rather than taken from the request. A
 * caller cannot ask for one strategy's config to be parsed into another's slot — the
 * deployment already knows what it is.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const params = new URL(request.url).searchParams;
    const id = requireString(params.get("deployment"), "deployment", 40);
    const deployment = deploymentById(id);
    if (!deployment) return jsonError("No such deployment", 404);
    return jsonOk({
      deploymentId: deployment.id,
      strategy: deployment.strategy,
      label: deployment.label,
      config: deployment.config,
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const parsed = asObject(await request.json());
    const id = requireString(parsed.deployment, "deployment", 40);
    const deployment = deploymentById(id);
    if (!deployment) return jsonError("No such deployment", 404);

    const patch = asObject(parsed.config ?? {});
    const account = deployment.accountType;
    const strategy = deployment.strategy;

    /** One place to log and audit, since every branch does the same thing. */
    const commit = (
      next: StrategyConfig | PerpBridgeConfig | FundingBridgeConfig | FundingYieldConfig,
      summary: string,
    ) => {
      const saved = saveDeploymentConfig(id, next);
      appendStrategyLog({
        strategy,
        accountType: account,
        level: "INFO",
        message: `[${deployment.label}] Config updated: ${summary}`,
      });
      recordAudit({
        action: "strategy.config",
        accountType: account,
        payload: { deployment: id, label: deployment.label, strategy, ...next },
        outcome: "saved",
      });
      return jsonOk({
        deploymentId: id,
        strategy,
        config: saved.config,
        state: getStrategyRuntime().snapshot(id),
      });
    };

    // Validated against the stored config, so a partial patch keeps the rest.
    if (strategy === "perpbridge") {
      const next = parsePerpBridgeConfig(patch, deployment.config as PerpBridgeConfig);
      return commit(
        next,
        `gap ≥ ${next.minEntrySpread}%, target ${next.minProfitSpread}% net, ` +
          `${next.maxPositions} max positions, $${next.marginPerLeg}×${next.leverage} per leg`,
      );
    }

    if (strategy === "fundingbridge") {
      const next = parseFundingBridgeConfig(patch, deployment.config as FundingBridgeConfig);
      return commit(
        next,
        `lock at diff ≥ ${next.minDiffFr}% within ${next.entryWindowMin}m, ` +
          `enter at spread ≥ ${next.entrySpread}%, matched-cadence exit ${next.exitDiffFr}% then ` +
          `${next.minProfitSpread}% net, mismatched-cadence hold ≤ ${next.maxHoldMin}m, ` +
          `${next.maxPositions} max positions, $${next.marginPerLeg}×${next.leverage} per leg`,
      );
    }

    if (strategy === "fundingyield") {
      const next = parseFundingYieldConfig(patch, deployment.config as FundingYieldConfig);
      return commit(
        next,
        `diff ≥ ${next.minDiffFr}% over ~${next.targetSettlements} settlements, ` +
          `net ≥ $${next.minNetYieldUsd} with round trip spread ≤ ${next.maxSpreadCostPct}%, ` +
          `exit at ${next.profitTargetMultiple}× fees, stop −$${next.stopLossUsd}, ` +
          `${next.exitOnReversal ? "close" : "hold"} on reversal, ` +
          `hold ≤ ${next.maxHoldHours}h, ${next.maxPositions} max positions, ` +
          `$${next.marginPerLeg}×${next.leverage} per leg`,
      );
    }

    const next = parseStrategyConfig(patch, deployment.config as StrategyConfig);
    return commit(
      next,
      `${next.entryMode} entry, diff ≥ ${next.minDiffFr}%, ` +
        `${next.maxPositions} max positions, $${next.marginPerLeg}×${next.leverage} per leg, ` +
        `${next.entryWindowMin}m window`,
    );
  } catch (err) {
    if (err instanceof StrategyConfigError) return jsonError(err.message, 400);
    if (err instanceof PerpBridgeConfigError) return jsonError(err.message, 400);
    if (err instanceof FundingBridgeConfigError) return jsonError(err.message, 400);
    if (err instanceof FundingYieldConfigError) return jsonError(err.message, 400);
    return handleRouteError(err);
  }
}
