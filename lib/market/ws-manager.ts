import WebSocket from "ws";
import type { ExchangeId, ShardState, ShardTelemetry } from "@/lib/types";
import type { ExchangeAdapter, WsEndpointPlan } from "@/lib/exchanges/adapter";
import { coinsPerShard } from "@/lib/exchanges/adapter";
import { ADAPTERS } from "@/lib/exchanges";
import { assertAllowedUrl } from "@/lib/private/hosts";
import { backoffDelay } from "@/lib/market/backoff";
import type { MarketStore } from "@/lib/market/store";

const RESOLVE_TIMEOUT_MS = 15_000;

/**
 * How long a firehose socket may stay silent before it is force-reconnected.
 *
 * A firehose is a whole venue's market on one connection, so "open but silent" is a
 * total outage for that venue rather than a quiet pair. The sharded case does not need
 * this — a topic shard covering a few hundred illiquid coins can legitimately go quiet
 * for a while, and dropping it would be the wrong reaction.
 */
const FIREHOSE_SILENCE_MS = 60_000;

/** Rate smoothing window. Long enough to read, short enough to react. */
const RATE_WINDOW_MS = 10_000;

interface Shard {
  /** Stable id so reconnects reuse the same coin set. */
  id: string;
  exchange: ExchangeId;
  plan: WsEndpointPlan;
  coins: Set<string>;
  socket: WebSocket | null;
  heartbeat: NodeJS.Timeout | null;
  reconnect: NodeJS.Timeout | null;
  attempts: number;
  closing: boolean;
  /** Coins already sent in a subscribe frame on the current socket. */
  subscribed: Set<string>;

  // ── Telemetry ──
  state: ShardState;
  connectedAt: number | null;
  messages: number;
  bytes: number;
  lastMessageAt: number | null;
  reconnects: number;
  lastError: string | null;
  nextRetryAt: number | null;
  /** Counters at the last rate sample, so rates are per-interval not lifetime. */
  sampleAt: number;
  sampleMessages: number;
  sampleBytes: number;
  msgRate: number;
  byteRate: number;
}

/**
 * Owns every venue websocket.
 *
 * Two things changed with full-market coverage. Subscriptions are split by *kind*
 * rather than by priority — funding for everything, books only where they are wanted —
 * so shards are bucketed `f` and `b`, and the two sets are diffed independently. And a
 * plan can be a firehose: one socket carrying the venue's whole market, which is never
 * sharded and whose subscribe frame ignores the coin list entirely.
 *
 * Every shard also carries its own counters. With roughly thirty sockets across eight
 * venues, "the venue looks fine" is no longer a useful granularity — a single silent
 * shard is a few hundred pairs with no data, and nothing above this layer can see it.
 */
export class WsManager {
  private readonly shards = new Map<string, Shard>();
  /** Shard ids per venue, so a venue rollup does not scan every shard. */
  private readonly byVenue = new Map<ExchangeId, Set<string>>();
  private stopped = false;
  private silenceTimer: NodeJS.Timeout | null = null;

  constructor(private readonly store: MarketStore) {
    this.silenceTimer = setInterval(() => this.checkFirehoseSilence(), 15_000);
  }

  /**
   * Apply the desired subscription sets.
   *
   * `funding` is normally every pair the venue lists. `book` is the Book Focus set,
   * which is much smaller and changes as attention moves. Venues whose single channel
   * carries both get their book plan satisfied by the funding subscription, so passing
   * a book set for them would open a second socket for data already arriving.
   */
  sync(funding: Map<ExchangeId, string[]>, book: Map<ExchangeId, string[]>): void {
    if (this.stopped) return;
    const exchanges = new Set<ExchangeId>([...funding.keys(), ...book.keys()]);
    for (const exchange of exchanges) {
      const adapter = ADAPTERS[exchange];
      if (!adapter) continue;
      for (const plan of adapter.endpoints()) {
        const carriesFunding = plan.carries.includes("funding");
        // A plan carrying funding is driven by the full listing; a book-only plan is
        // driven by focus. A plan carrying both is driven by funding, because the
        // wider set subsumes the narrower one.
        const coins = carriesFunding ? (funding.get(exchange) ?? []) : (book.get(exchange) ?? []);
        this.syncPlan(adapter, plan, coins, carriesFunding ? "f" : "b");
      }
      this.reportVenue(exchange);
    }
  }

