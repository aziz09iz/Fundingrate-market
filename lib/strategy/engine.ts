import type {
  ExchangeId,
  FundingRateRow,
  MarketSnapshot,
  StrategyCandidate,
  StrategyConfig,
  StrategyPosition,
} from "@/lib/types";
import { deriveDirection, deriveExitSpread, derivePriceSpread } from "@/lib/market/derive";

/**
 * FundingSync decision logic.
 *
 * Deliberately pure: it takes a market snapshot plus the positions already held
 * and returns what should happen. No database, no orders, no clock of its own —
 * `now` is passed in. That makes every rule here testable with a fabricated
 * snapshot, which matters for a strategy that spends real money.
 */

/** What the engine wants to do with one candidate or position. */
export type StrategyAction =
  | { kind: "enter"; candidate: StrategyCandidate }
  | { kind: "open"; position: StrategyPosition; spread: number }
  | { kind: "cancel"; position: StrategyPosition; reason: string }
  | { kind: "close"; position: StrategyPosition; reason: string }
  /**
   * The awaited settlement passed, so the payment is collected. The position stays
   * open to wait for a decent exit price rather than taking whatever spread happens
   * to exist at that second.
   */
  | { kind: "harvested"; position: StrategyPosition; at: number }
  /**
   * The edge decayed, so the position is on its way out — but waiting for a spread
   * that at least covers fees rather than closing into a bad one.
   */
  | { kind: "exiting"; position: StrategyPosition; at: number; reason: string };

export interface EvaluationInput {
  snapshot: MarketSnapshot;
  config: StrategyConfig;
  positions: StrategyPosition[];
  now: number;
  /**
   * Total taker fees for one hedge round trip, as a percent of one leg's
   * notional: both venues, entry and exit. Passed in rather than read here so the
   * engine stays pure and testable.
   */
  feeCostPct: number;
}

export interface Evaluation {
  actions: StrategyAction[];
  /** Every candidate considered, actionable or not, for the UI and the log. */
  candidates: StrategyCandidate[];
  /**
   * Open positions the engine can no longer evaluate, because the coin left the
   * watch set or a leg lost its quote. Reported rather than ignored: two of the
   * three exit triggers depend on these numbers, so a blind position is one that
   * can only still exit on its funding deadline.
   */
  blind: { position: StrategyPosition; reason: string }[];
}

/**
 * Recomputes direction and diff FR for one coin restricted to the configured
 * venues. The dashboard's row values span all seven venues, which would pick a
 * pair the strategy is not allowed to trade.
 *
 * Both spreads are returned. `spread` is the entry cost (long pays the ask, short
 * receives the bid); `exitSpread` is what unwinding the same hedge costs, on the
 * other side of both books. Profit is `entry − exit`, so comparing an exit against
 * the entry-side number overstates every result by both venues' bid-ask widths.
 */
function restrictedView(
  row: FundingRateRow,
  venues: ExchangeId[],
): {
  diffFr: number | null;
  longExchange: ExchangeId;
  shortExchange: ExchangeId;
  spread: number | null;
  exitSpread: number | null;
} | null {
  const { diffFr, direction } = deriveDirection(row.normalizedRates, smallestInterval(row, venues), venues);
  if (diffFr === null || !direction) return null;
  const priceSpread = derivePriceSpread(direction, row.tickers);
  const exit = deriveExitSpread(direction, row.tickers);
  return {
    diffFr,
    longExchange: direction.longExchange,
    shortExchange: direction.shortExchange,
    spread: priceSpread?.pct ?? null,
    exitSpread: exit?.pct ?? null,
  };
}

/** Smallest confirmed interval among the venues this strategy may use. */
function smallestInterval(row: FundingRateRow, venues: ExchangeId[]): number | null {
  const intervals = venues
    .map((id) => row.rates[id])
    .filter((v) => v && v.rate !== null)
    .map((v) => v.intervalHours);
  return intervals.length > 0 ? Math.min(...intervals) : null;
}

/**
 * The leg whose settlement this hedge is timed around: the one paying the larger
 * raw rate, because that is the payment being harvested. For a KuCoin 4h +1% vs
 * Bybit 8h +0.1% pair that is KuCoin, matching how the position is meant to work.
 */
