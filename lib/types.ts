// Core domain types for the funding rate dashboard.
// All amounts are expressed as a percentage (e.g. 0.0123 means 0.0123%).

export type ExchangeId =
  | "binance"
  | "bybit"
  | "okx"
  | "kucoin"
  | "gateio"
  | "bitget"
  | "hyperliquid"
  | "aster"
  | "lighter"
  | "edgex";

/**
 * Whether a venue custodies funds behind an API key (centralized) or settles
 * on-chain and is signed for with a wallet (decentralized). The dashboard splits
 * its views on this, because the two have different funding cadences, different
 * credential shapes, and different withdrawal mechanics.
 */
export type VenueType = "cex" | "dex";

/**
 * Which venue pairs a funding view is allowed to quote a hedge across.
 *
 * A hedge is always two legs on two venues, so the interesting question is not
 * "which venues" but "which combinations". The three scopes are genuinely
 * different trades: `cex-cex` is the classic funding arbitrage with same-day
 * settlement on both legs; `dex-dex` settles on-chain on both sides; `cross`
 * bridges the two and carries the widest funding gaps precisely because moving
 * collateral between a custodial venue and a chain is slower.
 */
export type PairScope = "cex-cex" | "dex-dex" | "cross";

export interface ExchangeInfo {
  id: ExchangeId;
  name: string;
  /** Tailwind text color class used for branding accents. */
  accent: string;
  /** Funding settlement cadence in hours, as commonly used by the venue. */
  defaultIntervalHours: number;
  venueType: VenueType;
}

export interface FundingRateValue {
  exchange: ExchangeId;
  /** Funding rate as a percentage (0.0123 => 0.0123%). null means not listed. */
  rate: number | null;
  /** Settlement cadence in hours for this venue. */
  intervalHours: number;
  /** Epoch ms of the next funding settlement. */
  nextFundingTime: number;
  /**
   * False when intervalHours is still the venue default because the stream has
   * not yet reported enough timestamps to derive the real cadence.
   */
  intervalConfirmed?: boolean;
  /** Epoch ms when this reading arrived over the stream. */
  updatedAt?: number;
  /**
   * True when the rate came from a REST fallback because this venue's funding
   * stream is unreachable. Surfaced in the UI so the source is never implied.
   */
  fromRest?: boolean;
}

/** Best bid/ask for one (coin, venue), straight from the venue's stream. */
export interface Ticker {
  exchange: ExchangeId;
  /** Highest price a buyer is bidding — the price a short entry fills at. */
  bid: number | null;
  /** Lowest price a seller is asking — the price a long entry fills at. */
  ask: number | null;
  /** Epoch ms of the venue timestamp for this quote. */
  ts: number;
}

/** Which side of the book a displayed price refers to. */
export type PriceSide = "bid" | "ask";

/**
 * Entry cost of the hedge implied by a row's Direction, using executable
 * prices: the long leg pays the ask, the short leg receives the bid.
 */
export interface PriceSpread {
  longExchange: ExchangeId;
  shortExchange: ExchangeId;
  /** Ask on the long venue — what the long leg actually pays. */
  longAsk: number;
  /** Bid on the short venue — what the short leg actually receives. */
  shortBid: number;
  /** (shortBid - longAsk) / longAsk * 100. Positive means entry is in credit. */
  pct: number;
}

export interface NormalizedFundingRate {
  exchange: ExchangeId;
  rawRate: number;
  normalizedRate: number;
  intervalHours: number;
}

export interface FundingDirection {
  longExchange: ExchangeId;
  shortExchange: ExchangeId;
  longRate: number;
  shortRate: number;
  intervalHours: number;
  diff: number;
}

/** One row of the comparison table: a coin with its funding across venues. */
export interface FundingRateRow {
  coin: string;
  /** Base asset name for display, e.g. "Bitcoin". */
  name: string;
  rates: Record<ExchangeId, FundingRateValue>;
  normalizedRates: Record<ExchangeId, number | null>;
  /** Best bid/ask per venue; null entries mean no stream data yet. */
  tickers: Record<ExchangeId, Ticker | null>;
  /** Backward-compatible alias for diffFr. */
  spread: number | null;
  diffFr: number | null;
  direction: FundingDirection | null;
  /** Executable entry spread for the Direction pair, when both quotes exist. */
  priceSpread: PriceSpread | null;
}

export type SortKey = "coin" | ExchangeId | "spread" | "diffFr" | "priceSpread";
export type SortDir = "asc" | "desc";

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

// ─── Live market plumbing ───────────────────────────────────────────────────

export type VenueHealth = "connecting" | "ok" | "degraded" | "down";

export interface VenueStatus {
  exchange: ExchangeId;
  health: VenueHealth;
  /** Open websocket connections for this venue (sharded when topics are many). */
  connections: number;
  /** Number of (coin) subscriptions currently active. */
  subscriptions: number;
  /** Epoch ms of the last message received from this venue. */
  lastMessageAt: number | null;
  /** Epoch ms of the last successful REST ranking fetch. */
  lastPollAt: number | null;
  /** Most recent error, for surfacing in the UI. */
  lastError: string | null;
  /**
   * True when funding for this venue is being filled from REST because its
   * funding stream never delivers on this network.
   */
  fundingFromRest?: boolean;
}

/**
 * Which layer put a (coin, venue) subscription in place.
 *
 * 1 and 2 come from the REST ranking: each venue's own top pairs, then the same
 * coins on every other venue that lists them. 3 is a claim — a pair someone is
 * holding a position in. Ranking follows the market; claims follow your exposure,
 * and a coin can leave the top pairs while you are still in it.
 */
