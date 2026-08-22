import type { StrategyId } from "@/lib/types";

/**
 * Long-form documentation for each strategy, for the Strategy Library page.
 *
 * Kept here rather than in each strategy module so the library is one file to read and
 * to keep consistent, and so the browser can import it without pulling in engine code
 * that opens the database. The module doc comments remain the source of truth for
 * *how* each engine works; this is the source of truth for how to *explain* it.
 *
 * Every entry answers the same questions in the same order, because the value of the
 * page is comparison. A reader deciding between two strategies needs the same sections
 * side by side, not each one's most flattering angle.
 */

export interface StrategyDocSection {
  heading: string;
  /** Paragraphs, rendered in order. */
  body: string[];
}

export interface StrategyDoc {
  id: StrategyId;
  name: string;
  /** One line: what it earns from. Matches STRATEGY_META's tagline. */
  tagline: string;
  /** Two or three sentences: the whole idea, for someone skimming. */
  overview: string;
  /** What market inefficiency the money actually comes from. */
  edge: string;
  /** Ordered steps, from ranking to close. */
  flow: string[];
  /** Every way a position ends. */
  exits: { title: string; detail: string }[];
  /** What it deliberately does not look at, and why that is a choice. */
  ignores: string[];
  /** Honest failure modes. Not caveats — the things that lose money. */
  risks: string[];
  /** When this is the right tool. */
  suitedTo: string[];
  /** The parameters that decide its behaviour, in plain language. */
  keySettings: { name: string; detail: string }[];
  sections?: StrategyDocSection[];
}

const FUNDINGSYNC: StrategyDoc = {
  id: "fundingsync",
  name: "FundingSync",
  tagline: "Collects the funding rate difference between two venues",
  overview:
    "Hedges one coin across two venues shortly before a funding settlement, collects that " +
    "single payment, then waits for a decent price to leave on. The whole design is anchored " +
    "to one settlement: the entry window is measured backwards from it, and the mandatory " +
    "exits are that settlement and the one after.",
  edge:
    "Two venues quoting the same perpetual can charge very different funding rates. Holding " +
    "long on the venue paying the least and short on the venue paying the most collects the " +
    "difference, with no exposure to which way the price moves.",
  flow: [
    "Every coin is ranked by its normalized funding difference, restricted to the venues this deployment may use.",
    "A candidate needs the difference above minDiffFr, a confirmed settlement cadence, and to be inside entryWindowMin minutes of the settlement being harvested.",
    "The clock is anchored to the leg paying the larger absolute rate — that is the payment being collected, so timing around the other leg would aim at a settlement that barely matters.",
    "It also needs the entry spread at or above minEntrySpread, so the hedge opens in credit rather than paying to get in.",
    "Accepted candidates are queued, then opened once the spread clears again at tick time. Both legs are sent at market, sequentially.",
    "After the settlement passes, the payment is banked and the position waits for an exit price worth taking, bounded by the next settlement.",
  ],
  exits: [
    {
      title: "Settlement collected",
      detail:
        "Once the harvested settlement passes, the position either closes immediately or — with " +
        "holdForSpreadAfterFunding on — is marked harvested and waits for a spread that covers " +
        "the round trip. The wait is bounded by the next settlement, because that is when funding " +
        "starts costing again.",
    },
    {
      title: "Difference decayed",
      detail:
        "If the funding difference falls to exitDiffFr or below, the reason to hold is gone. With " +
        "holdForSpreadAfterDecay on it starts leaving and closes at break-even after fees, rather " +
        "than holding out for profit it no longer has an edge to earn.",
    },
    {
      title: "Spread target met",
      detail:
        "While the edge is intact, the position closes early if the spread has come back by " +
        "minProfitSpread plus the round trip's fees. In delay mode the test is convergence instead: " +
        "close once the exit spread is within maxExitSpread of zero.",
    },
    {
      title: "Queued entry cancelled",
      detail:
        "A queued entry is dropped if the settlement passes before the spread clears, or if the " +
        "difference collapses below cancelDiffFr while waiting.",
    },
  ],
  ignores: [
    "The sign of the funding difference after entry. It reads the absolute difference, so a full reversal — where the venue that was paying is now being paid — looks like a healthy edge. FundingBridge closes that gap.",
    "Whether the hedge is still two matched legs. There is no hedge-break guard, so a leg liquidated or partly tiered down leaves directional exposure the engine keeps treating as arbitrage.",
    "Loss in absolute terms. There is no stop-loss; every exit deadline is a settlement time.",
  ],
  risks: [
    "One payment against four taker fills. At typical CEX fees a round trip costs about 0.2% of notional while an ordinary payment earns 0.01%, which is why minDiffFr defaults to ten times a normal rate. The strategy is really earning the spread, with funding as the trigger.",
    "The entry spread floor rejects the widest funding differences on the board, because a wide difference usually exists precisely when two venues disagree about price.",
    "A coin that stops being streamed can only exit on its funding deadline. The engine logs this as a blind position, but cannot price an exit without quotes.",
  ],
  suitedTo: [
    "Funding spikes large enough that a single payment is worth the round trip on its own.",
    "Venue pairs with tight books, where an entry in credit is actually achievable.",
    "Operators who want every position bounded by a known deadline rather than by a loss limit.",
  ],
  keySettings: [
    { name: "minDiffFr", detail: "Minimum normalized funding difference to consider a coin." },
    { name: "entryWindowMin", detail: "How close to the settlement an entry is allowed." },
    { name: "minEntrySpread", detail: "Floor on entry credit. Positive means the hedge opens in profit on price." },
    { name: "minProfitSpread", detail: "Instant-mode exit target, with the round trip's fees added on top." },
    { name: "exitDiffFr / cancelDiffFr", detail: "Decay thresholds for leaving a position and dropping a queued entry." },
  ],
};

