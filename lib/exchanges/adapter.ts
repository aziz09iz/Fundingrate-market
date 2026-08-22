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
 * A websocket endpoint plus what it carries.
 *
 * `mode` is the important field. A `firehose` plan is one channel that delivers the
 * venue's whole market on a single socket: it is never sharded, and its
 * `subscribeMessages` is called once with an empty coin list, returning whatever
 * all-market frame the venue wants. A `topics` plan is subscribed per coin and
 * sharded at `maxTopicsPerConnection`.
 *
 * Mixing the two under one shape matters because the alternative is a per-venue
 * special case in the manager, and the manager is where a mistake means either a
 * silent socket or a subscription the venue rejects wholesale.
 */
export interface WsEndpointPlan {
  /** Stable key so the manager can track connections across resubscribes. */
  key: string;
  carries: ("funding" | "book")[];
  mode: "firehose" | "topics";
  /**
   * Max coins one socket should hold before the manager shards. Ignored for a
   * firehose plan, which is always exactly one socket.
   */
  maxTopicsPerConnection: number;
  /**
   * Topics each coin costs, when it is more than one. Aster needs two streams per
   * coin; a venue that caps *topics* rather than symbols needs this to shard
   * correctly.
   */
  topicsPerCoin?: number;
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
   * Where this venue's funding rates come from.
   *
   * `stream` is the default and the better answer when a venue offers it. `rest` means
   * the venue only publishes funding on a channel whose volume is dominated by
   * something else — Bitget bundles funding into a per-symbol ticker that pushes ~2,800
   * frames and 1.5 MB per second across its whole market, and sockets carrying that
   * much are dropped by the venue within the minute. One REST call returning every
   * symbol's rate is both more stable and two orders of magnitude cheaper, and funding
   * moves slowly enough that polling it loses nothing.
   *
   * A `rest` venue still subscribes its book channel, but only for the pairs Book Focus
   * asks for.
   */
  fundingSource?: "stream" | "rest";

  /**
   * Every perpetual this venue lists, by coin symbol.
   *
   * The whole listing, not a selection: the subscription set is now "everything the
   * venue trades", so this is a discovery call rather than a ranking one. It is
   * polled slowly — a listing set changes on the scale of days, not seconds — and
   * its result is the input to sharding.
   */
  fetchInstruments(signal: AbortSignal): Promise<string[]>;

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

/**
 * Coins one socket should hold for a plan, honouring a per-coin topic cost.
 *
 * Kept here rather than in the manager because the arithmetic belongs with the shape
 * that describes it: a venue capping topics rather than symbols is a property of the
 * plan, and the manager should not have to know which venues those are.
 */
export function coinsPerShard(plan: WsEndpointPlan): number {
  const perCoin = plan.topicsPerCoin ?? 1;
  return Math.max(1, Math.floor(plan.maxTopicsPerConnection / perCoin));
}