  private syncPlan(
    adapter: ExchangeAdapter,
    plan: WsEndpointPlan,
    coins: string[],
    bucket: "f" | "b",
  ): void {
    const prefix = `${adapter.id}:${plan.key}:${bucket}:`;
    // A firehose is exactly one socket whose subscription does not depend on the coin
    // list, so it is grouped as "all or nothing" rather than chunked.
    const groups =
      plan.mode === "firehose"
        ? coins.length > 0
          ? [coins]
          : []
        : chunk(coins, coinsPerShard(plan));

    // Retire shards that are no longer needed after the set shrank.
    for (const [id, shard] of this.shards) {
      if (!id.startsWith(prefix)) continue;
      const index = Number(id.split(":").pop());
      if (Number.isFinite(index) && index >= groups.length) {
        this.closeShard(shard);
        this.shards.delete(id);
        this.byVenue.get(adapter.id)?.delete(id);
      }
    }

    groups.forEach((group, index) => {
      const id = `${prefix}${index}`;
      const existing = this.shards.get(id);
      const next = new Set(group);

      if (!existing) {
        const shard: Shard = {
          id,
          exchange: adapter.id,
          plan,
          coins: next,
          socket: null,
          heartbeat: null,
          reconnect: null,
          attempts: 0,
          closing: false,
          subscribed: new Set(),
          state: "idle",
          connectedAt: null,
          messages: 0,
          bytes: 0,
          lastMessageAt: null,
          reconnects: 0,
          lastError: null,
          nextRetryAt: null,
          sampleAt: Date.now(),
          sampleMessages: 0,
          sampleBytes: 0,
          msgRate: 0,
          byteRate: 0,
        };
        this.shards.set(id, shard);
        this.trackVenue(adapter.id, id);
        void this.connect(adapter, shard);
        return;
      }

      const added = [...next].filter((c) => !existing.coins.has(c));
      const removed = [...existing.coins].filter((c) => !next.has(c));
      existing.coins = next;

      // A firehose already carries every market, so a change to the coin list is not
      // a change to the subscription and must not trigger one.
      if (plan.mode === "firehose") return;
      if (added.length === 0 && removed.length === 0) return;

      const socket = existing.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (removed.length > 0) {
        this.sendAll(socket, adapter.unsubscribeMessages(plan, removed));
        for (const coin of removed) existing.subscribed.delete(coin);
      }
      if (added.length > 0) {
        this.sendAll(socket, adapter.subscribeMessages(plan, added));
        for (const coin of added) existing.subscribed.add(coin);
      }
    });
  }

  private trackVenue(exchange: ExchangeId, id: string): void {
    let set = this.byVenue.get(exchange);
    if (!set) {
      set = new Set();
      this.byVenue.set(exchange, set);
    }
    set.add(id);
  }

