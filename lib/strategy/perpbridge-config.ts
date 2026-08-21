import type { ExchangeId, PerpBridgeConfig } from "@/lib/types";
import { EXCHANGE_IDS } from "@/lib/utils";

/**
 * PerpBridge defaults and validation.
 *
 * The one rule worth stating plainly: `minEntrySpread` has to stay comfortably
 * above the round trip's fees. The gap *is* the profit for this strategy — there
 * is no funding income to fall back on — so entering at a gap smaller than the
 * fees is a guaranteed loss dressed up as a trade. Four taker fills come to
 * roughly 0.2%, which is why the default entry floor is 0.5%.
 */

export const DEFAULT_PERPBRIDGE_CONFIG: PerpBridgeConfig = {
  venues: [...EXCHANGE_IDS],
  maxPositions: 5,
  marginPerLeg: 100,
  leverage: 2,
  minEntrySpread: 0.5,
  minProfitSpread: 0.2,
};

export class PerpBridgeConfigError extends Error {}

interface Bound {
  min: number;
  max: number;
  integer?: boolean;
}

const BOUNDS: Record<string, Bound> = {
  maxPositions: { min: 1, max: 20, integer: true },
  marginPerLeg: { min: 1, max: 1_000_000 },
  leverage: { min: 1, max: 25 },
  // Strictly positive: a zero or negative gap has nothing to earn back.
  minEntrySpread: { min: 0.01, max: 20 },
  minProfitSpread: { min: 0.01, max: 20 },
};

function numberField(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new PerpBridgeConfigError(`${field} must be a number`);
  const bound = BOUNDS[field];
  if (!bound) return n;
  if (n < bound.min || n > bound.max) {
    throw new PerpBridgeConfigError(`${field} must be between ${bound.min} and ${bound.max}`);
  }
  return bound.integer ? Math.trunc(n) : n;
}

function venueField(value: unknown, fallback: ExchangeId[]): ExchangeId[] {
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value)) throw new PerpBridgeConfigError("venues must be an array");
  const out: ExchangeId[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !(EXCHANGE_IDS as string[]).includes(entry)) {
      throw new PerpBridgeConfigError(`venues contains an unknown exchange: ${String(entry)}`);
    }
    if (!out.includes(entry as ExchangeId)) out.push(entry as ExchangeId);
  }
  if (out.length < 2) {
    throw new PerpBridgeConfigError("venues must include at least two exchanges to hedge across");
  }
  return out;
}

/**
 * Validates a partial config against a base, returning a complete config. Throws
 * rather than clamping, so a value that would be silently changed is refused
 * where the user can see it.
 */
export function parsePerpBridgeConfig(
  patch: Record<string, unknown>,
  base: PerpBridgeConfig = DEFAULT_PERPBRIDGE_CONFIG,
): PerpBridgeConfig {
  const next: PerpBridgeConfig = {
    venues: venueField(patch.venues, base.venues),
    maxPositions: numberField(patch.maxPositions, "maxPositions", base.maxPositions),
    marginPerLeg: numberField(patch.marginPerLeg, "marginPerLeg", base.marginPerLeg),
    leverage: numberField(patch.leverage, "leverage", base.leverage),
    minEntrySpread: numberField(patch.minEntrySpread, "minEntrySpread", base.minEntrySpread),
    minProfitSpread: numberField(patch.minProfitSpread, "minProfitSpread", base.minProfitSpread),
  };

  // The profit target has to be reachable: it is measured as how much of the
  // entry gap closes, so it can never exceed the gap itself.
  if (next.minProfitSpread > next.minEntrySpread) {
    throw new PerpBridgeConfigError(
      `the profit target (${next.minProfitSpread}%) cannot exceed the entry gap (${next.minEntrySpread}%), ` +
        `since profit is how much of that gap closes`,
    );
  }
  return next;
}

/** Reads a stored JSON config, falling back to defaults for anything invalid. */
export function readStoredPerpBridgeConfig(raw: string): PerpBridgeConfig {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_PERPBRIDGE_CONFIG };
    return parsePerpBridgeConfig(parsed as Record<string, unknown>);
  } catch {
    return { ...DEFAULT_PERPBRIDGE_CONFIG };
  }
}

/** Notional traded per leg, which is what the venue sees. */
export function perpBridgeNotional(config: PerpBridgeConfig): number {
  return config.marginPerLeg * config.leverage;
}
