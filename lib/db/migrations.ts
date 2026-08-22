import type { DatabaseSync } from "node:sqlite";

/**
 * Versioned schema migrations tracked by SQLite's own `user_version`.
 *
 * Append a new statement list and register it in MIGRATIONS to change the
 * schema; never edit an existing one, because a database that already ran it
 * will not re-run it.
 *
 * Every entry is a constant literal executed through a prepared statement.
 * Runtime values never reach SQL text anywhere in this app — callers bind
 * parameters instead (see lib/db/client.ts).
 */

interface Migration {
  version: number;
  /** Constant DDL, applied in order. Ends with the user_version bump. */
  statements: readonly string[];
  /**
   * Optional procedural step, run inside the same transaction *before* the
   * statements.
   *
   * Almost every migration here is declarative, and that is the right default.
   * This exists for the case that genuinely is not: rewriting a JSON column
   * requires parsing it, and a migration that must refuse to run has to look at
   * the data before deciding. Doing either in SQL string form would be less
   * readable and less safe than a bound loop.
   */
  run?: (db: DatabaseSync) => void;
}

const V1 = [
  // ── Paper trading ──────────────────────────────────────────────────────────
  // paper_state is a single row (id = 1) holding the simulated account state.
  "CREATE TABLE paper_state (id INTEGER PRIMARY KEY CHECK (id = 1), starting_balance REAL NOT NULL, realized_pnl REAL NOT NULL DEFAULT 0, reset_at INTEGER NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE paper_positions (id TEXT PRIMARY KEY, exchange TEXT NOT NULL, coin TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('long', 'short')), size REAL NOT NULL, entry_price REAL NOT NULL, leverage REAL NOT NULL DEFAULT 1, hedge_id TEXT, opened_at INTEGER NOT NULL, UNIQUE (exchange, coin, side))",
  "CREATE TABLE paper_orders (id TEXT PRIMARY KEY, exchange TEXT NOT NULL, coin TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('buy', 'sell')), order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit')), price REAL NOT NULL, size REAL NOT NULL, filled REAL NOT NULL DEFAULT 0, status TEXT NOT NULL, leverage REAL NOT NULL DEFAULT 1, reduce_only INTEGER NOT NULL DEFAULT 0, execution_mode TEXT, hedge_id TEXT, wait_long_exchange TEXT, wait_short_exchange TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE INDEX idx_paper_orders_status ON paper_orders(status, created_at DESC)",
  "CREATE TABLE paper_trades (id TEXT PRIMARY KEY, order_id TEXT, exchange TEXT NOT NULL, coin TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('buy', 'sell')), price REAL NOT NULL, size REAL NOT NULL, realized_pnl REAL, hedge_id TEXT, executed_at INTEGER NOT NULL)",
  "CREATE INDEX idx_paper_trades_time ON paper_trades(executed_at DESC)",
  // Daily realized PnL, keyed by UTC date so the sparkline is stable.
  "CREATE TABLE paper_pnl_daily (day TEXT PRIMARY KEY, realized_pnl REAL NOT NULL DEFAULT 0)",

  // ── Live account mirror ────────────────────────────────────────────────────
  // These tables cache what the venues report over private websockets. The
  // exchange is always the source of truth; this is only a local view.
  "CREATE TABLE live_positions (exchange TEXT NOT NULL, coin TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('long', 'short')), size REAL NOT NULL, entry_price REAL NOT NULL, mark_price REAL NOT NULL DEFAULT 0, unrealized_pnl REAL NOT NULL DEFAULT 0, leverage REAL NOT NULL DEFAULT 1, liquidation_price REAL, updated_at INTEGER NOT NULL, PRIMARY KEY (exchange, coin, side))",
  "CREATE TABLE live_orders (id TEXT PRIMARY KEY, exchange TEXT NOT NULL, exchange_order_id TEXT, client_order_id TEXT, coin TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('buy', 'sell')), order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit')), price REAL NOT NULL, size REAL NOT NULL, filled REAL NOT NULL DEFAULT 0, status TEXT NOT NULL, leverage REAL NOT NULL DEFAULT 1, reduce_only INTEGER NOT NULL DEFAULT 0, hedge_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE INDEX idx_live_orders_status ON live_orders(status, created_at DESC)",
  "CREATE UNIQUE INDEX idx_live_orders_venue_id ON live_orders(exchange, exchange_order_id) WHERE exchange_order_id IS NOT NULL",
  "CREATE TABLE live_trades (id TEXT PRIMARY KEY, exchange TEXT NOT NULL, exchange_trade_id TEXT, coin TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('buy', 'sell')), price REAL NOT NULL, size REAL NOT NULL, fee REAL, realized_pnl REAL, hedge_id TEXT, executed_at INTEGER NOT NULL)",
  "CREATE INDEX idx_live_trades_time ON live_trades(executed_at DESC)",
  "CREATE UNIQUE INDEX idx_live_trades_venue_id ON live_trades(exchange, exchange_trade_id) WHERE exchange_trade_id IS NOT NULL",
  "CREATE TABLE live_balances (exchange TEXT NOT NULL, asset TEXT NOT NULL, available REAL NOT NULL DEFAULT 0, in_position REAL NOT NULL DEFAULT 0, equity REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (exchange, asset))",

  // ── Credentials ────────────────────────────────────────────────────────────
  // Secrets are stored AES-256-GCM encrypted. The key lives only in the
  // environment, never here, so this table alone cannot be decrypted.
  "CREATE TABLE api_credentials (exchange TEXT PRIMARY KEY, api_key_cipher TEXT NOT NULL, api_secret_cipher TEXT NOT NULL, passphrase_cipher TEXT, key_tail TEXT NOT NULL, read_only INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 0, last_verified_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",

  // ── Audit ──────────────────────────────────────────────────────────────────
  // Every action that can move money is recorded before it is attempted, so a
  // bad outcome can always be traced back to exactly what was sent.
  "CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, account_type TEXT, exchange TEXT, coin TEXT, payload TEXT, outcome TEXT, error TEXT)",
  "CREATE INDEX idx_audit_at ON audit_log(at DESC)",

  // Idempotency guards against a retried or double-clicked order being sent
  // twice. Keyed by a caller-supplied token.
  "CREATE TABLE idempotency (key TEXT PRIMARY KEY, action TEXT NOT NULL, response TEXT, created_at INTEGER NOT NULL)",

  "PRAGMA user_version = 1",
] as const;