const PERPBRIDGE: StrategyDoc = {
  id: "perpbridge",
  name: "PerpBridge",
  tagline: "Ignores funding; earns the price gap between two venues closing",
  overview:
    "Buys the cheap venue and sells the expensive one whenever the gap between them is wide " +
    "enough, then closes once the gap has narrowed by the target. Funding is not consulted at " +
    "all, and there is no settlement to wait for — a gap is tradable the moment it appears.",
  edge:
    "Two venues quoting the same perpetual at different prices tend to converge. Selling the " +
    "expensive side and buying the cheap one captures that convergence, whichever direction the " +
    "underlying moves.",
  flow: [
    "For each coin, every ordered venue pair is examined and the widest positive gap is taken — deliberately not the funding-derived pair, which is usually a different one.",
    "A gap qualifies if it clears minEntrySpread and both legs can be priced on the side needed to close.",
    "There is no queue: the position is created and both legs are sent in the same cycle.",
    "From then on only one number matters — how much of the entry gap has come back.",
  ],
  exits: [
    {
      title: "Gap narrowed",
      detail:
        "The single exit: close when the entry spread minus the current exit spread reaches " +
        "minProfitSpread plus the round trip's fees. Both spreads are quoted on the side actually " +
        "traded, so the gain is capturable rather than notional.",
    },
  ],
  ignores: [
    "Funding entirely. The position has no clock leg, no settlement and no funding difference recorded, which is why the monitor shows fewer columns than the other cards.",
    "Time. There is no entry window, no maximum hold and no settlement deadline.",
  ],
  risks: [
    "A gap that widens instead of closing has no exit at all. The position sits until the gap comes back, and there is no stop-loss and no hold limit. This is the strategy's one real hole, and its author documented it as such.",
    "The entry floor is the only protection. minEntrySpread defaults to 0.5% against roughly 0.2% in fees, which is deliberately generous — a tighter floor turns a converging gap into a payment to the venues.",
    "No hedge-break guard: a liquidated leg leaves directional exposure the engine still treats as a hedge.",
  ],
  suitedTo: [
    "Volatile coins where cross-venue prices dislocate and snap back.",
    "Operators who want the simplest possible thesis, with one number to watch.",
    "Periods when funding is flat everywhere and the funding strategies have nothing to do.",
  ],
  keySettings: [
    { name: "minEntrySpread", detail: "How wide the gap must be to open. The only protection against a widening gap." },
    { name: "minProfitSpread", detail: "How much of the gap must close, net of fees." },
    { name: "maxPositions", detail: "How many gaps are held at once." },
  ],
};

