import type {
  ExchangeId,
  NetworkId,
  RebalanceConfig,
  TransferRecord,
  TransferStage,
  TransferStatus,
  TransferToken,
} from "@/lib/types";
import { getDb, inTransaction, rowBool, rowNum, rowStr } from "@/lib/db/client";
import { maskAddress } from "@/lib/rebalance/allowlist";

/**
 * Persistence for rebalancing: transfer records, the venue-reported event cache,
 * the saved automation config, and the run log the automation uses to enforce
 * its own limits.
 */

const DEFAULT_CONFIG: RebalanceConfig = {
  enabled: false,
  imbalanceThresholdPct: 20,
  marginRatioTriggerPct: 75,
  minIdleBalance: 500,
  preferredNetwork: { USDT: "TRC20", USDC: "ARBITRUM" },
  maxTransfersPerDay: 4,
  maxAmountPerTransfer: 2_000,
  cooldownMinutes: 60,
  allowedSources: [],
  allowedDestinations: [],
};

// ─── Config ─────────────────────────────────────────────────────────────────

function parseVenueList(value: unknown): ExchangeId[] {
  const raw = rowStr(value, "[]");
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is ExchangeId => typeof v === "string");
  } catch {
    return [];
  }
}

/** Reads the stored config, creating the single row on first use. */
export function getRebalanceConfig(): RebalanceConfig {
  const db = getDb();
  const row = db.prepare("SELECT * FROM rebalance_config WHERE id = 1").get() as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    const now = Date.now();
    db.prepare(
      "INSERT INTO rebalance_config (id, enabled, imbalance_threshold_pct, margin_ratio_trigger_pct, min_idle_balance, " +
        "preferred_network_usdt, preferred_network_usdc, max_transfers_per_day, max_amount_per_transfer, cooldown_minutes, " +
        "allowed_sources, allowed_destinations, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      DEFAULT_CONFIG.enabled ? 1 : 0,
      DEFAULT_CONFIG.imbalanceThresholdPct,
      DEFAULT_CONFIG.marginRatioTriggerPct,
      DEFAULT_CONFIG.minIdleBalance,
      DEFAULT_CONFIG.preferredNetwork.USDT,
      DEFAULT_CONFIG.preferredNetwork.USDC,
      DEFAULT_CONFIG.maxTransfersPerDay,
      DEFAULT_CONFIG.maxAmountPerTransfer,
      DEFAULT_CONFIG.cooldownMinutes,
      JSON.stringify(DEFAULT_CONFIG.allowedSources),
      JSON.stringify(DEFAULT_CONFIG.allowedDestinations),
      now,
    );
    return { ...DEFAULT_CONFIG };
  }
  return {
    enabled: rowBool(row.enabled),
    imbalanceThresholdPct: rowNum(row.imbalance_threshold_pct, 20),
    marginRatioTriggerPct: rowNum(row.margin_ratio_trigger_pct, 75),
    minIdleBalance: rowNum(row.min_idle_balance, 500),
    preferredNetwork: {
      USDT: rowStr(row.preferred_network_usdt, "TRC20") as NetworkId,
      USDC: rowStr(row.preferred_network_usdc, "ARBITRUM") as NetworkId,
    },
    maxTransfersPerDay: rowNum(row.max_transfers_per_day, 4),
    maxAmountPerTransfer: rowNum(row.max_amount_per_transfer, 2_000),
    cooldownMinutes: rowNum(row.cooldown_minutes, 60),
    allowedSources: parseVenueList(row.allowed_sources),
    allowedDestinations: parseVenueList(row.allowed_destinations),
  };
}

export function saveRebalanceConfig(config: RebalanceConfig): RebalanceConfig {
  getRebalanceConfig(); // ensure the row exists
  getDb()
    .prepare(
      "UPDATE rebalance_config SET enabled = ?, imbalance_threshold_pct = ?, margin_ratio_trigger_pct = ?, " +
        "min_idle_balance = ?, preferred_network_usdt = ?, preferred_network_usdc = ?, max_transfers_per_day = ?, " +
        "max_amount_per_transfer = ?, cooldown_minutes = ?, allowed_sources = ?, allowed_destinations = ?, " +
        "updated_at = ? WHERE id = 1",
    )
    .run(
      config.enabled ? 1 : 0,
      config.imbalanceThresholdPct,
      config.marginRatioTriggerPct,
      config.minIdleBalance,
      config.preferredNetwork.USDT,
      config.preferredNetwork.USDC,
      config.maxTransfersPerDay,
      config.maxAmountPerTransfer,
      config.cooldownMinutes,
      JSON.stringify(config.allowedSources),
      JSON.stringify(config.allowedDestinations),
      Date.now(),
    );
  return getRebalanceConfig();
}

// ─── Transfers ──────────────────────────────────────────────────────────────