// V2 adds exchange rebalancing: cross-venue stablecoin transfers, the saved
// guard rails for the automation, and a run log the automation uses to enforce
// its own cooldown and daily cap on the server rather than in the browser.
const V2 = [
  // ── Transfers ──
  // One row per rebalance attempt. `stage` records how far it got, because the
  // flow is two irreversible-ish steps: an internal futures→funding move, then
  // an on-chain withdrawal. A row stuck at 'internal' means money was moved
  // inside the venue but never left it, which is recoverable; that distinction
  // has to survive a crash.
  "CREATE TABLE transfers (id TEXT PRIMARY KEY, from_exchange TEXT NOT NULL, to_exchange TEXT NOT NULL, token TEXT NOT NULL, network TEXT NOT NULL, venue_chain TEXT, amount REAL NOT NULL, fee REAL NOT NULL DEFAULT 0, received REAL NOT NULL DEFAULT 0, address TEXT NOT NULL, memo TEXT, status TEXT NOT NULL, stage TEXT NOT NULL, venue_withdraw_id TEXT, tx_id TEXT, auto INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE INDEX idx_transfers_time ON transfers(created_at DESC)",
  "CREATE INDEX idx_transfers_status ON transfers(status, created_at DESC)",

  // Venue-reported withdraw/deposit rows, cached so history survives the venue
  // trimming its own records and so a withdrawal can be matched to the deposit
  // that completed it.
  "CREATE TABLE transfer_events (id TEXT PRIMARY KEY, exchange TEXT NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('withdraw','deposit')), venue_id TEXT NOT NULL, asset TEXT NOT NULL, amount REAL NOT NULL, fee REAL, venue_chain TEXT, address TEXT, tx_id TEXT, status TEXT NOT NULL, at INTEGER NOT NULL, transfer_id TEXT)",
  "CREATE UNIQUE INDEX idx_transfer_events_venue ON transfer_events(exchange, direction, venue_id)",
  "CREATE INDEX idx_transfer_events_time ON transfer_events(at DESC)",

  // ── Automation ──
  // Single row, mirroring paper_state. Kept server-side because the automation
  // enforces these limits without a browser attached.
  "CREATE TABLE rebalance_config (id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL DEFAULT 0, imbalance_threshold_pct REAL NOT NULL DEFAULT 20, margin_ratio_trigger_pct REAL NOT NULL DEFAULT 75, min_idle_balance REAL NOT NULL DEFAULT 500, preferred_network_usdt TEXT NOT NULL DEFAULT 'TRC20', preferred_network_usdc TEXT NOT NULL DEFAULT 'ARBITRUM', max_transfers_per_day INTEGER NOT NULL DEFAULT 4, max_amount_per_transfer REAL NOT NULL DEFAULT 2000, cooldown_minutes INTEGER NOT NULL DEFAULT 60, allowed_sources TEXT NOT NULL DEFAULT '[]', allowed_destinations TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL)",

  // Every automation evaluation, executed or not. This is what makes the daily
  // cap and cooldown real: without a persisted record a restart would reset them.
  "CREATE TABLE rebalance_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, evaluated INTEGER NOT NULL DEFAULT 0, executed INTEGER NOT NULL DEFAULT 0, skipped_reason TEXT, transfer_id TEXT, detail TEXT)",
  "CREATE INDEX idx_rebalance_runs_at ON rebalance_runs(at DESC)",

  "PRAGMA user_version = 2",
] as const;

// V3 adds the FundingSync strategy: its per-account configuration, the hedges it
// holds, and the decisions it logs. All three live server-side because the
// engine has to keep running with no browser attached.
const V3 = [
  // One row per account type. Live and paper each get their own configuration,
  // so paper can be tuned aggressively without touching the live settings.
  "CREATE TABLE strategy_state (account_type TEXT PRIMARY KEY CHECK (account_type IN ('live','paper')), enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL, last_run_at INTEGER, last_error TEXT, updated_at INTEGER NOT NULL)",

  // A hedge, not an order: two legs that only make sense together.
  //
  // entry_diff_fr and entry_spread are recorded at entry because both exit rules
  // are relative to them — profit is (entry_spread - current_spread), and the
  // diff-FR exit compares against what justified the entry. Without these the
  // position could not be evaluated after a restart.
  //
  // clock_exchange is the leg whose funding payment the position is timed
  // around; funding_time is that leg's settlement. Together they drive the
  // mandatory exit, which matters most when the two legs have different
  // intervals.
  "CREATE TABLE strategy_positions (id TEXT PRIMARY KEY, account_type TEXT NOT NULL CHECK (account_type IN ('live','paper')), coin TEXT NOT NULL, long_exchange TEXT NOT NULL, short_exchange TEXT NOT NULL, clock_exchange TEXT NOT NULL, funding_time INTEGER NOT NULL, entry_diff_fr REAL NOT NULL, entry_spread REAL, size REAL NOT NULL DEFAULT 0, leverage REAL NOT NULL DEFAULT 1, notional_per_leg REAL NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK (status IN ('queued','opening','open','closing','closed','cancelled','failed')), entry_mode TEXT NOT NULL CHECK (entry_mode IN ('instant','delay')), exit_reason TEXT, realized_pnl REAL, error TEXT, queued_at INTEGER NOT NULL, opened_at INTEGER, closed_at INTEGER, updated_at INTEGER NOT NULL)",
  "CREATE INDEX idx_strategy_positions_status ON strategy_positions(account_type, status, queued_at DESC)",
  // One live hedge per (account, coin): the same coin twice would double the
  // exposure while looking like two independent positions.
  "CREATE UNIQUE INDEX idx_strategy_positions_active ON strategy_positions(account_type, coin) WHERE status IN ('queued','opening','open','closing')",

  // Real decisions, including refusals. The point is being able to answer "why
  // did it not enter?" after the fact, which a browser-side log cannot do.
  "CREATE TABLE strategy_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, account_type TEXT NOT NULL CHECK (account_type IN ('live','paper')), level TEXT NOT NULL CHECK (level IN ('INFO','WARN','ERROR','EXEC')), coin TEXT, message TEXT NOT NULL)",
  "CREATE INDEX idx_strategy_logs_at ON strategy_logs(at DESC)",

  "PRAGMA user_version = 3",
] as const;

