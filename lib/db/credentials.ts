import type { CredentialKind, CredentialStatus, ExchangeId } from "@/lib/types";
import { getDb, inTransaction, rowBool, rowNum, rowStr } from "@/lib/db/client";
import { decryptSecret, encryptSecret, encryptionAvailable } from "@/lib/db/secrets";
import { EXCHANGE_IDS, credentialShapeOf, exchangeInfo } from "@/lib/utils";

/**
 * Venue credentials, stored encrypted in the database and configured only from
 * the dashboard.
 *
 * There used to be a second source — environment variables, which won over
 * database rows — and it is gone on purpose. Two sources meant a key could be
 * shadowed by one the UI could neither see nor change, and the reason to prefer
 * env (a secret that never touches disk) does not hold here: the process reads
 * .env.local off the same disk anyway.
 *
 * Two credential shapes, not one form with optional fields:
 *
 *   · `cex` — an API key issued by the exchange. Revocable there, so the worst
 *     case is bounded by the permissions granted.
 *   · `dex` — a wallet private key that signs on-chain. It cannot be revoked,
 *     only abandoned, and it authorises everything the wallet holds. The public
 *     address is stored alongside so the UI can identify the wallet without
 *     decrypting the key.
 *
 * Secrets never leave the server. `credentialStatuses()` is the only shape the
 * client ever sees, and it contains no secret material — not even encrypted.
 */

/** Venues whose API requires a passphrase alongside key and secret. */
const PASSPHRASE_VENUES: ReadonlySet<ExchangeId> = new Set(["okx", "kucoin", "bitget", "edgex"]);

/**
 * Venues this app will not place an order on, whatever the credential says.
 *
 * edgeX authenticates reads and cancellations with an HMAC key, but opening a
 * position additionally needs an EIP-712 "L2 signature" from a separate trading
 * key over a payload of resolution-scaled amounts that cannot be verified against
 * the venue from here. So the credential is accepted and used for reads, and the
 * order path refuses it.
 */
const READ_ONLY_VENUES: ReadonlySet<ExchangeId> = new Set(["edgex"]);

/**
 * Venues wired for market data only, with no authenticated integration at all.
 *
 * Lighter signs L2 transactions with a Schnorr signature over the ECgFp5 curve
 * using Poseidon2 hashing, which has no JavaScript implementation — official or
 * otherwise. Storing a credential for it would buy nothing and, being a DEX, would
 * mean holding an unrevocable wallet key that no code path can use. So the
 * credential surface refuses it outright rather than accepting a secret and failing
 * later.
 */
const NO_ACCOUNT_VENUES: ReadonlySet<ExchangeId> = new Set(["lighter"]);

export interface Credentials {
  exchange: ExchangeId;
  kind: CredentialKind;
  /** CEX: the API key. DEX: the public wallet address. */
  apiKey: string;
  /** CEX: the API secret. DEX: the wallet private key, or "" when read-only. */
  apiSecret: string;
  passphrase?: string;
  /** DEX only: the public address, same as apiKey. Kept named for clarity. */
  walletAddress?: string;
  readOnly: boolean;
}

export function requiresPassphrase(exchange: ExchangeId): boolean {
  return PASSPHRASE_VENUES.has(exchange);
}

export function isReadOnlyVenue(exchange: ExchangeId): boolean {
  return READ_ONLY_VENUES.has(exchange);
}

/** True when this app can authenticate against the venue at all. */
export function accountSupported(exchange: ExchangeId): boolean {
  return !NO_ACCOUNT_VENUES.has(exchange);
}

/** Which credential shape a venue takes. Derived from the venue, never supplied. */
export function credentialKind(exchange: ExchangeId): CredentialKind {
  // "dex" here means "signed for with a wallet key", which is not every DEX — see
  // credentialShapeOf for why edgeX is on the API-key form.
  return credentialShapeOf(exchange) === "wallet" ? "dex" : "cex";
}

export { encryptionAvailable };

// ─── Rows ───────────────────────────────────────────────────────────────────

