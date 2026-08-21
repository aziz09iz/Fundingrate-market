import { randomUUID } from "node:crypto";
import type { AccountType, StrategyDeployment, StrategyId } from "@/lib/types";
import { STRATEGY_IDS, STRATEGY_META } from "@/lib/types";
import { getDb, inTransaction, rowBool, rowNum, rowStr } from "@/lib/db/client";
import { DEFAULT_STRATEGY_CONFIG, readStoredConfig } from "@/lib/strategy/config";
import {
  DEFAULT_PERPBRIDGE_CONFIG,
  readStoredPerpBridgeConfig,
} from "@/lib/strategy/perpbridge-config";
import {
  DEFAULT_FUNDINGBRIDGE_CONFIG,
  readStoredFundingBridgeConfig,
} from "@/lib/strategy/fundingbridge-config";
import {
  DEFAULT_FUNDINGYIELD_CONFIG,
  readStoredFundingYieldConfig,
} from "@/lib/strategy/fundingyield-config";
import type { AnyStrategyConfig } from "@/lib/db/strategy";

/**
 * Strategy deployments.
 *
 * A strategy is a blueprint; a deployment is one running instance of it with its
 * own label, toggle and configuration. Several deployments of the same strategy can
 * run side by side on different venue sets — which is the point, and the reason the
 * old `(strategy, accountType)` primary key had to go.
 *
 * Deleting a deployment is refused while it still holds a hedge. That is not a
 * convenience check: its positions are real exposure, and orphaning them would
 * leave money in the market with no engine managing the exit.
 */

/** Ceiling on deployments per account, so the tick loop stays bounded. */
const MAX_DEPLOYMENTS_PER_ACCOUNT = 24;

export class DeploymentError extends Error {}

export function defaultConfigFor(strategy: StrategyId): AnyStrategyConfig {
  switch (strategy) {
    case "perpbridge":
      return { ...DEFAULT_PERPBRIDGE_CONFIG };
    case "fundingbridge":
      return { ...DEFAULT_FUNDINGBRIDGE_CONFIG };
    case "fundingyield":
      return { ...DEFAULT_FUNDINGYIELD_CONFIG };
    default:
      return { ...DEFAULT_STRATEGY_CONFIG };
  }
}

export function parseConfigFor(strategy: StrategyId, raw: string): AnyStrategyConfig {
  switch (strategy) {
    case "perpbridge":
      return readStoredPerpBridgeConfig(raw);
    case "fundingbridge":
      return readStoredFundingBridgeConfig(raw);
    case "fundingyield":
      return readStoredFundingYieldConfig(raw);
    default:
      return readStoredConfig(raw);
  }
}

export interface StoredDeployment extends StrategyDeployment {
  config: AnyStrategyConfig;
}

function rowToDeployment(row: Record<string, unknown>): StoredDeployment {
  const strategy = rowStr(row.strategy) as StrategyId;
  return {
    id: rowStr(row.id),
    strategy,
    accountType: rowStr(row.account_type) as AccountType,
    label: rowStr(row.label),
    enabled: rowBool(row.enabled),
    config: parseConfigFor(strategy, rowStr(row.config, "{}")),
    lastRunAt: rowNum(row.last_run_at, 0) || null,
    lastError: rowStr(row.last_error, "") || null,
    createdAt: rowNum(row.created_at),
  };
}

/**
 * Every deployment on one account, oldest first.
 *
 * The order is load-bearing rather than cosmetic: when two deployments want the
 * same venue leg, the first to claim it wins, and iterating in creation order makes
 * that outcome deterministic instead of depending on map iteration.
 */
export function deployments(accountType: AccountType): StoredDeployment[] {
  const rows = getDb()
    .prepare("SELECT * FROM strategy_deployments WHERE account_type = ? ORDER BY created_at ASC, id ASC")
    .all(accountType) as Record<string, unknown>[];
  return rows.map(rowToDeployment);
}

