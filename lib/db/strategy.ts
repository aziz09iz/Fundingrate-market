import { randomUUID } from "node:crypto";
import type {
  AccountType,
  ExchangeId,
  FundingBridgeConfig,
  FundingYieldConfig,
  LogChannel,
  LogEntry,
  LogLevel,
  PerpBridgeConfig,
  StrategyConfig,
  StrategyId,
  StrategyPosition,
  StrategyPositionStatus,
} from "@/lib/types";
import type { ExecutionMode } from "@/lib/types";
import { getDb, inTransaction, rowNum, rowStr } from "@/lib/db/client";
import {
  claimLegs,
  releaseLegs,
  type LegClaim,
  type ReservationConflict,
} from "@/lib/db/reservations";

/**
 * Persistence for the automation strategies.
 *
 * Positions and logs live here rather than in the browser because the engines have
 * to keep running — and keep their decisions auditable — with no tab open.
 *
 * Everything is keyed by `deploymentId`. That replaced `(strategy, accountType)`,
 * which encoded "one configuration per strategy" into every query: several
 * deployments of the same strategy now run side by side, each with its own venues
 * and thresholds. Deployment records themselves live in lib/db/deployments.ts.
 */

const LOG_RETENTION = 2_000;

/** Every strategy's stored configuration shape, narrowed by the caller. */
export type AnyStrategyConfig =
  | StrategyConfig
  | PerpBridgeConfig
  | FundingBridgeConfig
  | FundingYieldConfig;

/**
 * Hedge id prefix per strategy. Kept because a prefix makes an id readable at a
 * glance in a log line, but it is no longer how a leg is traced back to its owner:
 * three FundingBridge deployments all emit `FB-…`, so `lib/hedge-view.ts` looks the
 * row up by id instead.
 */
const ID_PREFIX: Record<StrategyId, string> = {
  fundingsync: "FS",
  perpbridge: "PB",
  fundingbridge: "FB",
  fundingyield: "FY",
};

// ─── Positions ──────────────────────────────────────────────────────────────

function rowToPosition(row: Record<string, unknown>): StrategyPosition {
  return {
    id: rowStr(row.id),
    strategy: rowStr(row.strategy, "fundingsync") as StrategyId,
    deploymentId: rowStr(row.deployment_id, "") || null,
    accountType: rowStr(row.account_type) as AccountType,
    coin: rowStr(row.coin),
    longExchange: rowStr(row.long_exchange) as ExchangeId,
    shortExchange: rowStr(row.short_exchange) as ExchangeId,
    // Null for a strategy with no funding clock, which is why these are not
    // coerced to 0 — a zero timestamp reads as a real one.
    clockExchange: (rowStr(row.clock_exchange, "") || null) as ExchangeId | null,
    fundingTime: row.funding_time === null ? null : rowNum(row.funding_time),
    entryDiffFr: row.entry_diff_fr === null ? null : rowNum(row.entry_diff_fr),
    entrySpread: row.entry_spread === null ? null : rowNum(row.entry_spread),
    harvestedAt: row.harvested_at === null ? null : rowNum(row.harvested_at),
    exitingSince: row.exiting_since === null ? null : rowNum(row.exiting_since),
    exitingReason: rowStr(row.exiting_reason, "") || null,
    // Null is meaningful, not a missing zero: on live the venue reports no per-position
    // funding figure, and reading that as "collected nothing" would trip a stop-loss on
    // a position that is actually ahead.
    fundingCollected: row.funding_collected === null ? null : rowNum(row.funding_collected),
    worstNetUsd: row.worst_net_usd === null ? null : rowNum(row.worst_net_usd),
    size: rowNum(row.size),
    leverage: rowNum(row.leverage, 1),
    notionalPerLeg: rowNum(row.notional_per_leg),
    status: rowStr(row.status) as StrategyPositionStatus,
    entryMode: rowStr(row.entry_mode) as ExecutionMode,
    exitReason: rowStr(row.exit_reason, "") || null,
    realizedPnl: row.realized_pnl === null ? null : rowNum(row.realized_pnl),
    error: rowStr(row.error, "") || null,
    queuedAt: rowNum(row.queued_at),
    openedAt: rowNum(row.opened_at, 0) || null,
    closedAt: rowNum(row.closed_at, 0) || null,
    updatedAt: rowNum(row.updated_at),
  };
}

