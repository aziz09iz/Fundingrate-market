"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarketView, MarketViewQuery } from "@/lib/types";

export type StreamStatus = "connecting" | "live" | "reconnecting" | "offline";

interface UseMarketViewOptions {
  /**
   * Called for every frame as it arrives. Runs inside the EventSource listener,
   * which is the right place to react to an external system rather than mirroring
   * the frame into another effect.
   */
  onView?: (view: MarketView) => void;
}

interface MarketViewState {
  view: MarketView | null;
  status: StreamStatus;
  /** Epoch ms of the last frame received. */
  lastUpdate: number | null;
  refresh: () => void;
}

/**
 * How long a query change is allowed to settle before reconnecting.
 *
 * Typing in the search box changes the query on every keystroke, and each change is a
 * new server-side view — without this, a five-letter symbol would open and tear down
 * five SSE connections and five Book Focus leases.
 */
const QUERY_DEBOUNCE_MS = 400;

/**
 * Subscribes to one page of the market over SSE.
 *
 * The exchange websockets live on the server, so this is one lightweight connection
 * regardless of how many venues or pairs are being watched. The query travels in the
 * URL, which also means the connection identifies which rows this client is looking at
 * — that is what keeps their order books subscribed.
 */
export function useMarketView(
  query: MarketViewQuery,
  options: UseMarketViewOptions = {},
): MarketViewState {
  const [view, setView] = useState<MarketView | null>(null);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const everConnected = useRef(false);
  // Held in a ref so changing the handler does not tear down the connection.
  const onViewRef = useRef(options.onView);
  useEffect(() => {
    onViewRef.current = options.onView;
  }, [options.onView]);

  // One id per mounted hook, so two tabs hold independent leases and closing one does
  // not release the other's quotes. Minted inside the effect rather than during render:
  // a random id computed while rendering is an impure value that could change on a
  // re-render, which would silently orphan the previous lease.
  const viewerRef = useRef<string | null>(null);

  const params = useMemo(() => queryParams(query), [query]);
  const [debouncedParams, setDebouncedParams] = useState(params);

  useEffect(() => {
    if (debouncedParams === params) return;
    const t = setTimeout(() => setDebouncedParams(params), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [params, debouncedParams]);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    if (viewerRef.current === null) {
      viewerRef.current = `v${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36).slice(-4)}`;
    }
    const url = `/api/market/stream?viewer=${viewerRef.current}&${debouncedParams}`;

    const connect = () => {
      if (cancelled) return;
      source = new EventSource(url);

      source.addEventListener("open", () => {
        everConnected.current = true;
        setStatus("live");
      });

      source.addEventListener("view", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as MarketView;
          setView(data);
          setLastUpdate(Date.now());
          setStatus("live");
          onViewRef.current?.(data);
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
  }, [debouncedParams, reconnectKey]);

  const refresh = useCallback(() => {
    setStatus("connecting");
    setReconnectKey((k) => k + 1);
  }, []);

  return { view, status, lastUpdate, refresh };
}

function queryParams(query: MarketViewQuery): string {
  const params = new URLSearchParams({
    scope: query.scope,
    sort: query.sort,
    dir: query.dir,
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.venues && query.venues.length > 0) params.set("venues", query.venues.join(","));
  if (query.search) params.set("q", query.search);
  if (query.pin && query.pin.length > 0) params.set("pin", query.pin.join(","));
  return params.toString();
}
