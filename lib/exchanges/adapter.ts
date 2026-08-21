import type { ExchangeId } from "@/lib/types";
import { assertAllowedUrl } from "@/lib/private/hosts";

/**
 * One venue's funding rate for one coin, as observed on the stream.
 * Rates are percentages (0.0123 means 0.0123%), matching FundingRateValue.
 */
export interface FundingUpdate {
  kind: "funding";
  exchange: ExchangeId;
  coin: string;
  ratePct: number;
  /** Epoch ms of the next settlement, when the venue reports it. */
  nextFundingTime: number | null;
  /**
   * Cadence in hours when the venue states it outright. Left null when it must
   * be inferred from observed settlement timestamps instead.
   */
  intervalHours: number | null;
  ts: number;
  /** True when this value came from a REST fallback rather than the stream. */
  fromRest?: boolean;
}

/** Best bid/ask for one coin on one venue. */
export interface BookUpdate {
  kind: "book";
  exchange: ExchangeId;
  coin: string;
  bid: number | null;
  ask: number | null;
  ts: number;
}

export type StreamUpdate = FundingUpdate | BookUpdate;

/** A candidate pair from the REST ranking pass. */
export interface RankedPair {
  coin: string;
  /** Absolute funding rate percentage, used only to order candidates. */
  absRatePct: number;
}

/** Funding for one coin as reported by REST, used only as a stream fallback. */
export interface FundingSnapshotRow {
  coin: string;
  ratePct: number;
  nextFundingTime: number | null;
  intervalHours: number | null;
}

/**
 * Authoritative funding cadence per coin, read from a venue's contract
 * metadata. This matters for correctness, not cosmetics: Diff FR divides by the
 * interval, so a wrong cadence silently scales a venue's rate.
 */
export interface IntervalRow {
  coin: string;
  intervalHours: number;
  /**
   * Next settlement, when the venue publishes it here. KuCoin's funding stream
   * omits the settlement clock entirely, so its metadata is the only source —
   * without this the dashboard has no countdown for that venue.
   */
  nextFundingTime?: number | null;
}

/**
 * A websocket endpoint plus the topics it carries. Venues that bundle funding
 * and book data in one channel report `carries: ["funding", "book"]`.
 */
export interface WsEndpointPlan {
  /** Stable key so the manager can track connections across resubscribes. */
  key: string;
  carries: ("funding" | "book")[];
  /** Max topics one socket should hold before the manager shards. */
  maxTopicsPerConnection: number;
}

export interface WsConnectionTarget {
  url: string;
  /** Sent immediately after open, before any subscribe. */
  onOpenMessages?: unknown[];
  heartbeat?: {
    intervalMs: number;
    /** String payloads are sent raw; objects are JSON-encoded. */
    message: unknown;
  };
}

export interface ExchangeAdapter {
  id: ExchangeId;
  /** Venue default cadence, used until the stream confirms the real one. */
  defaultIntervalHours: number;

  /**
   * REST pass used only to pick which pairs to watch. Its funding numbers rank
   * candidates and are never displayed — the UI shows stream values only.
   */
  fetchRanking(signal: AbortSignal): Promise<RankedPair[]>;

  /**
   * Optional REST funding snapshot, used only when this venue's funding stream
   * is unreachable from the current network. Values sourced this way are marked
   * so the UI can say the number came from REST rather than the stream.
   */
  fetchFundingSnapshot?(signal: AbortSignal, coins: string[]): Promise<FundingSnapshotRow[]>;

  /**
   * Optional per-coin funding cadence from contract metadata. Implement this
   * whenever the venue publishes it, because most pairs are not on the venue's
   * headline interval — several venues have more 4h contracts than 8h ones.
   */
  fetchIntervals?(signal: AbortSignal): Promise<IntervalRow[]>;

  /** Endpoint plans this venue needs; usually one or two. */
  endpoints(): WsEndpointPlan[];

  /** Resolves the URL for a plan. KuCoin fetches a bullet token here. */
  resolveConnection(plan: WsEndpointPlan, signal: AbortSignal): Promise<WsConnectionTarget>;

  /** Some venues encode the subscription set into the URL (Binance). */
  urlCarriesTopics?: boolean;

  /** Build the URL when topics live in the query string. */
  buildTopicUrl?(plan: WsEndpointPlan, coins: string[]): string;

  subscribeMessages(plan: WsEndpointPlan, coins: string[]): unknown[];
  unsubscribeMessages(plan: WsEndpointPlan, coins: string[]): unknown[];

  /** Parse one raw frame into zero or more updates. Must never throw. */
  parseMessage(raw: string, plan: WsEndpointPlan): StreamUpdate[];
}

// ─── Symbol helpers ─────────────────────────────────────────────────────────

/** Quote assets we accept; anything else is not a USDT-margined perp. */
const QUOTES = ["USDT"];

/**
 * KuCoin uses XBT for Bitcoin on futures. Keep this table tiny and explicit —
 * silent symbol guessing across venues causes mispriced pairs.
 */
const VENUE_ALIASES: Partial<Record<ExchangeId, Record<string, string>>> = {
  kucoin: { BTC: "XBT" },
};

export function toVenueBase(exchange: ExchangeId, coin: string): string {
  return VENUE_ALIASES[exchange]?.[coin] ?? coin;
}

export function fromVenueBase(exchange: ExchangeId, base: string): string {
  const aliases = VENUE_ALIASES[exchange];
  if (aliases) {
    for (const [canonical, venue] of Object.entries(aliases)) {
      if (venue === base) return canonical;
    }
  }
  return base;
}

/** "BTCUSDT" -> "BTC"; returns null for non-USDT or leveraged oddities. */
export function baseFromConcatSymbol(symbol: string): string | null {
  const upper = symbol.toUpperCase();
  for (const quote of QUOTES) {
    if (!upper.endsWith(quote)) continue;
    const base = upper.slice(0, -quote.length);
    if (!base || /\d[LS]$/.test(base)) return null;
    return base;
  }
  return null;
}

/** Parse a percentage from a venue's decimal rate string ("0.0001" -> 0.01). */
export function decimalRateToPct(value: string | number | null | undefined): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return n * 100;
}

export function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

/** Fetch JSON with a timeout, throwing a message that names the venue. */
export async function fetchJson<T>(
  label: string,
  url: string,
  signal: AbortSignal,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(assertAllowedUrl(url, label), {
    ...init,
    signal,
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    throw new Error(`${label}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Rank by absolute funding rate, largest first, and cap the list. */
export function rankByAbsRate(
  pairs: { coin: string; ratePct: number | null }[],
): RankedPair[] {
  return pairs
    .filter((p): p is { coin: string; ratePct: number } => p.ratePct !== null)
    .map((p) => ({ coin: p.coin, absRatePct: Math.abs(p.ratePct) }))
    .sort((a, b) => b.absRatePct - a.absRatePct);
}
