import type { RebalanceAutomationStatus } from "@/lib/types";
import {
  getRebalanceConfig,
  recordRebalanceRun,
  rebalanceRunStats,
} from "@/lib/db/rebalance";
import { actionableSuggestions, rebalanceSuggestions } from "@/lib/rebalance/engine";
import { exchangeBalances, syncTransferHistory } from "@/lib/rebalance/wallets";
import { executeTransfer } from "@/lib/rebalance/transfers";

/**
 * Automation runtime.
 *
 * This can send real, irreversible withdrawals with nobody watching, so it has
 * two independent locks:
 *
 *   1. `enabled` in the stored config — the UI toggle.
 *   2. `REBALANCE_AUTOMATION=true` in the server environment — the arm.
 *
 * Both are required. The reason for the second is that a single mis-click in the
 * browser should not be sufficient to start moving money; arming requires
 * editing the environment and restarting, which is a deliberate act.
 *
 * When not armed the loop still evaluates and logs what it *would* have done, so
 * the configuration can be tuned safely before anything is enabled.
 */

const EVALUATE_INTERVAL_MS = 60_000;
const HISTORY_SYNC_INTERVAL_MS = 5 * 60_000;

/** The env arm. Absent or anything other than "true" means not armed. */
export function automationArmed(): boolean {
  return process.env.REBALANCE_AUTOMATION?.trim().toLowerCase() === "true";
}

