import type {
  ExchangeId,
  FundingBridgeConfig,
  FundingRateRow,
  MarketSnapshot,
  StrategyCandidate,
  StrategyPosition,
} from "@/lib/types";
import { deriveDirection, deriveExitSpread, derivePriceSpread } from "@/lib/market/derive";

/**
 * FundingBridge decision logic.
 *
 * Pure, like the other two engines: a market snapshot plus what is already held goes
 * in, decisions come out. No database, no orders, and `now` is passed in.
 *
 * ── What makes this a different bet from FundingSync ────────────────────────────
 *
 * Both collect the funding difference, but they decide in a different order.
 * FundingSync ranks a coin and enters when the difference *and* the entry spread are
 * both acceptable in the same instant. FundingBridge splits that into two phases:
 *
 *   1. Lock. As a settlement approaches, the best coin on funding merit alone is
 *      locked as a target — price is not consulted. The clock is anchored to the leg
 *      paying the larger absolute rate, since that is the payment being collected.
 *   2. Release. The locked target is then watched every cycle, and the legs are sent
 *      the moment the entry becomes cheap enough. If the funding difference collapses
 *      while waiting, the target is dropped and the slot goes back.
 *
 * The consequence is a strategy that waits for a good price on a decision it has
 * already made, instead of requiring both to line up at once.
 *
 * ── Two exits, because two situations are not alike ─────────────────────────────
 *
 * When both legs settle on the same cadence they pay together, so the position can be
 * left alone until the funding edge is gone and then closed on a spread that covers
 * the round trip. When the cadences differ there is no shared deadline: the faster leg
 * pays repeatedly while the slower one has not settled, so waiting is not free. That
 * path closes on an estimate of what exiting right now would realise, and a hard
 * maximum hold stops a position that never becomes profitable from bleeding forever.
 *
 * ── Where this deliberately departs from the design it was modelled on ──────────
 *
 * The exit is measured against the *exit* spread — the other side of both books, which
 * is what an unwind actually trades — rather than against the entry-side number. The
 * two differ by both venues' bid-ask widths, and comparing an exit to an entry-side
 * spread reports gains that were never earned. Every profit gate here therefore reads
 * `entry spread − current exit spread`, with the round trip's four taker fees added on
 * top of the target.
 */

/** What the engine wants to do with one candidate or position. */
export type FundingBridgeAction =
  /** Reserve a coin on funding merit and start watching its price. */
  | { kind: "lock"; candidate: StrategyCandidate }
  /** The locked target's entry became cheap enough; send both legs. */
  | { kind: "open"; position: StrategyPosition; spread: number }
  /** Give up on a locked target before anything was sent. */
  | { kind: "cancel"; position: StrategyPosition; reason: string }
  /**
   * Mismatched-cadence path: the awaited settlement has passed and its grace period
   * elapsed, so the payment should be in. From here the position is judged on what
   * exiting would realise.
   */
  | { kind: "settled"; position: StrategyPosition; at: number }
  /**
   * Matched-cadence path: the funding edge is gone, so the position is on its way out
   * — but waiting for a spread that pays for the round trip rather than closing into
   * whatever exists this second.
   */
  | { kind: "exiting"; position: StrategyPosition; at: number; reason: string }
  | { kind: "close"; position: StrategyPosition; reason: string };

/** Base-asset size actually held on each leg, for the hedge-break guard. */
export interface HeldLegs {
  longSize: number;
  shortSize: number;
}

export interface FundingBridgeInput {
  snapshot: MarketSnapshot;
  config: FundingBridgeConfig;
  positions: StrategyPosition[];
  now: number;
  /** Round trip taker fees as a percent of one leg's notional: both venues, in and out. */
  feeCostPct: number;
  /**
   * Funding already credited per hedge id. Available on paper, where the app keeps its
   * own ledger; on live the venue folds funding into its balance, so this is empty and
   * the estimate falls back to a pro-rata figure derived from the entry difference.
   */
  fundingByHedge?: Record<string, number>;
  /**
   * Sizes actually held per position id. Absent means the check is skipped — which is
   * the honest default, since "no data" must not be read as "both legs are gone".
   */
  heldLegs?: Record<string, HeldLegs>;
}

export interface FundingBridgeEvaluation {
  actions: FundingBridgeAction[];
  candidates: StrategyCandidate[];
  /** Open positions whose exit rules can no longer be evaluated. */
  blind: { position: StrategyPosition; reason: string }[];
}

