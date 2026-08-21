import { randomUUID } from "node:crypto";
import type {
  AccountOverview,
  ExchangeId,
  Order,
  OrderSide,
  OrderStatus,
  OrderType,
  PaperAccountState,
  Position,
  Trade,
  TradeSource,
} from "@/lib/types";
import { DEFAULT_PAPER_BALANCE } from "@/lib/types";
import { getDb, inTransaction, rowBool, rowNum, rowStr } from "@/lib/db/client";
import { fillFee } from "@/lib/db/fees";
import { paperFundingByHedge } from "@/lib/db/funding";

/**
 * Paper account persistence.
 *
 * Simulated, but stored properly: without this the account was recomputed from
 * a constant on every render, so nothing survived a refresh and a "reset" had
 * nothing to reset.
 */

const PNL_SERIES_DAYS = 14;

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Reads a stored source tag, defaulting to manual for pre-V4 rows. */
function rowSource(value: unknown): TradeSource {
  return rowStr(value, "manual") === "auto" ? "auto" : "manual";
}

// ─── State ──────────────────────────────────────────────────────────────────

export function getPaperState(): PaperAccountState {
  const db = getDb();
  const row = db.prepare("SELECT * FROM paper_state WHERE id = 1").get() as
    | Record<string, unknown>
    | undefined;
  if (row) {
    return {
      startingBalance: rowNum(row.starting_balance, DEFAULT_PAPER_BALANCE),
      realizedPnl: rowNum(row.realized_pnl, 0),
      feesPaid: rowNum(row.fees_paid, 0),
      fundingPnl: rowNum(row.funding_pnl, 0),
      resetAt: rowNum(row.reset_at, 0),
    };
  }
  // First read initialises the account rather than returning a phantom state.
  const now = Date.now();
  db.prepare(
    "INSERT INTO paper_state (id, starting_balance, realized_pnl, reset_at, created_at) VALUES (1, ?, 0, ?, ?)",
  ).run(DEFAULT_PAPER_BALANCE, now, now);
  return {
    startingBalance: DEFAULT_PAPER_BALANCE,
    realizedPnl: 0,
    feesPaid: 0,
    fundingPnl: 0,
    resetAt: now,
  };
}

/**
 * Wipes every paper table and re-seeds the balance, all in one transaction so a
 * partial reset cannot leave orphan trades against a fresh balance.
 *
 * FundingSync's paper hedges go too. They reference paper positions that are
 * about to be deleted, so leaving them would show open hedges backed by nothing —
 * and the engine would then try to close positions that no longer exist.
 */
export function resetPaperAccount(startingBalance: number): PaperAccountState {
  const balance = Number.isFinite(startingBalance) && startingBalance > 0
    ? Math.min(startingBalance, 100_000_000)
    : DEFAULT_PAPER_BALANCE;
  const now = Date.now();

  inTransaction((db) => {
    db.prepare("DELETE FROM paper_positions").run();
    db.prepare("DELETE FROM paper_orders").run();
    db.prepare("DELETE FROM paper_trades").run();
    db.prepare("DELETE FROM paper_pnl_daily").run();
    db.prepare("DELETE FROM paper_funding").run();
    db.prepare("DELETE FROM strategy_positions WHERE account_type = 'paper'").run();
    db.prepare(
      "INSERT INTO paper_state (id, starting_balance, realized_pnl, fees_paid, funding_pnl, reset_at, created_at) VALUES (1, ?, 0, 0, 0, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET starting_balance = excluded.starting_balance, realized_pnl = 0, fees_paid = 0, funding_pnl = 0, reset_at = excluded.reset_at",
    ).run(balance, now, now);
  });

  return { startingBalance: balance, realizedPnl: 0, feesPaid: 0, fundingPnl: 0, resetAt: now };
}

// ─── Orders ─────────────────────────────────────────────────────────────────

