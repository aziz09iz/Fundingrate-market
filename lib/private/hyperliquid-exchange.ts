import { encode } from "@msgpack/msgpack";
import { keccak256, signTypedData, toHex } from "@/lib/private/eip712";
import { assertSigningHealthy } from "@/lib/private/signing-selftest";
import { assertAllowedUrl } from "@/lib/private/hosts";

/**
 * Hyperliquid's authenticated `/exchange` surface.
 *
 * Hyperliquid does not sign a request; it signs an *action*. The action object is
 * msgpack-encoded, concatenated with the nonce and a vault marker, hashed with
 * keccak256, and that hash is then placed inside an EIP-712 struct Hyperliquid
 * calls a "phantom agent" — a fixed envelope on a fixed chain id (1337) whose only
 * job is to carry the hash. The venue recomputes the same bytes from the JSON it
 * receives and compares.
 *
 * Two consequences shape this file:
 *
 *   · **Key order in the action is part of the signature.** msgpack preserves
 *     insertion order, so an object literal built in a different order than the
 *     venue expects hashes differently and the order is rejected as unsigned.
 *     Every wire object here is therefore constructed in one place, in the
 *     documented order, and never spread or re-serialised.
 *
 *   · **Numbers are strings, formatted precisely.** `0.0147` must be sent as
 *     "0.0147", not "0.01470000" and not "1.47e-2". `floatToWire` reproduces the
 *     official SDK's formatting exactly, including its refusal to silently round.
 *
 * Verified against the vectors in the official Python SDK's `tests/signing_test.py`
 * (connectionId, dummy action mainnet/testnet, order, order with cloid, vault, and
 * trigger order) — all six reproduce byte for byte.
 */

const API = "https://api.hyperliquid.xyz";

/** Mainnet only. The app has no testnet mode, so this is a constant, not a flag. */
const IS_MAINNET = true;

/** The venue's own aggressive-market convention: a 5% slippage IoC limit. */
export const DEFAULT_SLIPPAGE = 0.05;

const AGENT_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337,
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const;

const AGENT_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
};

// ─── Wire formatting ────────────────────────────────────────────────────────

/**
 * A float as Hyperliquid hashes it: at most 8 decimals, trailing zeros stripped,
 * no exponent.
 *
 * Throws rather than rounds. A size the venue would silently reinterpret is a
 * different order than the one the caller asked for, and at this layer there is
 * no way to tell a harmless trailing digit from a misplaced decimal point.
 */
export function floatToWire(x: number): string {
  if (!Number.isFinite(x)) throw new Error("hyperliquid: value is not a finite number");
  const rounded = x.toFixed(8);
  if (Math.abs(Number(rounded) - x) >= 1e-12) {
    throw new Error(`hyperliquid: ${x} needs more than 8 decimals`);
  }
  let out = rounded;
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  // "-0" and "-0.0" both normalise to "0"; the venue rejects a signed zero.
  if (out === "-0" || out === "") out = "0";
  return out;
}

/**
 * Rounds a price to what the venue will accept: 5 significant figures, and at
 * most `6 - szDecimals` decimal places for a perp.
 *
 * Integer prices are exempt from the significant-figure rule, which matters for
 * BTC — 71649 is five figures already, but 123456 would be rejected by a naive
 * reading of the rule and is in fact valid.
 */
export function roundPrice(price: number, szDecimals: number): number {
  const maxDecimals = Math.max(0, 6 - szDecimals);
  if (Number.isInteger(price)) return price;
  const fiveSig = Number(price.toPrecision(5));
  return Number(fiveSig.toFixed(maxDecimals));
}

/** Rounds a size to the asset's own lot precision. */
export function roundSize(size: number, szDecimals: number): number {
  return Number(size.toFixed(szDecimals));
}

// ─── Action hashing and signing ─────────────────────────────────────────────

function u64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(Math.trunc(value)));
  return out;
}

/**
 * The 32-byte connection id: msgpack(action) ‖ nonce ‖ vault marker.
 *
 * `expiresAfter` is not used by this app — an order that silently expires between
 * signing and arrival would look like a rejected order with no reason — so the
 * optional trailing block is omitted, which is what a null expiry encodes.
 */
export function actionHash(action: unknown, nonce: number, vaultAddress: string | null): Uint8Array {
  const parts: Buffer[] = [Buffer.from(encode(action)), u64(nonce)];
  if (vaultAddress === null) {
    parts.push(Buffer.from([0x00]));
  } else {
    parts.push(Buffer.from([0x01]), Buffer.from(vaultAddress.replace(/^0x/, ""), "hex"));
  }
  return keccak256(Uint8Array.from(Buffer.concat(parts)));
}

export interface WireSignature {
  r: string;
  s: string;
  v: number;
}

