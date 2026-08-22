import type {
  AccountType,
  ExposureState,
  FundingBridgeConfig,
  FundingYieldConfig,
  PerpBridgeConfig,
  StrategyCandidate,
  StrategyConfig,
  StrategyId,
  StrategyListItem,
  StrategyPosition,
  StrategyRunState,
  StrategySnapshot,
} from "@/lib/types";
import { STRATEGY_META } from "@/lib/types";
import { getMarketRuntime } from "@/lib/market/runtime";
import {
  accountActivePositions,
  activePositions,
  appendStrategyLog,
  committedNotional,
  positionHistory,
  queuePosition,
  realizedPnlFor,
  updatePosition,
  type QueueRejection,
} from "@/lib/db/strategy";
import {
  allDeployments,
  deploymentById,
  deploymentLabel,
  deployments,
  recordDeploymentRun,
  type StoredDeployment,
} from "@/lib/db/deployments";
import { reconcileReservations } from "@/lib/db/reservations";
import { maxExposureNotional } from "@/lib/db/settings";
import { notionalPerLeg } from "@/lib/strategy/config";
import { perpBridgeNotional } from "@/lib/strategy/perpbridge-config";
import { fundingBridgeNotional } from "@/lib/strategy/fundingbridge-config";
import { fundingYieldNotional } from "@/lib/strategy/fundingyield-config";
import { maxRoundTripFeePct } from "@/lib/db/fees";
import { sweepFunding } from "@/lib/strategy/funding";
import { paperFundingByHedge } from "@/lib/db/funding";
import { paperPositions } from "@/lib/db/paper";
import { livePositions } from "@/lib/db/live";
import { markPriceMap } from "@/lib/market/marks";
import { evaluate, type StrategyAction } from "@/lib/strategy/engine";
import { evaluateGaps, type PerpBridgeAction } from "@/lib/strategy/perpbridge";
import {
  evaluateTargets,
  type FundingBridgeAction,
  type HeldLegs,
} from "@/lib/strategy/fundingbridge";
import { evaluateYields, type FundingYieldAction } from "@/lib/strategy/fundingyield";
import { ExecutionFailed, closeHedge, legQuotes, openHedge } from "@/lib/strategy/executor";
import { notifyStrategyEvent } from "@/lib/notify/dispatch";
import { exchangeName } from "@/lib/utils";

/**
 * Automation runtime: one loop, every deployment, two accounts.
 *
 * A strategy is a blueprint; a deployment is one running instance of it with its own
 * label, venues and thresholds. Several deployments of the same strategy run side by
 * side, and each is ticked independently — the loop iterates deployments, not
 * strategies.
 *
 * Paper runs on the stored toggle alone, since it risks nothing. Live needs the
 * toggle *and* AUTO_TRADING=true in the server environment: sending real orders
 * unattended should not be one mis-click away, so arming it means editing the
 * environment and restarting. That arm stays global rather than per-deployment,
 * because weakening the one lock that protects every deployment would defeat it.
 *
 * Unarmed, the live engines still evaluate and log every decision they would have
 * taken. That is the point — a configuration can be judged against real market data
 * before anything is sent.
 *
 * Deployments compete for venue legs rather than running in isolation. An exchange
 * nets positions per (coin, side), so two deployments long BTC on Bybit would share
 * one exchange position. The first to claim a leg holds it; the loser logs which
 * deployment beat it. Iteration follows creation order, so that outcome is
 * deterministic rather than dependent on map ordering.
 */

const TICK_MS = 5_000;

/**
 * How often a blind position is re-reported. The loop runs every 5 seconds and a
 * coin can stay out of the watch set for hours, so logging each cycle would bury
 * everything else — but staying silent hides that exit rules are not running.
 */
const BLIND_LOG_INTERVAL_MS = 5 * 60_000;

/** How often stale leg reservations are swept. */
const RECONCILE_INTERVAL_MS = 60_000;

/** The env arm for live trading. Paper never needs it. */
export function autoTradingArmed(): boolean {
  return process.env.AUTO_TRADING?.trim().toLowerCase() === "true";
}

function runState(deployment: StoredDeployment): StrategyRunState {
  const armed = deployment.accountType === "paper" ? true : autoTradingArmed();
  return {
    deploymentId: deployment.id,
    strategy: deployment.strategy,
    accountType: deployment.accountType,
    label: deployment.label,
    enabled: deployment.enabled,
    armed,
    active: deployment.enabled && armed,
    lastRunAt: deployment.lastRunAt,
    lastError: deployment.lastError,
  };
}

/** Notional per leg for whichever config shape this strategy stores. */
function notionalFor(
  strategy: StrategyId,
  config: StrategyConfig | PerpBridgeConfig | FundingBridgeConfig | FundingYieldConfig,
): number {
  switch (strategy) {
    case "perpbridge":
      return perpBridgeNotional(config as PerpBridgeConfig);
    case "fundingbridge":
      return fundingBridgeNotional(config as FundingBridgeConfig);
    case "fundingyield":
      return fundingYieldNotional(config as FundingYieldConfig);
    default:
      return notionalPerLeg(config as StrategyConfig);
  }
}

/** Cycle outcome, shared by every deployment. */
export interface TickResult {
  actions: number;
  reason: string | null;
}

