import type { ExchangeId, MarketSnapshot, TradeSource } from "@/lib/types";
import { creditFunding, type FundingCredit } from "@/lib/db/funding";
import { getDb, rowNum, rowStr } from "@/lib/db/client";

/**
 * Settles funding payments on open paper positions.
 *
 * Each leg is paid on its own venue's schedule, using that venue's rate. That is
 * what a real account experiences, and it is the only way a mismatched-interval
 * pair behaves correctly — a 1h leg pays four times before its 4h partner pays
 * once.
 *
 * Settlement times are *derived* rather than watched for. Venues publish the
 * upcoming settlement, so the payments that already happened are
 * `nextFundingTime − k × interval`. Stepping back from the published clock makes
 * this deterministic and restart-safe: no in-memory record of "what we saw last
 * tick" is needed, and the unique index on paper_funding makes a repeat credit
 * impossible rather than merely unlikely.
 */

/**
 * How far back to look for missed settlements. Bounded so a position that was
 * open while the server was down does not suddenly book a day of payments from a
 * single current rate — the rate then is not evidence of the rate at the time.
 */
const MAX_LOOKBACK_MS = 2 * 60 * 60_000;

/** Most settlements credited per leg per sweep. */
const MAX_STEPS = 8;

interface Leg {
  exchange: ExchangeId;
  coin: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  openedAt: number;
  hedgeId: string | null;
  source: TradeSource;
}

function openLegs(): Leg[] {
  const rows = getDb()
    .prepare(
      "SELECT exchange, coin, side, size, entry_price, opened_at, hedge_id, source FROM paper_positions",
    )
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    exchange: rowStr(row.exchange) as ExchangeId,
    coin: rowStr(row.coin),
    side: rowStr(row.side) as "long" | "short",
    size: rowNum(row.size),
    entryPrice: rowNum(row.entry_price),
    openedAt: rowNum(row.opened_at),
    hedgeId: rowStr(row.hedge_id, "") || null,
    source: rowStr(row.source, "manual") === "auto" ? "auto" : "manual",
  }));
}

/**
 * Settlements that have already happened for a leg: stepping back from the
 * venue's published next settlement, while still after the position was opened.
 * Newest first.
 */
export function pastSettlements(
  nextFundingTime: number,
  intervalHours: number,
  openedAt: number,
  now: number,
): number[] {
  if (!nextFundingTime || !intervalHours || intervalHours <= 0) return [];
  const step = intervalHours * 3_600_000;
  const out: number[] = [];
  for (let k = 1; k <= MAX_STEPS; k++) {
    const t = nextFundingTime - k * step;
    if (t > now) continue;
    if (t <= openedAt) break;
    if (now - t > MAX_LOOKBACK_MS) break;
    out.push(t);
  }
  return out;
}

export interface SweepResult {
  credits: FundingCredit[];
  /** Legs skipped because no live rate was available, with the reason. */
  skipped: { coin: string; exchange: ExchangeId; reason: string }[];
}

/**
 * Credits every funding payment that has come due on an open paper position.
 *
 * Settles all open paper legs, not only strategy ones: a venue charges funding on
 * whatever is open, regardless of what put it there.
 */
export function sweepFunding(snapshot: MarketSnapshot, now = Date.now()): SweepResult {
  const credits: FundingCredit[] = [];
  const skipped: SweepResult["skipped"] = [];

  for (const leg of openLegs()) {
    const row = snapshot.rows.find((r) => r.coin === leg.coin);
    const value = row?.rates[leg.exchange];
    if (!value || value.rate === null || !value.nextFundingTime) {
      // Skip rather than guess: a payment invented from a missing rate is
      // indistinguishable from a real one once it is in the ledger.
      skipped.push({
        coin: leg.coin,
        exchange: leg.exchange,
        reason: "no live funding rate for this venue",
      });
      continue;
    }
    // An unconfirmed interval means the cadence is still a default guess, and the
    // step size is exactly what this calculation depends on.
    if (value.intervalConfirmed !== true) {
      skipped.push({
        coin: leg.coin,
        exchange: leg.exchange,
        reason: "funding interval not confirmed, so settlement times are unknown",
      });
      continue;
    }

    const notional = leg.size * leg.entryPrice;
    for (const fundingTime of pastSettlements(
      value.nextFundingTime,
      value.intervalHours,
      leg.openedAt,
      now,
    )) {
      const credit = creditFunding({
        exchange: leg.exchange,
        coin: leg.coin,
        side: leg.side,
        ratePct: value.rate,
        notional,
        fundingTime,
        hedgeId: leg.hedgeId,
        source: leg.source,
      });
      if (credit) credits.push(credit);
    }
  }

  return { credits, skipped };
}
