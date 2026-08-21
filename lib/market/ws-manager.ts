import WebSocket from "ws";
import type { ExchangeId } from "@/lib/types";
import type { ExchangeAdapter, WsEndpointPlan } from "@/lib/exchanges/adapter";
import { ADAPTERS } from "@/lib/exchanges";
import { assertAllowedUrl } from "@/lib/private/hosts";
import { backoffDelay } from "@/lib/market/backoff";
import type { MarketStore } from "@/lib/market/store";

const RESOLVE_TIMEOUT_MS = 15_000;

interface Shard {
  /** Stable id so reconnects reuse the same coin set. */
  id: string;
  plan: WsEndpointPlan;
  coins: Set<string>;
  socket: WebSocket | null;
  heartbeat: NodeJS.Timeout | null;
  reconnect: NodeJS.Timeout | null;
  attempts: number;
  closing: boolean;
  /** Coins already sent in a subscribe frame on the current socket. */
  subscribed: Set<string>;
}

/**
 * Owns every venue websocket. Connections live as long as the server process;
 * layer changes are applied as subscribe/unsubscribe diffs rather than
 * reconnects, except for venues that encode topics in the URL.
 */
export class WsManager {
  private readonly shards = new Map<string, Shard>();
  private stopped = false;

  constructor(private readonly store: MarketStore) {}

  /**
   * Apply a new desired subscription set for every venue.
   *
   * `pinned` lists the coins that are streamed because a position is open in
   * them. For most venues this makes no difference — subscriptions are diffed on
   * a live socket. It matters for venues that encode topics in the URL (Binance):
   * there, any change to the set forces a reconnect, so every ranking refresh
   * would drop the socket carrying the quotes for open positions. Those coins get
   * their own shard, which only changes when the positions do.
   */
  sync(desired: Map<ExchangeId, string[]>, pinned: Map<ExchangeId, string[]> = new Map()): void {
    if (this.stopped) return;
    for (const [exchange, coins] of desired) {
      const adapter = ADAPTERS[exchange];
      if (!adapter) continue;
      const pinnedCoins = adapter.urlCarriesTopics ? new Set(pinned.get(exchange) ?? []) : new Set<string>();
      const rankCoins = coins.filter((c) => !pinnedCoins.has(c));
      for (const plan of adapter.endpoints()) {
        this.syncPlan(adapter, plan, rankCoins, "r");
        // Called unconditionally, including with an empty set. The loop that
        // retires stale shards lives inside syncPlan and only inspects ids under
        // its own bucket prefix, so skipping the call when nothing is pinned meant
        // the pinned shard was never visited after the last position closed — its
        // socket stayed open on a stale coin set for the life of the process, and
        // reportVenue kept counting it as live. With an empty set the shard is
        // retired correctly by the code already there.
        this.syncPlan(adapter, plan, [...pinnedCoins], "p");
      }
      this.reportVenue(exchange);
    }
  }

