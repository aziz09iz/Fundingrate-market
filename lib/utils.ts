import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { ExchangeId, ExchangeInfo, PairScope, VenueType } from "@/lib/types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Funding rates are stored as a percentage (0.0123 means 0.0123%).
 * Render them with an explicit sign and a fixed precision so the table lines up
 * and the direction survives even where the colour does not.
 */
export function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  if (rate === 0) return "0.0000%";
  return formatSignedPct(rate, 4);
}

/**
 * Sign glyph for a signed number, so direction survives without colour. Uses a
 * real minus (U+2212) for negatives: at mono sizes a hyphen is easy to miss, and
 * the two are the same width in a tabular face.
 */
export function signGlyph(value: number | null): string {
  if (value === null || value === 0) return "";
  return value > 0 ? "+" : "\u2212";
}

/**
 * A signed percentage with an explicit sign and the magnitude unsigned, e.g.
 * "+0.0125%" / "−0.0125%". Pair with `signClass` for colour; the glyph is what
 * carries the meaning when colour is unavailable.
 */
export function formatSignedPct(value: number | null, decimals = 4): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${signGlyph(value)}${Math.abs(value).toFixed(decimals)}%`;
}

/** A signed currency amount with an explicit sign, e.g. "+$1,204.50". */
export function formatSignedUsd(value: number | null, decimals = 2): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${signGlyph(value)}$${Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/**
 * Colour for a signed value, from the semantic tokens rather than a raw Tailwind
 * shade, so the same number reads correctly on either background.
 */
export function signClass(value: number | null): string {
  if (value === null || value === 0) return "text-neutral-value";
  return value > 0 ? "text-positive" : "text-negative";
}

/** Tailwind class for a funding rate cell based on sign. */
export function rateColorClass(rate: number | null): string {
  return signClass(rate);
}

/** Compact countdown like "3h 12m" or "42m 07s" until the given epoch ms. */
export function formatCountdown(targetMs: number, nowMs: number = Date.now()): string {
  const diff = targetMs - nowMs;
  if (diff <= 0) return "due";
  const totalSec = Math.floor(diff / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

/**
 * Format a price with a precision that suits its magnitude, since the venues
 * quote everything from 60,000 to 0.00002.
 */
export function formatPrice(price: number | null): string {
  if (price === null || !Number.isFinite(price)) return "—";
  const abs = Math.abs(price);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 5 : 7;
  return price.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Compact "12s ago" / "3m ago" for stream freshness labels. */
export function formatAgo(ts: number | null, nowMs: number = Date.now()): string {
  if (ts === null) return "never";
  const diff = Math.max(0, nowMs - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

/**
 * Venue kind. Centralized venues hold custody and are reached with an API key;
 * decentralized ones settle on-chain and are signed for with a wallet, which is
 * why they are listed apart rather than mixed into one table.
 */
export const EXCHANGES: ExchangeInfo[] = [
  { id: "binance", name: "Binance", accent: "text-amber-400", defaultIntervalHours: 8, venueType: "cex" },
  { id: "bybit", name: "Bybit", accent: "text-yellow-300", defaultIntervalHours: 8, venueType: "cex" },
  { id: "okx", name: "OKX", accent: "text-sky-400", defaultIntervalHours: 8, venueType: "cex" },
  { id: "kucoin", name: "KuCoin", accent: "text-emerald-400", defaultIntervalHours: 8, venueType: "cex" },
  { id: "gateio", name: "Gate.io", accent: "text-purple-400", defaultIntervalHours: 8, venueType: "cex" },
  { id: "bitget", name: "Bitget", accent: "text-cyan-400", defaultIntervalHours: 8, venueType: "cex" },
  { id: "hyperliquid", name: "Hyperliquid", accent: "text-teal-300", defaultIntervalHours: 1, venueType: "dex" },
  // Aster's cadence is per-symbol (1h, 2h, 4h or 8h) and read from its funding
  // metadata; 8h is only the placeholder until that arrives.
  { id: "aster", name: "Aster", accent: "text-orange-300", defaultIntervalHours: 8, venueType: "dex" },
  { id: "lighter", name: "Lighter", accent: "text-lime-300", defaultIntervalHours: 1, venueType: "dex" },
  { id: "edgex", name: "edgeX", accent: "text-indigo-300", defaultIntervalHours: 4, venueType: "dex" },
];

export const EXCHANGE_IDS: ExchangeId[] = EXCHANGES.map((e) => e.id);

/** Venues of one kind, in the order they are declared above. */
export function exchangesOfType(type: VenueType): ExchangeInfo[] {
  return EXCHANGES.filter((e) => e.venueType === type);
}

export function exchangeIdsOfType(type: VenueType): ExchangeId[] {
  return exchangesOfType(type).map((e) => e.id);
}

export function exchangeInfo(id: ExchangeId): ExchangeInfo {
  return EXCHANGES.find((e) => e.id === id)!;
}

export function exchangeName(id: ExchangeId): string {
  return exchangeInfo(id).name;
}

export function venueTypeOf(id: ExchangeId): VenueType {
  return exchangeInfo(id).venueType;
}

/**
 * Venues authenticated with a wallet private key rather than an issued API secret.
 *
 * Deliberately not the same question as `venueTypeOf`. All four DEX venues settle
 * on-chain, but only Hyperliquid and Aster are *signed for* with a wallet key —
 * edgeX issues a revocable API key, secret and passphrase from its own web app, so
 * it belongs on the API-key form. Deriving the credential shape from the venue type
 * would show edgeX a wallet field and invite pasting a private key into something
 * that never reads one.
 *
 * This lives here rather than beside the credential store so the settings pages can
 * group venues without importing anything that touches the database.
 */
const WALLET_KEY_VENUES: ReadonlySet<ExchangeId> = new Set(["hyperliquid", "aster"]);

export function credentialShapeOf(id: ExchangeId): "wallet" | "apiKey" {
  return WALLET_KEY_VENUES.has(id) ? "wallet" : "apiKey";
}

/**
 * Is this venue pair inside the scope?
 *
 * `cross` deliberately requires one of each rather than merely allowing it: a
 * cross-venue view that also showed CEX-to-CEX pairs would just be the combined
 * table again, and the whole point of the split is that each page answers one
 * question.
 */
export function pairInScope(scope: PairScope, a: ExchangeId, b: ExchangeId): boolean {
  const ta = venueTypeOf(a);
  const tb = venueTypeOf(b);
  if (scope === "cex-cex") return ta === "cex" && tb === "cex";
  if (scope === "dex-dex") return ta === "dex" && tb === "dex";
  return ta !== tb;
}

/** Venues a scope can draw legs from. */
export function scopeVenues(scope: PairScope): ExchangeId[] {
  if (scope === "cex-cex") return exchangeIdsOfType("cex");
  if (scope === "dex-dex") return exchangeIdsOfType("dex");
  return EXCHANGE_IDS;
}