const FUNDINGBRIDGE: StrategyDoc = {
  id: "fundingbridge",
  name: "FundingBridge",
  tagline: "Locks the best funding pair, then waits for a cheap entry before hedging",
  overview:
    "Earns the same funding difference as FundingSync but decides in a different order. As a " +
    "settlement approaches it locks the best coin on funding merit alone, price unexamined, then " +
    "watches and sends the legs the moment the entry becomes cheap enough. It is the most " +
    "carefully bounded of the four: it checks for a broken hedge, detects a funding reversal, and " +
    "has two separate exit paths depending on whether the legs settle on the same clock.",
  edge:
    "The funding difference, the same as FundingSync. What differs is that a good price is waited " +
    "for on a decision already made, instead of requiring the difference and the price to line up " +
    "in the same instant.",
  flow: [
    "Lock: within entryWindowMin of a settlement, the best coin by funding difference is reserved as a target. Price is checked only for being priceable, not for being good.",
    "Release: the locked target is re-examined every cycle and both legs are sent as soon as the entry spread reaches entrySpread. If the difference collapses below cancelDiffFr while waiting, the target is dropped and the slot returns.",
    "Once open, the hedge-break guard runs first on every cycle — before price, before profit — because every rule below it assumes two matched legs.",
    "The path then forks on cadence: legs that settle on the same clock are judged on thresholds, legs on different clocks are judged on money.",
  ],
  exits: [
    {
      title: "Matched cadence — edge gone, then price",
      detail:
        "When both legs settle together, the position waits until the funding edge is gone: decayed " +
        "below exitDiffFr, or reversed outright. Only then does price decide, and the wait is " +
        "bounded by the next settlement. Once leaving, the target drops to break-even after fees — " +
        "holding out for profit with no edge left is a directional bet, not arbitrage.",
    },
    {
      title: "Mismatched cadence — estimated PnL",
      detail:
        "With different cadences there is no shared deadline and the faster leg keeps paying while " +
        "the slower one has not settled, so waiting has a running cost. After the awaited settlement " +
        "plus settleGraceMin, the position closes as soon as an exit would realise more than zero in " +
        "USD — price plus funding minus fees.",
    },
    {
      title: "Hedge broken",
      detail:
        "If the two legs' remaining sizes diverge by more than 10% of entry size after the first " +
        "minute, what is left is directional and it closes regardless of price. The delay exists " +
        "because the two venues' streams do not arrive at the same instant.",
    },
    {
      title: "Maximum hold",
      detail:
        "On the mismatched path only, maxHoldMin closes unconditionally. Without it a position that " +
        "never becomes profitable would be held forever by a rule that only closes at a profit.",
    },
  ],
  ignores: [
    "Price at the moment a target is selected — deliberately, since that is the whole point of splitting the decision.",
    "On the mismatched-cadence path, the decay threshold and funding reversal. That path is judged only on money and the clock.",
  ],
  risks: [
    "Still one payment against four taker fills, like FundingSync, and still gated on the entry spread being positive — so it refuses the same high-paying rows.",
    "No absolute stop-loss on the matched-cadence path. An unprofitable position waits for a settlement, not for a loss limit.",
    "The mismatched-cadence funding estimate is pro-rated on live accounts, because the venue reports no per-position figure. It is flagged as an estimate wherever it is shown.",
  ],
  suitedTo: [
    "Coins where the funding difference is durable but the price is briefly dislocated, so waiting for a cheap entry pays.",
    "Cross-venue pairs with different settlement cadences, which is the case its second exit path exists for.",
    "Operators who want the most guard rails per position.",
  ],
  keySettings: [
    { name: "minDiffFr", detail: "Minimum difference to lock a target." },
    { name: "entrySpread", detail: "Release condition: the spread the locked target waits for." },
    { name: "settleGraceMin", detail: "How long after a settlement to wait before trusting the payment landed." },
    { name: "maxHoldMin", detail: "Hard limit on the mismatched-cadence path, where holding on bleeds." },
  ],
};

