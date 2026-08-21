import type { ExchangeId, Position, StrategyId, Trade, TradeSource } from "@/lib/types";
import { STRATEGY_META } from "@/lib/types";

/**
 * Hedge-oriented views of account data.
 *
 * The account tables store legs, because that is what a venue fills. But a hedge
 * is one decision with two legs, and reading it as two rows means doing the
 * pairing by eye — worse, a long at one venue and a short at another look like
 * two opposing bets rather than one position. These helpers regroup legs into the
 * hedge they belong to.
 *
 * Pure functions over data already fetched: no queries, so the same grouping works
 * for paper and live.
 */

/**
 * Which strategy a hedge id belongs to, from its prefix.
 *
 * The prefix is assigned in `queuePosition`, so this needs no extra column — but it
 * identifies the *strategy*, not the deployment. Three FundingBridge deployments all
 * emit `FB-…`, and telling them apart needs the position row, which these pure
 * browser-side helpers cannot read. Callers that have a hedge-id → deployment-label
 * map from the server can pass it to `sourceLabel`/`sourceShort` for the finer answer.
 *
 * Only meaningful for automated rows: a manual trade may carry any hedge id.
 */
export function strategyFromHedgeId(hedgeId: string | null | undefined): StrategyId | null {
  if (!hedgeId) return null;
  if (hedgeId.startsWith("FS-")) return "fundingsync";
  if (hedgeId.startsWith("PB-")) return "perpbridge";
  if (hedgeId.startsWith("FB-")) return "fundingbridge";
  if (hedgeId.startsWith("FY-")) return "fundingyield";
  return null;
}

/**
 * Label for the source tag: the deployment's name when known, otherwise the
 * strategy's, otherwise "Manual".
 *
 * `deploymentLabels` maps hedge id to deployment label and comes from the server.
 * With several deployments of one strategy the label is the useful answer — "Asia
 * CEX" says which configuration opened this, where "FundingBridge" does not.
 */
export function sourceLabel(
  source: TradeSource | undefined,
  hedgeId?: string | null,
  deploymentLabels?: Record<string, string>,
): string {
  if (source !== "auto") return "Manual";
  const label = hedgeId ? deploymentLabels?.[hedgeId] : undefined;
  if (label) return label;
  const strategy = strategyFromHedgeId(hedgeId);
  return strategy ? STRATEGY_META[strategy].name : "Auto";
}

/**
 * Short tag for narrow columns. Reads the name from STRATEGY_META rather than
 * repeating it, so adding a strategy cannot leave this returning a bare "auto" for
 * rows it could actually identify.
 */
export function sourceShort(
  source: TradeSource | undefined,
  hedgeId?: string | null,
  deploymentLabels?: Record<string, string>,
): string {
  if (source !== "auto") return "manual";
  const label = hedgeId ? deploymentLabels?.[hedgeId] : undefined;
  if (label) return label;
  const strategy = strategyFromHedgeId(hedgeId);
  return strategy ? STRATEGY_META[strategy].name : "auto";
}

// ─── Open positions grouped into hedges ─────────────────────────────────────

export interface HedgeRow {
  /** hedgeId when the legs are paired, otherwise a synthetic key. */
  key: string;
  coin: string;
  source?: TradeSource;
  hedgeId?: string;
  longLeg: Position | null;
  shortLeg: Position | null;
  /** Legs that could not be paired — an unhedged remainder worth seeing. */
  extraLegs: Position[];
  /** Sum across the legs. */
  unrealizedPnl: number;
  /** True when any leg has no live quote, so the total is incomplete. */
  markStale: boolean;
  size: number;
  leverage: number;
  /** Notional at entry, summed over the legs. */
  notional: number;
  /** Funding received (positive) or paid (negative) so far, when known. */
  fundingPnl?: number;
  updatedAt: number;
}

/**
 * Groups open legs into hedges.
 *
 * Legs without a hedge id are grouped by (coin, source) instead: a manual long and
 * short on the same coin still form a hedge in substance, and showing them apart
 * would defeat the purpose. A leg with no partner is reported rather than hidden,
 * because an unpaired leg is directional exposure.
 */
