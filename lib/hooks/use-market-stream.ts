"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketSnapshot } from "@/lib/types";

export type StreamStatus = "connecting" | "live" | "reconnecting" | "offline";

interface UseMarketStreamOptions {
  /**
   * Called for every snapshot as it arrives from the server. Runs inside the
   * EventSource listener, which is the right place to react to an external
   * system rather than mirroring the snapshot into another effect.
   */
  onSnapshot?: (snapshot: MarketSnapshot) => void;
}

interface MarketStreamState {
  snapshot: MarketSnapshot | null;
  status: StreamStatus;
  /** Epoch ms of the last snapshot received. */
  lastUpdate: number | null;
  refresh: () => void;
}

/**
 * Subscribes to the server's market SSE stream. The exchange websockets live on
 * the server, so this is one lightweight connection regardless of how many
 * venues are being watched.
 */
export function useMarketStream(options: UseMarketStreamOptions = {}): MarketStreamState {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const everConnected = useRef(false);
  // Held in a ref so changing the handler does not tear down the connection.
  const onSnapshotRef = useRef(options.onSnapshot);
  useEffect(() => {
    onSnapshotRef.current = options.onSnapshot;
  }, [options.onSnapshot]);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      source = new EventSource("/api/market/stream");

      source.addEventListener("open", () => {
        everConnected.current = true;
        setStatus("live");
      });

      source.addEventListener("snapshot", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as MarketSnapshot;
          setSnapshot(data);
          setLastUpdate(Date.now());
          setStatus("live");
          onSnapshotRef.current?.(data);
        } catch {
          // A malformed frame is not fatal; the next one replaces it.
        }
      });

      source.addEventListener("error", () => {
        source?.close();
        source = null;
        setStatus(everConnected.current ? "reconnecting" : "offline");
        // EventSource retries on its own, but reconnecting explicitly keeps the
        // backoff predictable and the status honest.
        retry = setTimeout(connect, 3_000);
      });
    };

    connect();

    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [reconnectKey]);

  const refresh = useCallback(() => {
    setStatus("connecting");
    setReconnectKey((k) => k + 1);
  }, []);

  return { snapshot, status, lastUpdate, refresh };
}