// V4 does two things.
//
// 1. Tags every order, trade and position with what created it, so a manual
//    trade and a FundingSync leg are distinguishable in the account views. They
//    already shared the same tables — the strategy deliberately writes through
//    the same code path a manual trade uses — but until now nothing recorded
//    which was which.
//
// 2. Adds trading fees to the paper account. Without them a simulated hedge
//    looks profitable at spreads that a real one would lose money on, since two
//    legs in and two legs out means paying taker fees four times.
const V4 = [
  // 'manual' default: existing rows predate the strategy, so they were all
  // placed by hand.
  "ALTER TABLE paper_orders ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'",
  "ALTER TABLE paper_trades ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'",
  "ALTER TABLE paper_positions ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'",
  "ALTER TABLE live_orders ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'",
  "ALTER TABLE live_trades ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'",
  // No column on live_positions: those rows are replaced wholesale from venue
  // snapshots, which would wipe any tag written here. The live position tag is
  // derived on read from the hedges FundingSync is managing.

  // Fee per fill, in quote currency. Recorded separately from realized PnL so
  // the cost is visible rather than buried in the entry price.
  "ALTER TABLE paper_trades ADD COLUMN fee REAL NOT NULL DEFAULT 0",
  // Total fees paid since the last reset, so the account view can show what
  // trading actually cost.
  "ALTER TABLE paper_state ADD COLUMN fees_paid REAL NOT NULL DEFAULT 0",

  // Editable taker fee per venue, in percent. One row, mirroring paper_state.
  "CREATE TABLE fee_config (id INTEGER PRIMARY KEY CHECK (id = 1), rates TEXT NOT NULL, updated_at INTEGER NOT NULL)",

  "PRAGMA user_version = 4",
] as const;

// V5 adds funding payments to the paper account.
//
// Until now paper never credited or debited funding, which meant the one thing
// this strategy exists to harvest produced no income at all in simulation: every
// hedge could only lose fees and spread. A paper result without funding is not a
// pessimistic estimate of the real thing, it is a different strategy.
const V5 = [
  // One row per (position leg, settlement). The unique index is the whole point:
  // the engine ticks every 5 seconds, and a settlement stays "just passed" for a
  // while, so without it the same payment would be credited repeatedly.
  "CREATE TABLE paper_funding (id TEXT PRIMARY KEY, exchange TEXT NOT NULL, coin TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('long', 'short')), rate_pct REAL NOT NULL, notional REAL NOT NULL, amount REAL NOT NULL, funding_time INTEGER NOT NULL, hedge_id TEXT, source TEXT NOT NULL DEFAULT 'manual', credited_at INTEGER NOT NULL)",
  "CREATE UNIQUE INDEX idx_paper_funding_once ON paper_funding(exchange, coin, side, funding_time)",
  "CREATE INDEX idx_paper_funding_time ON paper_funding(credited_at DESC)",

  // Running total since the last reset, kept separate from trading PnL so the
  // account can show where the money actually came from.
  "ALTER TABLE paper_state ADD COLUMN funding_pnl REAL NOT NULL DEFAULT 0",

  "PRAGMA user_version = 5",
] as const;

// V6 makes room for a second strategy.
//
// Everything was keyed by account_type alone, which encoded "there is exactly one
// strategy" into the schema. PerpBridge trades on price spread and has no funding
// clock at all, so three things had to change: state and logs gain a strategy
// column, and strategy_positions is rebuilt with clock_exchange/funding_time
// nullable — a strategy that ignores funding has no settlement to record, and
// storing 0 there would look like a real timestamp.
//
// The active-position index stays keyed on (account_type, coin) rather than
// including the strategy. That is deliberate: paper_positions is unique on
// (exchange, coin, side), so two strategies holding the same coin on the same
// venue would silently merge into one position with a blended entry price, and
// closing one hedge would then close part of the other. One strategy per coin per
// account avoids that entirely.
const V6 = [
  // ── strategy_state: composite key (strategy, account_type) ────────────────
  "CREATE TABLE strategy_state_v6 (strategy TEXT NOT NULL CHECK (strategy IN ('fundingsync','perpbridge')), account_type TEXT NOT NULL CHECK (account_type IN ('live','paper')), enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL, last_run_at INTEGER, last_error TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (strategy, account_type))",
  "INSERT INTO strategy_state_v6 (strategy, account_type, enabled, config, last_run_at, last_error, updated_at) SELECT 'fundingsync', account_type, enabled, config, last_run_at, last_error, updated_at FROM strategy_state",
  "DROP TABLE strategy_state",
  "ALTER TABLE strategy_state_v6 RENAME TO strategy_state",

  // ── strategy_positions: strategy column, nullable funding clock ───────────
  "CREATE TABLE strategy_positions_v6 (id TEXT PRIMARY KEY, strategy TEXT NOT NULL CHECK (strategy IN ('fundingsync','perpbridge')), account_type TEXT NOT NULL CHECK (account_type IN ('live','paper')), coin TEXT NOT NULL, long_exchange TEXT NOT NULL, short_exchange TEXT NOT NULL, clock_exchange TEXT, funding_time INTEGER, entry_diff_fr REAL, entry_spread REAL, size REAL NOT NULL DEFAULT 0, leverage REAL NOT NULL DEFAULT 1, notional_per_leg REAL NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK (status IN ('queued','opening','open','closing','closed','cancelled','failed')), entry_mode TEXT NOT NULL CHECK (entry_mode IN ('instant','delay')), exit_reason TEXT, realized_pnl REAL, error TEXT, queued_at INTEGER NOT NULL, opened_at INTEGER, closed_at INTEGER, updated_at INTEGER NOT NULL)",
  "INSERT INTO strategy_positions_v6 (id, strategy, account_type, coin, long_exchange, short_exchange, clock_exchange, funding_time, entry_diff_fr, entry_spread, size, leverage, notional_per_leg, status, entry_mode, exit_reason, realized_pnl, error, queued_at, opened_at, closed_at, updated_at) SELECT id, 'fundingsync', account_type, coin, long_exchange, short_exchange, clock_exchange, funding_time, entry_diff_fr, entry_spread, size, leverage, notional_per_leg, status, entry_mode, exit_reason, realized_pnl, error, queued_at, opened_at, closed_at, updated_at FROM strategy_positions",
  "DROP TABLE strategy_positions",
  "ALTER TABLE strategy_positions_v6 RENAME TO strategy_positions",
  "CREATE INDEX idx_strategy_positions_status ON strategy_positions(strategy, account_type, status, queued_at DESC)",
  "CREATE UNIQUE INDEX idx_strategy_positions_active ON strategy_positions(account_type, coin) WHERE status IN ('queued','opening','open','closing')",

  // ── strategy_logs: which strategy wrote the line ──────────────────────────
  // 'system' is allowed as well as a strategy id: funding settlement is charged
  // on whatever is open regardless of which strategy opened it, so those lines
  // belong to the account rather than to either engine.
  "ALTER TABLE strategy_logs ADD COLUMN strategy TEXT NOT NULL DEFAULT 'fundingsync'",
  "CREATE INDEX idx_strategy_logs_strategy ON strategy_logs(strategy, at DESC)",

  "PRAGMA user_version = 6",
] as const;

