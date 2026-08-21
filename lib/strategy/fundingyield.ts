import type {
  ExchangeId,
  FundingRateRow,
  FundingYieldConfig,
  MarketSnapshot,
  StrategyCandidate,
  StrategyPosition,
} from "@/lib/types";
import { deriveDirection, deriveExitSpread, derivePriceSpread } from "@/lib/market/derive";

/**
 * FundingYield decision logic.
 *
 * Pure, like the other three engines: a market snapshot plus what is already held goes
 * in, decisions come out. No database, no orders, and `now` is passed in.
 *
 * ── The disagreement this strategy is built on ──────────────────────────────────
 *
 * The other three gate entry on the price spread clearing a threshold of its own.
 * FundingSync requires `spread >= minEntrySpread`; FundingBridge waits for the same
 * thing before releasing a locked target. Both default that floor to +0.02%, so an
 * entry must open in credit.
 *
 * On a live board the widest funding differences almost always come with a deeply
 * negative entry spread — not by coincidence, but because a large funding gap is what
 * you get when two venues disagree about a coin's price. Those two rules therefore
 * reject the highest-paying rows available.
 *
 * A negative entry spread is not a loss. The price component of a hedge's PnL is
 * `entry spread − exit spread`, and both sides move together: entering at −0.6% and
 * leaving at −0.63% costs 0.03%, not 0.6%. What is actually paid is the sum of the two
 * venues' bid-ask widths, and that number is `entry spread − exit spread` read at one
 * instant — which the snapshot already provides through `derivePriceSpread` and
 * `deriveExitSpread`.
 *
 * So this engine prices the spread instead of vetoing it, and adds it to the other two
 * components:
 *
 *     projected funding − round trip fees − measured spread cost > minNetYieldUsd
 *
 * ── Why it holds for days ───────────────────────────────────────────────────────
 *
 * At a 0.2% round trip and a 0.1% funding difference, one payment is a loss and three
 * are a profit. The other funding strategies enter for a single settlement and are
 * therefore forced to chase rates ten times normal. Holding across `targetSettlements`
 * payments pays the four taker fills once against several payments, which is what makes
 * an ordinary difference tradable.
 *
 * ── Why it is the only one with a stop-loss ─────────────────────────────────────
 *
 * The other three are bounded by something other than loss: FundingSync by its
 * settlement and the one after, FundingBridge by the next settlement or `maxHoldMin`,
 * PerpBridge by nothing at all — which is a real hole, but one its author documented.
 * This strategy deliberately gives up the settlement deadline, so it has to buy that
 * back with an explicit limit on how much a position may lose.
 */

/** What the engine wants to do with one candidate or position. */
export type FundingYieldAction =
  /** Enter now: the projected net yield clears the floor. No queue, no waiting. */
  | { kind: "open"; candidate: StrategyCandidate; projection: YieldProjection }
  /** Record a new worst-case mark, so a recovered position still shows its low. */
  | { kind: "mark"; position: StrategyPosition; worstNetUsd: number }
  | { kind: "close"; position: StrategyPosition; reason: string };

export interface FundingYieldInput {
  snapshot: MarketSnapshot;
  config: FundingYieldConfig;
  positions: StrategyPosition[];
  now: number;
  /** Round trip taker fees as a percent of one leg's notional: both venues, in and out. */
  feeCostPct: number;
  /**
   * Funding credited per hedge id. Present on paper, where the app keeps its own
   * ledger. Absent on live, where the venue folds funding into its balance — and the
   * difference matters here more than anywhere else, because this strategy's profit
   * exit reads collected funding directly.
   */
  fundingByHedge?: Record<string, number>;
  /** Sizes actually held per position id, for the hedge-break guard. */
  heldLegs?: Record<string, HeldLegs>;
}

/** Base-asset size actually held on each leg, for the hedge-break guard. */
export interface HeldLegs {
  longSize: number;
  shortSize: number;
}

export interface FundingYieldEvaluation {
  actions: FundingYieldAction[];
  candidates: StrategyCandidate[];
  /** Open positions whose exit rules can no longer be evaluated. */
  blind: { position: StrategyPosition; reason: string }[];
}

/**
 * Widest price spread that can plausibly be a real cross-venue difference. Beyond this
 * the two venues are not quoting the same thing — a stale tick, or a contract with a
 * different unit size — and sizing from such a price would be wrong too.
 *
 * Not configurable: a data-sanity floor, not a preference.
 */