  private async connect(adapter: ExchangeAdapter, shard: Shard): Promise<void> {
    if (this.stopped || shard.coins.size === 0) return;
    shard.closing = false;
    shard.state = "connecting";
    shard.nextRetryAt = null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
    let target: Awaited<ReturnType<ExchangeAdapter["resolveConnection"]>>;
    try {
      target = await adapter.resolveConnection(shard.plan, controller.signal);
    } catch (err) {
      clearTimeout(timer);
      shard.lastError = errorMessage(err);
      this.store.setVenueHealth(adapter.id, "down", shard.lastError);
      this.scheduleReconnect(adapter, shard);
      return;
    } finally {
      clearTimeout(timer);
    }

    let socket: WebSocket;
    try {
      // KuCoin mints its socket URL inside a REST response, so the destination
      // is validated here rather than trusted because it came from the venue.
      socket = new WebSocket(assertAllowedUrl(target.url, `${adapter.id}/ws`));
    } catch (err) {
      shard.lastError = errorMessage(err);
      this.store.setVenueHealth(adapter.id, "down", shard.lastError);
      this.scheduleReconnect(adapter, shard);
      return;
    }
    shard.socket = socket;
    this.store.setVenueHealth(adapter.id, "connecting");

    socket.on("open", () => {
      shard.attempts = 0;
      shard.state = "open";
      shard.connectedAt = Date.now();
      shard.lastError = null;
      if (target.onOpenMessages) this.sendAll(socket, target.onOpenMessages);
      const coins = [...shard.coins];
      // A firehose subscribes with no coin list; the adapter builds its own
      // all-market frame from the plan.
      this.sendAll(socket, adapter.subscribeMessages(shard.plan, coins));
      shard.subscribed = new Set(coins);
      if (target.heartbeat) {
        shard.heartbeat = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          this.send(socket, target.heartbeat!.message);
        }, target.heartbeat.intervalMs);
      }
      this.reportVenue(adapter.id);
    });

    socket.on("message", (data) => {
      const raw = data.toString();
      shard.messages += 1;
      shard.bytes += raw.length;
      shard.lastMessageAt = Date.now();
      this.sampleRate(shard);
      // Adapters must not throw on malformed frames, but guard anyway so one
      // bad payload cannot take down a venue's socket.
      try {
        const updates = adapter.parseMessage(raw, shard.plan);
        if (updates.length > 0) this.store.applyUpdates(updates);
      } catch (err) {
        shard.lastError = errorMessage(err);
        this.store.setVenueHealth(adapter.id, "degraded", shard.lastError);
      }
    });

    socket.on("error", (err) => {
      shard.lastError = errorMessage(err);
      this.store.setVenueHealth(adapter.id, "degraded", shard.lastError);
    });

    socket.on("close", () => {
      this.clearTimers(shard);
      shard.socket = null;
      shard.subscribed.clear();
      shard.connectedAt = null;
      shard.state = shard.closing ? "closed" : "backoff";
      this.reportVenue(adapter.id);
      if (!shard.closing) {
        this.store.setVenueHealth(adapter.id, "down");
        this.scheduleReconnect(adapter, shard);
      }
    });
  }

  /** Refreshes the smoothed rates, at most once per window. */
  private sampleRate(shard: Shard): void {
    const now = Date.now();
    const elapsed = now - shard.sampleAt;
    if (elapsed < RATE_WINDOW_MS) return;
    const perSec = 1000 / elapsed;
    shard.msgRate = (shard.messages - shard.sampleMessages) * perSec;
    shard.byteRate = (shard.bytes - shard.sampleBytes) * perSec;
    shard.sampleAt = now;
    shard.sampleMessages = shard.messages;
    shard.sampleBytes = shard.bytes;
  }

  /**
   * Drops a firehose socket that has gone quiet.
   *
   * Its `readyState` is OPEN and no error was ever raised, so nothing else in the
   * stack has any reason to doubt it — the venue simply stopped sending. Without this
   * check the venue's whole market would sit frozen behind a socket that looks healthy.
   */
  private checkFirehoseSilence(): void {
    if (this.stopped) return;
    const now = Date.now();
    for (const shard of this.shards.values()) {
      if (shard.plan.mode !== "firehose") continue;
      if (shard.state !== "open" || !shard.socket) continue;
      const since = shard.lastMessageAt ?? shard.connectedAt;
      if (since === null || now - since <= FIREHOSE_SILENCE_MS) continue;
      shard.lastError = `no frames for ${Math.round((now - since) / 1000)}s; reconnecting`;
      this.store.setVenueHealth(shard.exchange, "degraded", shard.lastError);
      this.redial(shard);
    }
  }

  /** Closes and immediately reopens one shard. Used by silence detection and the UI. */
  private redial(shard: Shard): void {
    const adapter = ADAPTERS[shard.exchange];
    if (!adapter) return;
    this.closeShard(shard);
    shard.closing = false;
    shard.reconnects += 1;
    shard.attempts = 0;
    void this.connect(adapter, shard);
  }

  /** Manual reconnect from the Stream Fabric console. */
  reconnectShard(id: string): boolean {
    const shard = this.shards.get(id);
    if (!shard || this.stopped) return false;
    shard.lastError = "manual reconnect";
    this.redial(shard);
    return true;
  }

  private scheduleReconnect(adapter: ExchangeAdapter, shard: Shard): void {
    if (this.stopped || shard.closing) return;
    if (shard.reconnect) clearTimeout(shard.reconnect);
    shard.attempts += 1;
    shard.reconnects += 1;
    shard.state = "backoff";
    const delay = backoffDelay(shard.attempts);
    shard.nextRetryAt = Date.now() + delay;
    shard.reconnect = setTimeout(() => {
      shard.reconnect = null;
      shard.nextRetryAt = null;
      void this.connect(adapter, shard);
    }, delay);
  }

  private reportVenue(exchange: ExchangeId): void {
    let connections = 0;
    const coins = new Set<string>();
    for (const id of this.byVenue.get(exchange) ?? []) {
      const shard = this.shards.get(id);
      if (!shard) continue;
      if (shard.socket?.readyState === WebSocket.OPEN) connections += 1;
      for (const coin of shard.coins) coins.add(coin);
    }
    this.store.setVenueConnections(exchange, connections, coins.size);
  }

  /** Per-shard state for the console. */
  telemetry(): ShardTelemetry[] {
    const out: ShardTelemetry[] = [];
    for (const shard of this.shards.values()) {
      const perCoin = shard.plan.topicsPerCoin ?? 1;
      out.push({
        id: shard.id,
        exchange: shard.exchange,
        plan: shard.plan.key,
        mode: shard.plan.mode,
        carries: shard.plan.carries,
        state: shard.state,
        coins: shard.plan.mode === "firehose" ? 0 : shard.coins.size,
        topics: shard.plan.mode === "firehose" ? 1 : shard.coins.size * perCoin,
        connectedAt: shard.connectedAt,
        messages: shard.messages,
        bytes: shard.bytes,
        msgRate: Math.round(shard.msgRate * 10) / 10,
        byteRate: Math.round(shard.byteRate),
        lastMessageAt: shard.lastMessageAt,
        reconnects: shard.reconnects,
        lastError: shard.lastError,
        nextRetryAt: shard.nextRetryAt,
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Sockets a venue's plans call for, given its current subscription sets. */
  expectedSockets(exchange: ExchangeId): number {
    let expected = 0;
    for (const id of this.byVenue.get(exchange) ?? []) {
      if (this.shards.has(id)) expected += 1;
    }
    return expected;
  }

  private sendAll(socket: WebSocket, messages: unknown[]): void {
    for (const message of messages) this.send(socket, message);
  }

  private send(socket: WebSocket, message: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(typeof message === "string" ? message : JSON.stringify(message));
    } catch {
      // A failed send means the socket is going away; the close handler will
      // schedule the reconnect.
    }
  }

  private clearTimers(shard: Shard): void {
    if (shard.heartbeat) {
      clearInterval(shard.heartbeat);
      shard.heartbeat = null;
    }
    if (shard.reconnect) {
      clearTimeout(shard.reconnect);
      shard.reconnect = null;
    }
    shard.nextRetryAt = null;
  }

  private closeShard(shard: Shard): void {
    shard.closing = true;
    this.clearTimers(shard);
    const socket = shard.socket;
    shard.socket = null;
    shard.connectedAt = null;
    shard.state = "closed";
    if (socket) {
      try {
        socket.removeAllListeners();
        socket.close();
      } catch {
        // Already closed.
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
    for (const shard of this.shards.values()) this.closeShard(shard);
    this.shards.clear();
    this.byVenue.clear();
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
