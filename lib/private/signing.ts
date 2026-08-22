import { createHash, createHmac } from "node:crypto";
import type { Credentials } from "@/lib/db/credentials";
import { assertAllowedUrl } from "@/lib/private/hosts";

/**
 * Per-venue request signing.
 *
 * Every venue uses HMAC over a slightly different canonical string, so each
 * scheme is written out explicitly rather than hidden behind an abstraction —
 * a subtly wrong signature is silently rejected, and guessing is worse than
 * being verbose.
 *
 * Nothing here logs or returns secret material.
 */

export interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Venue hosts. Wallet and withdrawal endpoints live on different hosts than the
 * derivatives APIs, so a signer takes the host as an argument with the
 * derivatives host as its default. Every value here must also appear in the
 * outbound allowlist, which is what actually enforces the destination.
 */
export const VENUE_HOSTS = {
  bybit: "api.bybit.com",
  okx: "www.okx.com",
  kucoinFutures: "api-futures.kucoin.com",
  kucoinSpot: "api.kucoin.com",
  gateio: "api.gateio.ws",
  bitget: "api.bitget.com",
} as const;

function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function hmacBase64(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64");
}

/** Sorted query string, which several venues require for a stable signature. */
function queryString(params: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
}

/** Builds the absolute URL and refuses a host outside the allowlist. */
function endpointUrl(host: string, pathWithQuery: string): string {
  return assertAllowedUrl(`https://${host}${pathWithQuery}`, "signed request");
}