const MAX_PLAUSIBLE_SPREAD_PCT = 5;

/** See FundingBridge: the same tolerance, for the same reason. */
const HEDGE_DRIFT_TOLERANCE = 0.1;
const HEDGE_CHECK_SETTLE_MS = 60_000;

/**
 * What entering a hedge right now is projected to yield, in USD.
 *
 * Every component is money, which is the point: a funding rate, a fee percentage and a
 * bid-ask width are not comparable until they are. Each can be wrong on its own, and
 * none of them is hidden inside a threshold.
 */
export interface YieldProjection {
  /** Normalized funding difference per settlement, in percent. */
  diffFrPct: number;
  /** Settlements this projection assumes will be collected. */
  settlements: number;
  /** Funding expected over those settlements, in USD on one leg's notional. */
  fundingUsd: number;
  /** Round trip taker fees, in USD. */
  feeUsd: number;
  /**
   * Measured cost of entering and exiting on price, in percent: the exit spread minus the
   * entry spread at this instant.
   *
   * Always positive, and the direction of the subtraction is worth stating. The entry
   * spread is the short venue's bid against the long venue's ask; the exit spread is the
   * other side of both books. Since a bid is never above its own ask, the exit spread is
   * always the larger number — so the cost is `exit − entry`, and it equals the sum of
   * both venues' bid-ask widths.
   */
  spreadCostPct: number;
  /** That cost in USD. */
  spreadCostUsd: number;
  /** fundingUsd − feeUsd − spreadCostUsd. */
  netUsd: number;
}

/**
 * Prices one candidate hedge.
 *
 * `entrySpread` and `exitSpread` are read at the same instant on opposite sides of both
 * books, so their difference is what the round trip costs in price terms — regardless of
 * whether either number is positive. That is the whole insight this strategy rests on,
 * and it is why a −0.6% entry spread is not disqualifying.
 */
