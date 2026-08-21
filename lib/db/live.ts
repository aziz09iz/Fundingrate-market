import { randomUUID } from "node:crypto";
import type {
  ExchangeId,
  LiveAccountSnapshot,
  Order,
  OrderSide,
  OrderStatus,
  OrderType,
  Position,
  Trade,
  TradeSource,
  VenueBalance,
} from "@/lib/types";
import { getDb, inTransaction, rowBool, rowNum, rowStr } from "@/lib/db/client";
import { sourceFromClientOrderId } from "@/lib/private/client-id";

/**
 * Local mirror of live account state.
 *
 * The exchange is always the source of truth. These tables cache what the
 * private websockets report so the UI has something to render between messages
 * and across a page reload — they are never used to decide what to send.
 */

/** Reads a stored source tag, defaulting to manual for pre-V4 rows. */
function rowSource(value: unknown): TradeSource {
  return rowStr(value, "manual") === "auto" ? "auto" : "manual";
}

// ─── Positions ──────────────────────────────────────────────────────────────

export interface PositionUpsert {
  exchange: ExchangeId;
  coin: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice?: number;
  unrealizedPnl?: number;
  leverage?: number;
  liquidationPrice?: number | null;
}

export function upsertLivePosition(input: PositionUpsert): void {
  const now = Date.now();
  // A venue reporting size 0 means the position is gone.
  if (input.size <= 0) {
    getDb()
      .prepare("DELETE FROM live_positions WHERE exchange = ? AND coin = ? AND side = ?")
      .run(input.exchange, input.coin, input.side);
    return;
  }
  getDb()
    .prepare(
      "INSERT INTO live_positions (exchange, coin, side, size, entry_price, mark_price, unrealized_pnl, leverage, liquidation_price, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(exchange, coin, side) DO UPDATE SET size = excluded.size, entry_price = excluded.entry_price, " +
        "mark_price = excluded.mark_price, unrealized_pnl = excluded.unrealized_pnl, leverage = excluded.leverage, " +
        "liquidation_price = excluded.liquidation_price, updated_at = excluded.updated_at",
    )
    .run(
      input.exchange,
      input.coin,
      input.side,
      input.size,
      input.entryPrice,
      input.markPrice ?? 0,
      input.unrealizedPnl ?? 0,
      input.leverage ?? 1,
      input.liquidationPrice ?? null,
      now,
    );
}

/** Replaces a venue's whole position set, used when a stream sends a snapshot. */
export function replaceLivePositions(
  exchange: ExchangeId,
  positions: Omit<PositionUpsert, "exchange">[],
): void {
  inTransaction((db) => {
    db.prepare("DELETE FROM live_positions WHERE exchange = ?").run(exchange);
    const stmt = db.prepare(
      "INSERT INTO live_positions (exchange, coin, side, size, entry_price, mark_price, unrealized_pnl, leverage, liquidation_price, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const now = Date.now();
    for (const p of positions) {
      if (p.size <= 0) continue;
      stmt.run(
        exchange,
        p.coin,
        p.side,
        p.size,
        p.entryPrice,
        p.markPrice ?? 0,
        p.unrealizedPnl ?? 0,
        p.leverage ?? 1,
        p.liquidationPrice ?? null,
        now,
      );
    }
  });
}

/**
 * Legs currently managed by FundingSync on the live account, as
 * `exchange:coin:side` keys.
 *
 * Live positions are reported by the venue, which knows nothing about who opened
 * them, so the tag cannot be stored on the row — a stream snapshot would
 * overwrite it. It is derived on read from the hedges the strategy is managing.
 */
function autoLiveLegs(): Set<string> {
  const rows = getDb()
    .prepare(
      "SELECT coin, long_exchange, short_exchange FROM strategy_positions " +
        "WHERE account_type = 'live' AND status IN ('opening','open','closing')",
    )
    .all() as Record<string, unknown>[];
  const keys = new Set<string>();
  for (const row of rows) {
    const coin = rowStr(row.coin);
    keys.add(`${rowStr(row.long_exchange)}:${coin}:long`);
    keys.add(`${rowStr(row.short_exchange)}:${coin}:short`);
  }
  return keys;
}

export function livePositions(): Position[] {
  const rows = getDb()
    .prepare("SELECT * FROM live_positions ORDER BY exchange, coin")
    .all() as Record<string, unknown>[];
  const auto = autoLiveLegs();
  return rows.map((row) => {
    const exchange = rowStr(row.exchange) as ExchangeId;
    const coin = rowStr(row.coin);
    const side = rowStr(row.side) as "long" | "short";
    return {
      exchange,
      coin,
      side,
      size: rowNum(row.size),
      entryPrice: rowNum(row.entry_price),
      markPrice: rowNum(row.mark_price),
      unrealizedPnl: rowNum(row.unrealized_pnl),
      leverage: rowNum(row.leverage, 1),
      liquidationPrice: row.liquidation_price === null ? null : rowNum(row.liquidation_price),
      source: auto.has(`${exchange}:${coin}:${side}`) ? "auto" : "manual",
      updatedAt: rowNum(row.updated_at),
    };
  });
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
  };
}