// ─── Bybit v5 ───────────────────────────────────────────────────────────────
// HMAC-SHA256 over timestamp + apiKey + recvWindow + (query | body).
export function signBybit(
  creds: Credentials,
  method: string,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  body?: unknown,
): SignedRequest {
  const timestamp = String(Date.now());
  const recvWindow = "5000";
  const query = method === "GET" ? queryString(params) : "";
  const payload = body === undefined ? "" : JSON.stringify(body);
  const signature = hmacHex(
    creds.apiSecret,
    timestamp + creds.apiKey + recvWindow + (method === "GET" ? query : payload),
  );
  return {
    url: endpointUrl(VENUE_HOSTS.bybit, `${path}${query ? `?${query}` : ""}`),
    method,
    headers: {
      "X-BAPI-API-KEY": creds.apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": signature,
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    body: payload || undefined,
  };
}

// ─── OKX v5 ─────────────────────────────────────────────────────────────────
// Base64 HMAC-SHA256 over ISO timestamp + method + requestPath + body, plus a
// passphrase header.
export function signOkx(
  creds: Credentials,
  method: string,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  body?: unknown,
): SignedRequest {
  const timestamp = new Date().toISOString();
  const query = method === "GET" ? queryString(params) : "";
  const requestPath = `${path}${query ? `?${query}` : ""}`;
  const payload = body === undefined ? "" : JSON.stringify(body);
  const signature = hmacBase64(
    creds.apiSecret,
    timestamp + method.toUpperCase() + requestPath + payload,
  );
  return {
    url: endpointUrl(VENUE_HOSTS.okx, requestPath),
    method,
    headers: {
      "OK-ACCESS-KEY": creds.apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": creds.passphrase ?? "",
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    body: payload || undefined,
  };
}

/** OKX websocket login also signs the literal path /users/self/verify. */
export function okxWsLogin(creds: Credentials): unknown {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = hmacBase64(creds.apiSecret, `${timestamp}GET/users/self/verify`);
  return {
    op: "login",
    args: [
      {
        apiKey: creds.apiKey,
        passphrase: creds.passphrase ?? "",
        timestamp,
        sign,
      },
    ],
  };
}

// ─── KuCoin Futures ─────────────────────────────────────────────────────────
// Base64 HMAC-SHA256 over timestamp + method + endpoint + body. The passphrase
// itself must also be signed, and KC-API-KEY-VERSION must be 2.
export function signKucoin(
  creds: Credentials,
  method: string,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  body?: unknown,
  host: string = VENUE_HOSTS.kucoinFutures,
): SignedRequest {
  const timestamp = String(Date.now());
  const query = method === "GET" ? queryString(params) : "";
  const endpoint = `${path}${query ? `?${query}` : ""}`;
  const payload = body === undefined ? "" : JSON.stringify(body);
  const signature = hmacBase64(
    creds.apiSecret,
    timestamp + method.toUpperCase() + endpoint + payload,
  );
  const passphrase = hmacBase64(creds.apiSecret, creds.passphrase ?? "");
  return {
    url: endpointUrl(host, endpoint),
    method,
    headers: {
      "KC-API-KEY": creds.apiKey,
      "KC-API-SIGN": signature,
      "KC-API-TIMESTAMP": timestamp,
      "KC-API-PASSPHRASE": passphrase,
      "KC-API-KEY-VERSION": "2",
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    body: payload || undefined,
  };
}

// ─── Gate.io v4 ─────────────────────────────────────────────────────────────
// HMAC-SHA512 over method, path, query, SHA512 of the body, and timestamp.
export function signGateio(
  creds: Credentials,
  method: string,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  body?: unknown,
): SignedRequest {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const query = queryString(params);
  const payload = body === undefined ? "" : JSON.stringify(body);
  const bodyHash = createHash("sha512").update(payload).digest("hex");
  const signString = [method.toUpperCase(), path, query, bodyHash, timestamp].join("\n");
  const signature = createHmac("sha512", creds.apiSecret).update(signString).digest("hex");
  return {
    url: endpointUrl(VENUE_HOSTS.gateio, `${path}${query ? `?${query}` : ""}`),
    method,
    headers: {
      KEY: creds.apiKey,
      Timestamp: timestamp,
      SIGN: signature,
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    body: payload || undefined,
  };
}

// ─── Bitget v2 ──────────────────────────────────────────────────────────────
// Base64 HMAC-SHA256 over timestamp + method + requestPath + body, plus a
// plaintext passphrase header.
export function signBitget(
  creds: Credentials,
  method: string,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  body?: unknown,
): SignedRequest {
  const timestamp = String(Date.now());
  const query = method === "GET" ? queryString(params) : "";
  const requestPath = `${path}${query ? `?${query}` : ""}`;
  const payload = body === undefined ? "" : JSON.stringify(body);
  const signature = hmacBase64(
    creds.apiSecret,
    timestamp + method.toUpperCase() + requestPath + payload,
  );
  return {
    url: endpointUrl(VENUE_HOSTS.bitget, requestPath),
    method,
    headers: {
      "ACCESS-KEY": creds.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": creds.passphrase ?? "",
      locale: "en-US",
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    body: payload || undefined,
  };
}

/** Bitget websocket login signs timestamp + "GET" + "/user/verify". */
export function bitgetWsLogin(creds: Credentials): unknown {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = hmacBase64(creds.apiSecret, `${timestamp}GET/user/verify`);
  return {
    op: "login",
    args: [
      {
        apiKey: creds.apiKey,
        passphrase: creds.passphrase ?? "",
        timestamp,
        sign,
      },
    ],
  };
}

/** Bybit websocket auth signs "GET/realtime" + expiry. */
export function bybitWsAuth(creds: Credentials): unknown {
  const expires = Date.now() + 10_000;
  const signature = hmacHex(creds.apiSecret, `GET/realtime${expires}`);
  return { op: "auth", args: [creds.apiKey, expires, signature] };
}

/** Gate.io futures websocket auth signs channel + event + timestamp. */
export function gateioWsAuth(creds: Credentials, channel: string, event: string): unknown {
  const time = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha512", creds.apiSecret)
    .update(`channel=${channel}&event=${event}&time=${time}`)
    .digest("hex");
  return {
    time,
    channel,
    event,
    auth: { method: "api_key", KEY: creds.apiKey, SIGN: signature },
  };
}

/**
 * Performs a signed request and returns parsed JSON.
 *
 * Errors deliberately carry only the venue's message and status — never the
 * request headers, which hold the signature and key.
 */
export async function sendSigned<T>(
  label: string,
  signed: SignedRequest,
  signal: AbortSignal,
): Promise<T> {
  // Re-checked at the moment of the request: a signer could be bypassed, but
  // this call site cannot be.
  const url = assertAllowedUrl(signed.url, label);
  const res = await fetch(url, {
    method: signed.method,
    headers: { accept: "application/json", ...signed.headers },
    body: signed.body,
    signal,
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  if (!res.ok) {
    const detail =
      parsed && typeof parsed === "object"
        ? JSON.stringify(parsed).slice(0, 300)
        : `HTTP ${res.status}`;
    throw new Error(`${label}: ${res.status} ${detail}`);
  }
  return parsed as T;
}