const FUNDINGYIELD: StrategyDoc = {
  id: "fundingyield",
  name: "FundingYield",
  tagline: "Holds a funding hedge across several settlements, judged on net USD yield",
  overview:
    "Disagrees with the other three about what a price spread means. Rather than requiring the " +
    "entry to open in credit, it prices what the round trip actually costs and adds it to the " +
    "funding and the fees, entering when that single sum is worth enough. It then holds across " +
    "several settlements so the four taker fills are paid once instead of once per payment — and " +
    "because it gives up the settlement deadline, it is the only strategy here with a stop-loss.",
  edge:
    "The funding difference, like two of the others — but reached by taking positions they refuse. " +
    "A large funding gap exists precisely when two venues disagree about a coin's price, so the " +
    "entry-spread floor in FundingSync and FundingBridge rejects the highest-paying rows on the " +
    "board. Holding across several payments then turns an ordinary difference into a profitable " +
    "one, which a single-settlement strategy cannot do.",
  flow: [
    "Every coin's funding difference is recomputed for the deployment's venues, and the entry and exit spreads are read at the same instant.",
    "The round trip's price cost is the exit spread minus the entry spread — the sum of both venues' bid-ask widths — rather than the entry spread judged on its own.",
    "Projected funding over targetSettlements, minus the round trip fees, minus that spread cost, gives one figure in dollars. It must clear minNetYieldUsd, and the spread cost must stay under maxSpreadCostPct.",
    "Candidates are ranked by that dollar figure, not by the funding difference: a large difference on a wide-book pair is worse than a small one on a tight pair.",
    "There is no queue and no window. The test prices everything it depends on in one instant, so there is nothing to wait for — both legs go out at market immediately.",
    "While open, collected funding is mirrored onto the position each cycle, and the lowest mark-to-market it has been through is recorded so a recovered position still shows how close it came to the stop.",
  ],
  exits: [
    {
      title: "Profit target",
      detail:
        "Closes once collected funding reaches profitTargetMultiple times the round trip's fees, " +
        "with the position also net positive. Read off funding rather than total PnL on purpose: the " +
        "target is about the strategy having done its job, and letting price movement satisfy it " +
        "would close positions that never collected anything.",
    },
    {
      title: "Stop-loss",
      detail:
        "The bound bought in exchange for giving up a settlement deadline. Closes when the whole " +
        "position — price against the hedge, plus funding already collected — falls stopLossUsd " +
        "below zero. Counted net of collected funding, because a stop that ignored income would " +
        "close positions that are ahead overall. Requires a live spread reading: without one it " +
        "cannot fire, and the engine logs that as a blind position.",
    },
    {
      title: "Funding reversed",
      detail:
        "With exitOnReversal on, a negative signed difference closes the position: the venue that " +
        "was paying is now being paid, so nothing about the position's reason to exist survives. " +
        "Waiting for the stop-loss instead would just be paying to find out.",
    },
    {
      title: "Hedge broken",
      detail:
        "Same guard as FundingBridge, and checked before everything else: legs whose remaining sizes " +
        "diverge by more than 10% mean what is left is directional.",
    },
    {
      title: "Hold backstop",
      detail:
        "maxHoldHours closes a position that is neither profitable nor losing enough to stop out. Not " +
        "a strategy rule — capital parked in a hedge going nowhere is capital doing nothing. Zero " +
        "disables it.",
    },
  ],
  ignores: [
    "Whether the entry spread is positive. This is the deliberate inversion: a −0.6% entry spread costs almost nothing if the exit spread is −0.63%, because the price component of PnL is the difference between them.",
    "Individual settlement times. There is no clock leg and no funding time recorded, because the position is not timed around any single payment.",
  ],
  risks: [
    "Holding for days means exposure to everything that can happen in days: a venue halting withdrawals, one leg liquidating, or the difference simply evaporating after the fees are paid. The stop-loss bounds the loss, not the frequency.",
    "On live accounts the funding figure is pro-rated rather than measured, because venues fold funding into their balance. Both the profit target and the stop-loss read that estimate, so both are approximate on live in a way they are not on paper.",
    "Wider books than the other strategies accept, by design. maxSpreadCostPct is the guard, but the projection assumes both legs fill at the quoted touch — on a thin book they will not.",
    "Seven of the eight venues can trade live. Lighter cannot, and its zero fees would help this strategy more than any other, so a paper result that includes it overstates what live can reproduce.",
  ],
  suitedTo: [
    "Moderate funding differences that persist, rather than spikes — the opposite of what FundingSync wants.",
    "Coins the other three refuse because their entry spread is negative, which on a live board is most of the highest-paying rows.",
    "Operators willing to hold multi-day positions in exchange for fees amortised across several payments.",
  ],
  keySettings: [
    { name: "minDiffFr", detail: "Lower than the other funding strategies, because fees are spread over several payments." },
    { name: "targetSettlements", detail: "How many payments the projection assumes. Must comfortably exceed the break-even count, or every candidate is blocked." },
    { name: "minNetYieldUsd", detail: "The floor on the whole sum: funding minus fees minus spread cost, in dollars." },
    { name: "maxSpreadCostPct", detail: "Ceiling on both venues' bid-ask widths combined — a liquidity guard as much as a cost one." },
    { name: "profitTargetMultiple", detail: "Collected funding as a multiple of the round trip before closing." },
    { name: "stopLossUsd", detail: "The loss limit. The only one of its kind across the four strategies." },
  ],
  sections: [
    {
      heading: "The arithmetic, worked through",
      body: [
        "A round trip is four taker fills. On the default venue set the worst pair costs about 0.24% of one leg's notional — $0.48 at $200 per leg, paid once. One funding payment at a 0.05% normalized difference earns $0.10 on the same notional.",
        "So five payments cover the fees, and the tenth leaves about $0.52 in profit. That is why targetSettlements defaults to 10 rather than to the break-even count: a target set at break-even projects zero net, and the net-yield floor would then block every candidate.",
        "Compare that with a single-settlement strategy. To make one payment worth a $0.48 round trip, the difference has to be around 0.25% — five times an ordinary rate. That is exactly why FundingSync and FundingBridge default minDiffFr to 0.1% and still need a spread in credit on top: they are chasing spikes because a single payment cannot pay for itself otherwise.",
        "The venue set therefore matters more here than anywhere else. Lighter charges nothing and Aster 0.035%, so that pair would cost $0.14 rather than $0.48 — the same trade keeping three times as much. Aster can trade live; Lighter cannot, so a paper result built on that pair overstates what live can reproduce.",
      ],
    },
    {
      heading: "Why a negative entry spread is not a loss",
      body: [
        "The entry spread is the short venue's bid minus the long venue's ask. The exit spread is the other side of both books — the long leg's bid against the short leg's ask. A hedge's price PnL is the entry spread minus the exit spread at the moment of closing.",
        "Both numbers move together, because they are quoted on the same two order books. Entering at −0.6% and leaving at −0.63% costs 0.03%, not 0.6%. What is actually paid is the sum of the two venues' bid-ask widths, which is the exit spread minus the entry spread read at one instant.",
        "The other three strategies test the entry spread against a floor as though it were the cost. On a live board that rejects nearly every row with a large funding difference, because a large difference is what you get when two venues disagree about price. This strategy measures the cost instead, and caps that.",
      ],
    },
  ],
};