export type SubscriptionLayer = 1 | 2 | 3;

export interface LayerAssignment {
  exchange: ExchangeId;
  coin: string;
  layer: SubscriptionLayer;
}

export interface MarketSnapshot {
  rows: FundingRateRow[];
  venues: VenueStatus[];
  layers: LayerAssignment[];
  /** Coins currently watched, i.e. the union of layers 1, 2 and 3. */
  coins: string[];
  /** Pairs streamed because a position is open in them, with the holder. */
  claims?: { exchange: ExchangeId; coin: string; reason: string }[];
  /** Epoch ms this snapshot was produced. */
  updatedAt: number;
  /** Epoch ms of the last completed REST ranking cycle. */
  lastPollAt: number | null;
  config: MarketConfig;
}

export interface MarketConfig {
  /** REST ranking cadence in seconds. */
  pollIntervalSec: number;
  /** How many top-funding pairs each venue contributes to layer 1. */
  layer1CountPerExchange: number;
}


// ─── Account / trading domain ───────────────────────────────────────────────

export type AccountType = "live" | "paper";

export interface ConnectedAccount {
  exchange: ExchangeId;
  connected: boolean;
  /** Masked API key tail, e.g. "••••3fA2". */
  maskedApiKey?: string;
  /** When the connection was last verified, epoch ms. */
  lastChecked?: number;
}

/**
 * What created an order, trade or position. Manual trades and strategy legs
 * share the same tables — the strategy writes through the same code path a
 * manual trade uses — so this is how they are told apart.
 */
export type TradeSource = "manual" | "auto";

export interface Position {
  /** Venue holding this position. Required: a position without a venue cannot
   * be closed, hedged, or rebalanced. */
  exchange: ExchangeId;
  coin: string;
  side: "long" | "short";
  size: number; // base asset units
  entryPrice: number;
  markPrice: number;
  /** Unrealized PnL in quote currency (USD). */
  unrealizedPnl: number;
  leverage: number;
  /** Liquidation price when the venue reports one. */
  liquidationPrice?: number | null;
  /** Links the two legs of one hedge. */
  hedgeId?: string;
  /** Whether a manual trade or the strategy opened this. */
  source?: TradeSource;
  /**
   * True when no live quote is available, so `markPrice` fell back to the entry
   * price and `unrealizedPnl` is not a real number. Distinguishes "flat" from
   * "unknown" — without this a position whose venue went quiet reads as 0.00 PnL,
   * which looks like information but is its absence.
   */
  markStale?: boolean;
  /** Epoch ms of the last update for this position. */
  updatedAt?: number;
}

export interface Trade {
  id: string;
  time: number; // epoch ms
  coin: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  /** Realized PnL in USD, net of fees (null for non-closing trades). */
  realizedPnl: number | null;
  exchange: ExchangeId;
  /** Trading fee for this fill, in USD. */
  fee?: number | null;
  hedgeId?: string;
  source?: TradeSource;
}

export interface PnLSummary {
  daily: number; // USD, today
  total: number; // USD, all-time realized
  /** Last N days of daily PnL for a sparkline, oldest first. */
  series: number[];
}

export interface AccountOverview {
  accountType: AccountType;
  balance: number;
  equity: number;
  marginUsed: number;
  available: number;
  pnl: PnLSummary;
  positions: Position[];
  recentTrades: Trade[];
  /** Open orders currently resting on the book. */
  openOrders?: Order[];
  /** Trading fees charged since the last reset. Paper account only. */
  feesPaid?: number;
  /**
   * Net funding received (positive) or paid (negative) since the last reset.
   * Paper account only; on live the venue reports it inside its own balance.
   */
  fundingPnl?: number;
  /**
   * Funding attributed per hedge id, and per coin for legs with no hedge id, so a
   * grouped view can show what each hedge earned without another request.
   */
  fundingByHedge?: Record<string, number>;
  fundingByCoin?: Record<string, number>;
  /** Epoch ms of the last state change. */
  updatedAt?: number;
}

// ─── Paper account ──────────────────────────────────────────────────────────

export interface PaperAccountState {
  /** Balance the account was last reset to. */
  startingBalance: number;
  /** Sum of realized PnL since the last reset, net of fees and including funding. */
  realizedPnl: number;
  /** Trading fees paid since the last reset. */
  feesPaid: number;
  /** Net funding received (positive) or paid (negative) since the last reset. */
  fundingPnl: number;
  /** Epoch ms of the last reset. */
  resetAt: number;
}

/** Default simulated balance when the paper account is created or reset. */
export const DEFAULT_PAPER_BALANCE = 10_000;

// ─── Credentials ────────────────────────────────────────────────────────────

/**
 * How a venue is authenticated.
 *
 * `cex` is an API key issued by the exchange, revocable there. `dex` is a wallet
 * private key that signs on-chain: it cannot be revoked, only abandoned, which is
 * why the two are stored and presented as different things rather than as one
 * form with optional fields.
 */
export type CredentialKind = "cex" | "dex";

/**
 * Everything the UI is allowed to know about a stored credential. Secrets are
 * deliberately absent — no endpoint ever returns them, encrypted or otherwise.
 */