function rowToTransfer(row: Record<string, unknown>): TransferRecord {
  const address = rowStr(row.address);
  const verified = row.address_verified;
  return {
    id: rowStr(row.id),
    time: rowNum(row.created_at),
    from: rowStr(row.from_exchange) as ExchangeId,
    to: rowStr(row.to_exchange) as ExchangeId,
    token: rowStr(row.token) as TransferToken,
    network: rowStr(row.network) as NetworkId,
    amount: rowNum(row.amount),
    fee: rowNum(row.fee),
    received: rowNum(row.received),
    status: rowStr(row.status) as TransferStatus,
    stage: rowStr(row.stage) as TransferStage,
    txId: rowStr(row.tx_id, "") || null,
    venueWithdrawId: rowStr(row.venue_withdraw_id, "") || null,
    // Never the full address: this value crosses into the browser.
    addressMasked: address ? maskAddress(address) : undefined,
    auto: rowBool(row.auto),
    addressVerified: verified === null || verified === undefined ? null : rowBool(verified),
    addressVerifyNote: rowStr(row.address_verify_note, "") || null,
    error: rowStr(row.error, "") || null,
    updatedAt: rowNum(row.updated_at),
  };
}

export interface TransferInsert {
  id: string;
  from: ExchangeId;
  to: ExchangeId;
  token: TransferToken;
  network: NetworkId;
  venueChain: string;
  amount: number;
  fee: number;
  address: string;
  memo?: string | null;
  auto?: boolean;
  /** True when the destination venue confirmed the address, null when unasked. */
  addressVerified?: boolean | null;
  addressVerifyNote?: string | null;
}

/** Records the intent before anything is sent, so a crash leaves a trace. */
export function insertTransfer(input: TransferInsert): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO transfers (id, from_exchange, to_exchange, token, network, venue_chain, amount, fee, received, " +
        "address, memo, status, stage, auto, address_verified, address_verify_note, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'internal', ?, ?, ?, ?, ?)",
    )
    .run(
      input.id,
      input.from,
      input.to,
      input.token,
      input.network,
      input.venueChain,
      input.amount,
      input.fee,
      Math.max(0, Number((input.amount - input.fee).toFixed(8))),
      input.address,
      input.memo ?? null,
      input.auto ? 1 : 0,
      input.addressVerified === null || input.addressVerified === undefined
        ? null
        : input.addressVerified
          ? 1
          : 0,
      input.addressVerifyNote ?? null,
      now,
      now,
    );
}

export interface TransferUpdate {
  status?: TransferStatus;
  stage?: TransferStage;
  venueWithdrawId?: string | null;
  txId?: string | null;
  fee?: number;
  error?: string | null;
}

export function updateTransfer(id: string, update: TransferUpdate): void {
  getDb()
    .prepare(
      "UPDATE transfers SET status = COALESCE(?, status), stage = COALESCE(?, stage), " +
        "venue_withdraw_id = COALESCE(?, venue_withdraw_id), tx_id = COALESCE(?, tx_id), " +
        "fee = COALESCE(?, fee), error = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      update.status ?? null,
      update.stage ?? null,
      update.venueWithdrawId ?? null,
      update.txId ?? null,
      update.fee ?? null,
      update.error ?? null,
      Date.now(),
      id,
    );
}

export function transferById(id: string): TransferRecord | null {
  const row = getDb().prepare("SELECT * FROM transfers WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTransfer(row) : null;
}

/** Full destination address for a stored transfer. Server-only. */
export function transferAddress(id: string): { address: string; memo: string | null } | null {
  const row = getDb().prepare("SELECT address, memo FROM transfers WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return { address: rowStr(row.address), memo: rowStr(row.memo, "") || null };
}

export function transfers(limit = 100): TransferRecord[] {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = getDb()
    .prepare("SELECT * FROM transfers ORDER BY created_at DESC LIMIT ?")
    .all(capped) as Record<string, unknown>[];
  return rows.map(rowToTransfer);
}

/** Transfers still in flight, which the poller needs to reconcile. */
export function pendingTransfers(): TransferRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM transfers WHERE status IN ('pending','processing') ORDER BY created_at ASC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToTransfer);
}

// ─── Venue event cache ──────────────────────────────────────────────────────

export interface TransferEventInsert {
  exchange: ExchangeId;
  direction: "withdraw" | "deposit";
  venueId: string;
  asset: string;
  amount: number;
  fee?: number | null;
  venueChain?: string | null;
  address?: string | null;
  txId?: string | null;
  status: TransferStatus;
  at: number;
}

/**
 * Upserts venue-reported events. Keyed by (exchange, direction, venueId) so a
 * repeated poll updates status rather than duplicating the row.
 */