// V7 lets a FundingSync hedge keep its position after the payment is collected.
//
// Closing the instant the settlement passed meant taking whatever spread happened
// to exist at that second, which regularly turned a collected funding payment into
// a net loss. The payment is already banked at that point, so the only thing left
// to optimise is the exit price — and waiting for a decent one costs nothing but
// time.
//
// `harvested_at` records when the awaited settlement passed. It is the marker for
// "funding is in, now wait for a good exit", and it is stored rather than derived
// because the deadline for that wait is the *next* settlement, which needs the
// previous one to be known after a restart.
const V7 = [
  "ALTER TABLE strategy_positions ADD COLUMN harvested_at INTEGER",
  "PRAGMA user_version = 7",
] as const;

// V8 lets a hedge whose edge has decayed wait for a decent exit price.
//
// The decay rule used to close at once, which meant accepting whatever spread
// existed at that second — the same mistake V7 fixed for the settlement path, and
// it produced the same result: a hedge closed on a -0.77 spread because the
// funding difference happened to slip under the threshold at a bad moment.
//
// The difference from V7 matters, though. When funding has been collected, waiting
// is nearly free. When the difference decays the payment has *not* arrived and the
// reason to hold is gone, so the target is lowered to break-even after fees rather
// than the full profit target: holding out for profit with no edge left is a
// directional bet, not arbitrage.
//
// `exiting_since` marks when the wait began; `exiting_reason` keeps the original
// trigger so the eventual close still says why it started leaving.
const V8 = [
  "ALTER TABLE strategy_positions ADD COLUMN exiting_since INTEGER",
  "ALTER TABLE strategy_positions ADD COLUMN exiting_reason TEXT",
  "PRAGMA user_version = 8",
] as const;

// V9 admits a third strategy.
//
// The CHECK constraints written in V6 enumerate the strategy ids, so 'fundingbridge'
// is rejected by both strategy_state and strategy_positions until they are widened.
// SQLite cannot alter a CHECK in place, hence the same table-rebuild V6 used.
//
// The active-position index is again keyed on (account_type, coin) without the
// strategy, for the reason V6 gives: paper_positions is unique on
// (exchange, coin, side), so two strategies holding one coin would merge into a
// single position with a blended entry price. A third strategy competes for coins
// with the other two rather than running independently, which is the intended
// behaviour and not an oversight.
//
// strategy_logs needs nothing: V6 added its strategy column with a plain default and
// no CHECK, so a new channel writes without complaint.
const V9 = [
  // ── strategy_state ────────────────────────────────────────────────────────
  "CREATE TABLE strategy_state_v9 (strategy TEXT NOT NULL CHECK (strategy IN ('fundingsync','perpbridge','fundingbridge')), account_type TEXT NOT NULL CHECK (account_type IN ('live','paper')), enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL, last_run_at INTEGER, last_error TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (strategy, account_type))",
  "INSERT INTO strategy_state_v9 (strategy, account_type, enabled, config, last_run_at, last_error, updated_at) SELECT strategy, account_type, enabled, config, last_run_at, last_error, updated_at FROM strategy_state",
  "DROP TABLE strategy_state",
  "ALTER TABLE strategy_state_v9 RENAME TO strategy_state",

  // ── strategy_positions ────────────────────────────────────────────────────
  // Carries every column V6 through V8 established, including harvested_at,
  // exiting_since and exiting_reason: a rebuild that dropped them would silently
  // release positions that are mid-exit.
  "CREATE TABLE strategy_positions_v9 (id TEXT PRIMARY KEY, strategy TEXT NOT NULL CHECK (strategy IN ('fundingsync','perpbridge','fundingbridge')), account_type TEXT NOT NULL CHECK (account_type IN ('live','paper')), coin TEXT NOT NULL, long_exchange TEXT NOT NULL, short_exchange TEXT NOT NULL, clock_exchange TEXT, funding_time INTEGER, entry_diff_fr REAL, entry_spread REAL, size REAL NOT NULL DEFAULT 0, leverage REAL NOT NULL DEFAULT 1, notional_per_leg REAL NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK (status IN ('queued','opening','open','closing','closed','cancelled','failed')), entry_mode TEXT NOT NULL CHECK (entry_mode IN ('instant','delay')), exit_reason TEXT, realized_pnl REAL, error TEXT, queued_at INTEGER NOT NULL, opened_at INTEGER, closed_at INTEGER, updated_at INTEGER NOT NULL, harvested_at INTEGER, exiting_since INTEGER, exiting_reason TEXT)",
  "INSERT INTO strategy_positions_v9 (id, strategy, account_type, coin, long_exchange, short_exchange, clock_exchange, funding_time, entry_diff_fr, entry_spread, size, leverage, notional_per_leg, status, entry_mode, exit_reason, realized_pnl, error, queued_at, opened_at, closed_at, updated_at, harvested_at, exiting_since, exiting_reason) SELECT id, strategy, account_type, coin, long_exchange, short_exchange, clock_exchange, funding_time, entry_diff_fr, entry_spread, size, leverage, notional_per_leg, status, entry_mode, exit_reason, realized_pnl, error, queued_at, opened_at, closed_at, updated_at, harvested_at, exiting_since, exiting_reason FROM strategy_positions",
  "DROP TABLE strategy_positions",
  "ALTER TABLE strategy_positions_v9 RENAME TO strategy_positions",
  "CREATE INDEX idx_strategy_positions_status ON strategy_positions(strategy, account_type, status, queued_at DESC)",
  "CREATE UNIQUE INDEX idx_strategy_positions_active ON strategy_positions(account_type, coin) WHERE status IN ('queued','opening','open','closing')",

  "PRAGMA user_version = 9",
] as const;

