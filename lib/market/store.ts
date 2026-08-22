import type {
  ExchangeId,
  FundingRateRow,
  FundingRateValue,
  MarketHighlight,
  MarketSnapshot,
  MarketSummary,
  MarketView,
  MarketViewQuery,
  MarketViewRow,
  SortKey,
  VenueHealth,
  VenueStatus,
} from "@/lib/types";
import type { StreamUpdate } from "@/lib/exchanges/adapter";
import type { MarketClaim } from "@/lib/market/claims";
import { EXCHANGE_IDS, exchangeInfo, pairInScope } from "@/lib/utils";
import {
  buildRow,
  derivePriceSpread,
  deriveScopedDirection,
  type CoinReadings,
} from "@/lib/market/derive";

/**
 * Minimum gap between stored quote updates for one (venue, coin). The venues
 * push top-of-book changes many times per second; the UI renders once a second,
 * so coalescing here keeps the event loop free without losing anything visible.
 */
const BOOK_WRITE_INTERVAL_MS = 400;

/** Page size bounds for a view. The ceiling is a render budget, not a data limit. */
const MIN_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 250;

interface VenueState {
  health: VenueHealth;
  connections: number;
  subscriptions: number;
  lastMessageAt: number | null;
  lastPollAt: number | null;
  lastError: string | null;
  fundingFromRest?: boolean;
}

/**
 * In-memory market state for every pair on every venue. Nothing is persisted: on
 * restart everything is rebuilt from the venues' own REST and websocket feeds.
 *
 * The shape changed with the move to full-market coverage. Previously sixty coins
 * were watched and `rows()` rebuilt all of them on every call, which was fine at that
 * size and is not at several thousand: each row allocates two per-venue records,
 * normalizes every rate and runs a pairwise direction search. So rows are cached and
 * only rebuilt for coins whose readings actually changed, and the per-scope sort keys
 * are cached alongside them — sorting the whole market by funding gap must not mean
 * re-deriving the whole market per request.
 */
export class MarketStore {
  private readonly coins = new Map<string, CoinReadings>();
  private readonly venues = new Map<ExchangeId, VenueState>();
  /** Pairs claimed by an open position, keyed `exchange:coin`. */
  private claims = new Map<string, MarketClaim>();
  private lastPollAt: number | null = null;
  private version = 0;
  /** Observed settlement timestamps per (venue, coin), for cadence inference. */
  private readonly settlementHistory = new Map<string, number[]>();
  /** Last time a quote was stored per (venue, coin), for write coalescing. */
  private readonly lastBookWrite = new Map<string, number>();
  /**
   * Authoritative funding cadence per (venue, coin) from contract metadata.
   * Preferred over anything inferred, because Diff FR divides by the interval
   * and a wrong cadence silently scales a venue's rate.
   */
  private readonly intervalMetadata = new Map<string, number>();
  /**
   * Next settlement per (venue, coin) from contract metadata. Only needed for
   * venues whose funding stream omits the settlement clock — KuCoin's
   * `funding.rate` frames carry the rate but no timestamp, so without this its
   * countdown column would stay empty while every other venue shows one.
   */
  private readonly settlementMetadata = new Map<string, number>();

  /** Built rows, invalidated per coin rather than wholesale. */
  private readonly rowCache = new Map<string, FundingRateRow>();
  private readonly dirtyCoins = new Set<string>();
  /** Cached full row list, rebuilt only when the dirty set is non-empty. */
  private rowsCache: FundingRateRow[] | null = null;
  /** Cached full snapshot, for the server-side callers that need every row. */
  private snapshotCache: { version: number; value: MarketSnapshot } | null = null;

  constructor() {
    for (const id of EXCHANGE_IDS) {
      this.venues.set(id, {
        health: "connecting",
        connections: 0,
        subscriptions: 0,
        lastMessageAt: null,
        lastPollAt: null,
        lastError: null,
      });
    }
  }

  getVersion(): number {
    return this.version;
  }

  /** Coins the store holds any reading for. */
  watchedCoins(): string[] {
    return [...this.coins.keys()];
  }

  coinCount(): number {
    return this.coins.size;
  }

  /** Venues with a funding reading for this coin, for Book Focus fan-out. */
  venuesListing(coin: string): ExchangeId[] {
    const readings = this.coins.get(coin);
    if (!readings) return [];
    const out: ExchangeId[] = [];
    for (const id of EXCHANGE_IDS) {
      if (readings.funding[id]?.rate != null) out.push(id);
    }
    return out;
  }