export interface CredentialStatus {
  exchange: ExchangeId;
  kind: CredentialKind;
  /** True when a credential is stored for this venue. */
  configured: boolean;
  /**
   * False when this app has no authenticated integration for the venue at all —
   * market data works, but positions, balances and orders do not. The UI must not
   * offer a credential form for these: storing a secret that nothing can use is
   * pure downside, and for a DEX that secret is an unrevocable wallet key.
   */
  accountSupported: boolean;
  /** Last 4 characters of the public API key, for recognition only. */
  keyTail: string | null;
  /** Whether this venue participates in private streams and orders. */
  enabled: boolean;
  /** True when the key is marked read-only, so orders are refused. */
  readOnly: boolean;
  /** Whether the venue needs a passphrase alongside key and secret. */
  requiresPassphrase: boolean;
  /** True when order placement is not implemented for this venue. */
  readOnlyVenue?: boolean;
  /** Optional operator label, so several accounts stay distinguishable. */
  label?: string | null;
  /** For a DEX venue: the public wallet address, masked. */
  walletAddressMasked?: string | null;
  lastVerifiedAt: number | null;
  lastError: string | null;
}

// ─── Live account ───────────────────────────────────────────────────────────

export type PrivateStreamHealth = "disabled" | "connecting" | "ok" | "degraded" | "down";

export interface PrivateVenueStatus {
  exchange: ExchangeId;
  health: PrivateStreamHealth;
  /** Epoch ms of the last private message received. */
  lastMessageAt: number | null;
  lastError: string | null;
}

export interface VenueBalance {
  exchange: ExchangeId;
  asset: string;
  available: number;
  inPosition: number;
  equity: number;
  updatedAt: number;
}

export interface LiveAccountSnapshot {
  positions: Position[];
  openOrders: Order[];
  recentTrades: Trade[];
  balances: VenueBalance[];
  venues: PrivateVenueStatus[];
  updatedAt: number;
}

// ─── Automation domain ──────────────────────────────────────────────────────

/**
 * The strategies this app can run.
 *
 * They are deliberately different in kind, not variations of one thing:
 * FundingSync earns the funding difference and is timed around settlements;
 * PerpBridge ignores funding entirely and earns the price spread converging;
 * FundingBridge also earns funding, but reaches it differently — it locks a target
 * on funding merit alone and then waits for the entry to become cheap, and its exit
 * depends on whether the two legs settle on the same clock.
 *
 * FundingYield is the fourth and inverts a shared assumption. The other three gate
 * entry on the price spread being acceptable *on its own*, which rejects the widest
 * funding differences precisely because a wide difference exists when two venues
 * disagree about price. FundingYield adds the three numbers into one figure instead
 * — expected funding, minus fees, minus the measured cost of getting in and out —
 * and holds across several settlements so the round trip's four taker fills are
 * amortised rather than paid per payment. Because it has no settlement deadline to
 * hide behind, it is also the only one with a real stop-loss.
 */
export type StrategyId = "fundingsync" | "perpbridge" | "fundingbridge" | "fundingyield";

export const STRATEGY_IDS: readonly StrategyId[] = [
  "fundingsync",
  "perpbridge",
  "fundingbridge",
  "fundingyield",
] as const;

/** Display metadata, so the UI does not hardcode names in several places. */
export interface StrategyMeta {
  id: StrategyId;
  name: string;
  /** One line, plain: what it earns from. */
  tagline: string;
}

export const STRATEGY_META: Record<StrategyId, StrategyMeta> = {
  fundingsync: {
    id: "fundingsync",
    name: "FundingSync",
    tagline: "Collects the funding rate difference between two venues",
  },
  perpbridge: {
    id: "perpbridge",
    name: "PerpBridge",
    tagline: "Ignores funding; earns the price gap between two venues closing",
  },
  fundingbridge: {
    id: "fundingbridge",
    name: "FundingBridge",
    tagline: "Locks the best funding pair, then waits for a cheap entry before hedging",
  },
  fundingyield: {
    id: "fundingyield",
    name: "FundingYield",
    tagline: "Holds a funding hedge across several settlements, judged on net USD yield",
  },
};

/**
 * FundingSync configuration.
 *
 * The strategy hedges one coin across two venues to collect the funding
 * difference, entering shortly before the settlement it intends to harvest and
 * exiting once that settlement has passed or the edge is gone.
 *
 * Every field is editable per account type; the defaults live in
 * lib/strategy/config.ts.
 */