// V10 moves two things out of the environment and into the database, so the
// dashboard is the only place they are configured.
//
// 1. Credentials gain a shape. A CEX is reached with key/secret/passphrase; a DEX
//    is reached by signing with a wallet key, which is a different secret with a
//    different blast radius — a leaked API key can be revoked on the venue, a
//    leaked wallet key cannot. `kind` records which, and `wallet_address_cipher`
//    holds the public address so the UI can show it without decrypting the key.
//
// 2. Withdrawal destinations become a table. They used to be env-only on the
//    argument that a bug must not be able to introduce a new destination. The
//    table keeps that property differently: a row is inert until `confirmed` is
//    set, and only an authenticated dashboard action can set it. The address is
//    stored encrypted, so the database file alone does not reveal where funds go.
const V10 = [
  // ── Credentials ──
  // 'cex' default: every existing row predates DEX support.
  "ALTER TABLE api_credentials ADD COLUMN kind TEXT NOT NULL DEFAULT 'cex'",
  // Public address for a DEX wallet. Encrypted like the rest, because knowing
  // which address this trader uses is itself worth protecting.
  "ALTER TABLE api_credentials ADD COLUMN wallet_address_cipher TEXT",
  // Optional label, so several venues on one chain stay distinguishable.
  "ALTER TABLE api_credentials ADD COLUMN label TEXT",

  // ── Withdrawal destinations ──
  // One row per (venue, token, network). `confirmed` is the arming flag: a
  // transfer resolves only against confirmed rows, so a half-entered address
  // cannot receive funds. `verified_address_tail` records the last four
  // characters the venue itself reported, for the cross-check that refuses to
  // send when a venue rotates its deposit address.
  "CREATE TABLE rebalance_destinations (id TEXT PRIMARY KEY, exchange TEXT NOT NULL, token TEXT NOT NULL, network TEXT NOT NULL, address_cipher TEXT NOT NULL, address_tail TEXT NOT NULL, memo_cipher TEXT, label TEXT, confirmed INTEGER NOT NULL DEFAULT 0, verified_at INTEGER, verified_address_tail TEXT, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE UNIQUE INDEX idx_rebalance_dest_route ON rebalance_destinations(exchange, token, network)",

  "PRAGMA user_version = 10",
] as const;

// V11 makes the API secret optional.
//
// V1 declared api_secret_cipher NOT NULL, which was right when every credential
// was an exchange API key. It is wrong for a DEX wallet added read-only: an
// address alone is enough to read positions and balances, and demanding a private
// key to *watch* an account pushes an operator into handing over more authority
// than the task needs. That configuration was accepted by the UI and then rejected
// by the database, so the constraint had to go.
//
// SQLite cannot drop a NOT NULL in place, hence the table rebuild. Every column
// V1 and V10 established is carried across; dropping one would silently
// disconnect a working venue.
const V11 = [
  "CREATE TABLE api_credentials_v11 (exchange TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'cex', api_key_cipher TEXT NOT NULL, api_secret_cipher TEXT, passphrase_cipher TEXT, wallet_address_cipher TEXT, key_tail TEXT NOT NULL, label TEXT, read_only INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 0, last_verified_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "INSERT INTO api_credentials_v11 (exchange, kind, api_key_cipher, api_secret_cipher, passphrase_cipher, wallet_address_cipher, key_tail, label, read_only, enabled, last_verified_at, last_error, created_at, updated_at) SELECT exchange, kind, api_key_cipher, api_secret_cipher, passphrase_cipher, wallet_address_cipher, key_tail, label, read_only, enabled, last_verified_at, last_error, created_at, updated_at FROM api_credentials",
  "DROP TABLE api_credentials",
  "ALTER TABLE api_credentials_v11 RENAME TO api_credentials",

  "PRAGMA user_version = 11",
] as const;

