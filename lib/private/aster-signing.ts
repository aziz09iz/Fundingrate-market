import type { Credentials } from "@/lib/db/credentials";
import { addressFromPrivateKey, signTypedData } from "@/lib/private/eip712";
import { assertSigningHealthy } from "@/lib/private/signing-selftest";
import { assertAllowedUrl } from "@/lib/private/hosts";
import type { SignedRequest } from "@/lib/private/signing";

/**
 * Aster's V3 authenticated API.
 *
 * Aster's *public* API follows the conventional USDⓈ-M futures shape, and its V3
 * private endpoints keep it — `/fapi/v3/order`, `/fapi/v3/balance`,
 * `/fapi/v3/positionRisk`, with the same field names. What is unconventional is the
 * authentication. There is no API secret and no HMAC. Instead:
 *
 *   1. The parameters, including `signer` and `nonce`, are urlencoded in insertion
 *      order into one string.
 *   2. That whole string is the single `msg` field of an EIP-712 struct named
 *      `Message`, under the domain `AsterSignTransaction` on chain id 1666.
 *   3. The resulting 65-byte signature is appended as another parameter.
 *
 * So the credential is a wallet: `apiKey` holds the master account address (Aster
 * calls it `user`) and `apiSecret` holds the **API wallet's** private key. Unlike
 * Hyperliquid, the signing address here is *expected* to differ from the account
 * address — that is what an approved agent is — so no cross-check between them is
 * possible, and the signer address is derived from the key rather than stored.
 *
 * Two details that are easy to get wrong and produce a silently rejected request:
 *
 *   · **The nonce is microseconds, not milliseconds.** Aster's docs contradict
 *     themselves on the window (one section says ±60s, the order example says
 *     10s), so this uses a real microsecond clock rather than relying on the
 *     wider figure being true.
 *
 *   · **Order matters.** The signature covers the urlencoded string exactly as
 *     built, so the same object must produce the request and the signature. The
 *     signer below builds the string once and uses it for both.
 *
 * The V1 HMAC API is not used. Aster stopped issuing new V1 keys in March 2026, so
 * an integration written against it could not be configured by a new account.
 */

const HOST = "fapi.asterdex.com";

const DOMAIN = {
  name: "AsterSignTransaction",
  version: "1",
  chainId: 1666,
  verifyingContract: "0x0000000000000000000000000000000000000000",
} as const;

const TYPES = {
  Message: [{ name: "msg", type: "string" }],
};

/** Microsecond nonce, strictly increasing within a process. */
let lastSeconds = 0;
let counter = 0;
function nextNonce(): string {
  const seconds = Math.floor(Date.now() / 1000);
  if (seconds === lastSeconds) counter += 1;
  else {
    lastSeconds = seconds;
    counter = 0;
  }
  return String(seconds * 1_000_000 + counter);
}

export type AsterParams = Record<string, string | number | boolean | undefined>;

/**
 * Builds a signed Aster V3 request.
 *
 * Everything travels in the query string, including for POST and DELETE. Aster
 * accepts either that or a form body; the query string is used for both so there
 * is exactly one serialisation to keep in step with the signature.
 *
 * The signed parameters are the caller's, plus `signer` and `nonce`. Aster's own
 * `/fapi/v3/order` example sends exactly those two and its authentication table
 * says TRADE and USER_DATA endpoints need "a valid signer and signature" — `user`
 * belongs to the master-account endpoints (agent approval, sub-accounts), which
 * this app does not call. Sending an unexpected parameter to this API family is
 * itself an error, so nothing extra is added.
 */
export function signAster(
  creds: Credentials,
  method: string,
  path: string,
  params: AsterParams = {},
): SignedRequest {
  assertSigningHealthy();

  const privateKey = (creds.apiSecret ?? "").trim();
  if (!privateKey) {
    throw new Error(
      "Aster needs the API wallet private key. Create one at asterdex.com/en/api-wallet with perp " +
        "trading enabled, then store its key here.",
    );
  }
  let signer: string;
  try {
    signer = addressFromPrivateKey(privateKey);
  } catch (err) {
    throw new Error(
      `Aster API wallet key is not usable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Insertion order is the signed order. `signer` and `nonce` come last so a
  // caller cannot displace them by naming a parameter the same thing.
  const ordered: AsterParams = { ...params, signer, nonce: nextNonce() };

  const query = Object.entries(ordered)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");

  const signature = signTypedData(privateKey, DOMAIN, TYPES, "Message", { msg: query });

  return {
    url: assertAllowedUrl(
      `https://${HOST}${path}?${query}&signature=${signature.serialized}`,
      "aster/signed",
    ),
    method,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  };
}

/**
 * Aster's agent model needs the signer address as a parameter on some endpoints.
 *
 * Derived rather than stored: the signer is whatever wallet the key controls, and
 * a stored value that disagreed with the key would just produce a rejected
 * signature with no useful message.
 */
export function signerAddressFor(creds: Credentials): string {
  const privateKey = (creds.apiSecret ?? "").trim();
  if (!privateKey) throw new Error("Aster has no API wallet key stored");
  return addressFromPrivateKey(privateKey);
}

export { HOST as ASTER_HOST };