export function projectYield(input: {
  diffFrPct: number;
  entrySpread: number;
  exitSpread: number;
  notionalPerLeg: number;
  feeCostPct: number;
  settlements: number;
}): YieldProjection {
  const { diffFrPct, entrySpread, exitSpread, notionalPerLeg, feeCostPct, settlements } = input;
  const fundingUsd = (diffFrPct / 100) * notionalPerLeg * settlements;
  const feeUsd = (feeCostPct / 100) * notionalPerLeg;
  const spreadCostPct = Number((exitSpread - entrySpread).toFixed(6));
  const spreadCostUsd = (spreadCostPct / 100) * notionalPerLeg;

  return {
    diffFrPct,
    settlements,
    fundingUsd: round(fundingUsd),
    feeUsd: round(feeUsd),
    spreadCostPct,
    spreadCostUsd: round(spreadCostUsd),
    netUsd: round(fundingUsd - feeUsd - spreadCostUsd),
  };
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * Recomputes direction and funding difference for one coin, restricted to the venues
 * this strategy may use. The dashboard's row values span every venue, which would pick a
 * pair the strategy is not allowed to trade.
 */
function restrictedView(
  row: FundingRateRow,
  venues: ExchangeId[],
): {
  diffFr: number;
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

/**
 * Current funding and price state for a held position, measured on its own two legs.
 *
 * `signedDiffFr` is the part that matters after entry: the short leg's normalized rate
 * minus the long leg's. It was positive at entry by construction, so a negative reading
 * means the venues have swapped which one pays — the hedge is on the wrong side of the
 * only thing it was opened to collect. An absolute difference cannot show that.
 */
function positionView(snapshot: MarketSnapshot, position: StrategyPosition) {
  const row = snapshot.rows.find((r) => r.coin === position.coin);
  if (!row) {
    return {
      signedDiffFr: null as number | null,
      exitSpread: null as number | null,
      intervalHours: null as number | null,
    };
  }
  const longRate = row.normalizedRates[position.longExchange];
  const shortRate = row.normalizedRates[position.shortExchange];
  return {
    signedDiffFr:
      longRate === null || shortRate === null ? null : Number((shortRate - longRate).toFixed(6)),
    exitSpread: deriveExitSpread(positionDirection(position), row.tickers)?.pct ?? null,
    intervalHours: smallestInterval(row, [position.longExchange, position.shortExchange]),
  };
}

/**
 * Whether the two legs still hold the same size, or null when there is nothing to
 * compare against. Same shape as FundingBridge's, and the same reasoning: a leg tiered
 * down by a partial liquidation is what an open/closed check misses.
 */
export function hedgeDrift(held: HeldLegs | undefined, entrySize: number): number | null {
  if (!held || entrySize <= 0) return null;
  const long = Math.max(0, Math.min(held.longSize / entrySize, 1));
  const short = Math.max(0, Math.min(held.shortSize / entrySize, 1));
  return Number(Math.abs(long - short).toFixed(6));
}

/**
 * What this position is worth right now, in USD: price movement since entry, plus
 * funding collected, minus the fees a close would pay.
 *
 * This single number drives both the profit exit and the stop-loss, which is
 * deliberate — a position is ahead or behind by one measure, not by two that can
 * disagree. Funding is read from the ledger when there is one; on live there is not, and
 * the fallback is pro-rated from the difference at entry and flagged, because assuming
 * zero income on a strategy built to collect it would trip the stop-loss on positions
 * that are actually ahead.
 */
export interface PositionValue {
  /** Spread movement in our favour since entry, in percent. Null without a quote. */
  spreadGainPct: number | null;
  priceUsd: number;
  fundingUsd: number;
  feeUsd: number;
  /** priceUsd + fundingUsd − feeUsd. */
  netUsd: number;
  /** True when the funding figure is derived rather than read from a ledger. */
  fundingEstimated: boolean;
}

export function positionValue(
  position: StrategyPosition,
  input: FundingYieldInput,
): PositionValue {
  const { exitSpread, intervalHours } = positionView(input.snapshot, position);
  const notional = position.notionalPerLeg;
  const feeUsd = (input.feeCostPct / 100) * notional;

  // Entry minus exit, the opposite order from the projection's cost: here the question is
  // how much price has moved in our favour since entry, and a smaller exit spread than
  // the one we entered on is a gain.
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
    priceUsd: round(priceUsd),
    fundingUsd: round(fundingUsd),
    feeUsd: round(feeUsd),
    netUsd: round(priceUsd + fundingUsd - feeUsd),
    fundingEstimated,
  };
}

/**
 * Funding a position has plausibly collected, when no ledger is available.
 *
 * The entry difference is expressed per normalization interval, so one interval held
 * earns roughly `entryDiffFr%` of notional. Pro-rating by elapsed time understates a
 * position that just crossed a payment and overstates one short of the next — an
 * estimate used to decide whether to act, never to report a result.
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
 * Ranks coins by projected net yield, best first, marking each actionable or blocked
 * with the reason.
 *
 * Ranked by USD rather than by funding difference, unlike the other two funding
 * strategies. A 0.4% difference on a pair whose round trip costs 0.3% in spread is worse
 * than a 0.1% difference on a tight pair, and ranking by the difference alone puts them
 * the wrong way round.
 */
export function rankYields(input: FundingYieldInput): StrategyCandidate[] {
  const { snapshot, config, feeCostPct } = input;
  const notional = config.marginPerLeg * config.leverage;
  const scored: { candidate: StrategyCandidate; net: number }[] = [];

  for (const row of snapshot.rows) {
    const view = restrictedView(row, config.venues);
    if (!view) continue;

    const candidate: StrategyCandidate = {
      coin: row.coin,
      longExchange: view.longExchange,
      shortExchange: view.shortExchange,
      // No clock: this strategy is not timed around any single settlement, which is
      // the point of it. A venue here would imply a deadline it does not have.
      clockExchange: null,
      diffFr: view.diffFr,
      spread: view.spread,
      exitSpread: view.exitSpread,
      fundingTime: null,
      minutesToFunding: null,
    };

    if (view.diffFr < config.minDiffFr) {
      candidate.blockedReason =
        `funding difference ${view.diffFr.toFixed(4)}% is under the ${config.minDiffFr}% floor`;
      scored.push({ candidate, net: Number.NEGATIVE_INFINITY });
      continue;
    }
    if (view.spread === null || view.exitSpread === null) {
      candidate.blockedReason = "one leg has no quote on a side needed to price the round trip";
      scored.push({ candidate, net: Number.NEGATIVE_INFINITY });
      continue;
    }
    if (Math.abs(view.spread) > MAX_PLAUSIBLE_SPREAD_PCT) {
      candidate.blockedReason =
        `implausible spread ${view.spread.toFixed(2)}% — the venues are not quoting the same thing`;
      scored.push({ candidate, net: Number.NEGATIVE_INFINITY });
      continue;
    }

    const projection = projectYield({
      diffFrPct: view.diffFr,
      entrySpread: view.spread,
      exitSpread: view.exitSpread,
      notionalPerLeg: notional,
      feeCostPct,
      settlements: config.targetSettlements,
    });

    // A wide bid-ask is a liquidity warning as much as an expense: the projection
    // assumes both legs fill at the quoted touch, which an illiquid book will not honour.
    if (projection.spreadCostPct > config.maxSpreadCostPct) {
      candidate.blockedReason =
        `round trip costs ${projection.spreadCostPct.toFixed(4)}% in spread, over the ` +
        `${config.maxSpreadCostPct}% ceiling — the books are too wide to trust the fill`;
    } else if (projection.netUsd < config.minNetYieldUsd) {
      candidate.blockedReason =
        `projected net ${fmtUsd(projection.netUsd)} over ${config.targetSettlements} settlements ` +
        `is under the ${fmtUsd(config.minNetYieldUsd)} floor ` +
        `(funding ${fmtUsd(projection.fundingUsd)}, fees ${fmtUsd(-projection.feeUsd)}, ` +
        `spread ${fmtUsd(-projection.spreadCostUsd)})`;
    }

    scored.push({ candidate, net: projection.netUsd });
  }

  return scored.sort((a, b) => b.net - a.net).map((entry) => entry.candidate);
}

function fmtUsd(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

/**
 * Decides what to do with one position already on the books. Returns null when it should
 * be left alone.
 *
 * The order is the risk order, not the profit order: a broken hedge first, then the
 * stop-loss, then the reasons to leave voluntarily. A profit exit checked before the stop
 * would let a position that is deeply under water stay open because it might recover.
 */
export function decideYieldPosition(
  position: StrategyPosition,
  input: FundingYieldInput,
): FundingYieldAction | null {
  const { config, now } = input;
  if (position.status !== "open") return null;

  // ── The hedge itself is broken ─────────────────────────────────────────────
  // Acted on regardless of price or profit: a half-liquidated hedge is directional
  // exposure, and every rule below assumes two matched legs. Quiet for the first minute
  // while both venues' streams catch up.
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

  const value = positionValue(position, input);
  const view = positionView(input.snapshot, position);

  // ── Stop-loss ──────────────────────────────────────────────────────────────
  // The bound this strategy buys in exchange for giving up a settlement deadline.
  // Measured on the whole position — price against the hedge, plus funding already
  // collected — because a stop that ignored collected funding would close positions that
  // are ahead overall.
  //
  // Requires a real spread reading: without one, `priceUsd` is 0 and the net figure is
  // funding alone, which would never trip a stop no matter how far price had moved.
  if (value.spreadGainPct !== null && value.netUsd <= -config.stopLossUsd) {
    return {
      kind: "close",
      position,
      reason:
        `stop-loss — down ${fmtUsd(value.netUsd)} against the ${fmtUsd(-config.stopLossUsd)} limit ` +
        `(price ${fmtUsd(value.priceUsd)}, funding ${fmtUsd(value.fundingUsd)}` +
        `${value.fundingEstimated ? " pro-rated" : ""}, fees ${fmtUsd(-value.feeUsd)})`,
    };
  }

  // ── Funding reversed ───────────────────────────────────────────────────────
  // The venue that was paying is now being paid. Nothing about the position's reason to
  // exist survives that, so waiting for the stop-loss would just be paying to find out.
  if (config.exitOnReversal && view.signedDiffFr !== null && view.signedDiffFr < 0) {
    return {
      kind: "close",
      position,
      reason:
        `funding reversed — ${position.shortExchange} now pays less than ${position.longExchange} ` +
        `(${view.signedDiffFr.toFixed(4)}%), so the hedge is on the wrong side of its own edge. ` +
        `Closing at ${fmtUsd(value.netUsd)}`,
    };
  }

  // ── Profit target ──────────────────────────────────────────────────────────
  // Read off collected funding rather than the net figure, because the target is about
  // the strategy having done its job: the fees are paid off and the multiple kept. Price
  // movement is incidental income here, and letting it satisfy the target would close
  // positions that never collected anything.
  const target = value.feeUsd * config.profitTargetMultiple;
  if (value.fundingUsd >= target && value.netUsd > 0) {
    return {
      kind: "close",
      position,
      reason:
        `target reached — collected ${fmtUsd(value.fundingUsd)} of funding` +
        `${value.fundingEstimated ? " (pro-rated)" : ""}, ${config.profitTargetMultiple}× the ` +
        `${fmtUsd(value.feeUsd)} round trip. Closing at ${fmtUsd(value.netUsd)}`,
    };
  }

  // ── Hold backstop ──────────────────────────────────────────────────────────
  // Not a strategy rule: capital in a hedge that is neither profitable nor losing enough
  // to stop out is capital doing nothing.
  if (config.maxHoldHours > 0) {
    const heldHours = (now - openedAt) / 3_600_000;
    if (heldHours >= config.maxHoldHours) {
      return {
        kind: "close",
        position,
        reason:
          `held ${heldHours.toFixed(1)}h, hitting the ${config.maxHoldHours}h limit — ` +
          `closing at ${fmtUsd(value.netUsd)} rather than holding capital in a position going nowhere`,
      };
    }
  }

  // ── Nothing to do, but record how bad it got ───────────────────────────────
  // A position that recovered still needs to show its low, or there is no way to tell
  // whether the stop-loss is set anywhere near where it matters.
  if (value.spreadGainPct !== null) {
    const worst = position.worstNetUsd;
    if (worst === null || worst === undefined || value.netUsd < worst) {
      return { kind: "mark", position, worstNetUsd: value.netUsd };
    }
  }
  return null;
}

/**
 * Why an open position cannot be evaluated this cycle, or null when it can. Only the
 * data the exit rules actually read is checked.
 */
export function yieldBlindReason(
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
    // Worth a warning rather than silence: without an exit spread the stop-loss cannot
    // fire, which is precisely the guard this strategy depends on.
    return `no quote on the side needed to close one leg of ${position.coin}, so the stop-loss cannot be evaluated`;
  }
  if (view.signedDiffFr === null) {
    return `no funding rate for both legs of ${position.coin}, so a reversal cannot be detected`;
  }
  return null;
}

/**
 * One full evaluation: deal with what is held, then open new hedges within the remaining
 * position budget.
 *
 * No queue phase, unlike the two funding strategies that wait for a settlement window or
 * a cheap entry. The entry test here is already a complete answer — it prices everything
 * it depends on in one instant — so there is nothing to wait for.
 */
export function evaluateYields(input: FundingYieldInput): FundingYieldEvaluation {
  const { config, positions, snapshot } = input;
  const actions: FundingYieldAction[] = [];
  const blind: FundingYieldEvaluation["blind"] = [];

  for (const position of positions) {
    const reason = yieldBlindReason(position, snapshot);
    if (reason) blind.push({ position, reason });
    const action = decideYieldPosition(position, input);
    if (action) actions.push(action);
  }

  const candidates = rankYields(input);
  const heldCoins = new Set(positions.map((p) => p.coin));
  const slots = Math.max(0, config.maxPositions - positions.length);
  const notional = config.marginPerLeg * config.leverage;

  let opened = 0;
  for (const candidate of candidates) {
    if (opened >= slots) break;
    if (candidate.blockedReason) continue;
    // One position per coin per deployment: two hedges on the same coin would fight for
    // the same venue legs and net into one exchange position.
    if (heldCoins.has(candidate.coin)) continue;
    // Narrowed together because the projection needs all three; `exitSpread` is optional
    // on the shared candidate type, so undefined has to be excluded as well as null.
    const { diffFr, spread, exitSpread } = candidate;
    if (diffFr === null || spread === null || exitSpread === null || exitSpread === undefined) {
      continue;
    }

    actions.push({
      kind: "open",
      candidate,
      projection: projectYield({
        diffFrPct: diffFr,
        entrySpread: spread,
        exitSpread,
        notionalPerLeg: notional,
        feeCostPct: input.feeCostPct,
        settlements: config.targetSettlements,
      }),
    });
    heldCoins.add(candidate.coin);
    opened += 1;
  }

  return { actions, candidates, blind };
}
