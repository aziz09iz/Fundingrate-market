import type { ExchangeId, MarketConfig, MarketSnapshot } from "@/lib/types";
import { MarketStore } from "@/lib/market/store";
import { WsManager } from "@/lib/market/ws-manager";
import { pollFundingFallback, pollIntervals, pollRanking } from "@/lib/market/poller";

/** How often the REST funding fallback runs for venues with a silent stream. */
const FUNDING_FALLBACK_INTERVAL_MS = 15_000;

/**
 * Long-lived market runtime: one REST ranking loop plus a websocket manager.
 * Nothing is persisted — restart the server and it rebuilds from the venues.
 *
 * Note this needs a process that stays alive, so it does not fit a serverless
 * deployment. Running `next dev` or `next start` on a host you control is fine.
 */
class MarketRuntime {
  readonly store = new MarketStore();
  private readonly ws = new WsManager(this.store);
  /** Every coin each venue lists, learned from the ranking pass. */
  private readonly listedByVenue = new Map<ExchangeId, Set<string>>();
  private timer: NodeJS.Timeout | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private started = false;
  private cycleRunning = false;
  private fallbackRunning = false;
  private currentIntervalSec: number | null = null;
  /** Last serialised SSE frame, shared by every connected client. */
  private frameCache: { version: number; bytes: Uint8Array } | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.runCycle();
    this.fallbackTimer = setInterval(
      () => void this.runFundingFallback(),
      FUNDING_FALLBACK_INTERVAL_MS,
    );
  }

  private async runFundingFallback(): Promise<void> {
    if (this.fallbackRunning) return;
    this.fallbackRunning = true;
    try {
      await pollFundingFallback(this.store);
    } catch {
      // A failed fallback must not stop the loop.
    } finally {
      this.fallbackRunning = false;
    }
  }

  private scheduleNext(): void {
    const { pollIntervalSec } = this.store.getConfig();
    this.currentIntervalSec = pollIntervalSec;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.runCycle(), pollIntervalSec * 1000);
  }

  private async runCycle(): Promise<void> {
    if (this.cycleRunning) return;
    this.cycleRunning = true;
    try {
      // Cadence metadata first: Diff FR divides by the interval, so the rows
      // built from this cycle should already carry the venue-declared value.
      await pollIntervals(this.store);
      const { layers } = await pollRanking(this.store, this.listedByVenue);
      if (layers.length > 0) {
        this.store.setLayers(layers);
        const desired = new Map<ExchangeId, string[]>();
        // Layer 3 coins are tracked separately so venues that rebuild their
        // socket on every set change do not drop position quotes each cycle.
        const pinned = new Map<ExchangeId, string[]>();
        for (const assignment of layers) {
          const list = desired.get(assignment.exchange) ?? [];
          list.push(assignment.coin);
          desired.set(assignment.exchange, list);
          if (assignment.layer === 3) {
            const pin = pinned.get(assignment.exchange) ?? [];
            pin.push(assignment.coin);
            pinned.set(assignment.exchange, pin);
          }
        }
        this.ws.sync(desired, pinned);
        // Fill funding straight away for venues whose stream stays silent,
        // instead of leaving their column empty until the next interval.
        void this.runFundingFallback();
      }
    } catch {
      // A failed cycle must not kill the loop; the next one retries.
    } finally {
      this.cycleRunning = false;
      this.scheduleNext();
    }
  }

  setConfig(patch: Partial<MarketConfig>): MarketConfig {
    const before = this.store.getConfig();
    const next = this.store.setConfig(patch);
    // Re-rank immediately when the layer size changes, and reschedule when the
    // cadence changes, so a settings edit takes effect without a restart.
    if (next.layer1CountPerExchange !== before.layer1CountPerExchange) {
      void this.runCycle();
    } else if (next.pollIntervalSec !== this.currentIntervalSec) {
      this.scheduleNext();
    }
    return next;
  }

  snapshot(): MarketSnapshot {
    return this.store.snapshot();
  }

  version(): number {
    return this.store.getVersion();
  }

  /**
   * The current snapshot as a ready-to-send SSE frame, built at most once per
   * store version however many clients are connected.
   *
   * Every open tab used to build and serialise its own copy on its own interval,
   * and the payload is identical for all of them — around 200 KB at a full 60-coin
   * universe. That made the cost of an extra tab a full extra build, serialise and
   * garbage cycle every second. Caching by version turns it into one.
   *
   * The bytes are cached rather than the object because the object would still be
   * re-serialised per client, which is the expensive half.
   */
  snapshotFrame(): { version: number; bytes: Uint8Array } {
    const version = this.store.getVersion();
    if (this.frameCache?.version === version) return this.frameCache;
    const bytes = FRAME_ENCODER.encode(
      `event: snapshot\ndata: ${JSON.stringify(this.store.snapshot())}\n\n`,
    );
    this.frameCache = { version, bytes };
    return this.frameCache;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
    this.ws.stop();
    this.started = false;
  }
}

const FRAME_ENCODER = new TextEncoder();

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