// V12 turns a strategy from a singleton into a blueprint you can deploy.
//
// Until now `strategy_state` had PRIMARY KEY (strategy, account_type): exactly one
// configuration per strategy per account, structurally. That made three
// FundingBridge deployments with different venue sets impossible to express.
//
// Three changes, and the second is the load-bearing one.
//
// 1. `strategy_deployments` replaces `strategy_state`. Each row is one running
//    deployment with its own label, toggle and config. No CHECK on `strategy`:
//    V6 and V9 both had to rebuild a table just to widen such an enumeration, and
//    the id is already validated in application code.
//
// 2. `leg_reservations` replaces the `(account_type, coin)` unique index that used
//    to allow one open hedge per coin per account. That index was both too blunt
//    and not enough: it stopped FundingSync and FundingBridge from holding the same
//    coin on entirely separate venues, while the thing that actually collides is a
//    *leg*. A venue nets positions per (coin, side) — if two deployments both go
//    long BTC on Binance, Binance holds one position and closing either hedge would
//    close part of the other. So the constraint now matches exactly what the venue
//    enforces: one leg per (account, venue, coin, side). Claimed in the same
//    transaction that queues the hedge, so two deployments racing for a leg cannot
//    both win.
//
// 3. `app_settings` is a small key/value store for things that belong to the whole
//    app rather than to one strategy — the account exposure ceiling and the
//    Telegram notification config. Values are opaque strings so a secret can be
//    stored encrypted without the table knowing.
const V12 = [
  // ── Deployments ──
  "CREATE TABLE strategy_deployments (id TEXT PRIMARY KEY, strategy TEXT NOT NULL, account_type TEXT NOT NULL CHECK (account_type IN ('live','paper')), label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL, last_run_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  // A label is how an operator refers to a deployment in logs and alerts, so two
  // with the same name on one account would make those unreadable.
  "CREATE UNIQUE INDEX idx_deployments_label ON strategy_deployments(account_type, label)",
  "CREATE INDEX idx_deployments_account ON strategy_deployments(account_type, strategy)",

  // Carry every existing configuration across as a deployment, so a running setup
  // is not silently reset. The label names the strategy because that is what it
  // was: the only deployment of it.
  "INSERT INTO strategy_deployments (id, strategy, account_type, label, enabled, config, last_run_at, last_error, created_at, updated_at) SELECT lower(strategy) || '-' || lower(account_type) || '-1', strategy, account_type, CASE strategy WHEN 'fundingsync' THEN 'FundingSync 1' WHEN 'perpbridge' THEN 'PerpBridge 1' WHEN 'fundingbridge' THEN 'FundingBridge 1' ELSE strategy || ' 1' END, enabled, config, last_run_at, last_error, updated_at, updated_at FROM strategy_state",
  "DROP TABLE strategy_state",

  // ── Positions gain an owner ──
  // Nullable: a hedge opened before this migration has no deployment, and
  // inventing one would attribute history to a deployment that never ran it. The
  // backfill below assigns the ones it can identify unambiguously.
  "ALTER TABLE strategy_positions ADD COLUMN deployment_id TEXT",
  "UPDATE strategy_positions SET deployment_id = lower(strategy) || '-' || lower(account_type) || '-1' WHERE deployment_id IS NULL",
  "CREATE INDEX idx_strategy_positions_deployment ON strategy_positions(deployment_id, status, queued_at DESC)",

  // The old one-coin-per-account rule goes; leg reservations take over.
  "DROP INDEX idx_strategy_positions_active",

  // ── Leg reservations ──
  // The primary key *is* the rule: one deployment per venue leg per account.
  "CREATE TABLE leg_reservations (account_type TEXT NOT NULL CHECK (account_type IN ('live','paper')), exchange TEXT NOT NULL, coin TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('long','short')), position_id TEXT NOT NULL, deployment_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (account_type, exchange, coin, side))",
  "CREATE INDEX idx_leg_reservations_position ON leg_reservations(position_id)",

  // Reservations for hedges that are already live, so a restart mid-position does
  // not free a leg the account is actually holding.
  "INSERT OR IGNORE INTO leg_reservations (account_type, exchange, coin, side, position_id, deployment_id, created_at) SELECT account_type, long_exchange, coin, 'long', id, deployment_id, queued_at FROM strategy_positions WHERE status IN ('queued','opening','open','closing') AND deployment_id IS NOT NULL",
  "INSERT OR IGNORE INTO leg_reservations (account_type, exchange, coin, side, position_id, deployment_id, created_at) SELECT account_type, short_exchange, coin, 'short', id, deployment_id, queued_at FROM strategy_positions WHERE status IN ('queued','opening','open','closing') AND deployment_id IS NOT NULL",

  // ── App settings ──
  "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",

  "PRAGMA user_version = 12",
] as const;

// V13 records what the destination cross-check actually decided.
//
// `verified_address_tail` alone could not express the difference between "the
// venue reported a different address" and "the venue could not be asked", so the
// UI derived a match by comparing four-character tails. Two different addresses
// that happen to end the same way then read as verified, which is the wrong
// answer from the one check that exists to be trusted.
//
// `verified_match` stores the server's full-string comparison as a tri-state:
// 1 matched, 0 mismatched, NULL never checked. Existing rows are backfilled from
// what can be inferred — a row with a verification timestamp and no error was a
// match, since recordDestinationVerification only sets the timestamp on success.
const V13 = [
  "ALTER TABLE rebalance_destinations ADD COLUMN verified_match INTEGER",
  "UPDATE rebalance_destinations SET verified_match = 1 WHERE verified_at IS NOT NULL AND (last_error IS NULL OR last_error = '')",
  "UPDATE rebalance_destinations SET verified_match = 0 WHERE verified_address_tail IS NOT NULL AND verified_at IS NULL",

  // ── Transfers record whether the destination was cross-checked ──
  // For an irreversible withdrawal, "we could not confirm the address with the
  // venue" is part of what happened and belongs in the record, not just in a log
  // line. NULL for rows that predate the check.
  "ALTER TABLE transfers ADD COLUMN address_verified INTEGER",
  "ALTER TABLE transfers ADD COLUMN address_verify_note TEXT",

  "PRAGMA user_version = 13",
] as const;

