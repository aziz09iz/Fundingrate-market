import type { ExchangeId, FundingYieldConfig } from "@/lib/types";
import { DEFAULT_TAKER_FEES } from "@/lib/fees-shared";
import { EXCHANGE_IDS } from "@/lib/utils";

/**
 * FundingYield defaults and validation.
 *
 * The defaults encode the arithmetic the strategy exists to exploit, so they are worth
 * reading rather than skimming — and they only make sense together, which is why
 * `parseFundingYieldConfig` checks them against each other rather than one at a time.
 *
 * A round trip on the default venue set costs about 0.24% of one leg's notional: four
 * taker fills on the worst pair among them. At $200 per leg that is $0.48, paid once.
 * One settlement at a 0.05% normalized difference earns $0.10.
 *
 * So five payments cover the fees and the rest is profit. `targetSettlements` defaults
 * to 10 — twice the break-even count — because a target at break-even projects zero and
 * every candidate would be blocked. Ten payments project $1.00 gross against $0.48 in
 * fees, leaving about $0.52 before the round trip's spread cost.
 *
 * `minDiffFr` is 0.05 against the 0.1 the other funding strategies use. They enter for a
 * single payment and therefore need a spike; this one amortises, so a moderate difference
 * that persists is worth more than a large one that lasts an hour. The lower floor is
 * what lets it see those coins at all.
 */

export const DEFAULT_FUNDINGYIELD_CONFIG: FundingYieldConfig = {
  venues: [...EXCHANGE_IDS],
  maxPositions: 3,
  marginPerLeg: 100,
  leverage: 2,
  minDiffFr: 0.05,
  targetSettlements: 10,
  minNetYieldUsd: 0.25,
  maxSpreadCostPct: 0.4,
  profitTargetMultiple: 1.5,
  stopLossUsd: 5,
  exitOnReversal: true,
  maxHoldHours: 72,
};

export class FundingYieldConfigError extends Error {}

interface Bound {
  min: number;
  max: number;
  integer?: boolean;
}

const BOUNDS: Record<string, Bound> = {
  maxPositions: { min: 1, max: 20, integer: true },
  marginPerLeg: { min: 1, max: 1_000_000 },
  leverage: { min: 1, max: 25 },
  minDiffFr: { min: 0.001, max: 100 },
  // At least one: a target of zero settlements would mean the fees are considered
  // paid off before any funding has been collected.
  targetSettlements: { min: 1, max: 30, integer: true },
  // Can be zero — "any positive projection will do" is a coherent choice — but not
  // negative, which would be asking to enter positions expected to lose.
  minNetYieldUsd: { min: 0, max: 10_000 },
  maxSpreadCostPct: { min: 0.01, max: 5 },
  // Below 1 the position closes before its fees are covered, which is the one setting
  // that guarantees a loss on every trade.
  profitTargetMultiple: { min: 1, max: 20 },
  // Zero is refused rather than treated as "no stop": this strategy holds for days,
  // and an unbounded loss is the risk it was built to accept in exchange for the
  // settlement deadline it gave up.
  stopLossUsd: { min: 0.5, max: 100_000 },
  // Zero disables the backstop, which is allowed — the stop-loss and the reversal exit
  // still bound the position.
  maxHoldHours: { min: 0, max: 720, integer: true },
};

function numberField(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new FundingYieldConfigError(`${field} must be a number`);
  const bound = BOUNDS[field];
  if (!bound) return n;
  if (n < bound.min || n > bound.max) {
    throw new FundingYieldConfigError(`${field} must be between ${bound.min} and ${bound.max}`);
  }
  return bound.integer ? Math.trunc(n) : n;
}

function boolField(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true";
}

function venueField(value: unknown, fallback: ExchangeId[]): ExchangeId[] {
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value)) throw new FundingYieldConfigError("venues must be an array");
  const out: ExchangeId[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !(EXCHANGE_IDS as string[]).includes(entry)) {
      throw new FundingYieldConfigError(`venues contains an unknown exchange: ${String(entry)}`);
    }
    if (!out.includes(entry as ExchangeId)) out.push(entry as ExchangeId);
  }
  if (out.length < 2) {
    throw new FundingYieldConfigError(
      "venues must include at least two exchanges to hedge across",
    );
  }
  return out;
}

/**
 * Validates a partial config against a base, returning a complete config. Throws
 * rather than clamping, so a value that would be silently changed is refused where
 * the user can see it.
 */