export interface QueuePositionInput {
  strategy: StrategyId;
  deploymentId: string;
  accountType: AccountType;
  coin: string;
  longExchange: ExchangeId;
  shortExchange: ExchangeId;
  /** Omit for a strategy that does not track funding. */
  clockExchange?: ExchangeId | null;
  fundingTime?: number | null;
  entryDiffFr?: number | null;
  entryMode: ExecutionMode;
  size: number;
  leverage: number;
  notionalPerLeg: number;
  /** Initial status. PerpBridge opens straight away rather than queueing. */
  status?: Extract<StrategyPositionStatus, "queued" | "opening">;
}

/** Why a queue attempt was refused, so the log can name the reason. */
export type QueueRejection =
  | { kind: "leg-taken"; conflict: ReservationConflict }
  | { kind: "error"; message: string };

export type QueueResult =
  | { ok: true; position: StrategyPosition }
  | { ok: false; rejection: QueueRejection };

/**
 * Records the intent to open a hedge, reserving both venue legs in the same
 * transaction.
 *
 * The reservation is the interesting part. A venue nets positions per (coin, side),
 * so two deployments that both go long BTC on Bybit would share one exchange
 * position — and closing either hedge would close part of the other. Claiming the
 * legs atomically with the insert means two deployments racing for the same leg
 * cannot both believe they won.
 *
 * Returns a rejection rather than throwing: losing a race is an ordinary outcome the
 * caller logs and moves on from, not an exception.
 */
export function queuePosition(input: QueuePositionInput): QueueResult {
  const id = `${ID_PREFIX[input.strategy]}-${randomUUID().slice(0, 8)}`;
  const now = Date.now();

  const claims: LegClaim[] = [
    { accountType: input.accountType, exchange: input.longExchange, coin: input.coin, side: "long" },
    {
      accountType: input.accountType,
      exchange: input.shortExchange,
      coin: input.coin,
      side: "short",
    },
  ];

  try {
    const conflict = inTransaction((db) => {
      const clash = claimLegs(db, claims, id, input.deploymentId);
      if (clash) return clash;

      db.prepare(
        "INSERT INTO strategy_positions (id, strategy, deployment_id, account_type, coin, long_exchange, short_exchange, clock_exchange, " +
          "funding_time, entry_diff_fr, size, leverage, notional_per_leg, status, entry_mode, queued_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        input.strategy,
        input.deploymentId,
        input.accountType,
        input.coin,
        input.longExchange,
        input.shortExchange,
        input.clockExchange ?? null,
        input.fundingTime ?? null,
        input.entryDiffFr ?? null,
        input.size,
        input.leverage,
        input.notionalPerLeg,
        input.status ?? "queued",
        input.entryMode,
        now,
        now,
      );
      return null;
    });

    if (conflict) return { ok: false, rejection: { kind: "leg-taken", conflict } };
  } catch (err) {
    return {
      ok: false,
      rejection: { kind: "error", message: err instanceof Error ? err.message : String(err) },
    };
  }

  const position = positionById(id);
  if (!position) {
    return { ok: false, rejection: { kind: "error", message: "position vanished after insert" } };
  }
  return { ok: true, position };
}