/**
 * Widest price spread that can plausibly be a real cross-venue difference. Two venues
 * quoting the same perpetual sit within a fraction of a percent; a larger reading means
 * they are not quoting the same thing — a stale tick, or a contract with a different
 * unit size. Sizing from such a price would be wrong too.
 *
 * Not configurable: a data-sanity floor, not a preference.
 */
const MAX_PLAUSIBLE_SPREAD_PCT = 5;

/**
 * How far the two legs' remaining sizes may diverge before the hedge is considered
 * broken, as a fraction of entry size.
 *
 * A hedge is only a hedge while both legs are the same size. One leg liquidated — or
 * tiered partly down, which an open/closed check cannot see — leaves directional
 * exposure wearing the costume of an arbitrage position, so this closes what is left
 * rather than reporting it and waiting.
 *
 * Not configurable: a tolerance for rounding and partial fills, not a risk preference.
 */
const HEDGE_DRIFT_TOLERANCE = 0.1;

/**
 * How long after opening the hedge-break guard stays quiet.
 *
 * The live position mirror is filled from venue streams, and the two venues do not
 * report at the same instant. For a few seconds after both legs are sent, one can be
 * visible while the other has not arrived — which looks exactly like a leg that was
 * liquidated. Closing on that reading would destroy a healthy hedge to protect against
 * a problem that does not exist, so the guard waits until both venues have had time to
 * speak.
 *
 * Not configurable: this is the mirror's latency, not a risk preference.
 */
const HEDGE_CHECK_SETTLE_MS = 60_000;

/**
 * Recomputes direction and funding difference for one coin, restricted to the venues
 * this strategy may use. The dashboard's row values span all seven venues, which would
 * pick a pair the strategy is not allowed to trade.
 *
 * Both spreads come back. `spread` is the entry (long pays the ask, short receives the
 * bid); `exitSpread` is what unwinding the same hedge costs, on the other side of both
 * books.
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
  const { diffFr, direction } = deriveDirection(
    row.normalizedRates,
    smallestInterval(row, venues),
    venues,
  );
  if (diffFr === null || !direction) return null;
  return {
    diffFr,
    longExchange: direction.longExchange,
    shortExchange: direction.shortExchange,
    spread: derivePriceSpread(direction, row.tickers)?.pct ?? null,
    exitSpread: deriveExitSpread(direction, row.tickers)?.pct ?? null,
  };
}

/** Smallest interval among the venues this strategy may use, for normalization. */
function smallestInterval(row: FundingRateRow, venues: ExchangeId[]): number | null {
  const intervals = venues
    .map((id) => row.rates[id])
    .filter((v) => v && v.rate !== null)
    .map((v) => v.intervalHours);
  return intervals.length > 0 ? Math.min(...intervals) : null;
}

/**
 * The leg whose settlement this hedge is timed around: the one paying the larger
 * absolute raw rate, because that is the payment being collected.
 *
 * Anchoring to the other leg is the mistake this guards against — for a 4h +1% venue
 * paired against an 8h +0.1% one, arming the entry around the 8h settlement would time
 * the position for a payment that hardly matters.
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
 * Ranks coins by funding difference, largest first, marking each actionable or blocked
 * with the reason.
 *
 * Ranking is by difference alone, which is the whole point of the lock phase: price is
 * not part of choosing *what* to trade here, only of deciding *when* to enter it.
 */
export function rankTargets(input: FundingBridgeInput): StrategyCandidate[] {
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

    // An unconfirmed interval means intervalHours is still the venue's default guess.
    // Normalization divides by it and the exit path compares cadences, so a wrong one
    // corrupts both the ranking and the choice of exit rule.
    if (!clock.confirmed) {
      candidate.blockedReason = `${clock.exchange} funding interval not confirmed yet`;
    } else if (minutes < 0) {
      candidate.blockedReason = "settlement already passed";
    } else if (minutes > config.entryWindowMin) {
      candidate.blockedReason = `outside the ${config.entryWindowMin}m lock window (${minutes.toFixed(0)}m away)`;
    } else if (view.spread === null) {
      // Locking a coin whose entry cannot be priced would produce a target that can
      // never be released, since sizing needs a quote too.
      candidate.blockedReason = "one leg has no live quote, so the entry cannot be priced";
    } else if (Math.abs(view.spread) > MAX_PLAUSIBLE_SPREAD_PCT) {
      candidate.blockedReason = `implausible spread ${view.spread.toFixed(2)}% — quotes look mismatched`;
    }

    out.push(candidate);
  }

  return out.sort((a, b) => (b.diffFr ?? 0) - (a.diffFr ?? 0));
}

