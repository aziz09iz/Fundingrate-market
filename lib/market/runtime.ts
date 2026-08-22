import type {
  MarketSnapshot,
  MarketView,
  MarketViewQuery,
  StreamFabricStatus,
} from "@/lib/types";
import { MarketStore } from "@/lib/market/store";
import { WsManager } from "@/lib/market/ws-manager";
import { BookFocus } from "@/lib/market/focus";
import { InstrumentRegistry, INSTRUMENT_REFRESH_INTERVAL_MS } from "@/lib/market/registry";
import { pollFundingFallback, pollIntervals } from "@/lib/market/poller";
import { currentClaims } from "@/lib/market/claims";
import { ADAPTERS } from "@/lib/exchanges";
import { EXCHANGE_IDS } from "@/lib/utils";

/** How often the REST funding fallback runs for venues with a silent stream. */
const FUNDING_FALLBACK_INTERVAL_MS = 15_000;

/**
 * How often subscriptions are reconciled against the registry and Book Focus.
 *
 * Fast, because this is what applies a focus change: opening a page should have its
 * quotes within a few seconds, not on the next instrument refresh. It is cheap by
 * design — the funding set only changes when a venue lists or delists something, and
 * the manager diffs rather than resubscribing.
 */
const RECONCILE_INTERVAL_MS = 5_000;

/** How often contract cadence metadata is re-read. */
const INTERVAL_REFRESH_MS = 5 * 60_000;

/** Distinct serialised view frames kept, so several tabs on one view share a build. */
const FRAME_CACHE_LIMIT = 16;

/** How often event-loop delay is sampled. */
const LOOP_SAMPLE_MS = 500;

/**
 * Measures how late a timer actually fires.
 *
 * Worth reporting rather than inferring: this process parses several thousand
 * websocket frames a second, and when the loop falls behind the first casualty is the
 * heartbeat a venue expects on a schedule — the socket is then closed by the venue for
 * being idle, which looks like a network fault and is not one. A lag figure turns that
 * into something an operator can see.
 */
class LoopLagMonitor {
  private timer: NodeJS.Timeout | null = null;
  private lastAt = Date.now();
  private lag = 0;

  start(): void {
    if (this.timer) return;
    this.lastAt = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const observed = now - this.lastAt - LOOP_SAMPLE_MS;
      this.lastAt = now;
      // Exponential decay, so one slow tick does not read as a sustained stall and a
      // sustained stall does not disappear on the next fast tick.
      this.lag = Math.max(0, this.lag * 0.7 + Math.max(0, observed) * 0.3);
    }, LOOP_SAMPLE_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  current(): number {
    return Math.round(this.lag);
  }
}

/**
 * Long-lived market runtime: an instrument registry, a websocket manager and the
 * store they feed.
 *
 * Nothing is persisted — restart the server and it rebuilds from the venues. This
 * needs a process that stays alive, so it does not fit a serverless deployment;
 * running `next dev` or `next start` on a host you control is fine.
 */
class MarketRuntime {
  readonly store = new MarketStore();
  readonly registry = new InstrumentRegistry();
  readonly focus = new BookFocus();
  private readonly ws = new WsManager(this.store);
  private instrumentTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private started = false;
  private refreshing = false;
  private fallbackRunning = false;
  private registryAt: number | null = null;
  private readonly loopLag = new LoopLagMonitor();
  /** Serialised SSE frames keyed by store version and view query. */
  private readonly frameCache = new Map<string, { version: number; bytes: Uint8Array }>();

  start(): void {
    if (this.started) return;
    this.started = true;
    this.loopLag.start();
    void this.refreshInstruments();
    void this.refreshIntervals();
    this.instrumentTimer = setInterval(
      () => void this.refreshInstruments(),
      INSTRUMENT_REFRESH_INTERVAL_MS,
    );
    this.intervalTimer = setInterval(() => void this.refreshIntervals(), INTERVAL_REFRESH_MS);
    this.reconcileTimer = setInterval(() => this.reconcile(), RECONCILE_INTERVAL_MS);
    this.fallbackTimer = setInterval(
      () => void this.runFundingFallback(),
      FUNDING_FALLBACK_INTERVAL_MS,
    );
  }

