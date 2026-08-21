import { createHmac } from "node:crypto";
import type { Credentials } from "@/lib/db/credentials";
import { assertAllowedUrl } from "@/lib/private/hosts";
import type { SignedRequest } from "@/lib/private/signing";

/**
 * edgeX's V2 HMAC authentication layer.
 *
 * edgeX signs private requests with an HMAC over `timestamp + METHOD + path +
 * body`, which sounds like the CEX venues in `signing.ts` — but three details are
 * unlike any of them, and each one produces a signature the venue silently
 * rejects if guessed:
 *
 *   · **The secret is base64-*encoded* before use as the HMAC key**, not decoded.
 *     The key is the ASCII base64 text of the secret's bytes. This looks like a
 *     bug in their SDK, but it is what both the Python and Go SDKs do and what
 *     the docs specify, so it is what the server verifies against.
 *
 *   · **The signed path excludes the query string.** Query parameters appear
 *     exactly once in the signature, in the body slot.
 *
 *   · **For a GET, the "body" is the sorted query string**, joined `k=v&k=v`,
 *     alphabetically by key, and *not* URL-encoded. For a POST it is the JSON
 *     body flattened the same way — so a request whose signature is built from
 *     the JSON text would fail even though the JSON is what travels on the wire.
 *
 * Everything here is derived from the official Python and Go SDK sources. edgeX's
 * documentation host does not resolve, so the SDKs are the only authority; that is
 * also why this app does not place orders on edgeX. See `lib/private/edgex.ts`.
 */

const HOST = "edgex-prod-v2.edgex.exchange";

export type EdgexParams = Record<string, string | number | undefined>;

/** `k=v&k=v`, sorted by key, empty values dropped, not URL-encoded. */
function signatureBody(params: EdgexParams): string {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && String(params[key]) !== "")
    .sort()
    .map((key) => `${key}=${String(params[key])}`)
    .join("&");
}

/**
 * Flattens a JSON body the way edgeX signs it: sorted keys, arrays joined by `&`.
 *
 * The array flattening is genuinely lossy — `["a","b"]` becomes `a&b`, which
 * cannot be read back — but it is what the SDKs sign, and this app only ever sends
 * single-element lists here.
 */
function flattenBody(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(data).sort()) {
    const value = data[key];
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) parts.push(`${key}=${String(item)}`);
    } else {
      parts.push(`${key}=${String(value)}`);
    }
  }
  return parts.join("&");
}

function requireHmacCreds(creds: Credentials): {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
} {
  const apiKey = (creds.apiKey ?? "").trim();
  const apiSecret = (creds.apiSecret ?? "").trim();
  const passphrase = (creds.passphrase ?? "").trim();
  if (!apiKey || !apiSecret || !passphrase) {
    throw new Error(
      "edgeX needs an API key, secret and passphrase, all created in the edgeX web app.",
    );
  }
  return { apiKey, apiSecret, passphrase };
}

function headersFor(
  creds: Credentials,
  method: string,
  path: string,
  body: string,
): Record<string, string> {
  const { apiKey, apiSecret, passphrase } = requireHmacCreds(creds);
  const timestamp = String(Date.now());
  const message = `${timestamp}${method.toUpperCase()}${path}${body}`;
  // Base64-encoded, not decoded. See the note at the top of this file.
  const key = Buffer.from(apiSecret, "utf8").toString("base64");
  const signature = createHmac("sha256", key).update(message).digest("hex");
  return {
    "X-edgeX-Api-Key": apiKey,
    "X-edgeX-Passphrase": passphrase,
    "X-edgeX-Signature": signature,
    "X-edgeX-Timestamp": timestamp,
  };
}

export function signEdgexGet(
  creds: Credentials,
  path: string,
  params: EdgexParams = {},
): SignedRequest {
  const body = signatureBody(params);
  const query = Object.keys(params)
    .filter((key) => params[key] !== undefined && String(params[key]) !== "")
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
    .join("&");
  return {
    url: assertAllowedUrl(`https://${HOST}${path}${query ? `?${query}` : ""}`, "edgex/signed"),
    method: "GET",
    headers: headersFor(creds, "GET", path, body),
  };
}

export function signEdgexPost(
  creds: Credentials,
  path: string,
  data: Record<string, unknown>,
): SignedRequest {
  // The signature covers the flattened form; the wire body stays JSON.
  const headers = headersFor(creds, "POST", path, flattenBody(data));
  return {
    url: assertAllowedUrl(`https://${HOST}${path}`, "edgex/signed"),
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(data),
  };
}

export { HOST as EDGEX_HOST };