/** Deployments across both accounts, for the tick loop. */
export function allDeployments(): StoredDeployment[] {
  const rows = getDb()
    .prepare("SELECT * FROM strategy_deployments ORDER BY created_at ASC, id ASC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToDeployment);
}

export function deploymentById(id: string): StoredDeployment | null {
  const row = getDb()
    .prepare("SELECT * FROM strategy_deployments WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToDeployment(row) : null;
}

/** Suggests the next free label for a strategy, e.g. "FundingBridge 3". */
export function suggestLabel(strategy: StrategyId, accountType: AccountType): string {
  const base = STRATEGY_META[strategy].name;
  const taken = new Set(deployments(accountType).map((d) => d.label.toLowerCase()));
  for (let n = 1; n <= MAX_DEPLOYMENTS_PER_ACCOUNT + 1; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now().toString(36)}`;
}

export interface CreateDeploymentInput {
  strategy: StrategyId;
  accountType: AccountType;
  /** Operator label. Falls back to a suggested one when blank. */
  label?: string | null;
  /** Starting configuration. Defaults to the strategy's shipped values. */
  config?: AnyStrategyConfig;
}

/**
 * Creates a deployment, switched off.
 *
 * Off is the only safe initial state: a deployment created enabled would start
 * placing orders on whatever configuration it happened to inherit, before anyone
 * looked at it.
 */
export function createDeployment(input: CreateDeploymentInput): StoredDeployment {
  if (!(STRATEGY_IDS as readonly string[]).includes(input.strategy)) {
    throw new DeploymentError(`Unknown strategy: ${input.strategy}`);
  }
  const existing = deployments(input.accountType);
  if (existing.length >= MAX_DEPLOYMENTS_PER_ACCOUNT) {
    throw new DeploymentError(
      `This account already has ${MAX_DEPLOYMENTS_PER_ACCOUNT} deployments, which is the limit.`,
    );
  }

  const label = (input.label?.trim() || suggestLabel(input.strategy, input.accountType)).slice(0, 40);
  if (existing.some((d) => d.label.toLowerCase() === label.toLowerCase())) {
    throw new DeploymentError(`“${label}” is already used on this account.`);
  }

  const id = `DEP-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const config = input.config ?? defaultConfigFor(input.strategy);
  getDb()
    .prepare(
      "INSERT INTO strategy_deployments (id, strategy, account_type, label, enabled, config, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
    )
    .run(id, input.strategy, input.accountType, label, JSON.stringify(config), now, now);

  const created = deploymentById(id);
  if (!created) throw new DeploymentError("Deployment was created but could not be read back");
  return created;
}

export function renameDeployment(id: string, label: string): StoredDeployment {
  const deployment = deploymentById(id);
  if (!deployment) throw new DeploymentError("No such deployment");
  const next = label.trim().slice(0, 40);
  if (!next) throw new DeploymentError("A deployment needs a name");
  const clash = deployments(deployment.accountType).some(
    (d) => d.id !== id && d.label.toLowerCase() === next.toLowerCase(),
  );
  if (clash) throw new DeploymentError(`“${next}” is already used on this account.`);

  getDb()
    .prepare("UPDATE strategy_deployments SET label = ?, updated_at = ? WHERE id = ?")
    .run(next, Date.now(), id);
  return deploymentById(id)!;
}

export function saveDeploymentConfig(id: string, config: AnyStrategyConfig): StoredDeployment {
  const deployment = deploymentById(id);
  if (!deployment) throw new DeploymentError("No such deployment");
  getDb()
    .prepare("UPDATE strategy_deployments SET config = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(config), Date.now(), id);
  return deploymentById(id)!;
}

export function setDeploymentEnabled(id: string, enabled: boolean): StoredDeployment {
  const deployment = deploymentById(id);
  if (!deployment) throw new DeploymentError("No such deployment");
  getDb()
    .prepare(
      "UPDATE strategy_deployments SET enabled = ?, last_error = NULL, updated_at = ? WHERE id = ?",
    )
    .run(enabled ? 1 : 0, Date.now(), id);
  return deploymentById(id)!;
}

export function recordDeploymentRun(id: string, error?: string | null): void {
  const now = Date.now();
  getDb()
    .prepare(
      "UPDATE strategy_deployments SET last_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
    )
    .run(now, error ?? null, now, id);
}

/** How many hedges this deployment still has to manage. */
export function openPositionCount(id: string): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS c FROM strategy_positions WHERE deployment_id = ? " +
        "AND status IN ('queued','opening','open','closing')",
    )
    .get(id) as { c?: unknown } | undefined;
  return rowNum(row?.c, 0);
}

/**
 * Removes a deployment. Refused while it holds a hedge.
 *
 * Deleting one with open exposure would leave real positions with no engine
 * watching their exit rules — the position would sit there until someone noticed.
 * Switching the deployment off and closing its hedges first is the honest order.
 */
export function deleteDeployment(id: string): void {
  const deployment = deploymentById(id);
  if (!deployment) throw new DeploymentError("No such deployment");
  const open = openPositionCount(id);
  if (open > 0) {
    throw new DeploymentError(
      `“${deployment.label}” still has ${open} open ${open === 1 ? "hedge" : "hedges"}. ` +
        `Switch it off and close them first — deleting now would leave them unmanaged.`,
    );
  }
  // Settled history keeps its deployment_id: the rows are the record of what this
  // deployment did, and a foreign key would have deleted them with it.
  inTransaction((db) => {
    db.prepare("DELETE FROM leg_reservations WHERE deployment_id = ?").run(id);
    db.prepare("DELETE FROM strategy_deployments WHERE id = ?").run(id);
  });
}

/** Label lookup for logs and alerts, falling back to the id when it is gone. */
export function deploymentLabel(id: string | null | undefined): string {
  if (!id) return "unassigned";
  return deploymentById(id)?.label ?? id;
}