export function upsertTransferEvents(events: TransferEventInsert[]): void {
  if (events.length === 0) return;
  inTransaction((db) => {
    const stmt = db.prepare(
      "INSERT INTO transfer_events (id, exchange, direction, venue_id, asset, amount, fee, venue_chain, address, tx_id, status, at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(exchange, direction, venue_id) DO UPDATE SET status = excluded.status, tx_id = excluded.tx_id, " +
        "fee = excluded.fee, amount = excluded.amount, at = excluded.at",
    );
    for (const event of events) {
      stmt.run(
        `${event.exchange}:${event.direction}:${event.venueId}`,
        event.exchange,
        event.direction,
        event.venueId,
        event.asset,
        event.amount,
        event.fee ?? null,
        event.venueChain ?? null,
        event.address ?? null,
        event.txId ?? null,
        event.status,
        event.at,
      );
    }
  });
}

export interface TransferEventRow extends TransferEventInsert {
  transferId: string | null;
}

export function transferEvents(limit = 200): TransferEventRow[] {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 1000);
  const rows = getDb()
    .prepare("SELECT * FROM transfer_events ORDER BY at DESC LIMIT ?")
    .all(capped) as Record<string, unknown>[];
  return rows.map((row) => ({
    exchange: rowStr(row.exchange) as ExchangeId,
    direction: rowStr(row.direction) as "withdraw" | "deposit",
    venueId: rowStr(row.venue_id),
    asset: rowStr(row.asset),
    amount: rowNum(row.amount),
    fee: row.fee === null ? null : rowNum(row.fee),
    venueChain: rowStr(row.venue_chain, "") || null,
    address: rowStr(row.address, "") || null,
    txId: rowStr(row.tx_id, "") || null,
    status: rowStr(row.status) as TransferStatus,
    at: rowNum(row.at),
    transferId: rowStr(row.transfer_id, "") || null,
  }));
}

/** Links a venue event to one of our transfers once they are matched. */
export function linkTransferEvent(
  exchange: ExchangeId,
  direction: "withdraw" | "deposit",
  venueId: string,
  transferId: string,
): void {
  getDb()
    .prepare(
      "UPDATE transfer_events SET transfer_id = ? WHERE exchange = ? AND direction = ? AND venue_id = ?",
    )
    .run(transferId, exchange, direction, venueId);
}

// ─── Automation run log ─────────────────────────────────────────────────────

/**
 * Runs kept in the log. The loop evaluates once a minute, so without a ceiling
 * this table grows by roughly 1,400 rows a day for as long as the process lives —
 * and it is a diagnostic record, not an audit trail. Transfers themselves are in
 * `transfers`, which is never trimmed.
 */
const RUN_RETENTION = 1_000;

export interface RebalanceRunInsert {
  evaluated: number;
  executed: number;
  skippedReason?: string | null;
  transferId?: string | null;
  detail?: string | null;
}

export function recordRebalanceRun(input: RebalanceRunInsert): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO rebalance_runs (at, evaluated, executed, skipped_reason, transfer_id, detail) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    Date.now(),
    input.evaluated,
    input.executed,
    input.skippedReason ?? null,
    input.transferId ?? null,
    input.detail ?? null,
  );

  // Trimmed opportunistically, with hysteresis so the delete does not run on
  // every insert. A row that executed a transfer is kept regardless of age: the
  // daily cap and the cooldown are read from `transfers`, but this is where the
  // reason a transfer happened is recorded.
  const count = db.prepare("SELECT COUNT(*) AS c FROM rebalance_runs").get() as
    | { c?: unknown }
    | undefined;
  if (rowNum(count?.c) > RUN_RETENTION * 1.25) {
    db.prepare(
      "DELETE FROM rebalance_runs WHERE executed = 0 AND id NOT IN " +
        "(SELECT id FROM rebalance_runs ORDER BY id DESC LIMIT ?)",
    ).run(RUN_RETENTION);
  }
}

export interface RebalanceRunStats {
  transfersToday: number;
  lastRunAt: number | null;
  lastTransferAt: number | null;
  lastSkippedReason: string | null;
}

/**
 * Counts automation-sent transfers in the current UTC day and the last activity
 * timestamps. These come from the database rather than memory so a restart does
 * not silently reset the daily cap or the cooldown.
 */
export function rebalanceRunStats(): RebalanceRunStats {
  const db = getDb();
  const startOfDay = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );
  const today = db
    .prepare("SELECT COUNT(*) AS c FROM transfers WHERE auto = 1 AND created_at >= ?")
    .get(startOfDay) as { c?: unknown } | undefined;
  const lastRun = db.prepare("SELECT at, skipped_reason FROM rebalance_runs ORDER BY at DESC LIMIT 1").get() as
    | Record<string, unknown>
    | undefined;
  const lastTransfer = db
    .prepare("SELECT created_at FROM transfers WHERE auto = 1 ORDER BY created_at DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined;

  return {
    transfersToday: rowNum(today?.c),
    lastRunAt: lastRun ? rowNum(lastRun.at) : null,
    lastTransferAt: lastTransfer ? rowNum(lastTransfer.created_at) : null,
    lastSkippedReason: lastRun ? rowStr(lastRun.skipped_reason, "") || null : null,
  };
}