// V14 admits a fourth strategy, FundingYield.
//
// V9's CHECK on strategy_positions still enumerates three ids, and SQLite cannot alter
// a CHECK in place, so this is the same table rebuild V6 and V9 performed. The rebuild
// has to carry every column added since V9 — harvested_at, exiting_since and
// exiting_reason from V7/V8, deployment_id from V12 — because a rebuild that dropped
// one would silently release positions that are mid-exit or orphan them from their
// deployment.
//
// Two new columns come with it, both for the stop-loss FundingYield needs and the other
// three strategies deliberately do not have:
//
//   · `funding_collected` is the running total of funding credited to this hedge, in
//     USD. FundingYield's exit is "has the funding covered the round trip yet", and that
//     question cannot be answered from a rate: rates change while a position is held,
//     so the only honest figure is what was actually paid. Live venues fold funding into
//     their balance and report no per-position figure, which is why this is nullable
//     rather than defaulted to 0 — an unknown must not read as "collected nothing".
//   · `worst_net_usd` records the lowest mark-to-market the position has been through.
//     A stop-loss that only reads the current value cannot say how close a recovered
//     position came to being stopped, which is the number that tells you whether the
//     limit is set sensibly.
const V14 = [
  "CREATE TABLE strategy_positions_v14 (id TEXT PRIMARY KEY, strategy TEXT NOT NULL CHECK (strategy IN ('fundingsync','perpbridge','fundingbridge','fundingyield')), deployment_id TEXT, account_type TEXT NOT NULL CHECK (account_type IN ('live','paper')), coin TEXT NOT NULL, long_exchange TEXT NOT NULL, short_exchange TEXT NOT NULL, clock_exchange TEXT, funding_time INTEGER, entry_diff_fr REAL, entry_spread REAL, size REAL NOT NULL DEFAULT 0, leverage REAL NOT NULL DEFAULT 1, notional_per_leg REAL NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK (status IN ('queued','opening','open','closing','closed','cancelled','failed')), entry_mode TEXT NOT NULL CHECK (entry_mode IN ('instant','delay')), exit_reason TEXT, realized_pnl REAL, error TEXT, queued_at INTEGER NOT NULL, opened_at INTEGER, closed_at INTEGER, updated_at INTEGER NOT NULL, harvested_at INTEGER, exiting_since INTEGER, exiting_reason TEXT, funding_collected REAL, worst_net_usd REAL)",
  "INSERT INTO strategy_positions_v14 (id, strategy, deployment_id, account_type, coin, long_exchange, short_exchange, clock_exchange, funding_time, entry_diff_fr, entry_spread, size, leverage, notional_per_leg, status, entry_mode, exit_reason, realized_pnl, error, queued_at, opened_at, closed_at, updated_at, harvested_at, exiting_since, exiting_reason) SELECT id, strategy, deployment_id, account_type, coin, long_exchange, short_exchange, clock_exchange, funding_time, entry_diff_fr, entry_spread, size, leverage, notional_per_leg, status, entry_mode, exit_reason, realized_pnl, error, queued_at, opened_at, closed_at, updated_at, harvested_at, exiting_since, exiting_reason FROM strategy_positions",
  "DROP TABLE strategy_positions",
  "ALTER TABLE strategy_positions_v14 RENAME TO strategy_positions",
  "CREATE INDEX idx_strategy_positions_status ON strategy_positions(strategy, account_type, status, queued_at DESC)",
  "CREATE INDEX idx_strategy_positions_deployment ON strategy_positions(deployment_id, status, queued_at DESC)",

  "PRAGMA user_version = 14",
] as const;

// V15 adds two indexes for queries that were doing full table scans.
//
// Neither is a hypothetical. Both tables only grow — closed positions are kept for
// history and neither `live_orders` nor `live_trades` had any retention — and both
// queries run on paths where a scan is paid repeatedly:
//
//   · `live_orders(exchange, client_order_id)` serves the lookup in
//     `applyLiveOrderUpdate`, which runs once per order frame arriving on a venue's
//     private websocket. The existing indexes cover `(status, created_at)` and
//     `(exchange, exchange_order_id)`, so a lookup by *our* id had nothing to use.
//     Partial, because a manual order placed outside this app has no client id and
//     indexing those nulls would only make the index bigger.
//
//   · `strategy_positions(account_type, status)` serves `committedNotional`,
//     `activeCoins` and `autoLiveLegs`. V14's two indexes are led by `strategy` and
//     `deployment_id`, which none of those three filter on, so all three scanned.
//     `autoLiveLegs` runs on every `livePositions()` call, which the strategy loop
//     makes per live deployment every 5 seconds. Measured on this schema at 20,000
//     rows: 3.2 ms scanned against 12.9 µs seeked.
//
// Retention for the two live tables is deliberately *not* added here. Fill history
// is the record of what the venue actually did with real money, and trimming it is
// a decision about evidence rather than about disk — 200,000 rows is about 20 MB.
// The index is what makes the size stop mattering.
const V15 = [
  "CREATE INDEX IF NOT EXISTS idx_live_orders_client_id ON live_orders(exchange, client_order_id) WHERE client_order_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_strategy_positions_account ON strategy_positions(account_type, status)",

  "PRAGMA user_version = 15",
] as const;

// V16 retires two venues, Binance and edgeX, from a schema that never named them.
//
// No column CHECK-constrains an exchange id, so nothing here is repairing a broken
// row — every one of these is still valid SQL. What breaks is the *meaning*: an id
// the build no longer knows fails `requireExchange` at the API edge and disappears
// from anything derived from EXCHANGE_IDS, which turns some rows from data into
// litter and one kind into a silent hazard.
//
// Four things are cleared, and the reasoning differs for each:
//
//   · api_credentials — deleted, and this is the one that matters. `credentialStatuses`
//     builds its output by walking EXCHANGE_IDS, so a row for a retired venue is
//     fetched and then never emitted: invisible in the UI. `deleteCredentials` is only
//     reachable through a route whose validation now rejects the id. The result is an
//     encrypted API secret — or, for a wallet venue, an unrevocable private key — left
//     on disk with no screen that shows it and no button that removes it.
//
//   · rebalance_destinations — deleted. A withdrawal address for a venue that no longer
//     exists cannot be armed, verified or used, and its presence breaks the Destinations
//     view and the automation config save.
//
//   · rebalance_config allow-lists — filtered. A stale id is inert at the engine, but
//     `venueList` in the config route throws on an unknown venue, so the whole
//     automation config POST fails as soon as the UI echoes the stored value back.
//
//   · strategy_deployments.config — filtered. Left alone this is worse than an error:
//     `venueField` throws on the unknown id, `readStored*Config` catches it and falls
//     back to the shipped defaults, and `enabled` lives in its own column — so a live
//     deployment keeps running with every threshold the operator set silently replaced.
//     A config that filters down to fewer than two venues cannot satisfy the pair
//     requirement at all, so it is reset to defaults *and* switched off rather than left
//     to trade on a configuration nobody chose.
//
// History is kept: audit_log, transfers, transfer_events, paper_funding, closed
// positions and every trade row are the record of what happened with real money, and
// `exchangeInfo` now renders an unknown id as a plain label so those views still read.
//
// The migration refuses to run while a position on a retired venue is still live. Its
// leg reservation is what stops another deployment claiming a leg the account actually
// holds at the venue, and freeing that while the exposure is open would be the one
// genuinely dangerous outcome available here.
const RETIRED_VENUES = ["binance", "edgex"] as const;