  /**
   * Rediscovers what each venue lists, then applies it.
   *
   * The registry keeps a venue's previous coins when its request fails, so a timeout
   * cannot unsubscribe a whole market. Coins no venue lists any more are dropped from
   * the store here rather than lingering as rows nothing refreshes.
   */
  private async refreshInstruments(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.registry.refresh();
      this.registryAt = Date.now();
      const listed = this.registry.allCoins();
      // Claimed pairs survive a delisting: a position still has to be valued and
      // closed even if the venue has stopped listing the contract.
      for (const claim of currentClaims()) listed.add(claim.coin);
      this.store.retainCoins(listed);
      for (const exchange of EXCHANGE_IDS) {
        this.store.markPoll(exchange, Date.now());
      }
      this.reconcile();
      // Fill funding immediately for a venue whose stream stays silent, instead of
      // leaving its column empty until the next fallback tick.
      void this.runFundingFallback();
    } catch {
      // A failed refresh must not stop the loop; the next one retries.
    } finally {
      this.refreshing = false;
    }
  }

  private async refreshIntervals(): Promise<void> {
    try {
      await pollIntervals(this.store);
    } catch {
      // Missing cadence metadata leaves the previous value in place.
    }
  }

  private async runFundingFallback(): Promise<void> {
    if (this.fallbackRunning) return;
    this.fallbackRunning = true;
    try {
      await pollFundingFallback(this.store, this.registry);
    } catch {
      // A failed fallback must not stop the loop.
    } finally {
      this.fallbackRunning = false;
    }
  }

  /** Applies the current funding and Book Focus sets to the sockets. */
  private reconcile(): void {
    try {
      this.store.setClaims(currentClaims());
      this.ws.sync(this.registry.desiredFunding(), this.focus.desired(this.store));
    } catch {
      // A reconcile failure leaves the existing subscriptions in place.
    }
  }

  snapshot(): MarketSnapshot {
    return this.store.snapshot();
  }

  view(query: MarketViewQuery): MarketView {
    return this.store.view(query);
  }

  version(): number {
    return this.store.getVersion();
  }

  /**
   * Registers or renews one viewer's book interest and returns its view.
   *
   * The lease is taken from the rows actually returned, which is the whole point:
   * quotes follow the page being looked at rather than the market as a whole, and a
   * viewer that stops reading releases them without having to say so.
   */
  viewFor(viewerId: string, query: MarketViewQuery): MarketView {
    const view = this.store.view(query);
    this.focus.lease(viewerId, [...view.rows.map((r) => r.coin), ...(query.pin ?? [])]);
    return view;
  }

  releaseViewer(viewerId: string): void {
    this.focus.release(viewerId);
  }

  /**
   * A view as a ready-to-send SSE frame, built at most once per store version per
   * distinct query.
   *
   * Every open tab used to build and serialise its own copy on its own interval. The
   * payload is identical for tabs on the same view, so caching by version turns N
   * builds into one. It is keyed by query as well now, because two tabs on different
   * scopes genuinely need different bytes.
   */
  viewFrame(viewerId: string, query: MarketViewQuery): { version: number; bytes: Uint8Array } {
    const version = this.store.getVersion();
    const key = queryKey(query);
    const hit = this.frameCache.get(key);
    if (hit?.version === version) {
      // Still renew the lease: a cache hit means the data has not changed, not that
      // the viewer has gone away.
      this.focus.lease(viewerId, leaseCoins(this.store.view(query), query));
      return hit;
    }
    const view = this.viewFor(viewerId, query);
    const bytes = FRAME_ENCODER.encode(`event: view\ndata: ${JSON.stringify(view)}\n\n`);
    const frame = { version, bytes };
    // Bounded, evicting oldest first: the key space is user-driven (scope, sort, page,
    // search) and an unbounded map here would grow with every keystroke.
    if (this.frameCache.size >= FRAME_CACHE_LIMIT) {
      const oldest = this.frameCache.keys().next().value;
      if (oldest !== undefined) this.frameCache.delete(oldest);
    }
    this.frameCache.set(key, frame);
    return frame;
  }

  /** Everything the Stream Fabric console shows. */
  fabricStatus(): StreamFabricStatus {
    const shards = this.ws.telemetry();
    const venueStatuses = this.store.venueStatuses();
    const instruments = new Map(this.registry.status().map((s) => [s.exchange, s]));
    const coverage = this.store.coverage();

    const venues = venueStatuses.map((v) => {
      const own = shards.filter((s) => s.exchange === v.exchange);
      const instrument = instruments.get(v.exchange);
      return {
        exchange: v.exchange,
        health: v.health,
        socketsOpen: own.filter((s) => s.state === "open").length,
        socketsExpected: own.length,
        // Coins with an actual funding reading, not the subscription count: a venue
        // whose funding comes from REST has no funding subscription, and reporting zero
        // there would flag a fully covered venue as broken.
        fundingCoins: this.store.fundingCoinsFor(v.exchange),
        bookCoins: this.store.bookCoinsFor(v.exchange),
        listedCoins: instrument?.coins.length ?? 0,
        fundingSource: ADAPTERS[v.exchange]?.fundingSource ?? "stream",
        msgRate: Math.round(own.reduce((sum, s) => sum + s.msgRate, 0) * 10) / 10,
        lastMessageAt: v.lastMessageAt,
        lastError: v.lastError,
        fundingFromRest: v.fundingFromRest ?? false,
        instrumentsAt: instrument?.lastSuccessAt ?? null,
        instrumentsError: instrument?.lastError ?? null,
      };
    });

    return {
      shards,
      venues,
      totals: {
        socketsOpen: shards.filter((s) => s.state === "open").length,
        socketsExpected: shards.length,
        msgRate: Math.round(shards.reduce((sum, s) => sum + s.msgRate, 0) * 10) / 10,
        fundingPairs: coverage.funding,
        bookPairs: coverage.book,
        trackedPairs: this.registry.pairCount(),
        coins: this.store.coinCount(),
      },
      focus: {
        viewers: this.focus.viewerCount(),
        entries: this.focus.explain(this.store),
      },
      registryAgeMs: this.registryAt === null ? null : Date.now() - this.registryAt,
      loopLagMs: this.loopLag.current(),
    };
  }

  reconnectShard(id: string): boolean {
    return this.ws.reconnectShard(id);
  }

  /** Coins each venue lists, for the trade page's pair picker. */
  instruments(): { exchange: string; coins: string[] }[] {
    return this.registry.status().map((s) => ({ exchange: s.exchange, coins: s.coins }));
  }

  stop(): void {
    for (const timer of [this.instrumentTimer, this.reconcileTimer, this.intervalTimer]) {
      if (timer) clearInterval(timer);
    }
    this.instrumentTimer = null;
    this.reconcileTimer = null;
    this.intervalTimer = null;
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
    this.loopLag.stop();
    this.ws.stop();
    this.started = false;
  }
}

const FRAME_ENCODER = new TextEncoder();

function leaseCoins(view: MarketView, query: MarketViewQuery): string[] {
  return [...view.rows.map((r) => r.coin), ...(query.pin ?? [])];
}

function queryKey(query: MarketViewQuery): string {
  return [
    query.scope,
    (query.venues ?? []).join(","),
    query.search ?? "",
    query.sort,
    query.dir,
    query.page,
    query.pageSize,
    (query.pin ?? []).join(","),
  ].join("|");
}

// Survive dev-server hot reloads: without this each recompile would open a
// fresh set of exchange sockets and leak the old ones.
const globalRef = globalThis as typeof globalThis & {
  __frwMarketRuntime?: MarketRuntime;
};

export function getMarketRuntime(): MarketRuntime {
  if (!globalRef.__frwMarketRuntime) {
    globalRef.__frwMarketRuntime = new MarketRuntime();
  }
  const runtime = globalRef.__frwMarketRuntime;
  runtime.start();
  return runtime;
}