function rowToOrder(row: Record<string, unknown>): Order {
  return {
    id: rowStr(row.id),
    time: rowNum(row.created_at),
    pair: rowStr(row.coin),
    exchange: rowStr(row.exchange) as ExchangeId,
    side: rowStr(row.side) as OrderSide,
    marketType: "perp",
    orderType: rowStr(row.order_type) as OrderType,
    price: rowNum(row.price),
    size: rowNum(row.size),
    filled: rowNum(row.filled),
    status: rowStr(row.status) as OrderStatus,
    leverage: rowNum(row.leverage, 1),
    reduceOnly: rowBool(row.reduce_only),
    source: rowSource(row.source),
    hedgeId: rowStr(row.hedge_id, "") || undefined,
    executionMode: (rowStr(row.execution_mode, "") || undefined) as Order["executionMode"],
    waitLongExchange: (rowStr(row.wait_long_exchange, "") || undefined) as ExchangeId | undefined,
    waitShortExchange: (rowStr(row.wait_short_exchange, "") || undefined) as ExchangeId | undefined,
  };
}

export function insertPaperOrder(order: Order): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO paper_orders (id, exchange, coin, side, order_type, price, size, filled, status, leverage, reduce_only, execution_mode, hedge_id, wait_long_exchange, wait_short_exchange, source, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      order.id,
      order.exchange,
      order.pair,
      order.side,
      order.orderType,
      order.price,
      order.size,
      order.filled,
      order.status,
      order.leverage,
      order.reduceOnly ? 1 : 0,
      order.executionMode ?? null,
      order.hedgeId ?? null,
      order.waitLongExchange ?? null,
      order.waitShortExchange ?? null,
      order.source ?? "manual",
      order.time || now,
      now,
    );
}

export function openPaperOrders(): Order[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM paper_orders WHERE status IN ('pending', 'open', 'partial') ORDER BY created_at DESC",
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToOrder);
}

export function paperOrderHistory(limit = 100): Order[] {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = getDb()
    .prepare(
      "SELECT * FROM paper_orders WHERE status IN ('filled', 'cancelled') ORDER BY updated_at DESC LIMIT ?",
    )
    .all(capped) as Record<string, unknown>[];
  return rows.map(rowToOrder);
}

export function cancelPaperOrder(id: string): boolean {
  const result = getDb()
    .prepare(
      "UPDATE paper_orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending', 'open', 'partial')",
    )
    .run(Date.now(), id);
  return Number(result.changes) > 0;
}

// ─── Fills, positions, PnL ──────────────────────────────────────────────────

export interface FillInput {
  orderId?: string;
  exchange: ExchangeId;
  coin: string;
  side: OrderSide;
  price: number;
  size: number;
  leverage?: number;
  hedgeId?: string;
  source?: TradeSource;
}

/**
 * Applies a simulated fill: updates or closes the matching position, records the
 * trade, and books realized PnL when the fill reduces exposure. One transaction,
 * so position and trade can never disagree.
 *
 * Fees are charged on every fill, not just closing ones — a venue takes its cut
 * on entry too. They are deducted from realized PnL and from the account balance
 * so the money actually leaves, while the entry price stays the clean market
 * price. That keeps the fee visible instead of hidden inside a skewed entry.
 */