  /**
   * Forgets coins no venue lists any more.
   *
   * Driven by the instrument registry now rather than by a rotating watch set, so
   * this fires on a delisting rather than every minute. The per-(venue, coin) maps are
   * evicted with it: they are keyed independently and would otherwise accumulate an
   * entry for every symbol the process had ever seen.
   */
  retainCoins(keep: Set<string>): void {
    let changed = false;
    for (const coin of [...this.coins.keys()]) {
      if (keep.has(coin)) continue;
      this.coins.delete(coin);
      this.rowCache.delete(coin);
      this.dirtyCoins.delete(coin);
      changed = true;
    }
    if (!changed) return;

    const stale = (key: string): boolean => !keep.has(key.slice(key.indexOf(":") + 1));
    for (const map of [
      this.settlementHistory,
      this.lastBookWrite,
      this.intervalMetadata,
      this.settlementMetadata,
    ] as Map<string, unknown>[]) {
      for (const key of [...map.keys()]) {
        if (stale(key)) map.delete(key);
      }
    }
    this.invalidateRows();
    this.version += 1;
  }

  /**
   * Records which pairs are claimed by an open position. Held separately from the
   * readings so `rows()` can keep a claimed row that has no funding yet, and so the
   * UI can say why a pair is being watched.
   */
  setClaims(claims: MarketClaim[]): void {
    const next = new Map(claims.map((c) => [`${c.exchange}:${c.coin}`, c]));
    if (next.size === this.claims.size) {
      let same = true;
      for (const key of next.keys()) {
        if (!this.claims.has(key)) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    this.claims = next;
    this.invalidateRows();
    this.version += 1;
  }

  getClaims(): MarketClaim[] {
    return [...this.claims.values()];
  }

  /** Coins claimed by an open position. */
  claimedCoins(): Set<string> {
    return new Set([...this.claims.values()].map((c) => c.coin));
  }

  applyUpdates(updates: StreamUpdate[]): void {
    if (updates.length === 0) return;
    const now = Date.now();
    let dirty = false;
    for (const update of updates) {
      const readings = this.ensureCoin(update.coin);
      if (update.kind === "funding") {
        readings.funding[update.exchange] = this.toFundingValue(
          update,
          readings.funding[update.exchange],
        );
        this.dirtyCoins.add(update.coin);
        dirty = true;
      } else {
        const key = `${update.exchange}:${update.coin}`;
        const previous = readings.tickers[update.exchange];
        const bid = update.bid ?? previous?.bid ?? null;
        const ask = update.ask ?? previous?.ask ?? null;
        const unchanged = previous?.bid === bid && previous?.ask === ask;
        // Book feeds push far faster than any UI needs. Skip writes that would
        // change nothing, and coalesce the rest into a small time window so a
        // busy venue cannot monopolise the event loop.
        const lastWrite = this.lastBookWrite.get(key) ?? 0;
        if (unchanged || now - lastWrite < BOOK_WRITE_INTERVAL_MS) {
          this.touchVenue(update.exchange, now);
          continue;
        }
        this.lastBookWrite.set(key, now);
        readings.tickers[update.exchange] = {
          exchange: update.exchange,
          bid,
          ask,
          ts: update.ts,
        };
        this.dirtyCoins.add(update.coin);
        dirty = true;
      }
      this.touchVenue(update.exchange, now);
    }
    if (dirty) {
      this.rowsCache = null;
      this.version += 1;
    }
  }

  private touchVenue(exchange: ExchangeId, now: number): void {
    const venue = this.venues.get(exchange);
    if (!venue) return;
    venue.lastMessageAt = now;
    if (venue.health !== "ok") venue.health = "ok";
    venue.lastError = null;
  }

  private toFundingValue(
    update: Extract<StreamUpdate, { kind: "funding" }>,
    previous: FundingRateValue | undefined,
  ): FundingRateValue {
    const fallbackHours = exchangeInfo(update.exchange).defaultIntervalHours;
    // Contract metadata wins: it is the venue stating its own cadence.
    const declared = this.intervalMetadata.get(`${update.exchange}:${update.coin}`);
    let intervalHours = declared ?? update.intervalHours ?? null;
    let confirmed = intervalHours !== null;

    // Venues that publish neither cadence nor a settlement clock get their
    // interval inferred from the gaps between observed settlements.
    if (intervalHours === null && update.nextFundingTime) {
      const key = `${update.exchange}:${update.coin}`;
      const seen = this.settlementHistory.get(key) ?? [];
      if (seen[seen.length - 1] !== update.nextFundingTime) {
        seen.push(update.nextFundingTime);
        if (seen.length > 4) seen.shift();
        this.settlementHistory.set(key, seen);
      }
      if (seen.length >= 2) {
        const gapMs = seen[seen.length - 1] - seen[seen.length - 2];
        const gapHours = Math.round(gapMs / 3_600_000);
        if (gapHours > 0 && gapHours <= 24) {
          intervalHours = gapHours;
          confirmed = true;
        }
      }
    }

    if (intervalHours === null) {
      intervalHours = previous?.intervalConfirmed ? previous.intervalHours : fallbackHours;
      confirmed = previous?.intervalConfirmed ?? false;
    }

    return {
      exchange: update.exchange,
      rate: update.ratePct,
      intervalHours,
      // Stream value first; metadata covers venues that never send a clock.
      nextFundingTime:
        update.nextFundingTime ??
        this.settlementMetadata.get(`${update.exchange}:${update.coin}`) ??
        previous?.nextFundingTime ??
        0,
      intervalConfirmed: confirmed,
      updatedAt: update.ts,
      fromRest: update.fromRest ?? false,
    };
  }

  /**
   * Records the cadence a venue declares for each coin, and the next settlement
   * when the venue publishes one. Applied to readings already held so an
   * in-flight row is corrected rather than waiting for the next stream tick.
   */
  setIntervalMetadata(
    exchange: ExchangeId,
    rows: { coin: string; intervalHours: number; nextFundingTime?: number | null }[],
  ): void {
    let changed = false;
    for (const row of rows) {
      const key = `${exchange}:${row.coin}`;
      const existing = this.coins.get(row.coin)?.funding[exchange];

      if (this.intervalMetadata.get(key) !== row.intervalHours) {
        this.intervalMetadata.set(key, row.intervalHours);
        changed = true;
        if (existing) {
          existing.intervalHours = row.intervalHours;
          existing.intervalConfirmed = true;
          this.dirtyCoins.add(row.coin);
        }
      }

      const next = row.nextFundingTime;
      if (next !== undefined && next !== null && next > 0) {
        if (this.settlementMetadata.get(key) !== next) {
          this.settlementMetadata.set(key, next);
          changed = true;
        }
        // Only fill a gap or replace a settlement that has already passed; a
        // value the stream supplied for a future time is more current.
        if (existing && (!existing.nextFundingTime || existing.nextFundingTime <= Date.now())) {
          existing.nextFundingTime = next;
          this.dirtyCoins.add(row.coin);
        }
      }
    }
    if (changed) {
      this.rowsCache = null;
      this.version += 1;
    }
  }

  private ensureCoin(coin: string): CoinReadings {
    let readings = this.coins.get(coin);
    if (!readings) {
      readings = { funding: {}, tickers: {} };
      this.coins.set(coin, readings);
      this.rowsCache = null;
    }
    return readings;
  }

  markPoll(exchange: ExchangeId, at: number, error?: string): void {
    const venue = this.venues.get(exchange);
    if (!venue) return;
    venue.lastPollAt = at;
    if (error) {
      venue.lastError = error;
      if (venue.health === "ok") venue.health = "degraded";
    }
    this.lastPollAt = at;
    this.version += 1;
  }

  setVenueConnections(exchange: ExchangeId, connections: number, subscriptions: number): void {
    const venue = this.venues.get(exchange);
    if (!venue) return;
    if (venue.connections === connections && venue.subscriptions === subscriptions) return;
    venue.connections = connections;
    venue.subscriptions = subscriptions;
    if (connections === 0 && subscriptions > 0) venue.health = "down";
    this.version += 1;
  }

  setVenueHealth(exchange: ExchangeId, health: VenueHealth, error?: string | null): void {
    const venue = this.venues.get(exchange);
    if (!venue) return;
    if (venue.health === health && (error === undefined || venue.lastError === error)) return;
    venue.health = health;
    if (error !== undefined) venue.lastError = error;
    this.version += 1;
  }

  /**
   * Marks that this venue's funding is being filled from REST because its
   * funding stream stays silent. Surfaced in the UI rather than hidden.
   */
  setFundingFromRest(exchange: ExchangeId, fromRest: boolean): void {
    const venue = this.venues.get(exchange);
    if (!venue || venue.fundingFromRest === fromRest) return;
    venue.fundingFromRest = fromRest;
    this.version += 1;
  }

  /** True when the venue has at least one stream-sourced funding reading. */
  hasStreamFunding(exchange: ExchangeId): boolean {
    for (const readings of this.coins.values()) {
      const value = readings.funding[exchange];
      if (value && value.fromRest !== true) return true;
    }
    return false;
  }

  /** Pairs with a funding reading, and pairs with a live quote, for the console. */
  coverage(): { funding: number; book: number } {
    let funding = 0;
    let book = 0;
    for (const readings of this.coins.values()) {
      for (const id of EXCHANGE_IDS) {
        if (readings.funding[id]?.rate != null) funding += 1;
        const ticker = readings.tickers[id];
        if (ticker && (ticker.bid !== null || ticker.ask !== null)) book += 1;
      }
    }
    return { funding, book };
  }

  /**
   * Coins with a funding reading on one venue.
   *
   * The console shows this against the venue's listing rather than its subscription
   * count, because the two diverge legitimately: a venue whose funding comes from REST
   * has no funding subscription at all, and reading the socket count there would report
   * a venue with complete data as badly under-covered.
   */
  fundingCoinsFor(exchange: ExchangeId): number {
    let count = 0;
    for (const readings of this.coins.values()) {
      if (readings.funding[exchange]?.rate != null) count += 1;
    }
    return count;
  }

  /** Coins with a live quote on one venue, which is the Book Focus footprint. */
  bookCoinsFor(exchange: ExchangeId): number {
    let count = 0;
    for (const readings of this.coins.values()) {
      const ticker = readings.tickers[exchange];
      if (ticker && (ticker.bid !== null || ticker.ask !== null)) count += 1;
    }
    return count;
  }

  // ─── Rows ─────────────────────────────────────────────────────────────────

  private invalidateRows(): void {
    this.rowCache.clear();
    this.dirtyCoins.clear();
    this.rowsCache = null;
  }

  /**
   * Every row, rebuilding only the coins whose readings changed.
   *
   * The cache is what makes full-market coverage affordable: without it every caller
   * of `rows()` — the SSE frame, each `/api/market/snapshot` request, and the strategy
   * loop four times per tick — paid a full rebuild of several thousand rows.
   */
  rows(): FundingRateRow[] {
    if (this.rowsCache && this.dirtyCoins.size === 0) return this.rowsCache;

    for (const coin of this.dirtyCoins) {
      const readings = this.coins.get(coin);
      if (!readings) {
        this.rowCache.delete(coin);
        continue;
      }
      this.rowCache.set(coin, buildRow(coin, readings));
    }
    this.dirtyCoins.clear();

    const claimed = this.claimedCoins();
    const out: FundingRateRow[] = [];
    for (const coin of this.coins.keys()) {
      let row = this.rowCache.get(coin);
      if (!row) {
        const readings = this.coins.get(coin);
        if (!readings) continue;
        row = buildRow(coin, readings);
        this.rowCache.set(coin, row);
      }
      // A row with no live funding anywhere is noise; wait for the stream. A
      // claimed coin is the exception: a position needs its quote for valuation
      // and closing even before any funding frame has arrived, and dropping the
      // row here would leave the account unable to value it.
      const hasAnyRate = Object.values(row.rates).some((r) => r.rate !== null);
      const hasAnyQuote = Object.values(row.tickers).some(
        (t) => t && (t.bid !== null || t.ask !== null),
      );
      if (hasAnyRate || (claimed.has(coin) && hasAnyQuote)) out.push(row);
    }
    this.rowsCache = out;
    return out;
  }

  venueStatuses(): VenueStatus[] {
    const now = Date.now();
    return EXCHANGE_IDS.map((exchange) => {
      const v = this.venues.get(exchange)!;
      let health = v.health;
      // A venue that has stopped talking for a while is degraded even if the
      // socket is technically open.
      if (health === "ok" && v.lastMessageAt !== null && now - v.lastMessageAt > 90_000) {
        health = "degraded";
      }
      return {
        exchange,
        health,
        connections: v.connections,
        subscriptions: v.subscriptions,
        lastMessageAt: v.lastMessageAt,
        lastPollAt: v.lastPollAt,
        lastError: v.lastError,
        fundingFromRest: v.fundingFromRest ?? false,
      };
    });
  }

  /**
   * The whole market, unpaged.
   *
   * Kept for the server-side callers that genuinely need every row — order validation,
   * mark prices, and the four strategy engines scanning for candidates. Cached by
   * version so the strategy loop's four calls per tick cost one build.
   */
  snapshot(): MarketSnapshot {
    if (this.snapshotCache?.version === this.version) return this.snapshotCache.value;
    const value: MarketSnapshot = {
      rows: this.rows(),
      venues: this.venueStatuses(),
      coins: this.watchedCoins(),
      claims: this.getClaims(),
      updatedAt: Date.now(),
      lastPollAt: this.lastPollAt,
    };
    this.snapshotCache = { version: this.version, value };
    return value;
  }

  // ─── Views ────────────────────────────────────────────────────────────────

  /**
   * Coins with the widest scoped funding gap, for Book Focus.
   *
   * Deliberately not a full `view()` call: this runs on the subscription reconcile
   * path and only needs the coin names, so it skips paging, rescoping and row
   * construction.
   */
  topCoinsByDiff(
    scope: MarketViewQuery["scope"],
    venues: ExchangeId[],
    limit: number,
  ): string[] {
    const scored: { coin: string; diff: number }[] = [];
    for (const row of this.rows()) {
      const { diffFr } = deriveScopedDirection(
        row.normalizedRates,
        smallestInterval(row, venues),
        scope,
        venues,
      );
      if (diffFr === null) continue;
      scored.push({ coin: row.coin, diff: Math.abs(diffFr) });
    }
    scored.sort((a, b) => b.diff - a.diff);
    return scored.slice(0, limit).map((s) => s.coin);
  }

  /**
   * One page of the market, filtered, re-scoped and sorted on the server.
   *
   * Paging server-side is what keeps the 1 Hz push small with thousands of pairs, but
   * the reason it has to be *here* rather than in the browser is correctness, not
   * payload size: Diff FR and Direction depend on which venues the view includes, so a
   * client sorting by Diff FR over one page would be ordering by a number derived from
   * a different venue set than the one on screen. The sort and the derivation have to
   * agree, so they live together.
   */
  view(query: MarketViewQuery): MarketView {
    const venues =
      query.venues && query.venues.length > 0
        ? query.venues.filter((v) => (EXCHANGE_IDS as string[]).includes(v))
        : EXCHANGE_IDS;
    const pageSize = clamp(Math.round(query.pageSize), MIN_PAGE_SIZE, MAX_PAGE_SIZE);
    const search = query.search?.trim().toUpperCase() ?? "";
    const pinned = new Set(query.pin ?? []);
    // Can the visible venues form a pair this scope accepts? With no quotable pair
    // there is nothing for Diff FR to describe, and the columns are dropped rather
    // than filled with dashes.
    const pairable = venues.some((a) => venues.some((b) => a !== b && pairInScope(query.scope, a, b)));

    const matched: FundingRateRow[] = [];
    for (const row of this.rows()) {
      const isPinned = pinned.has(row.coin);
      if (!isPinned) {
        if (search && !row.coin.includes(search)) continue;
        // A coin with no rate on any venue in this view would render as a row of
        // dashes, so it is dropped rather than shown as if data were missing.
        if (!venues.some((ex) => row.rates[ex]?.rate != null)) continue;
      }
      const scoped = rescope(row, venues, query.scope);
      if (!isPinned && pairable && scoped.direction === null) continue;
      matched.push(scoped);
    }

    sortRows(matched, query.sort, query.dir === "asc" ? 1 : -1, pinned);

    const total = matched.length;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = clamp(Math.round(query.page), 1, pageCount);
    const start = (page - 1) * pageSize;

    return {
      // Trimmed to the fields the UI reads. `normalizedRates` and the `spread` alias
      // are for the server-side derivation and the strategy engines; shipping them at
      // 1 Hz would spend a third of every frame on data nothing renders.
      rows: matched.slice(start, start + pageSize).map(toViewRow),
      total,
      universe: this.coins.size,
      page,
      pageSize,
      pairable,
      // Computed over every matching row rather than the page: "highest funding" from
      // page 1 of a paged market would be a different claim than the card makes.
      summary: summarise(matched, venues),
      venues: this.venueStatuses(),
      claims: this.getClaims(),
      updatedAt: Date.now(),
    };
  }
}

function toViewRow(row: FundingRateRow): MarketViewRow {
  return {
    coin: row.coin,
    rates: row.rates,
    tickers: row.tickers,
    diffFr: row.diffFr,
    direction: row.direction,
    priceSpread: row.priceSpread,
  };
}

/**
 * Headline figures for a whole result set.
 *
 * `bestDiff` reads each row's already-scoped `diffFr` rather than re-deriving one, so
 * the card and the Diff FR column can never disagree about which pair is widest.
 */
function summarise(rows: FundingRateRow[], venues: ExchangeId[]): MarketSummary {
  let highest: MarketHighlight | null = null;
  let lowest: MarketHighlight | null = null;
  let bestDiff: MarketSummary["bestDiff"] = null;

  for (const row of rows) {
    for (const ex of venues) {
      const v = row.rates[ex];
      if (!v || v.rate === null) continue;
      if (!highest || v.rate > highest.rate) {
        highest = { coin: row.coin, exchange: ex, rate: v.rate, nextFundingTime: v.nextFundingTime };
      }
      if (!lowest || v.rate < lowest.rate) {
        lowest = { coin: row.coin, exchange: ex, rate: v.rate, nextFundingTime: v.nextFundingTime };
      }
    }
    if (row.diffFr !== null && (!bestDiff || row.diffFr > bestDiff.diff)) {
      bestDiff = { coin: row.coin, diff: row.diffFr, direction: row.direction };
    }
  }

  return { highest, lowest, bestDiff };
}

/**
 * Re-derive a row's Diff FR, Direction and entry spread under one scope.
 *
 * `buildRow` derives these across every venue at once, which is right for the
 * unscoped snapshot the strategy engines read and wrong for a scoped view: on the
 * decentralized page the best global pair is usually two centralized venues, and a row
 * headed "Long KuCoin · Short OKX" with neither column present cannot be checked
 * against anything.
 */
function rescope(row: FundingRateRow, venues: ExchangeId[], scope: MarketViewQuery["scope"]): FundingRateRow {
  const { diffFr, direction } = deriveScopedDirection(
    row.normalizedRates,
    // The normalization interval is a property of the reading, so it is taken from
    // the venues in view rather than recomputed from all of them.
    smallestInterval(row, venues),
    scope,
    venues,
  );
  return {
    ...row,
    spread: diffFr,
    diffFr,
    direction,
    priceSpread: derivePriceSpread(direction, row.tickers),
  };
}

/** Shortest funding interval among the venues in view that list this coin. */
function smallestInterval(row: FundingRateRow, venues: ExchangeId[]): number | null {
  let smallest: number | null = null;
  for (const ex of venues) {
    const value = row.rates[ex];
    if (value?.rate == null) continue;
    if (smallest === null || value.intervalHours < smallest) smallest = value.intervalHours;
  }
  return smallest;
}

/** In-place sort. Pinned coins lead, so a selected pair never falls off the page. */
function sortRows(
  rows: FundingRateRow[],
  key: SortKey,
  dirMul: number,
  pinned: Set<string>,
): void {
  rows.sort((a, b) => {
    if (pinned.size > 0) {
      const ap = pinned.has(a.coin) ? 0 : 1;
      const bp = pinned.has(b.coin) ? 0 : 1;
      if (ap !== bp) return ap - bp;
    }
    if (key === "coin") return a.coin.localeCompare(b.coin) * dirMul;
    if (key === "spread" || key === "diffFr") {
      return compareNullable(a.diffFr, b.diffFr, dirMul);
    }
    if (key === "priceSpread") {
      return compareNullable(a.priceSpread?.pct ?? null, b.priceSpread?.pct ?? null, dirMul);
    }
    return compareNullable(a.rates[key]?.rate ?? null, b.rates[key]?.rate ?? null, dirMul);
  });
}

/** Nulls sort last in either direction: "not listed" is not a low value. */
function compareNullable(a: number | null, b: number | null, dirMul: number): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * dirMul;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export { MAX_PAGE_SIZE, MIN_PAGE_SIZE };
