import type {
  ExchangeId,
  FundingRateRow,
  MarketSnapshot,
  PerpBridgeConfig,
  StrategyCandidate,
  StrategyPosition,
} from "@/lib/types";
import { deriveExitSpread, derivePriceSpread } from "@/lib/market/derive";

/**
 * PerpBridge decision logic.
 *
 * Pure, like the FundingSync engine: a snapshot plus what is held goes in,
 * decisions come out. No database, no orders, and `now` is passed in.
 *
 * The bet is simple enough to state in one line: two venues quoting the same
 * perpetual at different prices will converge, so sell the expensive one, buy the
 * cheap one, and close when the gap has narrowed. Funding is not consulted at all.
 *
 * That simplicity is also the risk. FundingSync has a deadline — the settlement it
 * targets — which bounds how long a position can misbehave. PerpBridge has none:
 * if the gap widens instead of closing, the position sits there. The entry floor
 * is the only real protection, which is why it defaults well above the fees.
 */

export type PerpBridgeAction =
  | { kind: "open"; candidate: StrategyCandidate; spread: number }
  | { kind: "close"; position: StrategyPosition; reason: string };

export interface PerpBridgeInput {
  snapshot: MarketSnapshot;
  config: PerpBridgeConfig;
  positions: StrategyPosition[];
  now: number;
  /** Round trip taker fees as a percent of one leg's notional. */
  feeCostPct: number;
}

export interface PerpBridgeEvaluation {
  actions: PerpBridgeAction[];
  candidates: StrategyCandidate[];
  /** Open positions whose gap can no longer be measured. */
  blind: { position: StrategyPosition; reason: string }[];
}

/**
 * Widest gap that can plausibly be a real cross-venue difference. Two venues on
 * the same perpetual do not differ by more than a few percent; a larger reading
 * means they are not quoting the same thing — a stale tick, or contracts with
 * different unit sizes. Sizing from such a price would be wrong too.
 *
 * Not configurable: a data-sanity floor, not a preference.
 */
const MAX_PLAUSIBLE_SPREAD_PCT = 5;

/**
 * The venue pair with the widest positive gap for one coin, restricted to the
 * venues this strategy may use.
 *
 * Every pair is examined rather than reusing the dashboard's funding-derived
 * direction: the widest *price* gap is frequently a different pair from the widest
 * funding difference, and this strategy only cares about the former.
 */
function widestGap(
  row: FundingRateRow,
  venues: ExchangeId[],
): { longExchange: ExchangeId; shortExchange: ExchangeId; spread: number; exitSpread: number | null } | null {
  let best: {
    longExchange: ExchangeId;
    shortExchange: ExchangeId;
    spread: number;
    exitSpread: number | null;
  } | null = null;

  for (const buyAt of venues) {
    const ask = row.tickers[buyAt]?.ask ?? null;
    if (ask === null || ask <= 0) continue;
    for (const sellAt of venues) {
      if (sellAt === buyAt) continue;
      const bid = row.tickers[sellAt]?.bid ?? null;
      if (bid === null || bid <= 0) continue;

      // Buy the cheap venue, sell the expensive one: the gap is the credit.
      const direction = {
        longExchange: buyAt,
        shortExchange: sellAt,
        longRate: 0,
        shortRate: 0,
        intervalHours: 0,
        diff: 0,
      };
      const entry = derivePriceSpread(direction, row.tickers);
      if (!entry) continue;
      if (best === null || entry.pct > best.spread) {
        best = {
          longExchange: buyAt,
          shortExchange: sellAt,
          spread: entry.pct,
          exitSpread: deriveExitSpread(direction, row.tickers)?.pct ?? null,
        };
      }
    }
  }
  return best;
}

/** Current gap for a held position, measured on its own two venues. */
function positionGap(
  snapshot: MarketSnapshot,
  position: StrategyPosition,
): { spread: number | null; exitSpread: number | null } {
  const row = snapshot.rows.find((r) => r.coin === position.coin);
  if (!row) return { spread: null, exitSpread: null };
  const direction = {
    longExchange: position.longExchange,
    shortExchange: position.shortExchange,
    longRate: 0,
    shortRate: 0,
    intervalHours: 0,
    diff: 0,
  };
  return {
    spread: derivePriceSpread(direction, row.tickers)?.pct ?? null,
    exitSpread: deriveExitSpread(direction, row.tickers)?.pct ?? null,
  };
}