export interface StrategyConfig {
  /** Venues the strategy may use. At least two, or nothing can be hedged. */
  venues: ExchangeId[];
  /** Maximum hedges held at once. */
  maxPositions: number;
  /** Margin committed per leg, in USD. */
  marginPerLeg: number;
  /** Leverage per leg, so notional per leg is marginPerLeg × leverage. */
  leverage: number;
  /** Enter only within this many minutes before the settlement being harvested. */
  entryWindowMin: number;
  /** Minimum normalized funding difference to consider a coin, in percent. */
  minDiffFr: number;
  /** instant sends immediately; delay waits for the price spread to converge. */
  entryMode: ExecutionMode;
  /**
   * Minimum entry spread required to open, in percent.
   *
   * The entry spread is `(bid on the short venue − ask on the long venue)`, so a
   * positive value means the hedge opens in credit: selling the expensive side
   * and buying the cheap one. A negative entry spread is a loss booked at the
   * moment of opening, and since prices tend to converge toward zero it is a loss
   * that gets realised rather than recovered — which is why the floor exists.
   *
   * It is a configurable floor rather than a hard "positive only" test because
   * funding income and spread are separate sources: a large diff FR can justify a
   * slightly negative entry.
   */
  minEntrySpread: number;
  /** Abandon a queued entry if the difference falls below this, in percent. */
  cancelDiffFr: number;
  /** Exit once the difference has decayed to this or below, in percent. */
  exitDiffFr: number;
  /**
   * Instant exit target: how far the spread must move in our favour, in percent,
   * *after* trading fees. Profit is `(entry spread − current exit spread)`, and
   * the gate adds the round trip's four taker fees on top of this number, so 0.2
   * means 0.2% actually kept.
   */
  minProfitSpread: number;
  /** Delay exit waits until |exit spread| is at or below this, in percent. */
  maxExitSpread: number;
  /**
   * Close after the harvested settlement passes.
   *
   * With `holdForSpreadAfterFunding` off this closes at the settlement regardless
   * of price, which is the safest behaviour for legs on different intervals:
   * holding on means paying the short-interval leg until the other settles.
   */
  exitAfterFunding: boolean;
  /**
   * After the payment is collected, hold the position until the spread is worth
   * exiting at instead of closing immediately.
   *
   * The payment is already banked once the settlement passes, so the only thing
   * left is the exit price — and taking whatever spread exists at that exact second
   * regularly turned a collected payment into a net loss. The wait is bounded by
   * the next settlement, because that is when the funding cost starts again.
   */
  holdForSpreadAfterFunding: boolean;
  /**
   * When the funding difference decays, wait for a spread that at least breaks even
   * instead of closing at whatever price exists.
   *
   * Closing on decay alone means accepting the spread of that exact second, which
   * is how a hedge ends up realising a loss it never had to take. The target here is
   * break-even after fees rather than the full profit target: with no edge left,
   * holding out for profit is a directional bet. Bounded by the settlement, which
   * is when funding starts costing.
   */
  holdForSpreadAfterDecay: boolean;
}

/**
 * PerpBridge configuration.
 *
 * A different bet from FundingSync, not a variation of it. Funding is ignored
 * entirely: the money comes from a price gap between two venues closing. Enter
 * when the gap is wide enough to cover fees with room to spare, close once the
 * gap has narrowed by the target amount.
 *
 * Because there is no settlement to aim at there is no entry window either — a
 * gap is tradable whenever it appears.
 */
export interface PerpBridgeConfig {
  /** Venues the strategy may use. At least two, or nothing can be hedged. */
  venues: ExchangeId[];
  /** Maximum hedges held at once. */
  maxPositions: number;
  /** Margin committed per leg, in USD. */
  marginPerLeg: number;
  /** Leverage per leg, so notional per leg is marginPerLeg × leverage. */
  leverage: number;
  /**
   * Minimum entry gap required to open, in percent.
   *
   * Only positive gaps are ever taken: the gap *is* the profit here, so opening
   * at zero or below has nothing to earn back. Kept well above the round trip's
   * fees, or a converging gap pays the venues instead of you.
   */
  minEntrySpread: number;
  /**
   * How much of the gap must close before exiting, in percent, after fees.
   * The round trip's four taker fees are added to this, so 0.2 means 0.2% kept.
   */
  minProfitSpread: number;
}

/**
 * FundingBridge configuration.
 *
 * A third bet, and it differs from FundingSync in where the two decisions are made
 * rather than in what it earns. FundingSync ranks a coin and enters when both the
 * funding difference and the entry spread are acceptable at the same moment.
 * FundingBridge separates them: a target is locked on funding merit alone as its
 * settlement approaches, and only then does it watch the spread, entering the moment
 * the entry becomes cheap enough and abandoning the target if the funding edge
 * collapses while it waits.
 *
 * The exit differs too, and that is the part worth understanding. When both legs
 * settle on the same cadence the position is left alone until the funding edge is
 * gone, then closes on a spread that pays for the round trip. When the cadences
 * differ there is no shared deadline to wait for — the faster leg keeps paying
 * funding while the slower one has not settled yet — so the position is closed on an
 * estimate of what exiting right now would realise, bounded by a hard maximum hold.
 */
export interface FundingBridgeConfig {
  /** Venues the strategy may use. At least two, or nothing can be hedged. */
  venues: ExchangeId[];
  /** Maximum hedges held at once. */
  maxPositions: number;
  /** Margin committed per leg, in USD. */
  marginPerLeg: number;
  /** Leverage per leg, so notional per leg is marginPerLeg × leverage. */
  leverage: number;
  /**
   * Lock a target only within this many minutes of the settlement it is aimed at.
   *
   * The clock is the leg paying the larger absolute rate, because that is the
   * payment being collected — anchoring to the other leg would arm the entry around
   * a settlement that barely matters.
   */
  entryWindowMin: number;
  /** Minimum normalized funding difference to lock a target, in percent. */
  minDiffFr: number;
  /**
   * Enter once the entry spread is at or above this, in percent.
   *
   * Distinct from FundingSync's floor in how it is used rather than in what it
   * measures: here it is the release condition for an already-locked target, so a
   * target sits and waits instead of being discarded.
   */
  entrySpread: number;
  /** Drop a locked target if the funding difference falls to this or below. */
  cancelDiffFr: number;
  /**
   * Same-cadence exit: close once the funding difference has decayed to this or
   * below, or the sign of the raw difference flips. Either means the reason to hold
   * is gone.
   */
  exitDiffFr: number;
  /**
   * Same-cadence exit, second stage: how much of the entry spread must come back,
   * in percent, after fees. The round trip's four taker fees are added on top.
   */
  minProfitSpread: number;
  /**
   * Different-cadence exit: minutes after the awaited settlement before the
   * estimate is allowed to close the position.
   *
   * A short delay rather than none, because the payment lands on the venue's own
   * schedule and reading the balance one second after the timestamp regularly misses
   * it.
   */
  settleGraceMin: number;
  /**
   * Different-cadence exit: the longest the position may be held, in minutes.
   *
   * This is the real protection on that path. With mismatched cadences the faster leg
   * pays funding repeatedly while the slower one has not settled, so an unprofitable
   * position left alone bleeds rather than waits.
   */
  maxHoldMin: number;
}