/**
 * Current funding difference and both spreads for a held position, measured on its own
 * two legs rather than on whatever pair looks best now.
 *
 * `signedDiffFr` is the part that matters after entry: the short leg's normalized rate
 * minus the long leg's. It was positive when the position opened, by construction, so a
 * negative reading means the two venues have swapped which one pays — the hedge is now
 * on the wrong side of the funding it was opened to collect. An absolute difference
 * cannot show that; it reads a full reversal as a healthy edge.
 */
function positionView(
  snapshot: MarketSnapshot,
  position: StrategyPosition,
): {
  diffFr: number | null;
  signedDiffFr: number | null;
  spread: number | null;
  exitSpread: number | null;
  /** True when both legs report a confirmed, equal settlement cadence. */
  sameCadence: boolean;
  /** Interval used for normalization, needed to pro-rate a funding estimate. */
  intervalHours: number | null;
  /** The clock leg's next settlement, read live rather than derived. */
  nextSettlement: number | null;
} {
  const row = snapshot.rows.find((r) => r.coin === position.coin);
  if (!row) {
    return {
      diffFr: null,
      signedDiffFr: null,
      spread: null,
      exitSpread: null,
      sameCadence: false,
      intervalHours: null,
      nextSettlement: null,
    };
  }

  const legs = [position.longExchange, position.shortExchange];
  const view = restrictedView(row, legs);
  const longRate = row.normalizedRates[position.longExchange];
  const shortRate = row.normalizedRates[position.shortExchange];
  const longLeg = row.rates[position.longExchange];
  const shortLeg = row.rates[position.shortExchange];

  return {
    diffFr: view?.diffFr ?? null,
    signedDiffFr:
      longRate === null || shortRate === null ? null : Number((shortRate - longRate).toFixed(6)),
    // Measured on the position's own orientation, not on the pair the row currently
    // favours: after a reversal those are opposite, and the position still holds the
    // legs it opened with.
    spread: derivePriceSpread(positionDirection(position), row.tickers)?.pct ?? null,
    exitSpread: deriveExitSpread(positionDirection(position), row.tickers)?.pct ?? null,
    sameCadence:
      longLeg?.intervalConfirmed === true &&
      shortLeg?.intervalConfirmed === true &&
      longLeg.intervalHours === shortLeg.intervalHours,
    intervalHours: smallestInterval(row, legs),
    nextSettlement: position.clockExchange
      ? row.rates[position.clockExchange]?.nextFundingTime ?? null
      : null,
  };
}

/** The position's own hedge orientation, for pricing its legs rather than a fresh pair. */
function positionDirection(position: StrategyPosition) {
  return {
    longExchange: position.longExchange,
    shortExchange: position.shortExchange,
    longRate: 0,
    shortRate: 0,
    intervalHours: 0,
    diff: 0,
  };
}

export interface ExitEstimate {
  /** Spread movement in our favour since entry, in percent. */
  spreadGainPct: number | null;
  /** That movement in USD on one leg's notional. */
  priceUsd: number;
  /** Funding collected so far, in USD. */
  fundingUsd: number;
  /** Round trip taker fees, in USD. */
  feeUsd: number;
  /** priceUsd + fundingUsd − feeUsd. */
  netUsd: number;
  /** True when the funding figure is derived rather than read from a ledger. */
  fundingEstimated: boolean;
}

/**
 * What closing this position right now would realise.
 *
 * This is the trigger on the mismatched-cadence path, where there is no shared
 * settlement to wait for and holding on has an ongoing cost. Three parts, each of
 * which can be wrong on its own but not silently:
 *
 * - Price. `entry spread − current exit spread`, on one leg's notional. Both numbers
 *   are quoted on the side actually traded, so this is a movement that could be
 *   captured rather than a paper one.
 * - Funding. Read from the ledger when there is one. On live there is not — the venue
 *   folds funding into its balance — so it is pro-rated from the difference at entry
 *   and flagged as an estimate, which is better than assuming zero income on a
 *   strategy whose entire purpose is collecting it.
 * - Fees. The round trip's four taker fills, which is why a position can show a spread
 *   gain and still be a loss.
 */