  private syncPlan(
    adapter: ExchangeAdapter,
    plan: WsEndpointPlan,
    coins: string[],
    bucket: "r" | "p",
  ): void {
    const groups = chunk(coins, plan.maxTopicsPerConnection);
    const prefix = `${adapter.id}:${plan.key}:${bucket}:`;
    // Retire shards that are no longer needed after the set shrank.
    for (const [id, shard] of this.shards) {
      if (!id.startsWith(prefix)) continue;
      const index = Number(id.split(":").pop());
      if (Number.isFinite(index) && index >= groups.length) {
        this.closeShard(shard);
        this.shards.delete(id);
      }
    }

    groups.forEach((group, index) => {
      const id = `${prefix}${index}`;
      const existing = this.shards.get(id);
      const next = new Set(group);

      if (!existing) {
        const shard: Shard = {
          id,
          plan,
          coins: next,
          socket: null,
          heartbeat: null,
          reconnect: null,
          attempts: 0,
          closing: false,
          subscribed: new Set(),
        };
        this.shards.set(id, shard);
        void this.connect(adapter, shard);
        return;
      }

      const added = [...next].filter((c) => !existing.coins.has(c));
      const removed = [...existing.coins].filter((c) => !next.has(c));
      existing.coins = next;

      if (added.length === 0 && removed.length === 0) return;

      if (adapter.urlCarriesTopics) {
        // Binance builds its stream list into the URL, so the set can only
        // change by reconnecting.
        this.closeShard(existing);
        existing.subscribed.clear();
        void this.connect(adapter, existing);
        return;
      }

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

  private async connect(adapter: ExchangeAdapter, shard: Shard): Promise<void> {
    if (this.stopped || shard.coins.size === 0) return;
    shard.closing = false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
    let url: string;
    let target: Awaited<ReturnType<ExchangeAdapter["resolveConnection"]>>;
    try {
      target = await adapter.resolveConnection(shard.plan, controller.signal);
      url = adapter.urlCarriesTopics && adapter.buildTopicUrl
        ? adapter.buildTopicUrl(shard.plan, [...shard.coins])
        : target.url;
    } catch (err) {
      clearTimeout(timer);
      this.store.setVenueHealth(adapter.id, "down", errorMessage(err));
      this.scheduleReconnect(adapter, shard);
      return;
    } finally {
      clearTimeout(timer);
    }

    let socket: WebSocket;
    try {
      // KuCoin mints its socket URL inside a REST response, so the destination
      // is validated here rather than trusted because it came from the venue.
      socket = new WebSocket(assertAllowedUrl(url, `${adapter.id}/ws`));
    } catch (err) {
      this.store.setVenueHealth(adapter.id, "down", errorMessage(err));
      this.scheduleReconnect(adapter, shard);
      return;
    }
    shard.socket = socket;
    this.store.setVenueHealth(adapter.id, "connecting");

    socket.on("open", () => {
      shard.attempts = 0;
      if (target.onOpenMessages) this.sendAll(socket, target.onOpenMessages);
      const coins = [...shard.coins];
      if (!adapter.urlCarriesTopics && coins.length > 0) {
        this.sendAll(socket, adapter.subscribeMessages(shard.plan, coins));
      }
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
      // Adapters must not throw on malformed frames, but guard anyway so one
      // bad payload cannot take down a venue's socket.
      try {
        const updates = adapter.parseMessage(data.toString(), shard.plan);
        if (updates.length > 0) this.store.applyUpdates(updates);
      } catch (err) {
        this.store.setVenueHealth(adapter.id, "degraded", errorMessage(err));
      }
    });

    socket.on("error", (err) => {
      this.store.setVenueHealth(adapter.id, "degraded", errorMessage(err));
    });

    socket.on("close", () => {
      this.clearTimers(shard);
      shard.socket = null;
      shard.subscribed.clear();
      this.reportVenue(adapter.id);
      if (!shard.closing) {
        this.store.setVenueHealth(adapter.id, "down");
        this.scheduleReconnect(adapter, shard);
      }
    });
  }

  private scheduleReconnect(adapter: ExchangeAdapter, shard: Shard): void {
    if (this.stopped || shard.closing) return;
    if (shard.reconnect) clearTimeout(shard.reconnect);
    shard.attempts += 1;
    shard.reconnect = setTimeout(
      () => {
        shard.reconnect = null;
        void this.connect(adapter, shard);
      },
      backoffDelay(shard.attempts),
    );
  }

  private reportVenue(exchange: ExchangeId): void {
    let connections = 0;
    const coins = new Set<string>();
    for (const [id, shard] of this.shards) {
      if (!id.startsWith(`${exchange}:`)) continue;
      if (shard.socket?.readyState === WebSocket.OPEN) connections += 1;
      for (const coin of shard.coins) coins.add(coin);
    }
    this.store.setVenueConnections(exchange, connections, coins.size);
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
  }

  private closeShard(shard: Shard): void {
    shard.closing = true;
    this.clearTimers(shard);
    const socket = shard.socket;
    shard.socket = null;
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
    for (const shard of this.shards.values()) this.closeShard(shard);
    this.shards.clear();
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