export function groupPositions(
  positions: Position[],
  fundingByHedge: Record<string, number> = {},
  fundingByCoin: Record<string, number> = {},
): HedgeRow[] {
  const groups = new Map<string, Position[]>();
  for (const p of positions) {
    const key = p.hedgeId ? `h:${p.hedgeId}` : `c:${p.coin}:${p.source ?? "manual"}`;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }

  const rows: HedgeRow[] = [];
  for (const [key, legs] of groups) {
    const longs = legs.filter((l) => l.side === "long");
    const shorts = legs.filter((l) => l.side === "short");
    const longLeg = longs[0] ?? null;
    const shortLeg = shorts[0] ?? null;
    const extraLegs = [...longs.slice(1), ...shorts.slice(1)];
    const hedgeId = legs.find((l) => l.hedgeId)?.hedgeId;

    rows.push({
      key,
      coin: legs[0].coin,
      source: legs[0].source,
      hedgeId,
      longLeg,
      shortLeg,
      extraLegs,
      unrealizedPnl: Number(legs.reduce((sum, l) => sum + l.unrealizedPnl, 0).toFixed(6)),
      markStale: legs.some((l) => l.markStale === true),
      // Both legs carry the same size in a hedge; the max covers a partial close.
      size: Math.max(...legs.map((l) => l.size)),
      leverage: legs[0].leverage,
      notional: Number(legs.reduce((sum, l) => sum + l.size * l.entryPrice, 0).toFixed(2)),
      fundingPnl: hedgeId
        ? fundingByHedge[hedgeId]
        : fundingByCoin[legs[0].coin],
      updatedAt: Math.max(...legs.map((l) => l.updatedAt ?? 0)),
    });
  }

  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ─── Fills grouped into hedge round trips ───────────────────────────────────

export interface HedgeTradeRow {
  key: string;
  coin: string;
  source?: TradeSource;
  hedgeId?: string;
  /** Every fill in this group, newest first. */
  fills: Trade[];
  /** Venues involved, for the route label. */
  buyExchanges: ExchangeId[];
  sellExchanges: ExchangeId[];
  /** Trading PnL net of fees, summed over closing fills. */
  realizedPnl: number | null;
  /** Total trading fees across every fill. */
  fee: number;
  /** Funding received or paid on this hedge, when known. */
  fundingPnl?: number;
  /** realizedPnl + fundingPnl — what the hedge actually earned. */
  totalPnl: number | null;
  /** True once at least one fill reported PnL, i.e. the hedge closed. */
  closed: boolean;
  time: number;
}

/**
 * Groups fills into hedges.
 *
 * Both the opening and closing fills of one hedge share its id, so a completed
 * round trip is four fills in one row. Fees are summed across all four, which is
 * the number that matters — a hedge pays taker fees four times, and seeing them
 * one fill at a time hides how much that is.
 */
export function groupTrades(
  trades: Trade[],
  fundingByHedge: Record<string, number> = {},
  fundingByCoin: Record<string, number> = {},
): HedgeTradeRow[] {
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    // Without a hedge id each fill stands alone: guessing which manual buy pairs
    // with which manual sell would invent a hedge that may not exist.
    const key = t.hedgeId ? `h:${t.hedgeId}` : `t:${t.id}`;
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }

  const rows: HedgeTradeRow[] = [];
  for (const [key, fills] of groups) {
    const closing = fills.filter((f) => f.realizedPnl !== null && f.realizedPnl !== undefined);
    const realizedPnl =
      closing.length > 0
        ? Number(closing.reduce((sum, f) => sum + (f.realizedPnl ?? 0), 0).toFixed(6))
        : null;
    const fee = Number(fills.reduce((sum, f) => sum + (f.fee ?? 0), 0).toFixed(6));
    const hedgeId = fills.find((f) => f.hedgeId)?.hedgeId;
    const funding = hedgeId ? fundingByHedge[hedgeId] : fundingByCoin[fills[0].coin];

    rows.push({
      key,
      coin: fills[0].coin,
      source: fills[0].source,
      hedgeId,
      fills: [...fills].sort((a, b) => b.time - a.time),
      buyExchanges: [...new Set(fills.filter((f) => f.side === "buy").map((f) => f.exchange))],
      sellExchanges: [...new Set(fills.filter((f) => f.side === "sell").map((f) => f.exchange))],
      realizedPnl,
      fee,
      fundingPnl: funding,
      totalPnl:
        realizedPnl === null && funding === undefined
          ? null
          : Number(((realizedPnl ?? 0) + (funding ?? 0)).toFixed(6)),
      closed: closing.length > 0,
      time: Math.max(...fills.map((f) => f.time)),
    });
  }

  return rows.sort((a, b) => b.time - a.time);
}