const V16_STATEMENTS = [
  "DELETE FROM api_credentials WHERE exchange IN ('binance', 'edgex')",
  "DELETE FROM rebalance_destinations WHERE exchange IN ('binance', 'edgex')",

  "PRAGMA user_version = 16",
] as const;

/** Statuses that mean the account may still hold the position at the venue. */
const LIVE_POSITION_STATUSES = ["queued", "opening", "open", "closing"] as const;

function retireVenues(db: DatabaseSync): void {
  const placeholders = RETIRED_VENUES.map(() => "?").join(", ");
  const statusPlaceholders = LIVE_POSITION_STATUSES.map(() => "?").join(", ");

  // Refuse rather than orphan: see the block comment above.
  const blocking = db
    .prepare(
      `SELECT id, account_type, coin, long_exchange, short_exchange, status FROM strategy_positions
       WHERE status IN (${statusPlaceholders})
         AND (long_exchange IN (${placeholders}) OR short_exchange IN (${placeholders}))`,
    )
    .all(...LIVE_POSITION_STATUSES, ...RETIRED_VENUES, ...RETIRED_VENUES) as Record<
    string,
    unknown
  >[];
  if (blocking.length > 0) {
    const detail = blocking
      .map(
        (row) =>
          `${String(row.account_type)} ${String(row.coin)} ` +
          `${String(row.long_exchange)}/${String(row.short_exchange)} (${String(row.status)}, id ${String(row.id)})`,
      )
      .join("; ");
    throw new Error(
      `Cannot retire ${RETIRED_VENUES.join(" and ")} while ${blocking.length} position(s) are still ` +
        `live on them. Close them at the venue first, then restart. Blocking: ${detail}`,
    );
  }

  // Reservations left by positions that already finished are safe to drop.
  db.prepare(`DELETE FROM leg_reservations WHERE exchange IN (${placeholders})`).run(
    ...RETIRED_VENUES,
  );

  filterRebalanceAllowLists(db);
  filterDeploymentVenues(db);
}

function filterRebalanceAllowLists(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT allowed_sources, allowed_destinations FROM rebalance_config WHERE id = 1")
    .get() as Record<string, unknown> | undefined;
  if (!row) return;

  const keep = (raw: unknown): string | null => {
    if (typeof raw !== "string") return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Unparseable already means "no venues allowed" to the reader; leave it.
      return null;
    }
    if (!Array.isArray(parsed)) return null;
    const filtered = parsed.filter(
      (v) => typeof v === "string" && !(RETIRED_VENUES as readonly string[]).includes(v),
    );
    return filtered.length === parsed.length ? null : JSON.stringify(filtered);
  };

  const sources = keep(row.allowed_sources);
  const destinations = keep(row.allowed_destinations);
  if (sources === null && destinations === null) return;

  db.prepare(
    "UPDATE rebalance_config SET allowed_sources = ?, allowed_destinations = ? WHERE id = 1",
  ).run(
    sources ?? (typeof row.allowed_sources === "string" ? row.allowed_sources : "[]"),
    destinations ?? (typeof row.allowed_destinations === "string" ? row.allowed_destinations : "[]"),
  );
}

function filterDeploymentVenues(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT id, config FROM strategy_deployments")
    .all() as Record<string, unknown>[];

  for (const row of rows) {
    const raw = typeof row.config === "string" ? row.config : "";
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const config = parsed as Record<string, unknown>;
    const venues = config.venues;
    if (!Array.isArray(venues)) continue;

    const kept = venues.filter(
      (v) => typeof v === "string" && !(RETIRED_VENUES as readonly string[]).includes(v),
    );
    if (kept.length === venues.length) continue;

    if (kept.length < 2) {
      // A hedge needs two legs, so this config cannot be repaired by filtering.
      // Dropping the venue list and leaving it enabled would start it trading on
      // shipped defaults, which is exactly the silent substitution being avoided.
      delete config.venues;
      db.prepare("UPDATE strategy_deployments SET config = ?, enabled = 0 WHERE id = ?").run(
        JSON.stringify(config),
        row.id as string,
      );
      continue;
    }

    config.venues = kept;
    db.prepare("UPDATE strategy_deployments SET config = ? WHERE id = ?").run(
      JSON.stringify(config),
      row.id as string,
    );
  }
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, statements: V1 },
  { version: 2, statements: V2 },
  { version: 3, statements: V3 },
  { version: 4, statements: V4 },
  { version: 5, statements: V5 },
  { version: 6, statements: V6 },
  { version: 7, statements: V7 },
  { version: 8, statements: V8 },
  { version: 9, statements: V9 },
  { version: 10, statements: V10 },
  { version: 11, statements: V11 },
  { version: 12, statements: V12 },
  { version: 13, statements: V13 },
  { version: 14, statements: V14 },
  { version: 15, statements: V15 },
  { version: 16, statements: V16_STATEMENTS, run: retireVenues },
];

export function runMigrations(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const current = typeof row?.user_version === "number" ? row.user_version : 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.prepare("BEGIN IMMEDIATE").run();
    try {
      migration.run?.(db);
      for (const statement of migration.statements) {
        db.prepare(statement).run();
      }
      db.prepare("COMMIT").run();
    } catch (err) {
      try {
        db.prepare("ROLLBACK").run();
      } catch {
        // Ignore: the original failure is what matters.
      }
      throw err;
    }
  }
}

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