export function parseFundingYieldConfig(
  patch: Record<string, unknown>,
  base: FundingYieldConfig = DEFAULT_FUNDINGYIELD_CONFIG,
): FundingYieldConfig {
  const next: FundingYieldConfig = {
    venues: venueField(patch.venues, base.venues),
    maxPositions: numberField(patch.maxPositions, "maxPositions", base.maxPositions),
    marginPerLeg: numberField(patch.marginPerLeg, "marginPerLeg", base.marginPerLeg),
    leverage: numberField(patch.leverage, "leverage", base.leverage),
    minDiffFr: numberField(patch.minDiffFr, "minDiffFr", base.minDiffFr),
    targetSettlements: numberField(
      patch.targetSettlements,
      "targetSettlements",
      base.targetSettlements,
    ),
    minNetYieldUsd: numberField(patch.minNetYieldUsd, "minNetYieldUsd", base.minNetYieldUsd),
    maxSpreadCostPct: numberField(patch.maxSpreadCostPct, "maxSpreadCostPct", base.maxSpreadCostPct),
    profitTargetMultiple: numberField(
      patch.profitTargetMultiple,
      "profitTargetMultiple",
      base.profitTargetMultiple,
    ),
    stopLossUsd: numberField(patch.stopLossUsd, "stopLossUsd", base.stopLossUsd),
    exitOnReversal: boolField(patch.exitOnReversal, base.exitOnReversal),
    maxHoldHours: numberField(patch.maxHoldHours, "maxHoldHours", base.maxHoldHours),
  };

  // Cross-field checks: each value above is individually valid, and these combinations
  // are the ones that are jointly nonsensical.
  const notional = next.marginPerLeg * next.leverage;
  if (next.stopLossUsd >= notional) {
    throw new FundingYieldConfigError(
      `stopLossUsd ($${next.stopLossUsd}) must be below one leg's notional ($${notional.toFixed(0)}), ` +
        `or the stop can never fire before the position is liquidated`,
    );
  }

  // The settlement target has to outrun the fees, or the projection is negative before
  // the spread cost is even measured and every candidate is blocked. Checked here rather
  // than left to the UI because a config saved through the API bypasses the form.
  const feeUsd = (worstRoundTripPct(next.venues) / 100) * notional;
  const perSettlementUsd = (next.minDiffFr / 100) * notional;
  const grossUsd = perSettlementUsd * next.targetSettlements;
  if (grossUsd <= feeUsd) {
    const needed = perSettlementUsd > 0 ? Math.ceil(feeUsd / perSettlementUsd) : 0;
    throw new FundingYieldConfigError(
      `${next.targetSettlements} settlements at ${next.minDiffFr}% yields $${grossUsd.toFixed(2)}, ` +
        `which does not cover the $${feeUsd.toFixed(2)} round trip on these venues. ` +
        `Raise targetSettlements to at least ${needed + 1}, or raise minDiffFr.`,
    );
  }
  if (next.minNetYieldUsd >= grossUsd - feeUsd) {
    throw new FundingYieldConfigError(
      `minNetYieldUsd ($${next.minNetYieldUsd}) is unreachable: ${next.targetSettlements} settlements ` +
        `at ${next.minDiffFr}% is $${grossUsd.toFixed(2)} gross, leaving ` +
        `$${(grossUsd - feeUsd).toFixed(2)} after the $${feeUsd.toFixed(2)} round trip. ` +
        `Lower the floor, or raise minDiffFr or targetSettlements.`,
    );
  }
  return next;
}

/**
 * Worst-case round trip fee across a venue set, as a percent of one leg's notional.
 *
 * Mirrors `maxRoundTripFeePct` in lib/db/fees.ts but reads the shipped defaults rather
 * than the saved fee table, because this module is imported by the browser and must not
 * open the database. The saved table is what the engine's own gate uses; this is for
 * refusing a config that cannot work on any plausible fee schedule.
 */
function worstRoundTripPct(venues: ExchangeId[]): number {
  const pcts = venues.map((v) => DEFAULT_TAKER_FEES[v] ?? 0.06).sort((a, b) => b - a);
  if (pcts.length === 0) return 0;
  return Number((((pcts[0] ?? 0) + (pcts[1] ?? pcts[0] ?? 0)) * 2).toFixed(6));
}

/** Reads a stored JSON config, falling back to defaults for anything invalid. */
export function readStoredFundingYieldConfig(raw: string): FundingYieldConfig {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return { ...DEFAULT_FUNDINGYIELD_CONFIG };
    }
    return parseFundingYieldConfig(parsed as Record<string, unknown>);
  } catch {
    // A config that cannot be parsed must not stop the engine from reporting state;
    // the defaults are safe because `enabled` is stored separately.
    return { ...DEFAULT_FUNDINGYIELD_CONFIG };
  }
}

/** Notional traded per leg, which is what the venue sees. */
export function fundingYieldNotional(config: FundingYieldConfig): number {
  return config.marginPerLeg * config.leverage;
}