/**
 * FundingYield configuration.
 *
 * The fourth bet, and it disagrees with the other three about what a price spread
 * means rather than about what to earn from.
 *
 * FundingSync and FundingBridge both gate entry on the entry spread clearing a floor,
 * so a coin whose two venues disagree by −0.6% is rejected however large its funding
 * difference is. But a negative entry spread is not a loss: the price component of a
 * hedge's PnL is `entry spread − exit spread`, and both move together. What is
 * actually paid to get in and out is the sum of the two venues' bid-ask widths, which
 * is exactly `entry spread − exit spread` measured at the same instant. So the widest
 * funding differences on the board — which exist *because* the venues disagree — are
 * being thrown away over a number that is not the cost.
 *
 * This strategy adds the three components into one figure and requires that:
 *
 *     expected funding − round trip fees − measured entry/exit cost > minNetYieldUsd
 *
 * Two consequences follow, and they reinforce each other. Coins the other three refuse
 * become tradable, because the spread is priced rather than vetoed. And the position is
 * held across `targetSettlements` payments instead of one, so the four taker fills are
 * paid once against several payments rather than once against one — the difference
 * between a fee that eats fifteen payments and a fee that eats three.
 *
 * The cost of dropping the settlement deadline is that nothing bounds a losing
 * position, which is why this is the only strategy here with a stop-loss.
 */
export interface FundingYieldConfig {
  /** Venues the strategy may use. At least two, or nothing can be hedged. */
  venues: ExchangeId[];
  /** Maximum hedges held at once. */
  maxPositions: number;
  /** Margin committed per leg, in USD. */
  marginPerLeg: number;
  /** Leverage per leg, so notional per leg is marginPerLeg × leverage. */
  leverage: number;
  /**
   * Minimum normalized funding difference to consider a coin, in percent.
   *
   * Lower than the other funding strategies use on purpose. They need one payment to
   * be worth a whole round trip, so they chase spikes; this one amortises the round
   * trip over several payments, so a moderate difference that persists is worth more
   * than a large one that vanishes.
   */
  minDiffFr: number;
  /**
   * How many settlements the position is sized to collect before the fees are
   * considered paid off.
   *
   * This is the number that makes the strategy work: on the default venue set a round
   * trip costs about $0.48 on $200 per leg, while one settlement at a 0.05% difference
   * earns $0.10 — so five payments cover the fees and the target has to be comfortably
   * above that. It is a target, not a deadline: the exit fires on collected funding, not
   * on a count.
   */
  targetSettlements: number;
  /**
   * Minimum net USD the entry must be projected to yield, after fees and after the
   * measured cost of entering and exiting.
   *
   * In USD rather than percent because that is the form the decision actually takes:
   * three components with different natural units — a rate, a fee percentage and a
   * spread — only become comparable once they are all money.
   */
  minNetYieldUsd: number;
  /**
   * Ceiling on the measured round trip price cost, in percent.
   *
   * The cost is the exit spread minus the entry spread — the sum of both venues' bid-ask
   * widths. A second gate on top of the net-yield test, because a very wide book is a
   * liquidity warning and not merely an expense: the measured cost assumes both legs fill
   * at the quoted touch, and on an illiquid book they will not.
   */
  maxSpreadCostPct: number;
  /**
   * Close once collected funding covers the round trip by this multiple.
   *
   * 1 means "fees are paid off"; 2 means "fees paid off and the same again kept".
   * Expressed as a multiple rather than a USD target so it scales with the position
   * size and the venue pair's fees.
   */
  profitTargetMultiple: number;
  /**
   * Stop-loss: close when mark-to-market falls this far below zero, in USD.
   *
   * The other three strategies have no equivalent, and can afford not to because a
   * settlement deadline or a hold limit eventually forces them out. This one holds
   * for days by design, so an unbounded loss has time to become a large one. Counted
   * on the whole position — price movement against the hedge plus funding already
   * collected — because a stop that ignored collected funding would close positions
   * that are ahead overall.
   */
  stopLossUsd: number;
  /**
   * Close when the funding difference reverses sign, rather than waiting for the
   * stop-loss.
   *
   * A reversal means the venue that was paying is now being paid: the position is on
   * the wrong side of the only thing it was opened to collect. Configurable because a
   * brief flip on a volatile coin can be worth sitting through if the collected
   * funding is already comfortable.
   */
  exitOnReversal: boolean;
  /**
   * Longest the position may be held, in hours. Zero disables it.
   *
   * A backstop rather than a strategy rule: capital parked in a hedge that is neither
   * profitable nor losing enough to stop out is capital doing nothing.
   */
  maxHoldHours: number;
}

export type StrategyPositionStatus =
  | "queued"
  | "opening"
  | "open"
  | "closing"
  | "closed"
  | "cancelled"
  | "failed";