class RebalanceRuntime {
  private evaluateTimer: NodeJS.Timeout | null = null;
  private historyTimer: NodeJS.Timeout | null = null;
  private started = false;
  private running = false;
  /**
   * When the loop last evaluated, held in memory rather than read back from the
   * run log.
   *
   * The log is no longer written for a cycle that stopped at the locks — that row
   * said the same thing every minute forever — so the log's newest timestamp is no
   * longer the same question as "when did the loop last run". This is, and it falls
   * back to the log across a restart.
   */
  private lastEvaluatedAt: number | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    // Both loops are fire-and-forget; a failure is logged as a run, not thrown.
    this.evaluateTimer = setInterval(() => void this.evaluate(), EVALUATE_INTERVAL_MS);
    this.historyTimer = setInterval(() => void this.syncHistory(), HISTORY_SYNC_INTERVAL_MS);
    void this.syncHistory();
  }

  status(): RebalanceAutomationStatus {
    const config = getRebalanceConfig();
    const stats = rebalanceRunStats();
    const armed = automationArmed();
    // A live lock is more current than the newest log row, and it is the reason
    // the loop is doing nothing right now — which is what the panel is asking.
    const lock = this.lockReason(config);
    return {
      enabled: config.enabled,
      armed,
      active: config.enabled && armed,
      transfersToday: stats.transfersToday,
      lastRunAt: this.lastEvaluatedAt ?? stats.lastRunAt,
      lastTransferAt: stats.lastTransferAt,
      lastSkippedReason: lock ?? stats.lastSkippedReason,
    };
  }

  /**
   * One evaluation cycle.
   *
   * `manual` distinguishes the operator pressing "evaluate now" from the scheduled
   * loop, and the difference is deliberate. A manual run always does the full
   * work — reading every venue's wallet and pricing every suggestion — because
   * somebody is watching and asked to see what would happen. The scheduled loop
   * checks the locks *first* and returns without touching a venue when it could not
   * act anyway: with the arm unset, which is the documented default, it would
   * otherwise fan out a wallet request to every credentialed venue every minute,
   * forever, only to discard the answer.
   */
  async evaluate(
    options: { manual?: boolean } = {},
  ): Promise<{ evaluated: number; executed: number; reason: string | null }> {
    if (this.running) return { evaluated: 0, executed: 0, reason: "already running" };
    this.running = true;
    this.lastEvaluatedAt = Date.now();
    try {
      const config = getRebalanceConfig();

      // The two locks, checked before any network call. `actionableCount` is
      // unknown at this point, so these are only the reasons that do not depend on
      // it — the rest are checked below, after the venues have been read.
      if (!options.manual) {
        const lock = this.lockReason(config);
        if (lock !== null) {
          // Deliberately not recorded. This branch fires every 60 seconds for as
          // long as the arm is unset, and a run log where every row says "nothing
          // was sent because nothing could be" is a table that grows by about
          // 1,400 rows a day and answers no question. `status()` still reports the
          // reason, read live from the config and the environment.
          return { evaluated: 0, executed: 0, reason: lock };
        }
      }

      const balances = await exchangeBalances();
      const suggestions = rebalanceSuggestions(balances, config);
      const actionable = actionableSuggestions(suggestions, balances, config);

      const skip = this.skipReason(config, actionable.length);
      if (skip !== null) {
        recordRebalanceRun({
          evaluated: actionable.length,
          executed: 0,
          skippedReason: skip,
        });
        return { evaluated: actionable.length, executed: 0, reason: skip };
      }

      // One transfer per cycle. Sending several at once would multiply the cost
      // of a mistake and makes the daily cap harder to reason about.
      const target = actionable[0];
      try {
        const record = await executeTransfer({
          from: target.from,
          to: target.to,
          token: target.token,
          network: config.preferredNetwork[target.token],
          amount: target.amount,
          auto: true,
        });
        recordRebalanceRun({
          evaluated: actionable.length,
          executed: 1,
          transferId: record.id,
          detail: target.reason,
        });
        return { evaluated: actionable.length, executed: 1, reason: null };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        recordRebalanceRun({
          evaluated: actionable.length,
          executed: 0,
          skippedReason: "execution failed",
          detail,
        });
        return { evaluated: actionable.length, executed: 0, reason: detail };
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      recordRebalanceRun({ evaluated: 0, executed: 0, skippedReason: "evaluation failed", detail });
      return { evaluated: 0, executed: 0, reason: detail };
    } finally {
      this.running = false;
    }
  }

  /**
   * The reasons that hold whatever the venues say, so they can be checked before
   * any venue is contacted. Kept separate from `skipReason` rather than folded into
   * it because these are the two locks, and a reader should be able to see that the
   * scheduled loop cannot reach the network without passing both.
   */
  private lockReason(config: ReturnType<typeof getRebalanceConfig>): string | null {
    if (!automationArmed()) {
      return "REBALANCE_AUTOMATION is not set on the server, so nothing is sent";
    }
    if (!config.enabled) return "automation is disabled in settings";
    return null;
  }

  /** Every reason not to act, checked server-side rather than in the browser. */
  private skipReason(
    config: ReturnType<typeof getRebalanceConfig>,
    actionableCount: number,
  ): string | null {
    const lock = this.lockReason(config);
    if (lock !== null) return lock;
    if (actionableCount === 0) return "no suggestion passes the guard rails";

    const stats = rebalanceRunStats();
    if (stats.transfersToday >= config.maxTransfersPerDay) {
      return `daily cap of ${config.maxTransfersPerDay} automated transfers reached`;
    }
    if (stats.lastTransferAt !== null) {
      const elapsedMin = (Date.now() - stats.lastTransferAt) / 60_000;
      if (elapsedMin < config.cooldownMinutes) {
        return `cooldown active, ${Math.ceil(config.cooldownMinutes - elapsedMin)} min remaining`;
      }
    }
    return null;
  }

  private async syncHistory(): Promise<void> {
    try {
      await syncTransferHistory();
    } catch {
      // History is a convenience; a failed sync must not affect anything else.
    }
  }

  stop(): void {
    if (this.evaluateTimer) clearInterval(this.evaluateTimer);
    if (this.historyTimer) clearInterval(this.historyTimer);
    this.evaluateTimer = null;
    this.historyTimer = null;
    this.started = false;
  }
}

// Survive dev-server hot reloads so a recompile does not leave two loops running,
// which would double the effective transfer rate.
const globalRef = globalThis as typeof globalThis & {
  __frwRebalanceRuntime?: RebalanceRuntime;
};

export function getRebalanceRuntime(): RebalanceRuntime {
  if (!globalRef.__frwRebalanceRuntime) {
    globalRef.__frwRebalanceRuntime = new RebalanceRuntime();
  }
  const runtime = globalRef.__frwRebalanceRuntime;
  runtime.start();
  return runtime;
}