export function applyPaperFill(input: FillInput): { realizedPnl: number | null; fee: number } {
  const now = Date.now();
  const opposite = input.side === "buy" ? "short" : "long";
  const same = input.side === "buy" ? "long" : "short";
  const source: TradeSource = input.source ?? "manual";
  const fee = fillFee(input.exchange, input.price, input.size);

  return inTransaction((db) => {
    const existingOpposite = db
      .prepare("SELECT * FROM paper_positions WHERE exchange = ? AND coin = ? AND side = ?")
      .get(input.exchange, input.coin, opposite) as Record<string, unknown> | undefined;

    let grossPnl: number | null = null;
    let remaining = input.size;

    // A buy against a short (or a sell against a long) reduces exposure first.
    if (existingOpposite) {
      const openSize = rowNum(existingOpposite.size);
      const entry = rowNum(existingOpposite.entry_price);
      const closing = Math.min(openSize, remaining);
      const direction = opposite === "long" ? 1 : -1;
      grossPnl = Number(((input.price - entry) * closing * direction).toFixed(6));
      remaining -= closing;

      if (closing >= openSize) {
        db.prepare("DELETE FROM paper_positions WHERE exchange = ? AND coin = ? AND side = ?").run(
          input.exchange,
          input.coin,
          opposite,
        );
      } else {
        db.prepare(
          "UPDATE paper_positions SET size = ? WHERE exchange = ? AND coin = ? AND side = ?",
        ).run(openSize - closing, input.exchange, input.coin, opposite);
      }
    }

    // Realized PnL reported and booked is net of this fill's fee. An opening
    // fill has no PnL of its own, so its fee shows up as a negative realization
    // — which is exactly what it is.
    const netPnl = grossPnl === null ? -fee : Number((grossPnl - fee).toFixed(6));

    db.prepare("UPDATE paper_state SET realized_pnl = realized_pnl + ?, fees_paid = fees_paid + ? WHERE id = 1").run(
      netPnl,
      fee,
    );
    db.prepare(
      "INSERT INTO paper_pnl_daily (day, realized_pnl) VALUES (?, ?) " +
        "ON CONFLICT(day) DO UPDATE SET realized_pnl = realized_pnl + excluded.realized_pnl",
    ).run(utcDay(now), netPnl);

    // Anything left opens or grows a position on the same side.
    if (remaining > 0) {
      const existingSame = db
        .prepare("SELECT * FROM paper_positions WHERE exchange = ? AND coin = ? AND side = ?")
        .get(input.exchange, input.coin, same) as Record<string, unknown> | undefined;

      if (existingSame) {
        const openSize = rowNum(existingSame.size);
        const entry = rowNum(existingSame.entry_price);
        const newSize = openSize + remaining;
        // Weighted average keeps the entry honest across multiple fills.
        const newEntry = (entry * openSize + input.price * remaining) / newSize;
        db.prepare(
          "UPDATE paper_positions SET size = ?, entry_price = ? WHERE exchange = ? AND coin = ? AND side = ?",
        ).run(newSize, newEntry, input.exchange, input.coin, same);
      } else {
        db.prepare(
          "INSERT INTO paper_positions (id, exchange, coin, side, size, entry_price, leverage, hedge_id, source, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          randomUUID(),
          input.exchange,
          input.coin,
          same,
          remaining,
          input.price,
          input.leverage ?? 1,
          input.hedgeId ?? null,
          source,
          now,
        );
      }
    }

    db.prepare(
      "INSERT INTO paper_trades (id, order_id, exchange, coin, side, price, size, realized_pnl, fee, hedge_id, source, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(),
      input.orderId ?? null,
      input.exchange,
      input.coin,
      input.side,
      input.price,
      input.size,
      // Only a closing fill reports PnL in the trade row; an opening fill's cost
      // is the fee column, so a null here still means "nothing was realized".
      grossPnl === null ? null : netPnl,
      fee,
      input.hedgeId ?? null,
      source,
      now,
    );

    if (input.orderId) {
      db.prepare(
        "UPDATE paper_orders SET filled = size, status = 'filled', updated_at = ? WHERE id = ?",
      ).run(now, input.orderId);
    }

    return { realizedPnl: grossPnl === null ? null : netPnl, fee };
  });
}