function clockLeg(
  row: FundingRateRow,
  longExchange: ExchangeId,
  shortExchange: ExchangeId,
): { exchange: ExchangeId; fundingTime: number; confirmed: boolean } | null {
  const candidates = [longExchange, shortExchange]
    .map((exchange) => ({ exchange, value: row.rates[exchange] }))
    .filter((entry) => entry.value && entry.value.rate !== null);
  if (candidates.length < 2) return null;

  const chosen = candidates.reduce((a, b) =>
    Math.abs(b.value.rate ?? 0) > Math.abs(a.value.rate ?? 0) ? b : a,
  );
  const fundingTime = chosen.value.nextFundingTime;
  if (!fundingTime || fundingTime <= 0) return null;
  return {
    exchange: chosen.exchange,
    fundingTime,
    confirmed: chosen.value.intervalConfirmed === true,
  };
}

/** Minutes from now until a settlement, negative once it has passed. */
function minutesUntil(fundingTime: number, now: number): number {
  return (fundingTime - now) / 60_000;
}

/**
 * Widest price spread that can plausibly be a real cross-venue difference.
 *
 * Two venues quoting the same perpetual sit within a fraction of a percent. A
 * reading of tens or hundreds of percent means they are not quoting the same
 * thing — a stale tick, or a contract with a different unit size. Entering on
 * that would also size the position from a wrong price, so such a candidate is
 * refused outright.
 *
 * Not configurable: this is a data-sanity floor, not a strategy preference.
 */
const MAX_PLAUSIBLE_SPREAD_PCT = 5;

/**
 * Ranks candidates by funding difference, largest first, and marks each one
 * actionable or blocked with the reason. Ranking is by diff FR rather than
 * spread: the difference is the edge, the spread is only the cost of taking it.
 */
export function rankCandidates(input: EvaluationInput): StrategyCandidate[] {
  const { snapshot, config, now } = input;
  const out: StrategyCandidate[] = [];

  for (const row of snapshot.rows) {
    const view = restrictedView(row, config.venues);
    if (!view) continue;
    if (view.diffFr === null || view.diffFr < config.minDiffFr) continue;

    const clock = clockLeg(row, view.longExchange, view.shortExchange);
    if (!clock) {
      out.push({
        coin: row.coin,
        longExchange: view.longExchange,
        shortExchange: view.shortExchange,
        clockExchange: view.longExchange,
        diffFr: view.diffFr,
        spread: view.spread,
        exitSpread: view.exitSpread,
        fundingTime: 0,
        minutesToFunding: Number.POSITIVE_INFINITY,
        blockedReason: "no settlement time reported for either leg",
      });
      continue;
    }

    const minutes = minutesUntil(clock.fundingTime, now);
    const candidate: StrategyCandidate = {
      coin: row.coin,
      longExchange: view.longExchange,
      shortExchange: view.shortExchange,
      clockExchange: clock.exchange,
      diffFr: view.diffFr,
      spread: view.spread,
      exitSpread: view.exitSpread,
      fundingTime: clock.fundingTime,
      minutesToFunding: minutes,
    };

    // An unconfirmed interval means intervalHours is still the venue default
    // guess. Normalization divides by it, so a wrong cadence can scale a rate by
    // 2× — not a basis for opening a position.
    if (!clock.confirmed) {
      candidate.blockedReason = `${clock.exchange} funding interval not confirmed yet`;
    } else if (minutes < 0) {
      candidate.blockedReason = "settlement already passed";
    } else if (minutes > config.entryWindowMin) {
      candidate.blockedReason = `outside entry window (${minutes.toFixed(0)}m away)`;
    } else if (view.spread === null) {
      candidate.blockedReason = "one leg has no live quote";
    } else if (view.spread < config.minEntrySpread) {
      // A negative entry spread is a loss taken at the moment of opening, and
      // prices converging toward zero realises it rather than recovering it.
      candidate.blockedReason =
        `entry spread ${view.spread.toFixed(4)}% is below the ${config.minEntrySpread}% floor`;
    } else if (Math.abs(view.spread) > MAX_PLAUSIBLE_SPREAD_PCT) {
      // Two venues on the same perpetual do not differ by this much. Something
      // is wrong with the quote, and sizing from it would be wrong too.
      candidate.blockedReason = `implausible spread ${view.spread.toFixed(2)}% — quotes look mismatched`;
    }

    out.push(candidate);
  }

  // Ranked by funding difference, so a candidate without one cannot compete.
  // rankCandidates only ever produces candidates with a numeric diffFr.
  return out.sort((a, b) => (b.diffFr ?? 0) - (a.diffFr ?? 0));
}