export function exitEstimate(
  position: StrategyPosition,
  input: FundingBridgeInput,
): ExitEstimate {
  const { exitSpread, intervalHours } = positionView(input.snapshot, position);
  const notional = position.notionalPerLeg;
  const feeUsd = (input.feeCostPct / 100) * notional;

  const spreadGainPct =
    exitSpread === null || position.entrySpread === null
      ? null
      : Number((position.entrySpread - exitSpread).toFixed(6));
  const priceUsd = spreadGainPct === null ? 0 : (spreadGainPct / 100) * notional;

  const ledger = input.fundingByHedge?.[position.id];
  const fundingEstimated = ledger === undefined;
  const fundingUsd = fundingEstimated
    ? proRatedFunding(position, intervalHours, input.now, notional)
    : ledger;

  return {
    spreadGainPct,
    priceUsd: Number(priceUsd.toFixed(6)),
    fundingUsd: Number(fundingUsd.toFixed(6)),
    feeUsd: Number(feeUsd.toFixed(6)),
    netUsd: Number((priceUsd + fundingUsd - feeUsd).toFixed(6)),
    fundingEstimated,
  };
}

/**
 * Funding a position has plausibly collected, when no ledger is available.
 *
 * The difference at entry is expressed per normalization interval, so one interval held
 * earns roughly `entryDiffFr%` of notional. Pro-rating by elapsed time rather than
 * counting settlements deliberately understates a position that has just crossed a
 * payment and overstates one that has not reached the next — it is an estimate used
 * only to decide whether exiting is worth it, never to report a result.
 */
function proRatedFunding(
  position: StrategyPosition,
  intervalHours: number | null,
  now: number,
  notional: number,
): number {
  const diff = position.entryDiffFr;
  const openedAt = position.openedAt ?? 0;
  if (diff === null || diff === undefined || !intervalHours || intervalHours <= 0) return 0;
  if (!openedAt || now <= openedAt) return 0;
  const intervalsHeld = (now - openedAt) / (intervalHours * 3_600_000);
  return (diff / 100) * notional * intervalsHeld;
}

/**
 * Whether the two legs still hold the same size, or null when there is nothing to
 * compare against.
 *
 * 0 means both legs are intact, or have shrunk by the same proportion. 1 means one leg
 * is gone entirely while the other is untouched. The middle is what an open/closed
 * check misses: a leg tiered down to 40% of entry size by a partial liquidation, while
 * its partner sits at 100%.
 */
export function hedgeDrift(held: HeldLegs | undefined, entrySize: number): number | null {
  if (!held || entrySize <= 0) return null;
  const long = Math.max(0, Math.min(held.longSize / entrySize, 1));
  const short = Math.max(0, Math.min(held.shortSize / entrySize, 1));
  return Number(Math.abs(long - short).toFixed(6));
}

/**
 * Decides what to do with one position already on the books. Returns null when it
 * should be left alone.
 */
export function decideTarget(
  position: StrategyPosition,
  input: FundingBridgeInput,
): FundingBridgeAction | null {
  const { config, snapshot, now } = input;
  const view = positionView(snapshot, position);

  // ── Locked target, nothing sent yet ────────────────────────────────────────
  if (position.status === "queued") {
    const minutes =
      position.fundingTime === null
        ? Number.POSITIVE_INFINITY
        : minutesUntil(position.fundingTime, now);

    // The window is the hard deadline: past it the payment this target was locked for
    // has already settled, so the reason to enter is gone.
    if (minutes < 0) {
      return {
        kind: "cancel",
        position,
        reason: "the settlement passed before the entry became cheap enough",
      };
    }
    if (view.diffFr !== null && view.diffFr <= config.cancelDiffFr) {
      return {
        kind: "cancel",
        position,
        reason:
          `funding difference collapsed to ${view.diffFr.toFixed(4)}% ` +
          `(at or below ${config.cancelDiffFr}%) while waiting for the entry`,
      };
    }
    if (view.spread === null) return null;
    // Refusing rather than cancelling: a nonsense quote is usually a bad tick, and the
    // target is still worth holding while the window lasts.
    if (Math.abs(view.spread) > MAX_PLAUSIBLE_SPREAD_PCT) return null;
    if (view.spread < config.entrySpread) return null;
    return { kind: "open", position, spread: view.spread };
  }

  if (position.status !== "open") return null;

  // ── The hedge itself is broken ─────────────────────────────────────────────
  // Checked before anything else and acted on regardless of price: a half-liquidated
  // hedge is directional exposure, and every rule below assumes two matched legs. Held
  // off for the first minute, though — see HEDGE_CHECK_SETTLE_MS.
  const openedAt = position.openedAt ?? position.queuedAt;
  if (now - openedAt >= HEDGE_CHECK_SETTLE_MS) {
    const drift = hedgeDrift(input.heldLegs?.[position.id], position.size);
    if (drift !== null && drift > HEDGE_DRIFT_TOLERANCE) {
      return {
        kind: "close",
        position,
        reason:
          `hedge broken — the legs' remaining sizes differ by ${(drift * 100).toFixed(1)}% ` +
          `(liquidation or a partial fill), so what is left is directional`,
      };
    }
  }

  const flipped = view.signedDiffFr !== null && view.signedDiffFr < 0;
  const gain =
    view.exitSpread === null || position.entrySpread === null
      ? null
      : position.entrySpread - view.exitSpread;

  return view.sameCadence
    ? decideMatchedCadence(position, input, view, flipped, gain)
    : decideMismatchedCadence(position, input, gain);
}

