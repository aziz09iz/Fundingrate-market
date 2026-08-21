import { requireAuth } from "@/lib/auth/guard";
import type { AccountType, StrategyId } from "@/lib/types";
import { STRATEGY_IDS, STRATEGY_META } from "@/lib/types";
import { appendStrategyLog } from "@/lib/db/strategy";
import {
  DeploymentError,
  createDeployment,
  deleteDeployment,
  deploymentById,
  openPositionCount,
  renameDeployment,
  suggestLabel,
} from "@/lib/db/deployments";
import { getStrategyRuntime } from "@/lib/strategy/runtime";
import { recordAudit } from "@/lib/db/audit";
import {
  asObject,
  handleRouteError,
  jsonError,
  jsonOk,
  optionalString,
  requireString,
  ValidationError,
} from "@/lib/api/validate";

/**
 * Deployments: create, rename and delete.
 *
 * A deployment is one running instance of a strategy with its own label, toggle and
 * configuration, so several of the same strategy can run on different venue sets.
 *
 * Two deliberate refusals live here. A new deployment always starts switched off —
 * one created enabled would begin placing orders on inherited settings before anyone
 * looked at them. And deletion is refused while the deployment holds a hedge, because
 * its positions are real exposure that would be left with no engine managing the exit.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function requireAccount(value: unknown): AccountType {
  if (value === "live" || value === "paper") return value;
  throw new ValidationError("account must be live or paper");
}

function requireStrategy(value: unknown): StrategyId {
  if (typeof value === "string" && (STRATEGY_IDS as readonly string[]).includes(value)) {
    return value as StrategyId;
  }
  throw new ValidationError(`strategy must be one of ${STRATEGY_IDS.join(", ")}`);
}

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const params = new URL(request.url).searchParams;
    const account = requireAccount(params.get("account"));
    const strategyRuntime = getStrategyRuntime();

    return jsonOk({
      accountType: account,
      deployments: strategyRuntime.list(account),
      exposure: strategyRuntime.exposure(account),
      /**
       * What can be deployed, with a suggested name for each. The suggestion is
       * computed server-side because uniqueness is enforced there — a client-side
       * guess would collide as soon as two tabs are open.
       */
      available: STRATEGY_IDS.map((strategy) => ({
        strategy,
        name: STRATEGY_META[strategy].name,
        tagline: STRATEGY_META[strategy].tagline,
        suggestedLabel: suggestLabel(strategy, account),
      })),
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
    const action = typeof parsed.action === "string" ? parsed.action : "create";
    const strategyRuntime = getStrategyRuntime();

    if (action === "rename") {
      const id = requireString(parsed.deployment, "deployment", 40);
      const label = requireString(parsed.label, "label", 40);
      const before = deploymentById(id);
      if (!before) return jsonError("No such deployment", 404);
      const after = renameDeployment(id, label);
      appendStrategyLog({
        strategy: after.strategy,
        accountType: after.accountType,
        level: "INFO",
        message: `[${after.label}] renamed from “${before.label}”`,
      });
      return jsonOk({
        deployments: strategyRuntime.list(after.accountType),
        exposure: strategyRuntime.exposure(after.accountType),
      });
    }

    if (action === "delete") {
      const id = requireString(parsed.deployment, "deployment", 40);
      const deployment = deploymentById(id);
      if (!deployment) return jsonError("No such deployment", 404);
      const open = openPositionCount(id);
      deleteDeployment(id);
      appendStrategyLog({
        strategy: deployment.strategy,
        accountType: deployment.accountType,
        level: "INFO",
        message: `[${deployment.label}] deleted`,
      });
      recordAudit({
        action: "strategy.deployment.delete",
        accountType: deployment.accountType,
        payload: {
          deployment: id,
          label: deployment.label,
          strategy: deployment.strategy,
          openPositions: open,
        },
        outcome: "deleted",
      });
      return jsonOk({
        deployments: strategyRuntime.list(deployment.accountType),
        exposure: strategyRuntime.exposure(deployment.accountType),
      });
    }

    // action === "create"
    const account = requireAccount(parsed.account);
    const strategy = requireStrategy(parsed.strategy);
    const label = optionalString(parsed.label, 40) ?? null;

    const created = createDeployment({ strategy, accountType: account, label });
    appendStrategyLog({
      strategy,
      accountType: account,
      level: "INFO",
      message:
        `[${created.label}] deployed on the ${account} account, switched off. ` +
        `Set its venues and thresholds, then start it.`,
    });
    recordAudit({
      action: "strategy.deployment.create",
      accountType: account,
      payload: { deployment: created.id, label: created.label, strategy },
      outcome: "created",
    });

    return jsonOk({
      deploymentId: created.id,
      deployments: strategyRuntime.list(account),
      exposure: strategyRuntime.exposure(account),
    });
  } catch (err) {
    // A name clash, a hedge still open, or the deployment cap — all things the user
    // can act on, so they read as 400 rather than a server fault.
    if (err instanceof DeploymentError) return jsonError(err.message, 400);
    return handleRouteError(err);
  }
}
