import { randomUUID } from "node:crypto";
import type { ExchangeId, TradeSource } from "@/lib/types";
import { DEFAULT_PAPER_BALANCE } from "@/lib/types";
import { getDb, inTransaction, rowNum, rowStr } from "@/lib/db/client";

/**
 * Funding payments for the paper account.
 *
 * Without this the simulation earned nothing from the only thing this strategy
 * exists to harvest: every hedge could only lose fees and spread, so paper was
 * not a conservative version of the real result — it was a different strategy.
 *
 * Each leg is settled on its own venue's schedule and its own rate, which is what
 * actually happens. Pairs with mismatched intervals therefore behave correctly:
 * a 1h leg pays four times before a 4h leg pays once.
 *
 * Sign convention: a positive funding rate means longs pay shorts. So the amount
 * credited to a leg is `-side * rate% * notional`, with side +1 for long and -1
 * for short.
 */

export interface FundingCredit {
  exchange: ExchangeId;
  coin: string;
  side: "long" | "short";
  /** Venue rate for this settlement, in percent. */
  ratePct: number;
  /** Position notional at settlement, in quote currency. */
  notional: number;
  /** Signed amount credited: positive is received, negative is paid. */
  amount: number;
  fundingTime: number;
  hedgeId?: string | null;
  source: TradeSource;
  creditedAt: number;
}

/** Amount a leg receives (positive) or pays (negative) at one settlement. */
export function fundingAmount(
  side: "long" | "short",
  ratePct: number,
  notional: number,
): number {
  const direction = side === "long" ? 1 : -1;
  return Number(((-direction * ratePct * Math.abs(notional)) / 100).toFixed(8));
}

export interface CreditInput {
  exchange: ExchangeId;
  coin: string;
  side: "long" | "short";
  ratePct: number;
  notional: number;
  fundingTime: number;
  hedgeId?: string | null;
  source?: TradeSource;
}

/**
 * Credits one settlement for one leg, or returns null when it was already
 * credited.
 *
 * The idempotency is not incidental: the engine ticks every five seconds and a
 * settlement stays recently-passed for minutes, so without the unique constraint
 * on (exchange, coin, side, funding_time) the same payment would be booked
 * dozens of times. The constraint lives in the schema rather than in a check
 * here, so a concurrent tick cannot slip between a read and a write.
 */
export function creditFunding(input: CreditInput): FundingCredit | null {
  const amount = fundingAmount(input.side, input.ratePct, input.notional);
  const source: TradeSource = input.source ?? "manual";
  const now = Date.now();

  return inTransaction((db) => {
    const result = db
      .prepare(
        "INSERT OR IGNORE INTO paper_funding (id, exchange, coin, side, rate_pct, notional, amount, funding_time, hedge_id, source, credited_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        input.exchange,
        input.coin,
        input.side,
        input.ratePct,
        Math.abs(input.notional),
        amount,
        input.fundingTime,
        input.hedgeId ?? null,
        source,
        now,
      );

    // Already credited: no ledger movement, and the caller is told so it can
    // avoid logging a payment twice.
    if (Number(result.changes) === 0) return null;

    // Create the state row if this is the first thing to touch the account. A
    // bare UPDATE silently changed nothing here, so the payment was recorded but
    // never reached the balance.
    db.prepare(
      "INSERT INTO paper_state (id, starting_balance, realized_pnl, fees_paid, funding_pnl, reset_at, created_at) " +
        "VALUES (1, ?, ?, 0, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET realized_pnl = realized_pnl + excluded.realized_pnl, " +
        "funding_pnl = funding_pnl + excluded.funding_pnl",
    ).run(DEFAULT_PAPER_BALANCE, amount, amount, now, now);
    db.prepare(
      "INSERT INTO paper_pnl_daily (day, realized_pnl) VALUES (?, ?) " +
        "ON CONFLICT(day) DO UPDATE SET realized_pnl = realized_pnl + excluded.realized_pnl",
    ).run(new Date(now).toISOString().slice(0, 10), amount);

    return {
      exchange: input.exchange,
      coin: input.coin,
      side: input.side,
      ratePct: input.ratePct,
      notional: Math.abs(input.notional),
      amount,
      fundingTime: input.fundingTime,
      hedgeId: input.hedgeId ?? null,
      source,
      creditedAt: now,
    };
  });
}

/** Recent funding credits, newest first. */
export function paperFundingHistory(limit = 50): FundingCredit[] {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = getDb()
    .prepare("SELECT * FROM paper_funding ORDER BY credited_at DESC LIMIT ?")
    .all(capped) as Record<string, unknown>[];
  return rows.map((row) => ({
    exchange: rowStr(row.exchange) as ExchangeId,
    coin: rowStr(row.coin),
    side: rowStr(row.side) as "long" | "short",
    ratePct: rowNum(row.rate_pct),
    notional: rowNum(row.notional),
    amount: rowNum(row.amount),
    fundingTime: rowNum(row.funding_time),
    hedgeId: rowStr(row.hedge_id, "") || null,
    source: rowStr(row.source, "manual") === "auto" ? "auto" : "manual",
    creditedAt: rowNum(row.credited_at),
  }));
}

/** Total funding credited since the last reset. */
export function paperFundingTotal(): number {
  const row = getDb().prepare("SELECT funding_pnl FROM paper_state WHERE id = 1").get() as
    | Record<string, unknown>
    | undefined;
  return row ? rowNum(row.funding_pnl) : 0;
}

/**
 * Funding credited per hedge id, and per coin for legs with no hedge id.
 *
 * Two maps rather than one because the grouping differs: an automated hedge is
 * identified by its id, while manual legs only share a coin. Returned together so
 * the account view can attribute funding to a row without a second query.
 */
export function paperFundingByHedge(): {
  byHedge: Record<string, number>;
  byCoin: Record<string, number>;
} {
  const rows = getDb()
    .prepare(
      "SELECT hedge_id, coin, SUM(amount) AS total FROM paper_funding GROUP BY hedge_id, coin",
    )
    .all() as Record<string, unknown>[];

  const byHedge: Record<string, number> = {};
  const byCoin: Record<string, number> = {};
  for (const row of rows) {
    const amount = rowNum(row.total);
    const hedgeId = rowStr(row.hedge_id, "");
    const coin = rowStr(row.coin);
    if (hedgeId) {
      byHedge[hedgeId] = Number(((byHedge[hedgeId] ?? 0) + amount).toFixed(6));
    } else {
      byCoin[coin] = Number(((byCoin[coin] ?? 0) + amount).toFixed(6));
    }
  }
  return { byHedge, byCoin };
}