type PositionView = ReturnType<typeof positionView>;

/**
 * Both legs settle together, so funding is paid and received on one clock and holding
 * on costs nothing beyond the risk of the spread moving.
 *
 * Two stages, in the order they matter. First the edge has to be gone — decayed below
 * the threshold, or reversed outright. Only then does price decide, and the wait is
 * bounded by the next settlement: past that, funding starts working against a position
 * whose edge has already disappeared.
 */
function decideMatchedCadence(
  position: StrategyPosition,
  input: FundingBridgeInput,
  view: PositionView,
  flipped: boolean,
  gain: number | null,
): FundingBridgeAction | null {
  const { config, now } = input;
  const exiting = position.exitingSince != null && position.exitingSince > 0;

  if (exiting) {
    if (view.nextSettlement && view.nextSettlement > 0 && now >= view.nextSettlement) {
      return {
        kind: "close",
        position,
        reason:
          `${position.exitingReason ?? "edge gone"} — the next settlement arrived while waiting ` +
          `for a spread, so closing rather than paying funding again`,
      };
    }
    // Break-even after fees, not the full profit target: with no edge left, holding out
    // for profit is a directional bet rather than arbitrage.
    if (gain !== null && gain >= input.feeCostPct) {
      return {
        kind: "close",
        position,
        reason:
          `${position.exitingReason ?? "edge gone"} — waited for a ${gain.toFixed(4)}% spread gain, ` +
          `covering ${input.feeCostPct.toFixed(4)}% in fees`,
      };
    }
    return null;
  }

  if (flipped) {
    return {
      kind: "exiting",
      position,
      at: now,
      reason:
        `funding reversed — ${position.shortExchange} now pays less than ${position.longExchange}, ` +
        `so the hedge is on the wrong side of the difference it was opened for`,
    };
  }
  if (view.diffFr !== null && view.diffFr <= config.exitDiffFr) {
    return {
      kind: "exiting",
      position,
      at: now,
      reason: `funding difference decayed to ${view.diffFr.toFixed(4)}% (at or below ${config.exitDiffFr}%)`,
    };
  }

  // The edge is intact, so this only fires when price hands over the profit early.
  if (gain !== null) {
    const target = config.minProfitSpread + input.feeCostPct;
    if (gain >= target) {
      return {
        kind: "close",
        position,
        reason:
          `spread returned ${gain.toFixed(4)}% while the funding edge held ` +
          `(target ${config.minProfitSpread}% + ${input.feeCostPct.toFixed(4)}% fees)`,
      };
    }
  }
  return null;
}

/**
 * The legs settle on different cadences, so there is no shared deadline and the faster
 * leg keeps paying funding while the slower one has not settled. Waiting has a running
 * cost, which is why this path is judged on money rather than on thresholds.
 *
 * The maximum hold is checked before anything else and closes regardless of the
 * estimate. That is the point of it: a position that never becomes profitable would
 * otherwise be held indefinitely by a rule that only ever closes at a profit.
 */