/** Marks are supplied by the caller from the live market snapshot. */
export function paperPositions(marks: Map<string, number>): Position[] {
  const rows = getDb()
    .prepare("SELECT * FROM paper_positions ORDER BY opened_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map((row) => {
    const exchange = rowStr(row.exchange) as ExchangeId;
    const coin = rowStr(row.coin);
    const side = rowStr(row.side) as "long" | "short";
    const size = rowNum(row.size);
    const entryPrice = rowNum(row.entry_price);
    // A coin that left the watch set has no quote. Falling back to the entry
    // price used to report 0.00 unrealized PnL, which reads as "flat" when it
    // actually means "unknown"; markStale says which it is.
    const quoted = marks.get(`${exchange}:${coin}`) ?? marks.get(coin) ?? null;
    const markStale = quoted === null;
    const markPrice = quoted ?? entryPrice;
    const direction = side === "long" ? 1 : -1;
    return {
      exchange,
      coin,
      side,
      size,
      entryPrice,
      markPrice,
      unrealizedPnl: markStale
        ? 0
        : Number(((markPrice - entryPrice) * size * direction).toFixed(6)),
      leverage: rowNum(row.leverage, 1),
      source: rowSource(row.source),
      markStale,
      hedgeId: rowStr(row.hedge_id, "") || undefined,
      updatedAt: rowNum(row.opened_at),
    };
  });
}

export function paperTrades(limit = 50): Trade[] {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = getDb()
    .prepare("SELECT * FROM paper_trades ORDER BY executed_at DESC LIMIT ?")
    .all(capped) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: rowStr(row.id),
    time: rowNum(row.executed_at),
    coin: rowStr(row.coin),
    side: rowStr(row.side) as OrderSide,
    price: rowNum(row.price),
    size: rowNum(row.size),
    realizedPnl: row.realized_pnl === null ? null : rowNum(row.realized_pnl),
    exchange: rowStr(row.exchange) as ExchangeId,
    // Charged on every fill, including opening ones that report no PnL.
    fee: rowNum(row.fee, 0),
    source: rowSource(row.source),
    hedgeId: rowStr(row.hedge_id, "") || undefined,
  }));
}

function pnlSeries(): { series: number[]; today: number } {
  const rows = getDb()
    .prepare("SELECT day, realized_pnl FROM paper_pnl_daily")
    .all() as Record<string, unknown>[];
  const byDay = new Map<string, number>();
  for (const row of rows) byDay.set(rowStr(row.day), rowNum(row.realized_pnl));

  const series: number[] = [];
  const now = Date.now();
  for (let i = PNL_SERIES_DAYS - 1; i >= 0; i--) {
    const day = utcDay(now - i * 86_400_000);
    series.push(Number((byDay.get(day) ?? 0).toFixed(2)));
  }
  return { series, today: series[series.length - 1] ?? 0 };
}

/** Full paper account view, with marks supplied from the market snapshot. */
export function paperAccountOverview(marks: Map<string, number> = new Map()): AccountOverview {
  const state = getPaperState();
  const positions = paperPositions(marks);
  const { series, today } = pnlSeries();
  const funding = paperFundingByHedge();

  const marginUsed = positions.reduce(
    (sum, p) => sum + (p.size * p.entryPrice) / Math.max(1, p.leverage),
    0,
  );
  const unrealized = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  // Positions with no quote contribute 0 rather than a number derived from their
  // entry price, so equity here is "equity of what can be valued". The UI marks
  // those rows, which is why the total is not silently wrong.
  const balance = state.startingBalance + state.realizedPnl;

  return {
    accountType: "paper",
    balance: Number(balance.toFixed(2)),
    equity: Number((balance + unrealized).toFixed(2)),
    marginUsed: Number(marginUsed.toFixed(2)),
    available: Number((balance - marginUsed).toFixed(2)),
    feesPaid: Number(state.feesPaid.toFixed(2)),
    fundingPnl: Number(state.fundingPnl.toFixed(4)),
    fundingByHedge: funding.byHedge,
    fundingByCoin: funding.byCoin,
    pnl: {
      daily: today,
      total: Number(state.realizedPnl.toFixed(2)),
      series,
    },
    positions,
    recentTrades: paperTrades(20),
    openOrders: openPaperOrders(),
    updatedAt: Date.now(),
  };
}
