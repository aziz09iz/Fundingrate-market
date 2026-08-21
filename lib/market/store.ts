import type {
  ExchangeId,
  FundingRateRow,
  FundingRateValue,
  LayerAssignment,
  MarketConfig,
  MarketSnapshot,
  VenueHealth,
  VenueStatus,
} from "@/lib/types";
import type { StreamUpdate } from "@/lib/exchanges/adapter";
import type { MarketClaim } from "@/lib/market/claims";
import { EXCHANGE_IDS, exchangeInfo } from "@/lib/utils";
import { buildRow, type CoinReadings } from "@/lib/market/derive";

export const DEFAULT_MARKET_CONFIG: MarketConfig = {
  pollIntervalSec: 60,
  layer1CountPerExchange: 10,
};

/** Ceiling on the watched coin universe so layer 2 cannot explode. */
export const MAX_COIN_UNIVERSE = 60;

/**
 * Minimum gap between stored quote updates for one (venue, coin). The venues
 * push top-of-book changes many times per second; the UI renders once a second,
 * so coalescing here keeps the event loop free without losing anything visible.
 */
const BOOK_WRITE_INTERVAL_MS = 400;

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
 * In-memory market state. Nothing is persisted: on restart everything is
 * rebuilt from the venues' own REST and websocket feeds.
 */
export class MarketStore {
  private readonly coins = new Map<string, CoinReadings>();
  private readonly venues = new Map<ExchangeId, VenueState>();
  private layers: LayerAssignment[] = [];
  /** Pairs claimed by an open position, keyed `exchange:coin`. */
  private claims = new Map<string, MarketClaim>();
  private config: MarketConfig = { ...DEFAULT_MARKET_CONFIG };
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

  getConfig(): MarketConfig {
    return { ...this.config };
  }

  setConfig(patch: Partial<MarketConfig>): MarketConfig {
    if (patch.pollIntervalSec !== undefined) {
      this.config.pollIntervalSec = clamp(Math.round(patch.pollIntervalSec), 10, 600);
    }
    if (patch.layer1CountPerExchange !== undefined) {
      this.config.layer1CountPerExchange = clamp(Math.round(patch.layer1CountPerExchange), 1, 50);
    }
    this.version += 1;
    return this.getConfig();
  }

  getVersion(): number {
    return this.version;
  }

  /** Coins currently watched, i.e. the union of layer 1 and layer 2. */
  watchedCoins(): string[] {
    return [...new Set(this.layers.map((l) => l.coin))].sort();
  }

  setLayers(layers: LayerAssignment[]): void {
    this.layers = layers;
    // Drop readings for coins that left the watch set so the UI never shows
    // prices that are no longer being refreshed. Claimed coins are in `layers`
    // as layer 3, so they survive this by construction.
    const keep = new Set(layers.map((l) => l.coin));
    for (const coin of [...this.coins.keys()]) {
      if (!keep.has(coin)) this.coins.delete(coin);
    }
    this.pruneByCoin(keep);
    this.version += 1;
  }

  /**
   * Evicts the per-(venue, coin) maps for coins that are no longer watched.
   *
   * These four are keyed `exchange:coin` and were written but never cleared, so
   * they accumulated a key for every pair that had ever been hot. Because the
   * ranking rotates the top set every cycle, that converges on every symbol on
   * every venue rather than on the sixty being watched — and nothing would ever
   * remove a delisted one. The bound is around a megabyte, so this is drift rather
   * than a runaway leak, but the `keep` set is already computed above and the
   * eviction costs one pass.
   */
  private pruneByCoin(keep: Set<string>): void {
    const stale = (key: string): boolean => {
      const coin = key.slice(key.indexOf(":") + 1);
      return !keep.has(coin);
    };
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
  }

  /**
   * Records which pairs are claimed by an open position. Held separately from
   * `layers` so `rows()` can keep a claimed row that has no funding reading yet,
   * and so the UI can say why a pair is being watched.
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
    this.version += 1;
  }

  getClaims(): MarketClaim[] {
    return [...this.claims.values()];
  }

  /** Coins claimed by an open position. */
  claimedCoins(): Set<string> {
    return new Set([...this.claims.values()].map((c) => c.coin));
  }

  getLayers(): LayerAssignment[] {
    return this.layers;
  }

  /** Venues subscribed for a given coin, per layer assignment. */
  venuesForCoin(coin: string): ExchangeId[] {
    return this.layers.filter((l) => l.coin === coin).map((l) => l.exchange);
  }

  coinsForVenue(exchange: ExchangeId): string[] {
    return this.layers.filter((l) => l.exchange === exchange).map((l) => l.coin);
  }

  applyUpdates(updates: StreamUpdate[]): void {
    if (updates.length === 0) return;
    const now = Date.now();
    let dirty = false;
    for (const update of updates) {
      const readings = this.ensureCoin(update.coin);
      if (update.kind === "funding") {
        readings.funding[update.exchange] = this.toFundingValue(update, readings.funding[update.exchange]);
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
        dirty = true;
      }
      this.touchVenue(update.exchange, now);
    }
    if (dirty) this.version += 1;
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
        }
      }
    }
    if (changed) this.version += 1;
  }

  private ensureCoin(coin: string): CoinReadings {
    let readings = this.coins.get(coin);
    if (!readings) {
      readings = { funding: {}, tickers: {} };
      this.coins.set(coin, readings);
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
    venue.connections = connections;
    venue.subscriptions = subscriptions;
    if (connections === 0 && subscriptions > 0) venue.health = "down";
    this.version += 1;
  }

  setVenueHealth(exchange: ExchangeId, health: VenueHealth, error?: string | null): void {
    const venue = this.venues.get(exchange);
    if (!venue) return;
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

  /** Coins in the watch set that still have no funding reading for a venue. */
  coinsMissingFunding(exchange: ExchangeId): string[] {
    return this.coinsForVenue(exchange).filter(
      (coin) => this.coins.get(coin)?.funding[exchange] === undefined,
    );
  }

  /** True when the venue has at least one stream-sourced funding reading. */
  hasStreamFunding(exchange: ExchangeId): boolean {
    for (const coin of this.coinsForVenue(exchange)) {
      const value = this.coins.get(coin)?.funding[exchange];
      if (value && value.fromRest !== true) return true;
    }
    return false;
  }

  rows(): FundingRateRow[] {
    const out: FundingRateRow[] = [];
    const claimed = this.claimedCoins();
    for (const coin of this.watchedCoins()) {
      const readings = this.coins.get(coin);
      if (!readings) continue;
      const row = buildRow(coin, readings);
      // A row with no live funding anywhere is noise; wait for the stream. A
      // claimed coin is the exception: a position needs its quote for valuation
      // and closing even before any funding frame has arrived, and dropping the
      // row here would leave the account unable to value it.
      const hasAnyRate = Object.values(row.rates).some((r) => r.rate !== null);
      const hasAnyQuote = Object.values(row.tickers).some((t) => t && (t.bid !== null || t.ask !== null));
      if (hasAnyRate || (claimed.has(coin) && hasAnyQuote)) out.push(row);
    }
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

  snapshot(): MarketSnapshot {
    return {
      rows: this.rows(),
      venues: this.venueStatuses(),
      layers: this.layers,
      coins: this.watchedCoins(),
      claims: this.getClaims(),
      updatedAt: Date.now(),
      lastPollAt: this.lastPollAt,
      config: this.getConfig(),
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