function decideMismatchedCadence(
  position: StrategyPosition,
  input: FundingBridgeInput,
  gain: number | null,
): FundingBridgeAction | null {
  const { config, now } = input;
  const estimate = exitEstimate(position, input);
  const openedAt = position.openedAt ?? position.queuedAt;
  const heldMin = (now - openedAt) / 60_000;

  if (heldMin >= config.maxHoldMin) {
    return {
      kind: "close",
      position,
      reason:
        `held ${heldMin.toFixed(0)}m, hitting the ${config.maxHoldMin}m limit for mismatched ` +
        `settlement cadences — closing at an estimated ${fmtUsd(estimate.netUsd)}` +
        (estimate.fundingEstimated ? " (funding pro-rated)" : ""),
    };
  }

  const harvested = position.harvestedAt != null && position.harvestedAt > 0;
  const settlementPassed =
    position.fundingTime !== null &&
    now >= position.fundingTime + config.settleGraceMin * 60_000;

  if (!harvested && settlementPassed) {
    // Marked rather than closed: the payment is in, and what remains is choosing a
    // moment to leave that does not give it back.
    return { kind: "settled", position, at: now };
  }

  if (harvested) {
    if (estimate.netUsd > 0) {
      return {
        kind: "close",
        position,
        reason:
          `payment collected and exiting now realises about ${fmtUsd(estimate.netUsd)} ` +
          `(price ${fmtUsd(estimate.priceUsd)}, funding ${fmtUsd(estimate.fundingUsd)}` +
          `${estimate.fundingEstimated ? " pro-rated" : ""}, fees ${fmtUsd(-estimate.feeUsd)})`,
      };
    }
    // Still under water: wait, bounded by maxHoldMin above.
    return null;
  }

  // Before the settlement, the only reason to leave early is price giving up the whole
  // target on its own.
  if (gain !== null) {
    const target = config.minProfitSpread + input.feeCostPct;
    if (gain >= target) {
      return {
        kind: "close",
        position,
        reason:
          `spread returned ${gain.toFixed(4)}% before the settlement ` +
          `(target ${config.minProfitSpread}% + ${input.feeCostPct.toFixed(4)}% fees)`,
      };
    }
  }
  return null;
}

function fmtUsd(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

/**
 * Why an open position cannot be evaluated this cycle, or null when it can. Only the
 * data the exit rules actually read is checked.
 */
export function targetBlindReason(
  position: StrategyPosition,
  snapshot: MarketSnapshot,
): string | null {
  if (position.status !== "open") return null;
  const row = snapshot.rows.find((r) => r.coin === position.coin);
  if (!row) {
    return `${position.coin} is no longer streamed, so only the hold limit can still close it`;
  }
  const view = positionView(snapshot, position);
  if (view.exitSpread === null) {
    return `no quote on the side needed to close one leg of ${position.coin}`;
  }
  // A missing funding rate matters only while the funding rules are still in play.
  // Once the settlement has been collected the position is judged on price alone.
  if (position.harvestedAt == null && view.diffFr === null) {
    return `no funding rate for both legs of ${position.coin}`;
  }
  if (!view.sameCadence && view.intervalHours === null) {
    return `settlement cadence unknown for ${position.coin}, so neither exit path applies`;
  }
  return null;
}

/**
 * One full evaluation: deal with what is held, then lock new targets within the
 * remaining position budget.
 *
 * Cancellations free their slot only once applied, so this cycle still counts them as
 * occupied. Being one target short for five seconds is preferable to briefly exceeding
 * maxPositions.
 */
export function evaluateTargets(input: FundingBridgeInput): FundingBridgeEvaluation {
  const { config, positions, snapshot } = input;
  const actions: FundingBridgeAction[] = [];
  const blind: FundingBridgeEvaluation["blind"] = [];

  for (const position of positions) {
    const reason = targetBlindReason(position, snapshot);
    if (reason) blind.push({ position, reason });
    const action = decideTarget(position, input);
    if (action) actions.push(action);
  }

  const candidates = rankTargets(input);
  const heldCoins = new Set(positions.map((p) => p.coin));
  const slots = Math.max(0, config.maxPositions - positions.length);

  let locked = 0;
  for (const candidate of candidates) {
    if (locked >= slots) break;
    if (candidate.blockedReason) continue;
    if (heldCoins.has(candidate.coin)) continue;
    actions.push({ kind: "lock", candidate });
    locked += 1;
  }

  return { actions, candidates, blind };
}