/** One hedge: two legs that only make sense together. */
export interface StrategyPosition {
  id: string;
  /** Which strategy opened this. */
  strategy: StrategyId;
  /**
   * Which deployment of that strategy opened it. Null only for hedges that predate
   * deployments, since inventing an owner would misattribute their history.
   */
  deploymentId: string | null;
  accountType: AccountType;
  coin: string;
  longExchange: ExchangeId;
  shortExchange: ExchangeId;
  /**
   * The leg whose funding payment this position is timed around. Null for a
   * strategy that ignores funding — PerpBridge has no settlement to wait for, and
   * a zero here would read as a real timestamp.
   */
  clockExchange: ExchangeId | null;
  /** Epoch ms of the settlement being harvested, or null when there is none. */
  fundingTime: number | null;
  /**
   * Normalized funding difference when the position was queued, in percent. Null
   * for a strategy that does not use funding at all.
   */
  entryDiffFr: number | null;
  /** Price spread at entry, in percent. Null while still queued. */
  entrySpread: number | null;
  /**
   * Epoch ms the awaited settlement passed, so the funding payment is collected
   * and the position is only waiting for a decent exit price. Null before that.
   */
  harvestedAt?: number | null;
  /**
   * Epoch ms a decay-triggered exit began. The position is on its way out and is
   * only waiting for a spread that does not give back the gains — distinct from
   * `harvestedAt`, where the payment is already banked.
   */
  exitingSince?: number | null;
  /** What started the exit, kept so the eventual close still reports it. */
  exitingReason?: string | null;
  /**
   * Funding credited to this hedge so far, in USD. Null when unknown.
   *
   * Null and 0 mean different things here: 0 is "nothing has settled yet", null is
   * "this account cannot tell us" — live venues fold funding into their balance and
   * report no per-position figure. A strategy whose exit depends on collected funding
   * has to treat those differently, or it would close a live position on the belief
   * that it has earned nothing.
   */
  fundingCollected?: number | null;
  /**
   * Lowest mark-to-market this position has been through, in USD. Null before the
   * first measurement.
   *
   * Recorded so a position that recovered still shows how close it came to its
   * stop-loss, which is the only way to tell whether the limit is set sensibly.
   */
  worstNetUsd?: number | null;
  size: number;
  leverage: number;
  notionalPerLeg: number;
  status: StrategyPositionStatus;
  entryMode: ExecutionMode;
  exitReason?: string | null;
  realizedPnl?: number | null;
  error?: string | null;
  queuedAt: number;
  openedAt?: number | null;
  closedAt?: number | null;
  updatedAt: number;
}

export type LogLevel = "INFO" | "WARN" | "ERROR" | "EXEC";

/**
 * Who wrote a log line. `system` covers work that belongs to the account rather
 * than to a strategy — funding settlement, for instance, is charged on whatever
 * is open no matter what opened it.
 */
export type LogChannel = StrategyId | "system";

export interface LogEntry {
  id: string;
  ts: number; // epoch ms
  level: LogLevel;
  source: AccountType; // which account the line belongs to
  /** Which strategy wrote the line, or `system` for account-level work. */
  strategy?: LogChannel;
  /** Coin the line refers to, when it is about one. */
  coin?: string | null;
  message: string;
}

/**
 * One running deployment of a strategy.
 *
 * A strategy is a blueprint; a deployment is an instance of it with its own label,
 * toggle and configuration. Three FundingBridge deployments can run side by side on
 * different venue sets, which is what makes the distinction worth having: the
 * strategy describes the bet, the deployment describes this particular bet.
 */
export interface StrategyDeployment {
  id: string;
  strategy: StrategyId;
  accountType: AccountType;
  /** Operator-chosen name, unique per account, used in logs and alerts. */
  label: string;
  enabled: boolean;
  lastRunAt: number | null;
  lastError: string | null;
  createdAt: number;
}

/**
 * Whether the deployment can act. Live requires the stored toggle *and*
 * AUTO_TRADING=true in the server environment, so a stray click cannot start
 * sending real orders. Paper needs only the toggle.
 */
export interface StrategyRunState {
  deploymentId: string;
  strategy: StrategyId;
  accountType: AccountType;
  /** The deployment's own label. */
  label: string;
  enabled: boolean;
  /** True when AUTO_TRADING=true. Always true for paper, which risks nothing. */
  armed: boolean;
  /** enabled && armed — the only state in which orders are sent. */
  active: boolean;
  lastRunAt: number | null;
  lastError: string | null;
}

/** A coin the strategy would enter, with why it is or is not acting yet. */
export interface StrategyCandidate {
  coin: string;
  longExchange: ExchangeId;
  shortExchange: ExchangeId;
  /** Funding clock leg, null for a strategy that ignores funding. */
  clockExchange: ExchangeId | null;
  /** Normalized funding difference, null when the strategy does not use it. */
  diffFr: number | null;
  /** Entry spread: short venue's bid minus long venue's ask, in percent. */
  spread: number | null;
  /** What unwinding would cost right now, on the other side of both books. */
  exitSpread?: number | null;
  fundingTime: number | null;
  minutesToFunding: number | null;
  /** Set when the candidate is not actionable, explaining exactly why. */
  blockedReason?: string;
}