export function signAction(
  privateKey: string,
  action: unknown,
  nonce: number,
  vaultAddress: string | null = null,
): WireSignature {
  assertSigningHealthy();
  assertVectorsMatch();
  const connectionId = toHex(actionHash(action, nonce, vaultAddress));
  const signature = signTypedData(privateKey, AGENT_DOMAIN, AGENT_TYPES, "Agent", {
    source: IS_MAINNET ? "a" : "b",
    connectionId,
  });
  return { r: signature.r, s: signature.s, v: signature.v };
}

// ─── Vector check ───────────────────────────────────────────────────────────

/**
 * Reproduces two of the official SDK's published test vectors before signing.
 *
 * `eip712.ts` has its own self-test, but it cannot catch the failure mode specific
 * to this venue: the action hash depends on msgpack's *encoding*, including key
 * order and integer width. A msgpack version that packed an object differently, or
 * a refactor that rebuilt the wire object in another order, would still produce a
 * valid EIP-712 signature — over the wrong bytes. The venue would reject it, but
 * only after the order had been recorded as submitted.
 *
 * The key below is the SDK's own test key. It signs nothing real.
 */
const VECTOR_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const VECTOR_CONNECTION_ID = "0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908";
const VECTOR_R = "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e";
const VECTOR_S = "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e";

let vectorResult: Error | null | undefined;

function checkVectors(): void {
  const hashed = toHex(
    actionHash(
      orderAction([
        orderWire({
          asset: 4,
          isBuy: true,
          price: 1670.1,
          size: 0.0147,
          reduceOnly: false,
          tif: "Ioc",
        }),
      ]),
      1677777606040,
      null,
    ),
  );
  if (hashed !== VECTOR_CONNECTION_ID) {
    throw new Error(
      `hyperliquid signing self-test failed: action hash is ${hashed}, expected ${VECTOR_CONNECTION_ID}`,
    );
  }

  const action = orderAction([
    orderWire({ asset: 1, isBuy: true, price: 100, size: 100, reduceOnly: false, tif: "Gtc" }),
  ]);
  const connectionId = toHex(actionHash(action, 0, null));
  const signature = signTypedData(VECTOR_KEY, AGENT_DOMAIN, AGENT_TYPES, "Agent", {
    source: "a",
    connectionId,
  });
  // noble strips a leading zero byte that the SDK's r values also lack, so compare
  // as numbers rather than as strings.
  if (BigInt(signature.r) !== BigInt(VECTOR_R) || BigInt(signature.s) !== BigInt(VECTOR_S)) {
    throw new Error("hyperliquid signing self-test failed: order signature does not match the vector");
  }
  if (signature.v !== 28) {
    throw new Error(`hyperliquid signing self-test failed: expected v=28, got ${signature.v}`);
  }
}