class StrategyRuntime {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  /** Guards against a cycle overlapping itself, per deployment. */
  private readonly running = new Set<string>();
  /** Latest candidates per deployment, so the UI can show them. */
  private readonly lastCandidates = new Map<string, StrategyCandidate[]>();
  /** Last time each blind position was logged. */
  private readonly blindLoggedAt = new Map<string, number>();
  private lastReconcileAt = 0;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => {
      // Funding is account-level: charged on whatever is open, whichever deployment
      // opened it. Settled once per loop rather than inside a deployment tick.
      const now = Date.now();
      this.settleFunding(now);

      // Sweep reservations whose position is gone. The main release path runs when a
      // hedge settles; this catches a process that died in between, which would
      // otherwise block that venue leg forever.
      if (now - this.lastReconcileAt > RECONCILE_INTERVAL_MS) {
        this.lastReconcileAt = now;
        try {
          reconcileReservations();
        } catch {
          // A failed sweep must not stop the cycle.
        }
      }

      for (const deployment of allDeployments()) {
        void this.tick(deployment.id);
      }
    }, TICK_MS);
  }

  snapshot(deploymentId: string): StrategySnapshot | null {
    const deployment = deploymentById(deploymentId);
    if (!deployment) return null;
    return {
      deploymentId: deployment.id,
      strategy: deployment.strategy,
      label: deployment.label,
      run: runState(deployment),
      config: deployment.config,
      positions: activePositions(deployment.id),
      history: positionHistory(deployment.id, 30),
      candidates: this.lastCandidates.get(deployment.id) ?? [],
      updatedAt: Date.now(),
    };
  }

  /** Summary of every deployment on one account, for the list view. */
  list(accountType: AccountType): StrategyListItem[] {
    return deployments(accountType).map((deployment) => {
      const positions = activePositions(deployment.id);
      const candidates = this.lastCandidates.get(deployment.id) ?? [];
      return {
        deploymentId: deployment.id,
        strategy: deployment.strategy,
        label: deployment.label,
        strategyName: STRATEGY_META[deployment.strategy].name,
        tagline: STRATEGY_META[deployment.strategy].tagline,
        run: runState(deployment),
        openPositions: positions.length,
        maxPositions: deployment.config.maxPositions,
        actionable: candidates.filter((c) => !c.blockedReason).length,
        realizedPnl: realizedPnlFor(deployment.id),
        notionalPerLeg: notionalFor(deployment.strategy, deployment.config),
        venues: deployment.config.venues,
      };
    });
  }

  /**
   * Account-wide exposure and its ceiling.
   *
   * Only becomes a real concern once several deployments run at once, which is
   * exactly when it appears: nothing counted total committed notional when one
   * strategy could only have one configuration.
   */
  exposure(accountType: AccountType): ExposureState {
    const list = deployments(accountType);
    return {
      accountType,
      committedNotional: committedNotional(accountType),
      maxNotional: maxExposureNotional(accountType),
      openPositions: accountActivePositions(accountType).length,
      activeDeployments: list.filter((d) => d.enabled).length,
    };
  }

  /**
   * Headroom left under the account ceiling, or null when there is no ceiling.
   *
   * Checked before queueing rather than after: a hedge that breaches the limit and
   * then has to be unwound pays four taker fees for nothing.
   */
  private exposureHeadroom(accountType: AccountType): number | null {
    const max = maxExposureNotional(accountType);
    if (max <= 0) return null;
    return Math.max(0, max - committedNotional(accountType));
  }

  /**
   * One evaluation for one deployment. Exposed so a manual "run now" hits exactly
   * the same code path, guard rails included.
   */
  async tick(deploymentId: string): Promise<TickResult> {
    if (this.running.has(deploymentId)) return { actions: 0, reason: "already running" };
    const deployment = deploymentById(deploymentId);
    if (!deployment) return { actions: 0, reason: "deployment no longer exists" };

    this.running.add(deploymentId);
    try {
      switch (deployment.strategy) {
        case "perpbridge":
          return await this.tickPerpBridge(deployment);
        case "fundingbridge":
          return await this.tickFundingBridge(deployment);
        case "fundingyield":
          return await this.tickFundingYield(deployment);
        default:
          return await this.tickFundingSync(deployment);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      recordDeploymentRun(deploymentId, detail);
      this.log(deployment, "ERROR", `Cycle failed: ${detail}`);
      return { actions: 0, reason: detail };
    } finally {
      this.running.delete(deploymentId);
    }
  }

  /**
   * Writes a log line attributed to the deployment.
   *
   * The label is prefixed into the message rather than stored in its own column:
   * `strategy_logs` is filtered by strategy channel, and adding a deployment
   * dimension to that filter would fragment the log view for no gain. Naming the
   * deployment in the text keeps one readable stream.
   */
  private log(
    deployment: StoredDeployment,
    level: "INFO" | "WARN" | "ERROR" | "EXEC",
    message: string,
    coin?: string | null,
  ): void {
    appendStrategyLog({
      strategy: deployment.strategy,
      accountType: deployment.accountType,
      level,
      coin: coin ?? null,
      message: `[${deployment.label}] ${message}`,
    });
  }

  /** Explains a refused queue attempt in terms of who holds the leg. */
  private logRejection(
    deployment: StoredDeployment,
    coin: string,
    rejection: QueueRejection,
  ): void {
    if (rejection.kind === "leg-taken") {
      const { claim, deploymentId, positionId } = rejection.conflict;
      const holder = deploymentId === deployment.id ? "this deployment" : deploymentLabel(deploymentId);
      this.log(
        deployment,
        "INFO",
        `Skipped ${coin}: the ${claim.side} leg on ${exchangeName(claim.exchange)} is held by ` +
          `${holder} (${positionId}). A venue nets one position per coin and side, so both cannot hold it.`,
        coin,
      );
      return;
    }
    this.log(deployment, "WARN", `Could not queue ${coin}: ${rejection.message}`, coin);
  }

  // ─── FundingSync ──────────────────────────────────────────────────────────

  private async tickFundingSync(deployment: StoredDeployment): Promise<TickResult> {
    const state = runState(deployment);
    const config = deployment.config as StrategyConfig;
    const positions = activePositions(deployment.id);
    const snapshot = getMarketRuntime().snapshot();
    const now = Date.now();

    const { actions, candidates, blind } = evaluate({
      snapshot,
      config,
      positions,
      now,
      // Worst-case round trip across the configured venues. A per-pair figure
      // would be tighter, but the profit gate has to hold for whichever pair the
      // engine picks, and a target that only clears the cheap pairs loses money on
      // the rest.
      feeCostPct: maxRoundTripFeePct(config.venues),
    });
    this.lastCandidates.set(deployment.id, candidates);
    this.logBlind(deployment, blind, now);

    if (!state.enabled) {
      recordDeploymentRun(deployment.id);
      return { actions: 0, reason: "deployment is switched off" };
    }
    if (!state.armed) {
      // Log what would have happened, then stop. This is the whole value of
      // running unarmed.
      this.logFundingSyncIntent(deployment, actions);
      recordDeploymentRun(deployment.id);
      return {
        actions: 0,
        reason: "AUTO_TRADING is not set on the server, so no live order is sent",
      };
    }

    let applied = 0;
    for (const action of actions) {
      const ok = await this.applyFundingSync(deployment, config, snapshot, action);
      if (ok) applied += 1;
    }
    recordDeploymentRun(deployment.id);
    return { actions: applied, reason: null };
  }

  // ─── PerpBridge ───────────────────────────────────────────────────────────

  private async tickPerpBridge(deployment: StoredDeployment): Promise<TickResult> {
    const state = runState(deployment);
    const config = deployment.config as PerpBridgeConfig;
    const positions = activePositions(deployment.id);
    const snapshot = getMarketRuntime().snapshot();
    const now = Date.now();

    const { actions, candidates, blind } = evaluateGaps({
      snapshot,
      config,
      positions,
      now,
      feeCostPct: maxRoundTripFeePct(config.venues),
    });
    this.lastCandidates.set(deployment.id, candidates);
    this.logBlind(deployment, blind, now);

    if (!state.enabled) {
      recordDeploymentRun(deployment.id);
      return { actions: 0, reason: "deployment is switched off" };
    }
    if (!state.armed) {
      for (const action of actions) {
        this.log(
          deployment,
          "INFO",
          action.kind === "open"
            ? `Would open ${action.candidate.coin} at a ${action.spread.toFixed(4)}% gap — not sent, AUTO_TRADING is not set`
            : `Would close ${action.position.coin}: ${action.reason} — not sent`,
          action.kind === "open" ? action.candidate.coin : action.position.coin,
        );
      }
      recordDeploymentRun(deployment.id);
      return {
        actions: 0,
        reason: "AUTO_TRADING is not set on the server, so no live order is sent",
      };
    }

    let applied = 0;
    for (const action of actions) {
      const ok = await this.applyPerpBridge(deployment, config, snapshot, action);
      if (ok) applied += 1;
    }
    recordDeploymentRun(deployment.id);
    return { actions: applied, reason: null };
  }

  // ─── FundingBridge ────────────────────────────────────────────────────────

  private async tickFundingBridge(deployment: StoredDeployment): Promise<TickResult> {
    const state = runState(deployment);
    const accountType = deployment.accountType;
    const config = deployment.config as FundingBridgeConfig;
    const positions = activePositions(deployment.id);
    const snapshot = getMarketRuntime().snapshot();
    const now = Date.now();

    const { actions, candidates, blind } = evaluateTargets({
      snapshot,
      config,
      positions,
      now,
      feeCostPct: maxRoundTripFeePct(config.venues),
      // Paper keeps its own funding ledger, so the exit estimate can use real
      // numbers. Live has none — the venue folds funding into its balance — and the
      // engine pro-rates instead, flagging the figure as an estimate.
      fundingByHedge: accountType === "paper" ? paperFundingByHedge().byHedge : undefined,
      heldLegs: this.heldLegs(accountType, positions),
    });
    this.lastCandidates.set(deployment.id, candidates);
    this.logBlind(deployment, blind, now);

    if (!state.enabled) {
      recordDeploymentRun(deployment.id);
      return { actions: 0, reason: "deployment is switched off" };
    }
    if (!state.armed) {
      this.logFundingBridgeIntent(deployment, actions);
      recordDeploymentRun(deployment.id);
      return {
        actions: 0,
        reason: "AUTO_TRADING is not set on the server, so no live order is sent",
      };
    }

    let applied = 0;
    for (const action of actions) {
      const ok = await this.applyFundingBridge(deployment, config, snapshot, action);
      if (ok) applied += 1;
    }
    recordDeploymentRun(deployment.id);
    return { actions: applied, reason: null };
  }

  // ─── FundingYield ─────────────────────────────────────────────────────────

  private async tickFundingYield(deployment: StoredDeployment): Promise<TickResult> {
    const state = runState(deployment);
    const accountType = deployment.accountType;
    const config = deployment.config as FundingYieldConfig;
    const positions = activePositions(deployment.id);
    const snapshot = getMarketRuntime().snapshot();
    const now = Date.now();

    const { actions, candidates, blind } = evaluateYields({
      snapshot,
      config,
      positions,
      now,
      feeCostPct: maxRoundTripFeePct(config.venues),
      // The funding ledger matters more to this strategy than to any other: its profit
      // exit reads collected funding directly. Paper has real numbers; live has none, and
      // the engine pro-rates and flags the figure rather than assuming zero income.
      fundingByHedge: accountType === "paper" ? paperFundingByHedge().byHedge : undefined,
      heldLegs: this.heldLegs(accountType, positions),
    });
    this.lastCandidates.set(deployment.id, candidates);
    this.logBlind(deployment, blind, now);

    // Collected funding is mirrored onto the position rows on every cycle, armed or not.
    // It is a record of what happened rather than a decision, and a position whose
    // funding is only written when the engine is armed would show nothing on an unarmed
    // live account — exactly where the operator is trying to judge the strategy.
    this.recordYieldFunding(positions, accountType);

    if (!state.enabled) {
      recordDeploymentRun(deployment.id);
      return { actions: 0, reason: "deployment is switched off" };
    }
    if (!state.armed) {
      this.logFundingYieldIntent(deployment, actions);
      recordDeploymentRun(deployment.id);
      return {
        actions: 0,
        reason: "AUTO_TRADING is not set on the server, so no live order is sent",
      };
    }

    let applied = 0;
    for (const action of actions) {
      const ok = await this.applyFundingYield(deployment, config, snapshot, action);
      if (ok) applied += 1;
    }
    recordDeploymentRun(deployment.id);
    return { actions: applied, reason: null };
  }

  /**
   * Mirrors the paper funding ledger onto the position rows.
   *
   * Live accounts are skipped rather than written with an estimate: the column is what
   * was actually collected, and storing a pro-rated guess there would make an estimate
   * indistinguishable from a measurement later.
   */
  private recordYieldFunding(positions: StrategyPosition[], accountType: AccountType): void {
    if (accountType !== "paper") return;
    const ledger = paperFundingByHedge().byHedge;
    for (const position of positions) {
      if (position.status !== "open") continue;
      const collected = ledger[position.id];
      if (collected === undefined) continue;
      if (position.fundingCollected === collected) continue;
      updatePosition(position.id, { fundingCollected: collected });
    }
  }

  /**
   * Sizes actually held on each leg of every open position, keyed by hedge id.   *
   * This is what makes the hedge-break guard possible: the engine's own record says
   * what the size should be, and this says what the venue reports. Legs are matched by
   * (exchange, coin, side) because that is how both account tables are keyed.
   *
   * A position with no matching row contributes zeroes rather than being omitted —
   * both legs gone is a drift of 0, which is correct: there is nothing left to be
   * unhedged. Omitting it would be read as "no data" and skip the check.
   */
  private heldLegs(
    accountType: AccountType,
    positions: StrategyPosition[],
  ): Record<string, HeldLegs> {
    if (positions.length === 0) return {};
    const open =
      accountType === "live" ? livePositions() : paperPositions(markPriceMap());
    const out: Record<string, HeldLegs> = {};
    for (const position of positions) {
      if (position.status !== "open") continue;
      const long = open.find(
        (p) =>
          p.exchange === position.longExchange && p.coin === position.coin && p.side === "long",
      );
      const short = open.find(
        (p) =>
          p.exchange === position.shortExchange && p.coin === position.coin && p.side === "short",
      );
      out[position.id] = { longSize: long?.size ?? 0, shortSize: short?.size ?? 0 };
    }
    return out;
  }

  // ─── Shared plumbing ──────────────────────────────────────────────────────

  /**
   * Credits funding on open paper positions and logs each payment.
   *
   * Logged under `system` rather than a strategy: the venue charges funding on
   * whatever is open, including manual positions, so attributing it to an engine
   * would be wrong. Failures are swallowed deliberately — a funding sweep that
   * throws must not stop the cycle from managing positions.
   */
  private settleFunding(now: number): void {
    try {
      const { credits } = sweepFunding(getMarketRuntime().snapshot(), now);
      for (const credit of credits) {
        appendStrategyLog({
          strategy: "system",
          accountType: "paper",
          level: "INFO",
          coin: credit.coin,
          message:
            `FUNDING ${credit.amount >= 0 ? "received" : "paid"} ` +
            `$${Math.abs(credit.amount).toFixed(4)} on ${credit.side} ${credit.coin} ` +
            `at ${exchangeName(credit.exchange)} (rate ${credit.ratePct}%, notional $${credit.notional.toFixed(2)})`,
        });
      }
    } catch (err) {
      appendStrategyLog({
        strategy: "system",
        accountType: "paper",
        level: "ERROR",
        message: `Funding sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Warns about open positions an engine cannot evaluate. Rate-limited per
   * position, and logged before the enabled/armed checks so a blind position is
   * reported even on an unarmed live account — exactly the situation where nobody
   * is watching the screen.
   */
  private logBlind(
    deployment: StoredDeployment,
    blind: { position: StrategyPosition; reason: string }[],
    now: number,
  ): void {
    const seen = new Set<string>();
    const prefix = `${deployment.id}:`;
    for (const entry of blind) {
      const key = `${prefix}${entry.position.id}`;
      seen.add(key);
      const last = this.blindLoggedAt.get(key) ?? 0;
      if (now - last < BLIND_LOG_INTERVAL_MS) continue;
      this.blindLoggedAt.set(key, now);
      this.log(
        deployment,
        "WARN",
        `Cannot evaluate open ${entry.position.coin}: ${entry.reason}`,
        entry.position.coin,
      );
    }
    // Forget positions that can be seen again, so recovery re-arms the warning.
    for (const key of [...this.blindLoggedAt.keys()]) {
      if (key.startsWith(prefix) && !seen.has(key)) this.blindLoggedAt.delete(key);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  // ─── FundingSync actions ──────────────────────────────────────────────────

  /** Writes what an armed engine would have done, without doing it. */
  private logFundingSyncIntent(
    deployment: StoredDeployment,
    actions: StrategyAction[],
  ): void {
    for (const action of actions) {
      switch (action.kind) {
        case "enter":
          this.log(
            deployment,
            "INFO",
            `Would queue ${action.candidate.coin}: long ${exchangeName(action.candidate.longExchange)}, ` +
              `short ${exchangeName(action.candidate.shortExchange)}, diff ${(action.candidate.diffFr ?? 0).toFixed(4)}% ` +
              `— not sent, AUTO_TRADING is not set`,
            action.candidate.coin,
          );
          break;
        case "open":
          this.log(
            deployment,
            "INFO",
            `Would open ${action.position.coin} at spread ${action.spread.toFixed(4)}% — not sent`,
            action.position.coin,
          );
          break;
        case "close":
          this.log(
            deployment,
            "INFO",
            `Would close ${action.position.coin}: ${action.reason} — not sent`,
            action.position.coin,
          );
          break;
        case "cancel":
          this.log(
            deployment,
            "INFO",
            `Would cancel ${action.position.coin}: ${action.reason}`,
            action.position.coin,
          );
          break;
        case "harvested":
          this.log(
            deployment,
            "INFO",
            `Would mark ${action.position.coin} as funding-collected and hold for a better exit`,
            action.position.coin,
          );
          break;
        case "exiting":
          this.log(
            deployment,
            "INFO",
            `Would start leaving ${action.position.coin} (${action.reason}) and wait for a fee-covering spread`,
            action.position.coin,
          );
          break;
      }
    }
  }

  private async applyFundingSync(
    deployment: StoredDeployment,
    config: StrategyConfig,
    snapshot: ReturnType<ReturnType<typeof getMarketRuntime>["snapshot"]>,
    action: StrategyAction,
  ): Promise<boolean> {
    switch (action.kind) {
      case "enter":
        return this.queueFundingSync(deployment, config, action.candidate);
      case "open":
        return this.open(deployment, snapshot, action.position, action.spread);
      case "cancel":
        updatePosition(action.position.id, {
          status: "cancelled",
          exitReason: action.reason,
          closedAt: Date.now(),
        });
        this.log(
          deployment,
          "INFO",
          `Cancelled queued ${action.position.coin}: ${action.reason}`,
          action.position.coin,
        );
        return true;
      case "close":
        return this.close(deployment, snapshot, action.position, action.reason);
      case "harvested":
        // Funding is collected; keep the position and wait for a decent exit.
        updatePosition(action.position.id, { harvestedAt: action.at });
        this.log(
          deployment,
          "INFO",
          `${action.position.coin} funding collected — holding for a better exit spread ` +
            `instead of closing now (deadline: the next settlement)`,
          action.position.coin,
        );
        return true;
      case "exiting":
        // On the way out, but not at any price: wait for a spread that covers fees.
        updatePosition(action.position.id, {
          exitingSince: action.at,
          exitingReason: action.reason,
        });
        this.log(
          deployment,
          "INFO",
          `${action.position.coin} ${action.reason} — leaving, but waiting for a spread that ` +
            `covers fees rather than closing into a bad one`,
          action.position.coin,
        );
        return true;
    }
  }

  private queueFundingSync(
    deployment: StoredDeployment,
    config: StrategyConfig,
    candidate: StrategyCandidate,
  ): boolean {
    const notional = notionalPerLeg(config);
    if (!this.withinExposureCeiling(deployment, candidate.coin, notional)) return false;

    const result = queuePosition({
      strategy: "fundingsync",
      deploymentId: deployment.id,
      accountType: deployment.accountType,
      coin: candidate.coin,
      longExchange: candidate.longExchange,
      shortExchange: candidate.shortExchange,
      clockExchange: candidate.clockExchange,
      fundingTime: candidate.fundingTime,
      entryDiffFr: candidate.diffFr,
      entryMode: config.entryMode,
      size: 0,
      leverage: config.leverage,
      notionalPerLeg: notional,
    });
    if (!result.ok) {
      this.logRejection(deployment, candidate.coin, result.rejection);
      return false;
    }

    const settles =
      candidate.clockExchange && candidate.minutesToFunding !== null
        ? `, ${exchangeName(candidate.clockExchange)} settles in ${candidate.minutesToFunding.toFixed(0)}m`
        : "";
    this.log(
      deployment,
      "INFO",
      `Queued ${candidate.coin} (${config.entryMode}): long ${exchangeName(candidate.longExchange)}, ` +
        `short ${exchangeName(candidate.shortExchange)}, diff ${(candidate.diffFr ?? 0).toFixed(4)}%${settles}`,
      candidate.coin,
    );
    return true;
  }

  // ─── PerpBridge actions ───────────────────────────────────────────────────

  private async applyPerpBridge(
    deployment: StoredDeployment,
    config: PerpBridgeConfig,
    snapshot: ReturnType<ReturnType<typeof getMarketRuntime>["snapshot"]>,
    action: PerpBridgeAction,
  ): Promise<boolean> {
    if (action.kind === "close") {
      return this.close(deployment, snapshot, action.position, action.reason);
    }

    const candidate = action.candidate;
    const notional = perpBridgeNotional(config);
    if (!this.withinExposureCeiling(deployment, candidate.coin, notional)) return false;

    // No queue: a price gap is either wide enough now or it is not, so the row is
    // created already `opening` and filled in the same cycle.
    const result = queuePosition({
      strategy: "perpbridge",
      deploymentId: deployment.id,
      accountType: deployment.accountType,
      coin: candidate.coin,
      longExchange: candidate.longExchange,
      shortExchange: candidate.shortExchange,
      entryMode: "instant",
      size: 0,
      leverage: config.leverage,
      notionalPerLeg: notional,
      status: "opening",
    });
    if (!result.ok) {
      this.logRejection(deployment, candidate.coin, result.rejection);
      return false;
    }

    this.log(
      deployment,
      "INFO",
      `Opening ${candidate.coin} on a ${action.spread.toFixed(4)}% gap: ` +
        `buy ${exchangeName(candidate.longExchange)}, sell ${exchangeName(candidate.shortExchange)}`,
      candidate.coin,
    );
    return this.open(deployment, snapshot, result.position, action.spread);
  }

  // ─── FundingBridge actions ────────────────────────────────────────────────

  /** Writes what an armed engine would have done, without doing it. */
  private logFundingBridgeIntent(
    deployment: StoredDeployment,
    actions: FundingBridgeAction[],
  ): void {
    for (const action of actions) {
      switch (action.kind) {
        case "lock":
          this.log(
            deployment,
            "INFO",
            `Would lock ${action.candidate.coin}: long ${exchangeName(action.candidate.longExchange)}, ` +
              `short ${exchangeName(action.candidate.shortExchange)}, ` +
              `diff ${(action.candidate.diffFr ?? 0).toFixed(4)}% — not sent, AUTO_TRADING is not set`,
            action.candidate.coin,
          );
          break;
        case "open":
          this.log(
            deployment,
            "INFO",
            `Would enter ${action.position.coin} at a ${action.spread.toFixed(4)}% entry spread — not sent`,
            action.position.coin,
          );
          break;
        case "cancel":
          this.log(
            deployment,
            "INFO",
            `Would drop the locked ${action.position.coin} target: ${action.reason}`,
            action.position.coin,
          );
          break;
        case "settled":
          this.log(
            deployment,
            "INFO",
            `Would mark ${action.position.coin} as settled and start judging the exit on estimated PnL`,
            action.position.coin,
          );
          break;
        case "exiting":
          this.log(
            deployment,
            "INFO",
            `Would start leaving ${action.position.coin} (${action.reason}) and wait for a fee-covering spread`,
            action.position.coin,
          );
          break;
        case "close":
          this.log(
            deployment,
            "INFO",
            `Would close ${action.position.coin}: ${action.reason} — not sent`,
            action.position.coin,
          );
          break;
      }
    }
  }

  private async applyFundingBridge(
    deployment: StoredDeployment,
    config: FundingBridgeConfig,
    snapshot: ReturnType<ReturnType<typeof getMarketRuntime>["snapshot"]>,
    action: FundingBridgeAction,
  ): Promise<boolean> {
    switch (action.kind) {
      case "lock":
        return this.lockFundingBridge(deployment, config, action.candidate);
      case "open":
        return this.open(deployment, snapshot, action.position, action.spread);
      case "cancel":
        updatePosition(action.position.id, {
          status: "cancelled",
          exitReason: action.reason,
          closedAt: Date.now(),
        });
        this.log(
          deployment,
          "INFO",
          `Dropped the locked ${action.position.coin} target: ${action.reason}`,
          action.position.coin,
        );
        return true;
      case "settled":
        // The payment should be in. From here the position is judged on what exiting
        // would realise, bounded by the configured hold limit.
        updatePosition(action.position.id, { harvestedAt: action.at });
        this.log(
          deployment,
          "INFO",
          `${action.position.coin} settlement passed — now closing on estimated PnL rather than ` +
            `on a spread threshold, since the legs settle on different cadences`,
          action.position.coin,
        );
        return true;
      case "exiting":
        updatePosition(action.position.id, {
          exitingSince: action.at,
          exitingReason: action.reason,
        });
        this.log(
          deployment,
          "INFO",
          `${action.position.coin} ${action.reason} — leaving, but waiting for a spread that ` +
            `covers fees rather than closing into a bad one`,
          action.position.coin,
        );
        return true;
      case "close":
        return this.close(deployment, snapshot, action.position, action.reason);
    }
  }

  /**
   * Reserves a coin and starts watching its price. Written as `queued`, which is what
   * the lock phase is: the decision is made, the entry is not.
   */
  private lockFundingBridge(
    deployment: StoredDeployment,
    config: FundingBridgeConfig,
    candidate: StrategyCandidate,
  ): boolean {
    const notional = fundingBridgeNotional(config);
    if (!this.withinExposureCeiling(deployment, candidate.coin, notional)) return false;

    const result = queuePosition({
      strategy: "fundingbridge",
      deploymentId: deployment.id,
      accountType: deployment.accountType,
      coin: candidate.coin,
      longExchange: candidate.longExchange,
      shortExchange: candidate.shortExchange,
      clockExchange: candidate.clockExchange,
      fundingTime: candidate.fundingTime,
      entryDiffFr: candidate.diffFr,
      // The wait for a cheap entry is the strategy, not an order type, so both legs
      // are sent at market once the spread clears.
      entryMode: "delay",
      size: 0,
      leverage: config.leverage,
      notionalPerLeg: notional,
    });
    if (!result.ok) {
      this.logRejection(deployment, candidate.coin, result.rejection);
      return false;
    }

    const settles =
      candidate.clockExchange && candidate.minutesToFunding !== null
        ? `, ${exchangeName(candidate.clockExchange)} settles in ${candidate.minutesToFunding.toFixed(0)}m`
        : "";
    this.log(
      deployment,
      "INFO",
      `Locked ${candidate.coin}: long ${exchangeName(candidate.longExchange)}, ` +
        `short ${exchangeName(candidate.shortExchange)}, diff ${(candidate.diffFr ?? 0).toFixed(4)}%${settles} ` +
        `— waiting for the entry spread to reach ${config.entrySpread}%`,
      candidate.coin,
    );
    return true;
  }

  // ─── FundingYield actions ─────────────────────────────────────────────────

  /** Writes what an armed engine would have done, without doing it. */
  private logFundingYieldIntent(
    deployment: StoredDeployment,
    actions: FundingYieldAction[],
  ): void {
    for (const action of actions) {
      switch (action.kind) {
        case "open": {
          const p = action.projection;
          this.log(
            deployment,
            "INFO",
            `Would open ${action.candidate.coin}: long ${exchangeName(action.candidate.longExchange)}, ` +
              `short ${exchangeName(action.candidate.shortExchange)}, diff ${(action.candidate.diffFr ?? 0).toFixed(4)}% ` +
              `— projected net $${p.netUsd.toFixed(2)} over ${p.settlements} settlements ` +
              `(funding $${p.fundingUsd.toFixed(2)}, fees −$${p.feeUsd.toFixed(2)}, ` +
              `spread −$${p.spreadCostUsd.toFixed(2)}). Not sent, AUTO_TRADING is not set.`,
            action.candidate.coin,
          );
          break;
        }
        case "close":
          this.log(
            deployment,
            "INFO",
            `Would close ${action.position.coin}: ${action.reason} — not sent`,
            action.position.coin,
          );
          break;
        case "mark":
          // Not logged: a new worst-case mark is bookkeeping, and one line per cycle per
          // position would bury everything else in the log.
          break;
      }
    }
  }

  private async applyFundingYield(
    deployment: StoredDeployment,
    config: FundingYieldConfig,
    snapshot: ReturnType<ReturnType<typeof getMarketRuntime>["snapshot"]>,
    action: FundingYieldAction,
  ): Promise<boolean> {
    switch (action.kind) {
      case "open":
        return this.openFundingYield(deployment, config, snapshot, action);
      case "mark":
        updatePosition(action.position.id, { worstNetUsd: action.worstNetUsd });
        return true;
      case "close":
        return this.close(deployment, snapshot, action.position, action.reason);
    }
  }

  /**
   * Opens a hedge in one step: queue and send in the same cycle.
   *
   * No lock-then-release phase, unlike FundingBridge. The entry test already prices
   * everything it depends on — funding, fees and the round trip's spread cost — at one
   * instant, so there is nothing left to wait for. The row is written `opening` so a
   * crash between the insert and the fill leaves a trace rather than a silent gap.
   */
  private async openFundingYield(
    deployment: StoredDeployment,
    config: FundingYieldConfig,
    snapshot: ReturnType<ReturnType<typeof getMarketRuntime>["snapshot"]>,
    action: Extract<FundingYieldAction, { kind: "open" }>,
  ): Promise<boolean> {
    const { candidate, projection } = action;
    const notional = fundingYieldNotional(config);
    if (!this.withinExposureCeiling(deployment, candidate.coin, notional)) return false;

    const result = queuePosition({
      strategy: "fundingyield",
      deploymentId: deployment.id,
      accountType: deployment.accountType,
      coin: candidate.coin,
      longExchange: candidate.longExchange,
      shortExchange: candidate.shortExchange,
      // No clock leg and no funding time: this strategy is not timed around any single
      // settlement, and a venue here would imply a deadline it does not have.
      clockExchange: null,
      fundingTime: null,
      entryDiffFr: candidate.diffFr,
      entryMode: "instant",
      size: 0,
      leverage: config.leverage,
      notionalPerLeg: notional,
      status: "opening",
    });
    if (!result.ok) {
      this.logRejection(deployment, candidate.coin, result.rejection);
      return false;
    }

    this.log(
      deployment,
      "INFO",
      `Entering ${candidate.coin} on a projected $${projection.netUsd.toFixed(2)} net over ` +
        `${projection.settlements} settlements: funding $${projection.fundingUsd.toFixed(2)}, ` +
        `fees −$${projection.feeUsd.toFixed(2)}, round trip spread −$${projection.spreadCostUsd.toFixed(2)} ` +
        `(${projection.spreadCostPct.toFixed(4)}%). Entry spread ${(candidate.spread ?? 0).toFixed(4)}% is ` +
        `priced rather than vetoed, which is why this coin is tradable here.`,
      candidate.coin,
    );

    return this.open(deployment, snapshot, result.position, candidate.spread ?? 0);
  }

  /**
   * Refuses a new hedge that would push the account past its notional ceiling.
   *
   * Checked before queueing rather than after opening: a hedge that breaches the
   * limit and then has to be unwound pays four taker fees for nothing. The ceiling
   * only starts mattering with several deployments — five at three positions each is
   * fifteen hedges, and before deployments nothing was counting that.
   */
  private withinExposureCeiling(
    deployment: StoredDeployment,
    coin: string,
    notionalPerLegValue: number,
  ): boolean {
    const headroom = this.exposureHeadroom(deployment.accountType);
    if (headroom === null) return true;
    const needed = notionalPerLegValue * 2;
    if (needed <= headroom) return true;
    this.log(
      deployment,
      "WARN",
      `Skipped ${coin}: it needs $${needed.toFixed(0)} of notional but only $${headroom.toFixed(0)} ` +
        `is left under the ${deployment.accountType} account ceiling. Raise the limit in General Setting ` +
        `or close something first.`,
      coin,
    );
    return false;
  }

  // ─── Execution, shared by every strategy ──────────────────────────────────

  private async open(
    deployment: StoredDeployment,
    snapshot: ReturnType<ReturnType<typeof getMarketRuntime>["snapshot"]>,
    position: StrategyPosition,
    spread: number,
  ): Promise<boolean> {
    const quote = legQuotes(
      position.coin,
      position.longExchange,
      position.shortExchange,
      snapshot.rows,
    );
    if (!quote) {
      this.log(
        deployment,
        "WARN",
        `Cannot open ${position.coin}: a leg lost its quote`,
        position.coin,
      );
      return false;
    }

    updatePosition(position.id, { status: "opening" });
    try {
      const result = await openHedge({
        accountType: deployment.accountType,
        coin: position.coin,
        longExchange: position.longExchange,
        shortExchange: position.shortExchange,
        notionalPerLeg: position.notionalPerLeg,
        leverage: position.leverage,
        hedgeId: position.id,
        quote,
      });
      updatePosition(position.id, {
        status: "open",
        entrySpread: spread,
        size: result.size,
        openedAt: Date.now(),
      });
      const detail =
        `OPEN ${position.coin} size ${result.size} — long ${exchangeName(position.longExchange)} @ ` +
        `${result.longFill}, short ${exchangeName(position.shortExchange)} @ ${result.shortFill}, ` +
        `entry spread ${spread.toFixed(4)}%`;
      this.log(deployment, "EXEC", detail, position.coin);
      void notifyStrategyEvent({
        kind: "opened",
        deployment,
        coin: position.coin,
        detail,
      });
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      updatePosition(position.id, { status: "failed", error: detail, closedAt: Date.now() });
      this.log(deployment, "ERROR", `Failed to open ${position.coin}: ${detail}`, position.coin);
      void notifyStrategyEvent({
        kind: "failed",
        deployment,
        coin: position.coin,
        detail: `Failed to open: ${detail}`,
      });
      return false;
    }
  }

  private async close(
    deployment: StoredDeployment,
    snapshot: ReturnType<ReturnType<typeof getMarketRuntime>["snapshot"]>,
    position: StrategyPosition,
    reason: string,
  ): Promise<boolean> {
    const quote = legQuotes(
      position.coin,
      position.longExchange,
      position.shortExchange,
      snapshot.rows,
    );
    updatePosition(position.id, { status: "closing" });
    try {
      const result = await closeHedge(position, quote);
      if (result.failures.length > 0) {
        // Back to `open` when nothing was touched, `closing` when one leg went.
        // The distinction matters: `closing` means the hedge is half-unwound and
        // needs attention, while a refusal that changed nothing is still a healthy
        // hedge waiting for its quote to come back.
        const stillWhole = result.closed === 0;
        updatePosition(position.id, {
          status: stillWhole ? "open" : "closing",
          error: result.failures.join("; "),
        });
        this.log(
          deployment,
          stillWhole ? "WARN" : "ERROR",
          stillWhole
            ? `Refused to close ${position.coin}, position left intact: ${result.failures.join("; ")}`
            : `Partially closed ${position.coin}: ${result.failures.join("; ")}`,
          position.coin,
        );
        if (!stillWhole) {
          // A half-unwound hedge is directional exposure nobody asked for, which is
          // the one strategy outcome worth interrupting someone for.
          void notifyStrategyEvent({
            kind: "failed",
            deployment,
            coin: position.coin,
            detail: `Half-unwound hedge — one leg closed, one did not: ${result.failures.join("; ")}`,
          });
        }
        return false;
      }
      updatePosition(position.id, {
        status: "closed",
        exitReason: reason,
        realizedPnl: result.realizedPnl,
        closedAt: Date.now(),
      });
      const detail =
        `CLOSE ${position.coin}: ${reason}` +
        (result.realizedPnl !== null ? ` · PnL ${result.realizedPnl.toFixed(2)}` : "");
      this.log(deployment, "EXEC", detail, position.coin);
      void notifyStrategyEvent({
        kind: "closed",
        deployment,
        coin: position.coin,
        detail,
        realizedPnl: result.realizedPnl,
      });
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      updatePosition(position.id, { status: "closing", error: detail });
      this.log(deployment, "ERROR", `Failed to close ${position.coin}: ${detail}`, position.coin);
      void notifyStrategyEvent({
        kind: "failed",
        deployment,
        coin: position.coin,
        detail: `Failed to close: ${detail}`,
      });
      return false;
    }
  }
}

// Survive dev-server hot reloads: two loops would double the effective order
// rate, which for a strategy that opens positions is not a cosmetic problem.
const globalRef = globalThis as typeof globalThis & {
  __frwStrategyRuntime?: StrategyRuntime;
};

export function getStrategyRuntime(): StrategyRuntime {
  if (!globalRef.__frwStrategyRuntime) {
    globalRef.__frwStrategyRuntime = new StrategyRuntime();
  }
  const runtime = globalRef.__frwStrategyRuntime;
  runtime.start();
  return runtime;
}

export { ExecutionFailed };
