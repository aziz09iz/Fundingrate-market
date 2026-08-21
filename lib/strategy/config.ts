import type { ExchangeId, StrategyConfig } from "@/lib/types";
import { EXCHANGE_IDS } from "@/lib/utils";

/**
 * FundingSync defaults and validation.
 *
 * The defaults are the values the strategy was specified with. Everything is
 * editable, but the bounds here are not decoration: a zero entry window would
 * never fire, and a `minDiffFr` of zero would enter on noise, paying two sets of
 * taker fees to harvest nothing.
 */

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  venues: [...EXCHANGE_IDS],
  maxPositions: 4,
  marginPerLeg: 100,
  leverage: 2,
  entryWindowMin: 30,
  minDiffFr: 0.1,
  entryMode: "delay",
  minEntrySpread: 0.02,
  cancelDiffFr: 0.05,
  exitDiffFr: 0.05,
  minProfitSpread: 0.2,
  maxExitSpread: 0.02,
  exitAfterFunding: true,
  holdForSpreadAfterFunding: true,
  holdForSpreadAfterDecay: true,
};

export class StrategyConfigError extends Error {}

interface Bound {
  min: number;
  max: number;
  integer?: boolean;
}

/** Bounds per numeric field, chosen so a valid config can actually trade. */
const BOUNDS: Record<string, Bound> = {
  maxPositions: { min: 1, max: 20, integer: true },
  marginPerLeg: { min: 1, max: 1_000_000 },
  leverage: { min: 1, max: 25 },
  entryWindowMin: { min: 1, max: 240, integer: true },
  minDiffFr: { min: 0.001, max: 100 },
  // Can go negative: a large funding difference can justify paying a little to
  // get in. The floor stops the case that was actually losing money — opening at
  // -1% and watching the spread converge to zero.
  minEntrySpread: { min: -5, max: 5 },
  cancelDiffFr: { min: 0, max: 100 },
  exitDiffFr: { min: 0, max: 100 },
  minProfitSpread: { min: 0.001, max: 10 },
  maxExitSpread: { min: 0.001, max: 5 },
};

function numberField(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new StrategyConfigError(`${field} must be a number`);
  const bound = BOUNDS[field];
  if (!bound) return n;
  if (n < bound.min || n > bound.max) {
    throw new StrategyConfigError(`${field} must be between ${bound.min} and ${bound.max}`);
  }
  return bound.integer ? Math.trunc(n) : n;
}

function boolField(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function venueField(value: unknown, fallback: ExchangeId[]): ExchangeId[] {
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value)) throw new StrategyConfigError("venues must be an array");
  const out: ExchangeId[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !(EXCHANGE_IDS as string[]).includes(entry)) {
      throw new StrategyConfigError(`venues contains an unknown exchange: ${String(entry)}`);
    }
    if (!out.includes(entry as ExchangeId)) out.push(entry as ExchangeId);
  }
  // A hedge needs two sides. One venue is not a configuration, it is a mistake.
  if (out.length < 2) {
    throw new StrategyConfigError("venues must include at least two exchanges to hedge across");
  }
  return out;
}

/**
 * Validates a partial config against a base, returning a complete config.
 * Throws `StrategyConfigError` rather than silently clamping: a value the user
 * typed that means something different from what gets used is worse than a
 * rejection they can see.
 */
export function parseStrategyConfig(
  patch: Record<string, unknown>,
  base: StrategyConfig = DEFAULT_STRATEGY_CONFIG,
): StrategyConfig {
  const next: StrategyConfig = {
    venues: venueField(patch.venues, base.venues),
    maxPositions: numberField(patch.maxPositions, "maxPositions", base.maxPositions),
    marginPerLeg: numberField(patch.marginPerLeg, "marginPerLeg", base.marginPerLeg),
    leverage: numberField(patch.leverage, "leverage", base.leverage),
    entryWindowMin: numberField(patch.entryWindowMin, "entryWindowMin", base.entryWindowMin),
    minDiffFr: numberField(patch.minDiffFr, "minDiffFr", base.minDiffFr),
    entryMode:
      patch.entryMode === "instant" || patch.entryMode === "delay"
        ? patch.entryMode
        : base.entryMode,
    minEntrySpread: numberField(patch.minEntrySpread, "minEntrySpread", base.minEntrySpread),
    cancelDiffFr: numberField(patch.cancelDiffFr, "cancelDiffFr", base.cancelDiffFr),
    exitDiffFr: numberField(patch.exitDiffFr, "exitDiffFr", base.exitDiffFr),
    minProfitSpread: numberField(patch.minProfitSpread, "minProfitSpread", base.minProfitSpread),
    maxExitSpread: numberField(patch.maxExitSpread, "maxExitSpread", base.maxExitSpread),
    exitAfterFunding: boolField(patch.exitAfterFunding, base.exitAfterFunding),
    holdForSpreadAfterFunding: boolField(
      patch.holdForSpreadAfterFunding,
      base.holdForSpreadAfterFunding,
    ),
    holdForSpreadAfterDecay: boolField(
      patch.holdForSpreadAfterDecay,
      base.holdForSpreadAfterDecay,
    ),
  };

  // Cross-field checks. These catch configurations that are individually valid
  // but jointly nonsensical.
  if (next.cancelDiffFr >= next.minDiffFr) {
    throw new StrategyConfigError(
      "cancelDiffFr must be below minDiffFr, otherwise every queued entry cancels immediately",
    );
  }
  if (next.exitDiffFr >= next.minDiffFr) {
    throw new StrategyConfigError(
      "exitDiffFr must be below minDiffFr, otherwise a position exits the moment it opens",
    );
  }
  return next;
}

/**
 * Reads a stored JSON config, falling back to defaults for anything invalid.
 *
 * `maxEntrySpread` is accepted as an alias so a config saved before the entry gate
 * was corrected still loads. The old field meant "tolerate paying up to this much
 * to get in", which allowed the entries that lost money; the stored number is
 * therefore not carried over — the default floor is used instead.
 */
export function readStoredConfig(raw: string): StrategyConfig {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_STRATEGY_CONFIG };
    const record = { ...(parsed as Record<string, unknown>) };
    delete record.maxEntrySpread;
    return parseStrategyConfig(record);
  } catch {
    // A config that cannot be parsed must not stop the engine from reporting
    // state; the defaults are safe because `enabled` is stored separately.
    return { ...DEFAULT_STRATEGY_CONFIG };
  }
}

/** Notional traded per leg, which is what the venue sees. */
export function notionalPerLeg(config: StrategyConfig): number {
  return config.marginPerLeg * config.leverage;
}