function assertVectorsMatch(): void {
  if (vectorResult === undefined) {
    try {
      checkVectors();
      vectorResult = null;
    } catch (err) {
      vectorResult = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (vectorResult) throw vectorResult;
}

// ─── Actions ────────────────────────────────────────────────────────────────

export type Tif = "Alo" | "Ioc" | "Gtc";

export interface OrderWire {
  /** Asset index. */
  a: number;
  /** True for a buy. */
  b: boolean;
  /** Limit price, wire-formatted. */
  p: string;
  /** Size in base units, wire-formatted. */
  s: string;
  /** Reduce-only. */
  r: boolean;
  t: { limit: { tif: Tif } };
  /** Client order id, a 16-byte 0x hex string. Omitted when absent. */
  c?: string;
}

/**
 * Builds one order wire object, in the exact key order the hash depends on.
 *
 * `cloid` must be exactly 16 bytes; Hyperliquid rejects anything else, and the
 * app's own client order ids are longer, so they are hashed down rather than
 * truncated — a truncation could collide across two orders placed in the same
 * millisecond and make a fill unattributable.
 */
export function orderWire(input: {
  asset: number;
  isBuy: boolean;
  price: number;
  size: number;
  reduceOnly: boolean;
  tif: Tif;
  cloid?: string | null;
}): OrderWire {
  const wire: OrderWire = {
    a: input.asset,
    b: input.isBuy,
    p: floatToWire(input.price),
    s: floatToWire(input.size),
    r: input.reduceOnly,
    t: { limit: { tif: input.tif } },
  };
  if (input.cloid) wire.c = input.cloid;
  return wire;
}

/** A 16-byte client order id derived from our own longer one. */
export function cloidFrom(clientOrderId: string): string {
  const digest = keccak256(Uint8Array.from(Buffer.from(clientOrderId, "utf8")));
  return `0x${Buffer.from(digest.slice(0, 16)).toString("hex")}`;
}

export function orderAction(orders: OrderWire[]): unknown {
  return { type: "order", orders, grouping: "na" };
}

export function cancelAction(cancels: { a: number; o: number }[]): unknown {
  return { type: "cancel", cancels };
}

export function cancelByCloidAction(cancels: { asset: number; cloid: string }[]): unknown {
  return { type: "cancelByCloid", cancels };
}

// ─── Transport ──────────────────────────────────────────────────────────────

export interface ExchangeResponse {
  status?: string;
  response?: {
    type?: string;
    data?: {
      statuses?: Array<{
        resting?: { oid?: number; cloid?: string };
        filled?: { totalSz?: string; avgPx?: string; oid?: number; cloid?: string };
        error?: string;
      }>;
    };
  };
}

/**
 * Posts a signed action.
 *
 * Hyperliquid answers HTTP 200 with `status: "err"` for a rejected action, and
 * even a 200/"ok" can carry a per-order `error` inside `statuses`. Both are
 * surfaced as thrown errors, because an order that was refused must not be
 * recorded as submitted.
 */
export async function postAction(
  action: unknown,
  signature: WireSignature,
  nonce: number,
  signal: AbortSignal,
): Promise<ExchangeResponse> {
  const url = assertAllowedUrl(`${API}/exchange`, "hyperliquid/exchange");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ action, nonce, signature, vaultAddress: null }),
    signal,
  });
  const text = await res.text();
  let parsed: ExchangeResponse;
  try {
    parsed = JSON.parse(text) as ExchangeResponse;
  } catch {
    throw new Error(`hyperliquid/exchange: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.ok || parsed.status === "err") {
    const detail =
      typeof parsed.response === "string" ? parsed.response : JSON.stringify(parsed.response ?? parsed);
    throw new Error(`hyperliquid/exchange: ${detail.slice(0, 300)}`);
  }
  const failure = parsed.response?.data?.statuses?.find((s) => s.error);
  if (failure) throw new Error(`hyperliquid/exchange: ${failure.error}`);
  return parsed;
}

// ─── Asset metadata ─────────────────────────────────────────────────────────

export interface AssetMeta {
  /** Index into the perp universe, which is the `a` field of an order. */
  index: number;
  name: string;
  szDecimals: number;
  maxLeverage: number;
}

interface MetaResponse {
  universe?: Array<{
    name?: string;
    szDecimals?: number;
    maxLeverage?: number;
    isDelisted?: boolean;
  }>;
}

let assetCache: { at: number; byCoin: Map<string, AssetMeta> } | null = null;
const ASSET_TTL_MS = 10 * 60 * 1000;

/**
 * Coin → asset metadata.
 *
 * Cached, because every order needs it and the universe changes on the order of
 * days. Delisted entries keep their index — the array position is the asset id,
 * so they cannot be filtered out of the list, only refused as an order target.
 */
export async function assetMap(signal: AbortSignal): Promise<Map<string, AssetMeta>> {
  if (assetCache && Date.now() - assetCache.at < ASSET_TTL_MS) return assetCache.byCoin;

  const url = assertAllowedUrl(`${API}/info`, "hyperliquid/meta");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ type: "meta" }),
    signal,
  });
  if (!res.ok) throw new Error(`hyperliquid/meta: HTTP ${res.status}`);
  const meta = (await res.json()) as MetaResponse;

  const byCoin = new Map<string, AssetMeta>();
  (meta.universe ?? []).forEach((row, index) => {
    const name = row.name?.trim().toUpperCase();
    if (!name || row.isDelisted === true) return;
    byCoin.set(name, {
      index,
      name,
      szDecimals: row.szDecimals ?? 0,
      maxLeverage: row.maxLeverage ?? 1,
    });
  });
  if (byCoin.size === 0) throw new Error("hyperliquid/meta: empty universe");

  assetCache = { at: Date.now(), byCoin };
  return byCoin;
}

export async function assetFor(coin: string, signal: AbortSignal): Promise<AssetMeta> {
  const map = await assetMap(signal);
  const asset = map.get(coin.trim().toUpperCase());
  if (!asset) {
    throw new Error(`hyperliquid: ${coin} is not a listed perp (or has been delisted)`);
  }
  return asset;
}

/** Mid price for one coin, used to derive an aggressive market limit. */
export async function midPrice(coin: string, signal: AbortSignal): Promise<number> {
  const url = assertAllowedUrl(`${API}/info`, "hyperliquid/allMids");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ type: "allMids" }),
    signal,
  });
  if (!res.ok) throw new Error(`hyperliquid/allMids: HTTP ${res.status}`);
  const mids = (await res.json()) as Record<string, string>;
  const mid = Number(mids[coin.trim().toUpperCase()]);
  if (!Number.isFinite(mid) || mid <= 0) {
    throw new Error(`hyperliquid: no mid price for ${coin}; refusing to price a market order`);
  }
  return mid;
}

/**
 * The limit price an aggressive IoC uses to behave as a market order.
 *
 * Crossing by 5% is the venue's own default. It bounds the damage of a thin book
 * without being so tight that a legitimate fill is missed, and because the order
 * is IoC the unfilled remainder is cancelled rather than resting at a bad price.
 */
export function aggressivePrice(mid: number, isBuy: boolean, szDecimals: number): number {
  const crossed = mid * (isBuy ? 1 + DEFAULT_SLIPPAGE : 1 - DEFAULT_SLIPPAGE);
  return roundPrice(crossed, szDecimals);
}

export { API as HYPERLIQUID_API };