/** Full state of one strategy on one account. */
export interface StrategySnapshot {
  deploymentId: string;
  strategy: StrategyId;
  /** The deployment's label, so headings and alerts can name it. */
  label: string;
  run: StrategyRunState;
  /** Shape depends on `strategy`; narrow before reading strategy-specific keys. */
  config: StrategyConfig | PerpBridgeConfig | FundingBridgeConfig | FundingYieldConfig;
  positions: StrategyPosition[];
  /** Recently closed hedges, for the result history. */
  history: StrategyPosition[];
  candidates: StrategyCandidate[];
  updatedAt: number;
}

/** One row of the deployment list: enough to decide what to open, nothing more. */
export interface StrategyListItem {
  deploymentId: string;
  strategy: StrategyId;
  /** The deployment's own name. */
  label: string;
  /** The strategy's name, e.g. "FundingBridge". */
  strategyName: string;
  tagline: string;
  run: StrategyRunState;
  openPositions: number;
  maxPositions: number;
  /** Candidates that would be acted on right now. */
  actionable: number;
  /** Realized PnL of this deployment's settled hedges. */
  realizedPnl: number;
  /** Notional traded per leg, so the exposure is visible without drilling in. */
  notionalPerLeg: number;
  /** Venues this deployment may use, for the list to show its scope. */
  venues: ExchangeId[];
}

/**
 * Account-wide exposure, which only becomes a real concern once several
 * deployments run at once: five deployments each committing three positions is
 * fifteen hedges nothing was counting before.
 */
export interface ExposureState {
  accountType: AccountType;
  /** Sum of notional per leg × 2 × open positions, across every deployment. */
  committedNotional: number;
  /** Configured ceiling. Zero means no limit. */
  maxNotional: number;
  openPositions: number;
  /** Deployments currently switched on. */
  activeDeployments: number;
}

// ─── Settings domain ────────────────────────────────────────────────────────

export interface ApiKeyConfig {
  exchange: ExchangeId;
  enabled: boolean;
  apiKey: string;
  apiSecret: string;
  /** Read-only trading permission flag (mock). */
  readOnly: boolean;
}

export interface GeneralSettings {
  defaultAccount: AccountType;
  /** REST ranking cadence, mirrors MarketConfig.pollIntervalSec. */
  pollIntervalSec: number;
  /** Layer 1 size per venue, mirrors MarketConfig.layer1CountPerExchange. */
  layer1CountPerExchange: number;
}

// ─── Trading domain ─────────────────────────────────────────────────────────

export type OrderSide = "buy" | "sell";
/** Only perpetual/futures markets are supported. */
export type MarketType = "perp";
export type OrderType = "market" | "limit";
export type OrderStatus = "pending" | "open" | "partial" | "filled" | "cancelled";
/**
 * instant submits immediately; delay parks the order until the mark price of
 * the long and short venue converge (cross-exchange price spread ≈ 0).
 */
export type ExecutionMode = "instant" | "delay";

export interface Order {
  id: string;
  time: number; // epoch ms
  pair: string;
  exchange: ExchangeId;
  side: OrderSide;
  marketType: MarketType;
  orderType: OrderType;
  price: number; // limit price, or fill price for market
  size: number; // base asset
  filled: number; // filled base asset
  status: OrderStatus;
  leverage: number;
  reduceOnly?: boolean;
  /** For closing trades in history. */
  realizedPnl?: number | null;
  /** Hedge pairing id — orders with the same hedgeId belong to one hedge. */
  hedgeId?: string;
  /** Whether a manual trade or the strategy placed this. */
  source?: TradeSource;
  executionMode?: ExecutionMode;
  /** Venue pair whose price convergence releases a delayed order. */
  waitLongExchange?: ExchangeId;
  waitShortExchange?: ExchangeId;
}

export interface OrderbookLevel {
  price: number;
  size: number;
  total: number; // cumulative size
}

export interface Orderbook {
  pair: string;
  bids: OrderbookLevel[]; // descending price
  asks: OrderbookLevel[]; // ascending price
  markPrice: number;
  spread: number;
  change24h: number; // percent
}

// ─── Exchange rebalancing domain ────────────────────────────────────────────

/** Only stablecoins are supported for CEX-to-CEX transfers. */
export type TransferToken = "USDT" | "USDC";

export type NetworkId = "TRC20" | "ERC20" | "BEP20" | "ARBITRUM" | "POLYGON" | "SOLANA";

export interface TransferNetwork {
  id: NetworkId;
  label: string;
  /** Withdrawal fee charged by the source venue, in token units. */
  fee: number;
  /** Minimum withdrawal amount in token units. */
  minAmount: number;
  /** Human estimate of arrival time. */
  eta: string;
  /** Tokens available on this chain. */
  tokens: TransferToken[];
  /** Some chains require an extra memo/tag alongside the address. */
  requiresMemo?: boolean;
}

/** Capital held on a single venue, split by usage. */
export interface ExchangeBalance {
  exchange: ExchangeId;
  /** Custodial or on-chain, so the treasury view can group without a lookup. */
  venueType: VenueType;
  /** Free collateral available to withdraw or open new positions. */
  available: number;
  /** Collateral currently locked as position margin. */
  inPosition: number;
  /** Margin utilisation 0..1 — high means close to a margin call. */
  marginRatio: number;
  /**
   * Funding/spot wallet balance. Only this can be withdrawn on most venues, so
   * it is tracked separately from the derivatives collateral above.
   */
  funding?: number;
  /** False when wallet reads are not implemented for this venue. */
  walletSupported?: boolean;
  /**
   * False when funds cannot be *sent* from this venue, even though its balance is
   * readable. On-chain venues land here: signing a withdrawal needs the wallet
   * key, so they can receive but not send.
   */
  transferSource?: boolean;
  /** True when at least one confirmed withdrawal destination exists here. */
  destinationAllowlisted?: boolean;
  /** Present when the venue's wallet read failed, so the UI can say why. */
  walletError?: string | null;
}

