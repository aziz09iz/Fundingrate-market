import type { ExchangeId } from "@/lib/types";
import { getDb, rowNum, rowStr } from "@/lib/db/client";
import { DEFAULT_TAKER_FEES } from "@/lib/fees-shared";
import { EXCHANGE_IDS } from "@/lib/utils";

/**
 * Trading fees for the paper account.
 *
 * These matter more than they look. A hedge opens two legs and closes two legs, so
 * a round trip pays taker fees four times — roughly 0.2% of notional on typical
 * venues. A simulated hedge that ignores this looks profitable at spreads where the
 * real one loses money, which makes paper results actively misleading rather than
 * merely optimistic.
 *
 * Defaults live in lib/fees-shared.ts so the browser can read them without opening
 * the database. They are editable because a VIP tier, a fee token discount, or a
 * promo changes them, and this app cannot see your tier.
 */

export type FeeRates = Record<ExchangeId, number>;

export { DEFAULT_TAKER_FEES };

/** Sanity bound: above this a "fee" is almost certainly a typo, not a tier. */
const MAX_FEE_PCT = 1;

export class FeeConfigError extends Error {}

function parseRates(raw: string): FeeRates {
  const out = { ...DEFAULT_TAKER_FEES };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return out;
    for (const id of EXCHANGE_IDS) {
      const value = (parsed as Record<string, unknown>)[id];
      const n = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(n) && n >= 0 && n <= MAX_FEE_PCT) out[id] = n;
    }
  } catch {
    // A corrupt row falls back to defaults rather than breaking every fill.
  }
  return out;
}

/** Reads the stored fee table, creating the row on first use. */
export function getFeeRates(): FeeRates {
  const db = getDb();
  const row = db.prepare("SELECT rates FROM fee_config WHERE id = 1").get() as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    db.prepare("INSERT INTO fee_config (id, rates, updated_at) VALUES (1, ?, ?)").run(
      JSON.stringify(DEFAULT_TAKER_FEES),
      Date.now(),
    );
    return { ...DEFAULT_TAKER_FEES };
  }
  return parseRates(rowStr(row.rates, "{}"));
}

/** Validates and stores the fee table. Rejects rather than clamps. */
export function saveFeeRates(patch: Record<string, unknown>): FeeRates {
  const current = getFeeRates();
  const next = { ...current };
  for (const id of EXCHANGE_IDS) {
    const value = patch[id];
    if (value === undefined || value === null || value === "") continue;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) throw new FeeConfigError(`${id} fee must be a number`);
    if (n < 0) throw new FeeConfigError(`${id} fee cannot be negative`);
    if (n > MAX_FEE_PCT) {
      throw new FeeConfigError(
        `${id} fee of ${n}% looks wrong — fees are entered in percent, so 0.05 means 0.05%`,
      );
    }
    next[id] = n;
  }
  getFeeRates();
  getDb()
    .prepare("UPDATE fee_config SET rates = ?, updated_at = ? WHERE id = 1")
    .run(JSON.stringify(next), Date.now());
  return getFeeRates();
}

/** Fee in quote currency for one fill. */
export function fillFee(exchange: ExchangeId, price: number, size: number, rates?: FeeRates): number {
  const table = rates ?? getFeeRates();
  const pct = table[exchange] ?? DEFAULT_TAKER_FEES[exchange];
  const notional = Math.abs(price * size);
  return Number(((notional * pct) / 100).toFixed(8));
}

/**
 * Total taker fees for one hedge round trip, as a percent of a single leg's
 * notional: both venues, opened and closed.
 *
 * This is the number a profit target has to clear. Expressed per leg notional so
 * it can be compared directly against a spread percentage — both legs carry the
 * same notional, so the four fills sum to (longPct + shortPct) × 2.
 */
export function roundTripFeePct(
  longExchange: ExchangeId,
  shortExchange: ExchangeId,
  rates?: FeeRates,
): number {
  const table = rates ?? getFeeRates();
  const long = table[longExchange] ?? DEFAULT_TAKER_FEES[longExchange];
  const short = table[shortExchange] ?? DEFAULT_TAKER_FEES[shortExchange];
  return Number(((long + short) * 2).toFixed(6));
}

/**
 * Worst-case round trip fee across the configured venues, for decisions that are
 * not tied to one pair. Worst case rather than average: a target that clears the
 * average still loses money on the expensive pairs.
 */
export function maxRoundTripFeePct(venues: ExchangeId[], rates?: FeeRates): number {
  const table = rates ?? getFeeRates();
  const pcts = venues.map((v) => table[v] ?? DEFAULT_TAKER_FEES[v]).sort((a, b) => b - a);
  if (pcts.length === 0) return 0;
  const worstPair = (pcts[0] ?? 0) + (pcts[1] ?? pcts[0] ?? 0);
  return Number((worstPair * 2).toFixed(6));
}

/** Total fees charged to the paper account since the last reset. */
export function paperFeesPaid(): number {
  const row = getDb().prepare("SELECT fees_paid FROM paper_state WHERE id = 1").get() as
    | Record<string, unknown>
    | undefined;
  return row ? rowNum(row.fees_paid) : 0;
}