export interface LiveOrderInsert {
  id: string;
  exchange: ExchangeId;
  exchangeOrderId?: string | null;
  clientOrderId?: string | null;
  coin: string;
  side: OrderSide;
  orderType: OrderType;
  price: number;
  size: number;
  status: OrderStatus;
  leverage?: number;
  reduceOnly?: boolean;
  hedgeId?: string | null;
  source?: TradeSource;
}

export function insertLiveOrder(input: LiveOrderInsert): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO live_orders (id, exchange, exchange_order_id, client_order_id, coin, side, order_type, price, size, filled, status, leverage, reduce_only, hedge_id, source, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      input.id,
      input.exchange,
      input.exchangeOrderId ?? null,
      input.clientOrderId ?? null,
      input.coin,
      input.side,
      input.orderType,
      input.price,
      input.size,
      input.status,
      input.leverage ?? 1,
      input.reduceOnly ? 1 : 0,
      input.hedgeId ?? null,
      input.source ?? "manual",
      now,
      now,
    );
}

export interface LiveOrderUpdate {
  exchange: ExchangeId;
  exchangeOrderId?: string | null;
  clientOrderId?: string | null;
  coin?: string;
  side?: OrderSide;
  orderType?: OrderType;
  price?: number;
  size?: number;
  filled?: number;
  status?: OrderStatus;
}

/**
 * Applies an order update from a private stream. Matches on the venue order id
 * first, then the client id we generated, and inserts a row when the order was
 * placed outside this app so the view stays complete.
 */
export function applyLiveOrderUpdate(update: LiveOrderUpdate): void {
  const db = getDb();
  const now = Date.now();

  let existing: Record<string, unknown> | undefined;
  if (update.exchangeOrderId) {
    existing = db
      .prepare("SELECT * FROM live_orders WHERE exchange = ? AND exchange_order_id = ?")
      .get(update.exchange, update.exchangeOrderId) as Record<string, unknown> | undefined;
  }
  if (!existing && update.clientOrderId) {
    existing = db
      .prepare("SELECT * FROM live_orders WHERE exchange = ? AND client_order_id = ?")
      .get(update.exchange, update.clientOrderId) as Record<string, unknown> | undefined;
  }

  if (existing) {
    db.prepare(
      "UPDATE live_orders SET exchange_order_id = COALESCE(?, exchange_order_id), price = COALESCE(?, price), " +
        "size = COALESCE(?, size), filled = COALESCE(?, filled), status = COALESCE(?, status), updated_at = ? WHERE id = ?",
    ).run(
      update.exchangeOrderId ?? null,
      update.price ?? null,
      update.size ?? null,
      update.filled ?? null,
      update.status ?? null,
      now,
      rowStr(existing.id),
    );
    return;
  }

  if (!update.coin || !update.side || !update.orderType) return;
  insertLiveOrder({
    id: randomUUID(),
    exchange: update.exchange,
    exchangeOrderId: update.exchangeOrderId ?? null,
    clientOrderId: update.clientOrderId ?? null,
    coin: update.coin,
    side: update.side,
    orderType: update.orderType,
    price: update.price ?? 0,
    size: update.size ?? 0,
    status: update.status ?? "open",
    // Our own client id prefix is the only evidence available for an order we
    // learn about from the stream before the REST call returned.
    source: sourceFromClientOrderId(update.clientOrderId) ?? "manual",
  });
}

export function liveOpenOrders(): Order[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM live_orders WHERE status IN ('pending', 'open', 'partial') ORDER BY created_at DESC",
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToOrder);
}

