import type { ExchangeId, FundingBridgeConfig } from "@/lib/types";
import { EXCHANGE_IDS } from "@/lib/utils";

/**
 * FundingBridge defaults and validation.
 *
 * Two things about the defaults are worth stating rather than leaving to be inferred.
 *
 * `entrySpread` is a *floor on credit*, not a ceiling on cost. The strategy this was
 * modelled on expressed the same rule inverted — it measured what entering costs and
 * required that number to stay small — which is the same test with the sign flipped.
 * Keeping this app's convention throughout (entry spread = short venue's bid − long
 * venue's ask, so positive means opening in credit) avoids a field whose meaning
 * silently reverses between two strategies on the same screen.
 *
 * `maxHoldMin` only applies when the two legs settle on different cadences, and it is
 * the one bound that cannot be relaxed to nothing. On that path the faster leg keeps
 * paying funding while the slower one has not settled, so a position that never turns
 * profitable does not merely wait — it bleeds.
 */

export const DEFAULT_FUNDINGBRIDGE_CONFIG: FundingBridgeConfig = {
  venues: [...EXCHANGE_IDS],
  maxPositions: 3,
  marginPerLeg: 100,
  leverage: 3,
  entryWindowMin: 30,
  minDiffFr: 0.1,
  entrySpread: 0.02,
  cancelDiffFr: 0.05,
  exitDiffFr: 0.05,
  minProfitSpread: 0.2,
  settleGraceMin: 5,
  maxHoldMin: 120,
};

export class FundingBridgeConfigError extends Error {}

interface Bound {
  min: number;
  max: number;
  integer?: boolean;
}

const BOUNDS: Record<string, Bound> = {
  maxPositions: { min: 1, max: 20, integer: true },
  marginPerLeg: { min: 1, max: 1_000_000 },
  leverage: { min: 1, max: 25 },
  entryWindowMin: { min: 1, max: 240, integer: true },
  minDiffFr: { min: 0.001, max: 100 },
  // Can go negative: a large funding difference can justify paying a little to get
  // in. The floor is what stops an entry at -1%, where convergence toward zero
  // realises the loss rather than recovering it.
  entrySpread: { min: -5, max: 5 },
  cancelDiffFr: { min: 0, max: 100 },
  exitDiffFr: { min: 0, max: 100 },
  minProfitSpread: { min: 0.001, max: 10 },
  // Zero grace is allowed but rarely right: the venue credits the payment on its own
  // schedule, so reading the account a second after the timestamp often misses it.
  settleGraceMin: { min: 0, max: 60, integer: true },
  maxHoldMin: { min: 5, max: 1_440, integer: true },
};

function numberField(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new FundingBridgeConfigError(`${field} must be a number`);
  const bound = BOUNDS[field];
  if (!bound) return n;
  if (n < bound.min || n > bound.max) {
    throw new FundingBridgeConfigError(`${field} must be between ${bound.min} and ${bound.max}`);
  }
  return bound.integer ? Math.trunc(n) : n;
}

function venueField(value: unknown, fallback: ExchangeId[]): ExchangeId[] {
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value)) throw new FundingBridgeConfigError("venues must be an array");
  const out: ExchangeId[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !(EXCHANGE_IDS as string[]).includes(entry)) {
      throw new FundingBridgeConfigError(`venues contains an unknown exchange: ${String(entry)}`);
    }
    if (!out.includes(entry as ExchangeId)) out.push(entry as ExchangeId);
  }
  if (out.length < 2) {
    throw new FundingBridgeConfigError(
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
export function parseFundingBridgeConfig(
  patch: Record<string, unknown>,
  base: FundingBridgeConfig = DEFAULT_FUNDINGBRIDGE_CONFIG,
): FundingBridgeConfig {
  const next: FundingBridgeConfig = {
    venues: venueField(patch.venues, base.venues),
    maxPositions: numberField(patch.maxPositions, "maxPositions", base.maxPositions),
    marginPerLeg: numberField(patch.marginPerLeg, "marginPerLeg", base.marginPerLeg),
    leverage: numberField(patch.leverage, "leverage", base.leverage),
    entryWindowMin: numberField(patch.entryWindowMin, "entryWindowMin", base.entryWindowMin),
    minDiffFr: numberField(patch.minDiffFr, "minDiffFr", base.minDiffFr),
    entrySpread: numberField(patch.entrySpread, "entrySpread", base.entrySpread),
    cancelDiffFr: numberField(patch.cancelDiffFr, "cancelDiffFr", base.cancelDiffFr),
    exitDiffFr: numberField(patch.exitDiffFr, "exitDiffFr", base.exitDiffFr),
    minProfitSpread: numberField(patch.minProfitSpread, "minProfitSpread", base.minProfitSpread),
    settleGraceMin: numberField(patch.settleGraceMin, "settleGraceMin", base.settleGraceMin),
    maxHoldMin: numberField(patch.maxHoldMin, "maxHoldMin", base.maxHoldMin),
  };

  // Cross-field checks: each value above is individually valid, and these
  // combinations are the ones that are jointly nonsensical.
  if (next.cancelDiffFr >= next.minDiffFr) {
    throw new FundingBridgeConfigError(
      "cancelDiffFr must be below minDiffFr, otherwise every locked target is dropped on the cycle after it is locked",
    );
  }
  if (next.exitDiffFr >= next.minDiffFr) {
    throw new FundingBridgeConfigError(
      "exitDiffFr must be below minDiffFr, otherwise a position starts leaving the moment it opens",
    );
  }
  if (next.maxHoldMin <= next.settleGraceMin) {
    throw new FundingBridgeConfigError(
      `maxHoldMin (${next.maxHoldMin}m) must exceed settleGraceMin (${next.settleGraceMin}m), ` +
        `or the hold limit fires before the payment has had time to land`,
    );
  }
  return next;
}

/** Reads a stored JSON config, falling back to defaults for anything invalid. */
export function readStoredFundingBridgeConfig(raw: string): FundingBridgeConfig {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return { ...DEFAULT_FUNDINGBRIDGE_CONFIG };
    }
    return parseFundingBridgeConfig(parsed as Record<string, unknown>);
  } catch {
    // A config that cannot be parsed must not stop the engine from reporting state;
    // the defaults are safe because `enabled` is stored separately.
    return { ...DEFAULT_FUNDINGBRIDGE_CONFIG };
  }
}

/** Notional traded per leg, which is what the venue sees. */
export function fundingBridgeNotional(config: FundingBridgeConfig): number {
  return config.marginPerLeg * config.leverage;
}