interface CredentialRow {
  exchange?: unknown;
  kind?: unknown;
  api_key_cipher?: unknown;
  api_secret_cipher?: unknown;
  passphrase_cipher?: unknown;
  wallet_address_cipher?: unknown;
  key_tail?: unknown;
  label?: unknown;
  read_only?: unknown;
  enabled?: unknown;
  last_verified_at?: unknown;
  last_error?: unknown;
}

function keyTail(value: string): string {
  return value.length <= 4 ? "••••" : value.slice(-4);
}

function maskAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Resolves usable credentials for a venue, or null when none are configured or
 * the stored secret cannot be decrypted.
 *
 * Server-only: callers must never pass the result to the client.
 */
export function getCredentials(exchange: ExchangeId): Credentials | null {
  const row = getDb()
    .prepare("SELECT * FROM api_credentials WHERE exchange = ? AND enabled = 1")
    .get(exchange) as CredentialRow | undefined;
  if (!row) return null;

  try {
    const kind = (rowStr(row.kind, "cex") as CredentialKind) ?? "cex";
    const passCipher = rowStr(row.passphrase_cipher, "");
    const secretCipher = rowStr(row.api_secret_cipher, "");
    return {
      exchange,
      kind,
      apiKey: decryptSecret(rowStr(row.api_key_cipher)),
      // A DEX wallet added for read-only use has no private key, which is a
      // legitimate configuration rather than a broken one.
      apiSecret: secretCipher ? decryptSecret(secretCipher) : "",
      passphrase: passCipher ? decryptSecret(passCipher) : undefined,
      walletAddress:
        kind === "dex" ? decryptSecret(rowStr(row.api_key_cipher)) : undefined,
      readOnly: rowBool(row.read_only) || isReadOnlyVenue(exchange),
    };
  } catch {
    // A changed password must not crash the caller; treat the credential as
    // unavailable instead.
    return null;
  }
}

// ─── Status for the UI ──────────────────────────────────────────────────────

export function credentialStatuses(): CredentialStatus[] {
  const rows = getDb().prepare("SELECT * FROM api_credentials").all() as CredentialRow[];
  const byExchange = new Map<string, CredentialRow>();
  for (const row of rows) byExchange.set(rowStr(row.exchange), row);

  return EXCHANGE_IDS.map((exchange) => {
    const row = byExchange.get(exchange);
    const kind = credentialKind(exchange);

    let walletAddressMasked: string | null = null;
    if (row && kind === "dex") {
      try {
        const cipher = rowStr(row.wallet_address_cipher, "") || rowStr(row.api_key_cipher, "");
        if (cipher) walletAddressMasked = maskAddress(decryptSecret(cipher));
      } catch {
        // Undecryptable address shows as absent; lastError below says why.
        walletAddressMasked = null;
      }
    }

    return {
      exchange,
      kind,
      configured: row !== undefined,
      accountSupported: accountSupported(exchange),
      keyTail: row ? rowStr(row.key_tail, "") || null : null,
      enabled: row ? rowBool(row.enabled) : false,
      readOnly: row ? rowBool(row.read_only) || isReadOnlyVenue(exchange) : isReadOnlyVenue(exchange),
      requiresPassphrase: requiresPassphrase(exchange),
      readOnlyVenue: isReadOnlyVenue(exchange),
      label: row ? rowStr(row.label, "") || null : null,
      walletAddressMasked,
      lastVerifiedAt: row ? rowNum(row.last_verified_at, 0) || null : null,
      lastError: row ? rowStr(row.last_error, "") || null : null,
    };
  });
}

// ─── Mutations ──────────────────────────────────────────────────────────────

export interface SaveCredentialInput {
  exchange: ExchangeId;
  /** CEX: API key. DEX: public wallet address. */
  apiKey: string;
  /** CEX: API secret. DEX: wallet private key, or empty for read-only. */
  apiSecret: string;
  passphrase?: string;
  label?: string | null;
  readOnly: boolean;
  enabled: boolean;
}

