import type { ExchangeId } from "@/lib/types";
import { EXCHANGE_IDS } from "@/lib/utils";
import { getMarketRuntime } from "@/lib/market/runtime";

/**
 * Shared request-shape validation for account routes.
 *
 * Server-side validation is not a formality here: these routes place orders, so
 * a malformed size or an unknown venue must be rejected before anything is sent
 * to an exchange.
 */

export class ValidationError extends Error {}

export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("Expected a JSON object body");
  }
  return body as Record<string, unknown>;
}

export function requireExchange(value: unknown): ExchangeId {
  const id = typeof value === "string" ? value : "";
  if (!(EXCHANGE_IDS as string[]).includes(id)) {
    throw new ValidationError(`Unknown exchange: ${String(value)}`);
  }
  return id as ExchangeId;
}

/** Coin symbols are uppercase alphanumerics; anything else is rejected. */
export function requireCoin(value: unknown): string {
  const coin = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{1,20}$/.test(coin)) {
    throw new ValidationError(`Invalid coin: ${String(value)}`);
  }
  return coin;
}

export function requireSide(value: unknown): "buy" | "sell" {
  if (value === "buy" || value === "sell") return value;
  throw new ValidationError(`Invalid side: ${String(value)}`);
}

export function requirePositionSide(value: unknown): "long" | "short" {
  if (value === "long" || value === "short") return value;
  throw new ValidationError(`Invalid position side: ${String(value)}`);
}

export function requireAccountType(value: unknown): "live" | "paper" {
  if (value === "live" || value === "paper") return value;
  throw new ValidationError(`Invalid account type: ${String(value)}`);
}

export function requireOrderType(value: unknown): "market" | "limit" {
  if (value === "market" || value === "limit") return value;
  throw new ValidationError(`Invalid order type: ${String(value)}`);
}

export function requirePositive(value: unknown, field: string, max = 1e12): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(`${field} must be a positive number`);
  }
  if (n > max) {
    throw new ValidationError(`${field} exceeds the allowed maximum of ${max}`);
  }
  return n;
}

export function optionalPositive(value: unknown, field: string, max = 1e12): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requirePositive(value, field, max);
}

export function requireLeverage(value: unknown): number {
  if (value === undefined || value === null || value === "") return 1;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 125) {
    throw new ValidationError("leverage must be between 1 and 125");
  }
  return Math.trunc(n);
}

export function requireString(value: unknown, field: string, maxLength = 200): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) throw new ValidationError(`${field} is required`);
  if (s.length > maxLength) throw new ValidationError(`${field} is too long`);
  return s;
}

export function optionalString(value: unknown, maxLength = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (!s) return undefined;
  return s.length > maxLength ? s.slice(0, maxLength) : s;
}

/**
 * Optional string that rejects an overlong value instead of truncating it.
 *
 * Use this for anything where a silently shortened value would be worse than an
 * error — a private key or an address truncated to fit would be stored as a wrong
 * secret and fail later with no clue why.
 */
export function optionalExactString(
  value: unknown,
  field: string,
  maxLength = 200,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`);
  const s = value.trim();
  if (!s) return undefined;
  if (s.length > maxLength) throw new ValidationError(`${field} is too long`);
  return s;
}

export function requireBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Refuses coins the market layer is not streaming. Without a live quote there
 * is no way to sanity-check a price, so an order on an unwatched pair is
 * rejected rather than sent blind.
 *
 * A pair claimed by an open position counts as watched even before the next
 * ranking cycle has picked it up: refusing there would block you from closing
 * something you already hold, which is the opposite of safe.
 */
export function requireWatchedCoin(coin: string): void {
  const snapshot = getMarketRuntime().snapshot();
  if (snapshot.coins.includes(coin)) return;
  if (snapshot.claims?.some((c) => c.coin === coin)) return;
  throw new ValidationError(
    `${coin} is not currently streaming. Only watched pairs can be traded.`,
  );
}

/** Best bid/ask for a venue from the live snapshot, for price sanity checks. */
export function venueQuote(
  coin: string,
  exchange: ExchangeId,
): { bid: number | null; ask: number | null } {
  const row = getMarketRuntime().snapshot().rows.find((r) => r.coin === coin);
  const ticker = row?.tickers[exchange] ?? null;
  return { bid: ticker?.bid ?? null, ask: ticker?.ask ?? null };
}

/**
 * Rejects a limit price that is wildly away from the market. A fat-fingered
 * price is one of the easiest ways to lose money on a real venue.
 */
export function assertPriceSane(
  coin: string,
  exchange: ExchangeId,
  price: number,
  maxDeviationPct = 20,
): void {
  const { bid, ask } = venueQuote(coin, exchange);
  const reference = bid !== null && ask !== null ? (bid + ask) / 2 : (ask ?? bid);
  if (reference === null || reference <= 0) return;
  const deviation = Math.abs((price - reference) / reference) * 100;
  if (deviation > maxDeviationPct) {
    throw new ValidationError(
      `Price ${price} is ${deviation.toFixed(1)}% away from the ${exchange} market (${reference}). Refusing as a likely mistake.`,
    );
  }
}

export function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function jsonOk(payload: unknown): Response {
  return Response.json(payload, { headers: { "cache-control": "no-store" } });
}

/** Turns thrown validation errors into 400s and anything else into a 500. */
export function handleRouteError(err: unknown): Response {
  if (err instanceof ValidationError) return jsonError(err.message, 400);
  const message = err instanceof Error ? err.message : "Unexpected error";
  return jsonError(message, 500);
}