/**
 * Ranks coins by their widest positive gap, largest first, marking each actionable
 * or blocked with the reason. Ranking is by gap because the gap is the entire
 * edge here.
 */
export function rankGaps(input: PerpBridgeInput): StrategyCandidate[] {
  const { snapshot, config } = input;
  const out: StrategyCandidate[] = [];

  for (const row of snapshot.rows) {
    const gap = widestGap(row, config.venues);
    if (!gap) continue;

    const candidate: StrategyCandidate = {
      coin: row.coin,
      longExchange: gap.longExchange,
      shortExchange: gap.shortExchange,
      // No funding clock: this strategy does not wait for a settlement.
      clockExchange: null,
      diffFr: null,
      spread: gap.spread,
      exitSpread: gap.exitSpread,
      fundingTime: null,
      minutesToFunding: null,
    };

    if (gap.spread < config.minEntrySpread) {
      candidate.blockedReason = `gap ${gap.spread.toFixed(4)}% is under the ${config.minEntrySpread}% floor`;
    } else if (gap.spread > MAX_PLAUSIBLE_SPREAD_PCT) {
      candidate.blockedReason = `implausible gap ${gap.spread.toFixed(2)}% — quotes look mismatched`;
    } else if (gap.exitSpread === null) {
      candidate.blockedReason = "one leg has no quote on the side needed to close";
    }

    out.push(candidate);
  }

  return out.sort((a, b) => (b.spread ?? -Infinity) - (a.spread ?? -Infinity));
}

/**
 * Whether an open position should be closed.
 *
 * One trigger only: enough of the entry gap has closed to clear the target plus
 * fees. There is deliberately no time-based exit — adding one would mean guessing
 * how long convergence should take, and a wrong guess closes profitable positions
 * early. The consequence, which is real, is that a gap that widens leaves the
 * position open until it comes back.
 */
export function decideGapPosition(
  position: StrategyPosition,
  input: PerpBridgeInput,
): PerpBridgeAction | null {
  if (position.status !== "open") return null;
  if (position.entrySpread === null) return null;

  const { exitSpread } = positionGap(input.snapshot, position);
  if (exitSpread === null) return null;

  const gain = position.entrySpread - exitSpread;
  const target = input.config.minProfitSpread + input.feeCostPct;
  if (gain >= target) {
    return {
      kind: "close",
      position,
      reason:
        `gap closed by ${gain.toFixed(4)}% (target ${input.config.minProfitSpread}% ` +
        `+ ${input.feeCostPct.toFixed(4)}% fees)`,
    };
  }
  return null;
}

/** Why an open position cannot be evaluated, or null when it can. */
export function gapBlindReason(
  position: StrategyPosition,
  snapshot: MarketSnapshot,
): string | null {
  if (position.status !== "open") return null;
  const row = snapshot.rows.find((r) => r.coin === position.coin);
  if (!row) {
    return `${position.coin} is no longer streamed, so the gap cannot be measured and it will not close on its own`;
  }
  const { exitSpread } = positionGap(snapshot, position);
  if (exitSpread === null) return `no quote for one leg of ${position.coin}`;
  return null;
}

/**
 * One full evaluation: close what has converged, then open new gaps within the
 * remaining position budget.
 *
 * Entry is immediate — there is no queue. FundingSync queues because it waits for
 * a settlement to approach; a price gap is either wide enough now or it is not.
 */
export function evaluateGaps(input: PerpBridgeInput): PerpBridgeEvaluation {
  const { config, positions, snapshot } = input;
  const actions: PerpBridgeAction[] = [];
  const blind: PerpBridgeEvaluation["blind"] = [];

  for (const position of positions) {
    const reason = gapBlindReason(position, snapshot);
    if (reason) blind.push({ position, reason });
    const action = decideGapPosition(position, input);
    if (action) actions.push(action);
  }

  const candidates = rankGaps(input);
  const heldCoins = new Set(positions.map((p) => p.coin));
  const slots = Math.max(0, config.maxPositions - positions.length);

  let opened = 0;
  for (const candidate of candidates) {
    if (opened >= slots) break;
    if (candidate.blockedReason) continue;
    if (heldCoins.has(candidate.coin)) continue;
    if (candidate.spread === null) continue;
    actions.push({ kind: "open", candidate, spread: candidate.spread });
    opened += 1;
  }

  return { actions, candidates, blind };
}