export interface RebalanceSuggestion {
  id: string;
  from: ExchangeId;
  to: ExchangeId;
  token: TransferToken;
  amount: number;
  /** Why this move is suggested, shown verbatim in the UI. */
  reason: string;
  urgency: "low" | "medium" | "high";
}

export type TransferStatus = "pending" | "processing" | "completed" | "failed";

/**
 * How far a transfer got. The flow is two steps — an internal futures→funding
 * move inside the source venue, then an on-chain withdrawal — and a transfer
 * stuck between them has money in a different place than one that never
 * started, so the distinction is recorded.
 */
export type TransferStage = "internal" | "withdraw" | "settled";

export interface TransferRecord {
  id: string;
  time: number; // epoch ms
  from: ExchangeId;
  to: ExchangeId;
  token: TransferToken;
  network: NetworkId;
  /** Amount debited from the source venue. */
  amount: number;
  fee: number;
  /** amount - fee, credited at the destination. */
  received: number;
  status: TransferStatus;
  stage: TransferStage;
  /** On-chain transaction hash once the venue reports one. */
  txId: string | null;
  /** The venue's own withdrawal id, used to poll status. */
  venueWithdrawId?: string | null;
  /** Masked destination address. Full addresses are not sent to the browser. */
  addressMasked?: string;
  /** True when the automation created this transfer rather than the user. */
  auto?: boolean;
  /**
   * Whether the destination venue confirmed the address before this was sent:
   * true it agreed, null it could not be asked. False never reaches a record —
   * a mismatch refuses the transfer rather than logging it.
   */
  addressVerified?: boolean | null;
  /** Why the cross-check could not be performed, when it could not. */
  addressVerifyNote?: string | null;
  error?: string | null;
  updatedAt?: number;
}

export interface RebalanceConfig {
  enabled: boolean;
  /** Trigger when a venue's share deviates from target by more than this (%). */
  imbalanceThresholdPct: number;
  /** Trigger a top-up when margin utilisation exceeds this (%). */
  marginRatioTriggerPct: number;
  /** Never move funds out of a venue below this idle amount. */
  minIdleBalance: number;
  /** Preferred chain per token, chosen to keep fees low. */
  preferredNetwork: Record<TransferToken, NetworkId>;
  maxTransfersPerDay: number;
  maxAmountPerTransfer: number;
  cooldownMinutes: number;
  /** Venues the automation may pull funds from. */
  allowedSources: ExchangeId[];
  /** Venues the automation may send funds to. */
  allowedDestinations: ExchangeId[];
}

/**
 * Whether the automation can actually execute. The UI toggle alone is not
 * enough: sending real withdrawals unattended also requires REBALANCE_AUTOMATION
 * in the server environment, so a stray click cannot start moving money.
 */
export interface RebalanceAutomationStatus {
  /** The stored config toggle. */
  enabled: boolean;
  /** True when REBALANCE_AUTOMATION=true is set on the server. */
  armed: boolean;
  /** enabled && armed — the only state in which a transfer is sent. */
  active: boolean;
  /** Transfers the automation has sent in the current UTC day. */
  transfersToday: number;
  lastRunAt: number | null;
  lastTransferAt: number | null;
  lastSkippedReason: string | null;
}

/**
 * One withdrawal destination as the dashboard shows it.
 *
 * Addresses stay masked: the full string exists only server-side, and only a
 * confirmed row can receive a transfer.
 */
export interface AllowlistedDestination {
  id: string;
  exchange: ExchangeId;
  token: TransferToken;
  network: NetworkId;
  addressMasked: string;
  requiresMemo: boolean;
  /** Operator label, e.g. which sub-account or wallet this is. */
  label?: string | null;
  /**
   * False until an operator explicitly arms the row. An unconfirmed destination
   * is inert — no transfer, manual or automated, resolves against it.
   */
  confirmed: boolean;
  /** When the venue last confirmed this is its own deposit address. */
  verifiedAt?: number | null;
  /**
   * The server's full-string comparison against the venue's reported address:
   * true matched, false differed, null never asked. Never derived from an address
   * tail — two different addresses can share their last four characters.
   */
  verifiedMatch?: boolean | null;
  /**
   * True when a past match is older than the verification TTL. A venue can rotate
   * a deposit address, so an old check describes a different address than the one
   * that would receive funds now.
   */
  verifiedStale?: boolean;
  lastError?: string | null;
}

/** A withdrawal chain as the venue currently reports it. */
export interface TransferNetworkOption {
  network: NetworkId;
  label: string;
  asset: TransferToken;
  fee: number;
  minAmount: number;
  enabled: boolean;
  confirmations?: number | null;
  /** True when a destination address is configured for this token/chain. */
  destinationAllowlisted: boolean;
  addressMasked?: string;
}

export interface RebalanceOverview {
  balances: ExchangeBalance[];
  suggestions: RebalanceSuggestion[];
  config: RebalanceConfig;
  automation: RebalanceAutomationStatus;
  destinations: AllowlistedDestination[];
  /** Venues with credentials but no wallet support, for an honest empty state. */
  unsupportedVenues: ExchangeId[];
  updatedAt: number;
}