export function liveOrderById(id: string): Order | null {
  const row = getDb().prepare("SELECT * FROM live_orders WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToOrder(row) : null;
}

/** Recent order history, for the trade page's History tab. */
export function liveOrderHistory(limit = 100): Order[] {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = getDb()
    .prepare(
      "SELECT * FROM live_orders WHERE status IN ('filled', 'cancelled') ORDER BY updated_at DESC LIMIT ?",
    )
    .all(capped) as Record<string, unknown>[];
  return rows.map(rowToOrder);
}

/** Venue order id for a local id, needed to cancel through REST. */
export function liveExchangeOrderId(id: string): string | null {
  const row = getDb()
    .prepare("SELECT exchange_order_id FROM live_orders WHERE id = ?")
    .get(id) as { exchange_order_id?: unknown } | undefined;
  const value = rowStr(row?.exchange_order_id, "");
  return value || null;
}

export function markLiveOrderCancelled(id: string): void {
  getDb()
    .prepare("UPDATE live_orders SET status = 'cancelled', updated_at = ? WHERE id = ?")
    .run(Date.now(), id);
}

// ─── Trades ─────────────────────────────────────────────────────────────────

export interface LiveTradeInsert {
  exchange: ExchangeId;
  exchangeTradeId?: string | null;
  /** Venue order id this fill came from, used to recover the source tag. */
  exchangeOrderId?: string | null;
  /** Our own order id echoed back by the venue, same purpose. */
  clientOrderId?: string | null;
  coin: string;
  side: OrderSide;
  price: number;
  size: number;
  fee?: number | null;
  realizedPnl?: number | null;
  hedgeId?: string | null;
  executedAt: number;
}

/**
 * Resolves whether a fill belongs to a manual or automated order.
 *
 * The venue has no idea about that distinction, so it is recovered in two steps:
 * the client order id prefix first — it is present on the very first frame, even
 * before the order row exists — then the stored order row. A fill that matches
 * neither is manual, which is the honest answer: an order placed from the
 * venue's own app was not automated by this webapp.
 */
function tradeSource(
  db: ReturnType<typeof getDb>,
  exchange: ExchangeId,
  exchangeOrderId?: string | null,
  clientOrderId?: string | null,
): TradeSource {
  const fromId = sourceFromClientOrderId(clientOrderId);
  if (fromId) return fromId;

  let row: Record<string, unknown> | undefined;
  if (exchangeOrderId) {
    row = db
      .prepare("SELECT source FROM live_orders WHERE exchange = ? AND exchange_order_id = ?")
      .get(exchange, exchangeOrderId) as Record<string, unknown> | undefined;
  }
  if (!row && clientOrderId) {
    row = db
      .prepare("SELECT source FROM live_orders WHERE exchange = ? AND client_order_id = ?")
      .get(exchange, clientOrderId) as Record<string, unknown> | undefined;
  }
  return row ? rowSource(row.source) : "manual";
}

/** Ignores duplicates so a replayed stream message cannot double-count a fill. */
export function insertLiveTrade(input: LiveTradeInsert): void {
  const db = getDb();
  const source = tradeSource(db, input.exchange, input.exchangeOrderId, input.clientOrderId);
  db.prepare(
    "INSERT OR IGNORE INTO live_trades (id, exchange, exchange_trade_id, coin, side, price, size, fee, realized_pnl, hedge_id, source, executed_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    randomUUID(),
    input.exchange,
    input.exchangeTradeId ?? null,
    input.coin,
    input.side,
    input.price,
    input.size,
    input.fee ?? null,
    input.realizedPnl ?? null,
    input.hedgeId ?? null,
    source,
    input.executedAt,
  );
}

export function liveTrades(limit = 50): Trade[] {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = getDb()
    .prepare("SELECT * FROM live_trades ORDER BY executed_at DESC LIMIT ?")
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
    fee: row.fee === null ? null : rowNum(row.fee),
    source: rowSource(row.source),
    hedgeId: rowStr(row.hedge_id, "") || undefined,
  }));
}

// ─── Balances ───────────────────────────────────────────────────────────────

export interface BalanceUpsert {
  exchange: ExchangeId;
  asset: string;
  available: number;
  inPosition?: number;
  equity?: number;
}

export function upsertLiveBalance(input: BalanceUpsert): void {
  getDb()
    .prepare(
      "INSERT INTO live_balances (exchange, asset, available, in_position, equity, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(exchange, asset) DO UPDATE SET available = excluded.available, in_position = excluded.in_position, " +
        "equity = excluded.equity, updated_at = excluded.updated_at",
    )
    .run(
      input.exchange,
      input.asset,
      input.available,
      input.inPosition ?? 0,
      input.equity ?? input.available,
      Date.now(),
    );
}

export function liveBalances(): VenueBalance[] {
  const rows = getDb()
    .prepare("SELECT * FROM live_balances ORDER BY exchange, asset")
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    exchange: rowStr(row.exchange) as ExchangeId,
    asset: rowStr(row.asset),
    available: rowNum(row.available),
    inPosition: rowNum(row.in_position),
    equity: rowNum(row.equity),
    updatedAt: rowNum(row.updated_at),
  }));
}

/** Drops every cached row for a venue, e.g. when its credentials are removed. */
export function clearLiveVenue(exchange: ExchangeId): void {
  inTransaction((db) => {
    db.prepare("DELETE FROM live_positions WHERE exchange = ?").run(exchange);
    db.prepare("DELETE FROM live_balances WHERE exchange = ?").run(exchange);
  });
}

export function liveSnapshot(venues: LiveAccountSnapshot["venues"]): LiveAccountSnapshot {
  return {
    positions: livePositions(),
    openOrders: liveOpenOrders(),
    recentTrades: liveTrades(30),
    balances: liveBalances(),
    venues,
    updatedAt: Date.now(),
  };
}