/** Stores credentials encrypted. Throws when no password is configured. */
export function saveCredentials(input: SaveCredentialInput): void {
  if (!encryptionAvailable()) {
    throw new Error("APP_PASSWORD is not set; cannot store credentials");
  }
  if (!accountSupported(input.exchange)) {
    throw new Error(
      `${exchangeInfo(input.exchange).name} account access is not implemented in this app, ` +
        `so a credential for it would be unusable. Market data works without one.`,
    );
  }
  const kind = credentialKind(input.exchange);

  if (kind === "cex") {
    if (!input.apiSecret) throw new Error(`${input.exchange} requires an API secret`);
    if (requiresPassphrase(input.exchange) && !input.passphrase) {
      throw new Error(`${input.exchange} requires a passphrase`);
    }
  }

  const now = Date.now();
  const keyCipher = encryptSecret(input.apiKey);
  // An empty secret is stored as NULL rather than as the encryption of "": a
  // read-only DEX wallet genuinely has no private key, and NULL says that.
  const secretCipher = input.apiSecret ? encryptSecret(input.apiSecret) : null;
  const passCipher = input.passphrase ? encryptSecret(input.passphrase) : null;
  const walletCipher = kind === "dex" ? keyCipher : null;
  // A DEX wallet with no private key cannot sign, so it is read-only whatever the
  // caller asked for.
  const readOnly =
    input.readOnly || isReadOnlyVenue(input.exchange) || (kind === "dex" && !input.apiSecret);

  inTransaction((db) => {
    db.prepare(
      "INSERT INTO api_credentials (exchange, kind, api_key_cipher, api_secret_cipher, passphrase_cipher, wallet_address_cipher, key_tail, label, read_only, enabled, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(exchange) DO UPDATE SET kind = excluded.kind, api_key_cipher = excluded.api_key_cipher, " +
        "api_secret_cipher = excluded.api_secret_cipher, passphrase_cipher = excluded.passphrase_cipher, " +
        "wallet_address_cipher = excluded.wallet_address_cipher, key_tail = excluded.key_tail, label = excluded.label, " +
        "read_only = excluded.read_only, enabled = excluded.enabled, updated_at = excluded.updated_at, last_error = NULL",
    ).run(
      input.exchange,
      kind,
      keyCipher,
      secretCipher,
      passCipher,
      walletCipher,
      keyTail(input.apiKey),
      input.label?.trim() || null,
      readOnly ? 1 : 0,
      input.enabled ? 1 : 0,
      now,
      now,
    );
  });
}

export function setCredentialEnabled(exchange: ExchangeId, enabled: boolean): void {
  getDb()
    .prepare("UPDATE api_credentials SET enabled = ?, updated_at = ? WHERE exchange = ?")
    .run(enabled ? 1 : 0, Date.now(), exchange);
}

export function deleteCredentials(exchange: ExchangeId): void {
  getDb().prepare("DELETE FROM api_credentials WHERE exchange = ?").run(exchange);
}

export function recordVerification(
  exchange: ExchangeId,
  ok: boolean,
  error?: string | null,
): void {
  getDb()
    .prepare(
      "UPDATE api_credentials SET last_verified_at = ?, last_error = ?, updated_at = ? WHERE exchange = ?",
    )
    .run(ok ? Date.now() : null, ok ? null : (error ?? "verification failed"), Date.now(), exchange);
}

/** Venues that currently have usable credentials, for the private streams. */
export function credentialedExchanges(): ExchangeId[] {
  return EXCHANGE_IDS.filter((id) => getCredentials(id) !== null);
}

/** Venues of one kind with usable credentials, for the split account views. */
export function credentialedExchangesOfKind(kind: CredentialKind): ExchangeId[] {
  return credentialedExchanges().filter((id) => credentialKind(id) === kind);
}

/** Display name, re-exported so callers do not import two modules for one row. */
export function credentialVenueName(exchange: ExchangeId): string {
  return exchangeInfo(exchange).name;
}