/** Current diff FR and spreads for a held position, restricted to its own legs. */
function positionView(
  snapshot: MarketSnapshot,
  position: StrategyPosition,
): { diffFr: number | null; spread: number | null; exitSpread: number | null } {
  const row = snapshot.rows.find((r) => r.coin === position.coin);
  if (!row) return { diffFr: null, spread: null, exitSpread: null };
  const legs = [position.longExchange, position.shortExchange];
  const view = restrictedView(row, legs);
  return {
    diffFr: view?.diffFr ?? null,
    spread: view?.spread ?? null,
    exitSpread: view?.exitSpread ?? null,
  };
}

/**
 * Decides what to do with one position already on the books.
 * Returns null when it should be left alone.
 */
export function decidePosition(
  position: StrategyPosition,
  input: EvaluationInput,
): StrategyAction | null {
  const { config, snapshot, now } = input;
  const { diffFr, spread, exitSpread } = positionView(snapshot, position);
  // FundingSync always records a settlement, so a missing one means the row is
  // not this strategy's. Treated as "no deadline" rather than crashing.
  const minutes = position.fundingTime === null ? Number.POSITIVE_INFINITY : minutesUntil(position.fundingTime, now);

  if (position.status === "queued") {
    // The window is the only hard deadline for a queued entry: past it, the
    // payment being targeted has settled and the reason to enter is gone.
    if (minutes < 0) {
      return { kind: "cancel", position, reason: "entry window closed before the spread converged" };
    }
    if (diffFr !== null && diffFr < config.cancelDiffFr) {
      return {
        kind: "cancel",
        position,
        reason: `funding difference fell to ${diffFr.toFixed(4)}% (below ${config.cancelDiffFr}%)`,
      };
    }
    // The entry spread floor applies to both modes. It used to be a ceiling on
    // how much the entry could cost, and only in delay mode, which let instant
    // open at a spread of -1% — a loss booked on opening that convergence then
    // realises rather than recovers.
    if (spread === null) return null;
    if (spread < config.minEntrySpread) return null;
    return { kind: "open", position, spread };
  }

  if (position.status !== "open") return null;

  const harvested = position.harvestedAt != null && position.harvestedAt > 0;
  const exiting = position.exitingSince != null && position.exitingSince > 0;

  /** The clock leg's next settlement, read live rather than derived from an interval. */
  const nextSettlement = position.clockExchange
    ? snapshot.rows.find((r) => r.coin === position.coin)?.rates[position.clockExchange]
        ?.nextFundingTime ?? null
    : null;

  // ── 1. The awaited settlement has passed ───────────────────────────────────
  if (config.exitAfterFunding && minutes < 0 && !harvested) {
    if (config.holdForSpreadAfterFunding) {
      // The payment is banked; only the exit price is left to optimise. Marking it
      // harvested rather than closing avoids taking whatever spread exists at this
      // exact second, which is what turned collected payments into net losses.
      return { kind: "harvested", position, at: now };
    }
    return { kind: "close", position, reason: "funding settled, closing as configured" };
  }

  // ── 2. Waiting for a good exit after collecting the payment ────────────────
  // The deadline is the clock leg's *next* settlement: once a payment happens the
  // venue moves its clock forward, so that value already is the next one.
  if (harvested) {
    if (nextSettlement && nextSettlement > 0 && now >= nextSettlement) {
      return {
        kind: "close",
        position,
        reason:
          "next settlement reached without a good exit — closing rather than paying funding again",
      };
    }
    // Diff FR decay is deliberately ignored once harvested: the difference usually
    // collapses right after a payment, so applying that rule here would close
    // immediately and undo the whole point of waiting.
    if (exitSpread !== null && position.entrySpread !== null) {
      const gain = position.entrySpread - exitSpread;
      const target = config.minProfitSpread + input.feeCostPct;
      if (gain >= target) {
        return {
          kind: "close",
          position,
          reason:
            `funding collected, then exited on a ${gain.toFixed(4)}% spread gain ` +
            `(target ${config.minProfitSpread}% + ${input.feeCostPct.toFixed(4)}% fees)`,
        };
      }
    }
    return null;
  }

  // ── 3. Leaving because the edge decayed, waiting for a spread worth taking ──
  // Break-even after fees rather than the full profit target: the payment has not
  // arrived and there is no edge left, so holding out for profit would be a
  // directional bet rather than arbitrage.
  if (exiting) {
    if (nextSettlement && nextSettlement > 0 && now >= nextSettlement) {
      return {
        kind: "close",
        position,
        reason:
          `${position.exitingReason ?? "edge gone"} — settlement reached while waiting for a spread, closing`,
      };
    }
    if (exitSpread !== null && position.entrySpread !== null) {
      const gain = position.entrySpread - exitSpread;
      if (gain >= input.feeCostPct) {
        return {
          kind: "close",
          position,
          reason:
            `${position.exitingReason ?? "edge gone"} — waited for a ${gain.toFixed(4)}% spread gain, ` +
            `covering ${input.feeCostPct.toFixed(4)}% in fees`,
        };
      }
    }
    return null;
  }

  // 4. The edge that justified the entry is gone.
  if (diffFr !== null && diffFr <= config.exitDiffFr) {
    const reason = `funding difference decayed to ${diffFr.toFixed(4)}% (at or below ${config.exitDiffFr}%)`;
    if (config.holdForSpreadAfterDecay) {
      // Start leaving, but not at any price: closing on the spread of this exact
      // second is how a hedge realises a loss it never had to take.
      return { kind: "exiting", position, at: now, reason };
    }
    return { kind: "close", position, reason };
  }

  // 3. Spread target, measured against the *exit* spread — the side of both books
  //    the unwind actually trades. Measuring against the entry-side spread
  //    ignored both venues' bid-ask widths and reported gains that were never
  //    earned.
  if (exitSpread !== null && position.entrySpread !== null) {
    const gain = position.entrySpread - exitSpread;
    if (position.entryMode === "instant") {
      // The target is what is kept, so the round trip's fees are added on top.
      const target = config.minProfitSpread + input.feeCostPct;
      if (gain >= target) {
        return {
          kind: "close",
          position,
          reason:
            `spread improved ${gain.toFixed(4)}% (target ${config.minProfitSpread}% ` +
            `+ ${input.feeCostPct.toFixed(4)}% fees)`,
        };
      }
    } else if (Math.abs(exitSpread) <= config.maxExitSpread) {
      return {
        kind: "close",
        position,
        reason: `exit spread converged to ${exitSpread.toFixed(4)}%`,
      };
    }
  }

  return null;
}