export const STRATEGY_DOCS: Record<StrategyId, StrategyDoc> = {
  fundingsync: FUNDINGSYNC,
  perpbridge: PERPBRIDGE,
  fundingbridge: FUNDINGBRIDGE,
  fundingyield: FUNDINGYIELD,
};

/** In the order they were built, which is also roughly increasing sophistication. */
export const STRATEGY_DOC_ORDER: StrategyId[] = [
  "fundingsync",
  "perpbridge",
  "fundingbridge",
  "fundingyield",
];

/**
 * How the four differ, at a glance.
 *
 * A comparison table is the one thing a per-strategy page cannot give you, and it is
 * usually the actual question — not "what does FundingYield do" but "which of these
 * should be running right now".
 */
export interface StrategyComparisonRow {
  aspect: string;
  values: Record<StrategyId, string>;
}

export const STRATEGY_COMPARISON: StrategyComparisonRow[] = [
  {
    aspect: "Earns from",
    values: {
      fundingsync: "Funding difference",
      perpbridge: "Price gap converging",
      fundingbridge: "Funding difference",
      fundingyield: "Funding difference",
    },
  },
  {
    aspect: "Pair chosen by",
    values: {
      fundingsync: "Funding",
      perpbridge: "Price",
      fundingbridge: "Funding",
      fundingyield: "Net USD yield",
    },
  },
  {
    aspect: "Entry spread",
    values: {
      fundingsync: "Must clear a floor",
      perpbridge: "Is the whole edge",
      fundingbridge: "Must clear a floor",
      fundingyield: "Priced, not vetoed",
    },
  },
  {
    aspect: "Settlements held",
    values: {
      fundingsync: "One",
      perpbridge: "None — ignores funding",
      fundingbridge: "One",
      fundingyield: "Several",
    },
  },
  {
    aspect: "Timed exit",
    values: {
      fundingsync: "Settlement + the next",
      perpbridge: "None",
      fundingbridge: "Next settlement or hold limit",
      fundingyield: "Hold backstop only",
    },
  },
  {
    aspect: "Stop-loss",
    values: {
      fundingsync: "No",
      perpbridge: "No",
      fundingbridge: "No",
      fundingyield: "Yes",
    },
  },
  {
    aspect: "Reversal check",
    values: {
      fundingsync: "No",
      perpbridge: "Not applicable",
      fundingbridge: "Yes",
      fundingyield: "Yes, configurable",
    },
  },
  {
    aspect: "Hedge-break guard",
    values: {
      fundingsync: "No",
      perpbridge: "No",
      fundingbridge: "Yes",
      fundingyield: "Yes",
    },
  },
  {
    aspect: "Typical hold",
    values: {
      fundingsync: "Minutes to hours",
      perpbridge: "Unbounded",
      fundingbridge: "Minutes to hours",
      fundingyield: "Hours to days",
    },
  },
];

