import WebSocket from "ws";
import type { ExchangeId, PrivateStreamHealth, PrivateVenueStatus } from "@/lib/types";
import type { PrivateAdapter, PrivateUpdate } from "@/lib/private/adapter";
import { PRIVATE_ADAPTERS } from "@/lib/private";
import { assertAllowedUrl } from "@/lib/private/hosts";
import { getCredentials, type Credentials } from "@/lib/db/credentials";
import { backoffDelay } from "@/lib/market/backoff";
import {
  applyLiveOrderUpdate,
  insertLiveTrade,
  replaceLivePositions,
  upsertLiveBalance,
  upsertLivePosition,
} from "@/lib/db/live";
import { EXCHANGE_IDS } from "@/lib/utils";

/**
 * Private websocket manager.
 *
 * Mirrors the public WsManager's shape — one socket per venue, jittered
 * exponential backoff shared with it, health pushed to state rather than thrown —
 * but every connection is authenticated, so failures are reported without ever
 * echoing credentials.
 */

const RESOLVE_TIMEOUT_MS = 15_000;

interface VenueConnection {
  exchange: ExchangeId;
  socket: WebSocket | null;
  heartbeat: NodeJS.Timeout | null;
  keepAlive: NodeJS.Timeout | null;
  reconnect: NodeJS.Timeout | null;
  attempts: number;
  closing: boolean;
  health: PrivateStreamHealth;
  lastMessageAt: number | null;
  lastError: string | null;
}

export class PrivateWsManager {
  private readonly connections = new Map<ExchangeId, VenueConnection>();
  private stopped = false;

  /** Opens streams for credentialed venues and closes the rest. */
  sync(): void {
    if (this.stopped) return;
    for (const exchange of EXCHANGE_IDS) {
      const adapter = PRIVATE_ADAPTERS[exchange];
      const creds = getCredentials(exchange);
      const supported = typeof adapter?.resolveWs === "function";
      const existing = this.connections.get(exchange);

      if (!creds || !supported) {
        if (existing) {
          this.close(existing);
          this.connections.delete(exchange);
        }
        continue;
      }
      if (existing) continue;

      const connection: VenueConnection = {
        exchange,
        socket: null,
        heartbeat: null,
        keepAlive: null,
        reconnect: null,
        attempts: 0,
        closing: false,
        health: "connecting",
        lastMessageAt: null,
        lastError: null,
      };
      this.connections.set(exchange, connection);
      void this.connect(adapter, creds, connection);
    }
  }