/**
 * Why an open position cannot be evaluated this cycle, or null when it can.
 * Only the data the exit rules actually read is checked.
 */
export function blindReason(
  position: StrategyPosition,
  snapshot: MarketSnapshot,
): string | null {
  if (position.status !== "open") return null;
  const row = snapshot.rows.find((r) => r.coin === position.coin);
  if (!row) {
    return `${position.coin} is no longer streamed, so only the funding deadline can still close it`;
  }
  const { diffFr, spread } = positionView(snapshot, position);
  // Once harvested only the exit spread matters, so a missing funding rate is not
  // blindness — the position is no longer waiting on funding for anything.
  if (position.harvestedAt == null && diffFr === null) {
    return `no funding rate for both legs of ${position.coin}`;
  }
  if (spread === null) return `no live quote for one leg of ${position.coin}`;
  return null;
}

/**
 * One full evaluation: what to do with existing positions, then which new
 * candidates to queue within the remaining position budget.
 */
export function evaluate(input: EvaluationInput): Evaluation {
  const { config, positions, snapshot } = input;
  const actions: StrategyAction[] = [];
  const blind: Evaluation["blind"] = [];

  for (const position of positions) {
    const reason = blindReason(position, snapshot);
    if (reason) blind.push({ position, reason });
    const action = decidePosition(position, input);
    if (action) actions.push(action);
  }

  const candidates = rankCandidates(input);
  const heldCoins = new Set(positions.map((p) => p.coin));
  // Cancellations free a slot only after they are applied, so this cycle counts
  // them as still occupied. Being one short for a cycle is preferable to briefly
  // exceeding maxPositions.
  const slots = Math.max(0, config.maxPositions - positions.length);

  let queued = 0;
  for (const candidate of candidates) {
    if (queued >= slots) break;
    if (candidate.blockedReason) continue;
    if (heldCoins.has(candidate.coin)) continue;
    actions.push({ kind: "enter", candidate });
    queued += 1;
  }

  return { actions, candidates, blind };
}