export interface PositionUpdate {
  status?: StrategyPositionStatus;
  entrySpread?: number | null;
  size?: number;
  exitReason?: string | null;
  realizedPnl?: number | null;
  error?: string | null;
  openedAt?: number | null;
  closedAt?: number | null;
  harvestedAt?: number | null;
  exitingSince?: number | null;
  exitingReason?: string | null;
  fundingCollected?: number | null;
  /**
   * Lowest mark-to-market seen, in USD. Written with a plain assignment rather than
   * COALESCE like the rest, because a worst case is normally negative and COALESCE has
   * no way to distinguish "leave it alone" from a real value — a −5 would be discarded
   * on the same test that skips a null.
   */
  worstNetUsd?: number | null;
}

export function updatePosition(id: string, update: PositionUpdate): void {
  getDb()
    .prepare(
      "UPDATE strategy_positions SET status = COALESCE(?, status), entry_spread = COALESCE(?, entry_spread), " +
        "size = COALESCE(?, size), exit_reason = COALESCE(?, exit_reason), " +
        "realized_pnl = COALESCE(?, realized_pnl), error = ?, " +
        "opened_at = COALESCE(?, opened_at), closed_at = COALESCE(?, closed_at), " +
        "harvested_at = COALESCE(?, harvested_at), exiting_since = COALESCE(?, exiting_since), " +
        "exiting_reason = COALESCE(?, exiting_reason), " +
        "funding_collected = COALESCE(?, funding_collected), " +
        // Deliberately not COALESCE: see the field's comment. A caller that omits it
        // passes the column's own value back, so the write is a no-op.
        "worst_net_usd = CASE WHEN ? IS NULL THEN worst_net_usd ELSE ? END, " +
        "updated_at = ? WHERE id = ?",
    )
    .run(
      update.status ?? null,
      update.entrySpread ?? null,
      update.size ?? null,
      update.exitReason ?? null,
      update.realizedPnl ?? null,
      update.error ?? null,
      update.openedAt ?? null,
      update.closedAt ?? null,
      update.harvestedAt ?? null,
      update.exitingSince ?? null,
      update.exitingReason ?? null,
      update.fundingCollected ?? null,
      update.worstNetUsd ?? null,
      update.worstNetUsd ?? null,
      Date.now(),
      id,
    );

  // A settled hedge holds nothing, so its legs go back to the pool. Done here
  // rather than at each call site because every terminal status has to release —
  // missing one would block that venue leg until the process restarted.
  if (
    update.status === "closed" ||
    update.status === "cancelled" ||
    update.status === "failed"
  ) {
    releaseLegs(id);
  }
}

export function positionById(id: string): StrategyPosition | null {
  const row = getDb().prepare("SELECT * FROM strategy_positions WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToPosition(row) : null;
}

/** Hedges an engine still has to manage: queued, opening, open or closing. */
export function activePositions(deploymentId: string): StrategyPosition[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM strategy_positions WHERE deployment_id = ? " +
        "AND status IN ('queued','opening','open','closing') ORDER BY queued_at ASC",
    )
    .all(deploymentId) as Record<string, unknown>[];
  return rows.map(rowToPosition);
}

/** Settled hedges, newest first, for the result history. */
export function positionHistory(deploymentId: string, limit = 50): StrategyPosition[] {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = getDb()
    .prepare(
      "SELECT * FROM strategy_positions WHERE deployment_id = ? " +
        "AND status IN ('closed','cancelled','failed') ORDER BY updated_at DESC LIMIT ?",
    )
    .all(deploymentId, capped) as Record<string, unknown>[];
  return rows.map(rowToPosition);
}

/** Realized PnL of every settled hedge for one deployment. */
export function realizedPnlFor(deploymentId: string): number {
  const row = getDb()
    .prepare(
      "SELECT SUM(realized_pnl) AS total FROM strategy_positions WHERE deployment_id = ? AND realized_pnl IS NOT NULL",
    )
    .get(deploymentId) as Record<string, unknown> | undefined;
  return Number(rowNum(row?.total, 0).toFixed(6));
}