  private async connect(
    adapter: PrivateAdapter,
    creds: Credentials,
    connection: VenueConnection,
  ): Promise<void> {
    if (this.stopped || connection.closing || !adapter.resolveWs) return;
    connection.health = "connecting";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
    let target: Awaited<ReturnType<NonNullable<PrivateAdapter["resolveWs"]>>>;
    try {
      target = await adapter.resolveWs(creds, controller.signal);
    } catch (err) {
      clearTimeout(timer);
      connection.health = "down";
      connection.lastError = message(err);
      this.scheduleReconnect(adapter, creds, connection);
      return;
    } finally {
      clearTimeout(timer);
    }

    let socket: WebSocket;
    try {
      // KuCoin returns its private socket URL in a REST body, so validate the
      // destination instead of trusting the response.
      socket = new WebSocket(assertAllowedUrl(target.url, `${adapter.id}/private-ws`));
    } catch (err) {
      connection.health = "down";
      connection.lastError = message(err);
      this.scheduleReconnect(adapter, creds, connection);
      return;
    }
    connection.socket = socket;

    socket.on("open", () => {
      connection.attempts = 0;
      connection.health = "ok";
      connection.lastError = null;
      for (const frame of target.onOpenMessages ?? []) this.send(socket, frame);

      if (target.heartbeat) {
        connection.heartbeat = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          this.send(socket, target.heartbeat!.message);
        }, target.heartbeat.intervalMs);
      }
      // Binance drops the stream unless its listenKey is refreshed.
      if (target.keepAlive) {
        connection.keepAlive = setInterval(() => {
          void target.keepAlive!.run().catch((err) => {
            connection.lastError = message(err);
            if (connection.health === "ok") connection.health = "degraded";
          });
        }, target.keepAlive.intervalMs);
      }

      // Seed from REST so the UI is populated before the first event arrives.
      void this.primeFromRest(adapter, creds, connection);
    });

    socket.on("message", (data) => {
      connection.lastMessageAt = Date.now();
      if (connection.health !== "ok") connection.health = "ok";
      if (!adapter.parseWsMessage) return;
      try {
        const updates = adapter.parseWsMessage(data.toString());
        if (updates.length > 0) this.apply(adapter.id, updates);
      } catch (err) {
        // A single malformed frame must not take down the venue.
        connection.health = "degraded";
        connection.lastError = message(err);
      }
    });

    socket.on("error", (err) => {
      connection.health = "degraded";
      connection.lastError = message(err);
    });

    socket.on("close", () => {
      this.clearTimers(connection);
      connection.socket = null;
      if (!connection.closing) {
        connection.health = "down";
        this.scheduleReconnect(adapter, creds, connection);
      }
    });
  }

  /** One authenticated REST pass so the local mirror starts complete. */
  private async primeFromRest(
    adapter: PrivateAdapter,
    creds: Credentials,
    connection: VenueConnection,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
    try {
      const [positions, balances, orders] = await Promise.all([
        adapter.fetchPositions(creds, controller.signal),
        adapter.fetchBalances(creds, controller.signal),
        adapter.fetchOpenOrders(creds, controller.signal),
      ]);
      replaceLivePositions(adapter.id, positions);
      for (const balance of balances) {
        upsertLiveBalance({ exchange: adapter.id, ...balance });
      }
      for (const order of orders) {
        applyLiveOrderUpdate({ exchange: adapter.id, ...order });
      }
    } catch (err) {
      connection.lastError = message(err);
      if (connection.health === "ok") connection.health = "degraded";
    } finally {
      clearTimeout(timer);
    }
  }

  private apply(exchange: ExchangeId, updates: PrivateUpdate[]): void {
    for (const update of updates) {
      switch (update.kind) {
        case "positions":
          replaceLivePositions(exchange, update.positions);
          break;
        case "position":
          upsertLivePosition({ exchange, ...update.position });
          break;
        case "order":
          applyLiveOrderUpdate({ exchange, ...update.order });
          break;
        case "fill":
          insertLiveTrade({ exchange, ...update.fill });
          break;
        case "balance":
          for (const balance of update.balances) {
            upsertLiveBalance({ exchange, ...balance });
          }
          break;
      }
    }
  }

  private scheduleReconnect(
    adapter: PrivateAdapter,
    creds: Credentials,
    connection: VenueConnection,
  ): void {
    if (this.stopped || connection.closing) return;
    if (connection.reconnect) clearTimeout(connection.reconnect);
    connection.attempts += 1;
    connection.reconnect = setTimeout(
      () => {
        connection.reconnect = null;
        // Re-read credentials in case they were rotated while disconnected.
        const fresh = getCredentials(connection.exchange) ?? creds;
        void this.connect(adapter, fresh, connection);
      },
      backoffDelay(connection.attempts),
    );
  }

  private send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
    } catch {
      // The close handler will schedule a reconnect.
    }
  }

  private clearTimers(connection: VenueConnection): void {
    if (connection.heartbeat) clearInterval(connection.heartbeat);
    if (connection.keepAlive) clearInterval(connection.keepAlive);
    if (connection.reconnect) clearTimeout(connection.reconnect);
    connection.heartbeat = null;
    connection.keepAlive = null;
    connection.reconnect = null;
  }

  private close(connection: VenueConnection): void {
    connection.closing = true;
    this.clearTimers(connection);
    const socket = connection.socket;
    connection.socket = null;
    if (socket) {
      try {
        socket.removeAllListeners();
        socket.close();
      } catch {
        // Already gone.
      }
    }
  }

  statuses(): PrivateVenueStatus[] {
    const now = Date.now();
    return EXCHANGE_IDS.map((exchange) => {
      const connection = this.connections.get(exchange);
      if (!connection) {
        return {
          exchange,
          // No credentials, or the venue has no private stream implemented.
          health: "disabled" as PrivateStreamHealth,
          lastMessageAt: null,
          lastError: null,
        };
      }
      let health = connection.health;
      // A quiet private stream is normal, but a very long silence is suspicious.
      if (
        health === "ok" &&
        connection.lastMessageAt !== null &&
        now - connection.lastMessageAt > 300_000
      ) {
        health = "degraded";
      }
      return {
        exchange,
        health,
        lastMessageAt: connection.lastMessageAt,
        lastError: connection.lastError,
      };
    });
  }

  stop(): void {
    this.stopped = true;
    for (const connection of this.connections.values()) this.close(connection);
    this.connections.clear();
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