/**
 * What every strategy here shares, stated once.
 *
 * Worth its own section because these are the properties that make the four comparable
 * at all — and because two of them are limits an operator will otherwise discover the
 * hard way.
 */
export const SHARED_MECHANICS: StrategyDocSection[] = [
  {
    heading: "Every position is a two-leg hedge",
    body: [
      "All four open one long and one short on the same coin across two different venues, at equal base size. The position is delta-neutral: price moving does not by itself win or lose money, which is what makes funding and spread the only things that matter.",
      "Both legs are sent sequentially, never in parallel. If the second leg fails the first is unwound, because a single filled leg is directional exposure wearing the costume of an arbitrage position.",
      "One coin per deployment at a time. Two hedges on one coin would compete for the same venue legs, and a venue nets positions per coin and side — so both would share one exchange position and closing either would partly close the other.",
    ],
  },
  {
    heading: "Fees are the dominant cost",
    body: [
      "A round trip is four taker fills: opening both legs and closing both. On mid-priced CEX venues that is roughly 0.2% of one leg's notional, which every profit target has to clear before anything is kept.",
      "Each engine uses the worst-case pair among its configured venues rather than an average, because a target that only clears the cheap pairs loses money on the rest.",
      "Only market orders are used. There is no maker path, so no strategy here can earn a rebate or avoid crossing the spread.",
    ],
  },
  {
    heading: "Live trading needs a server-side arm",
    body: [
      "A deployment's own toggle is enough on paper, which risks nothing. Live also requires AUTO_TRADING=true in the server environment, so sending real orders unattended is never one mis-click away.",
      "Unarmed live deployments still evaluate every cycle and log what they would have done. That is the point of running unarmed — it is the only way to judge a configuration before trusting it with money.",
      "Seven of the eight venues can trade live: the five centralized ones, plus Hyperliquid and Aster, whose orders are signed locally with a wallet key. Lighter is market data only, because it signs with a curve that has no JavaScript implementation. Paper can use all eight, so a paper result that leans on Lighter is better than live can reproduce.",
    ],
  },  {
    heading: "Refusals are logged, not hidden",
    body: [
      "Every candidate a strategy declines carries the reason, and the monitor shows it. The question worth answering after the fact is usually not why it entered but why it did not.",
      "A position whose exit rules cannot be evaluated — a coin no longer streamed, a leg with no quote — is reported as blind and warned about on a timer, rather than sitting silently unmanaged.",
      "Losing a race for a venue leg names the deployment that won it, so a strategy that seems idle can be seen competing rather than broken.",
    ],
  },
];