/** Every hedge still open on an account, whichever deployment owns it. */
export function accountActivePositions(accountType: AccountType): StrategyPosition[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM strategy_positions WHERE account_type = ? " +
        "AND status IN ('queued','opening','open','closing') ORDER BY queued_at ASC",
    )
    .all(accountType) as Record<string, unknown>[];
  return rows.map(rowToPosition);
}

/**
 * Notional committed across an account: both legs of every open hedge.
 *
 * Only meaningful once several deployments run at once, which is exactly when it
 * becomes necessary — five deployments at three positions each is fifteen hedges,
 * and nothing counted that before.
 */
export function committedNotional(accountType: AccountType): number {
  const row = getDb()
    .prepare(
      "SELECT SUM(notional_per_leg) * 2 AS total FROM strategy_positions WHERE account_type = ? " +
        "AND status IN ('queued','opening','open','closing')",
    )
    .get(accountType) as Record<string, unknown> | undefined;
  return Number(rowNum(row?.total, 0).toFixed(2));
}

/**
 * Coins with an active hedge on this account, regardless of deployment.
 *
 * No longer a gate on entry — leg reservations are, and they are finer-grained: two
 * deployments may both hold BTC as long as they do it on different venues. Kept
 * because the UI still finds "which coins is this account in" useful.
 */
export function activeCoins(accountType: AccountType): Set<string> {
  const rows = getDb()
    .prepare(
      "SELECT coin FROM strategy_positions WHERE account_type = ? AND status IN ('queued','opening','open','closing')",
    )
    .all(accountType) as Record<string, unknown>[];
  return new Set(rows.map((row) => rowStr(row.coin)));
}

// ─── Logs ───────────────────────────────────────────────────────────────────

export interface StrategyLogInput {
  /** `system` for account-level work such as funding settlement. */
  strategy: LogChannel;
  accountType: AccountType;
  level: LogLevel;
  message: string;
  coin?: string | null;
}

export function appendStrategyLog(input: StrategyLogInput): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO strategy_logs (at, strategy, account_type, level, coin, message) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(Date.now(), input.strategy, input.accountType, input.level, input.coin ?? null, input.message);

  // Trim opportunistically. The engines write several lines a cycle, so an
  // unbounded table would grow without limit on a long-running server.
  const count = db.prepare("SELECT COUNT(*) AS c FROM strategy_logs").get() as
    | { c?: unknown }
    | undefined;
  if (rowNum(count?.c) > LOG_RETENTION * 1.25) {
    db.prepare(
      "DELETE FROM strategy_logs WHERE id NOT IN (SELECT id FROM strategy_logs ORDER BY id DESC LIMIT ?)",
    ).run(LOG_RETENTION);
  }
}

export function strategyLogs(
  options: { strategy?: LogChannel; accountType?: AccountType; limit?: number } = {},
): LogEntry[] {
  const capped = Math.min(Math.max(Math.trunc(options.limit ?? 200), 1), 1_000);
  const db = getDb();

  // Built from a fixed set of clauses with bound parameters — no value ever
  // reaches the SQL text.
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.strategy) {
    clauses.push("strategy = ?");
    params.push(options.strategy);
  }
  if (options.accountType) {
    clauses.push("account_type = ?");
    params.push(options.accountType);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  params.push(capped);

  const rows = db
    .prepare(`SELECT * FROM strategy_logs${where} ORDER BY id DESC LIMIT ?`)
    .all(...params) as Record<string, unknown>[];

  // Oldest first, which is how a terminal reads.
  return rows
    .map((row) => ({
      id: String(rowNum(row.id)),
      ts: rowNum(row.at),
      level: rowStr(row.level) as LogLevel,
      source: rowStr(row.account_type) as AccountType,
      strategy: rowStr(row.strategy, "fundingsync") as LogChannel,
      coin: rowStr(row.coin, "") || null,
      message: rowStr(row.message),
    }))
    .reverse();
}
