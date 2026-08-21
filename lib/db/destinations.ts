import { randomUUID } from "node:crypto";
import type { AllowlistedDestination, ExchangeId, NetworkId, TransferToken } from "@/lib/types";
import { getDb, rowBool, rowNum, rowStr } from "@/lib/db/client";
import { decryptSecret, encryptSecret, encryptionAvailable } from "@/lib/db/secrets";

/**
 * Withdrawal destinations, stored encrypted.
 *
 * This is the single source of truth for where funds may be sent. It used to be
 * env-only, on the argument that a bug anywhere in the app must not be able to
 * introduce a new destination. Moving it into the database keeps that property
 * through a different mechanism:
 *
 *   · a row is inert until `confirmed` is set, and only an authenticated
 *     dashboard action sets it;
 *   · the address is written once and never returned to the browser in full;
 *   · `resolveDestination` is still the only function that can produce an address
 *     for a withdrawal, and it refuses anything unconfirmed.
 *
 * The trade-off is honest: a dashboard session can now add a destination where
 * previously a shell and a restart were required. That is what was asked for, and
 * the confirm step plus the venue-address cross-check are what keep it from being
 * a one-click mistake.
 */

export interface DestinationRecord {
  id: string;
  exchange: ExchangeId;
  token: TransferToken;
  network: NetworkId;
  address: string;
  memo: string | null;
  label: string | null;
  confirmed: boolean;
  verifiedAt: number | null;
  verifiedAddressTail: string | null;
  /** The server's full-string comparison: true matched, false differed, null never asked. */
  verifiedMatch: boolean | null;
  lastError: string | null;
}

interface DestinationRow {
  id?: unknown;
  exchange?: unknown;
  token?: unknown;
  network?: unknown;
  address_cipher?: unknown;
  address_tail?: unknown;
  memo_cipher?: unknown;
  label?: unknown;
  confirmed?: unknown;
  verified_at?: unknown;
  verified_address_tail?: unknown;
  verified_match?: unknown;
  last_error?: unknown;
}

/**
 * How long a venue cross-check is treated as current.
 *
 * A venue can rotate a deposit address at any time, so a check from months ago is
 * evidence about a different address than the one that would receive funds today.
 * Seven days is short enough to catch a rotation and long enough not to demand a
 * re-verify on every transfer.
 */
export const VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Masks an address for display so a full string is never shown by default. */
export function maskAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function addressTail(address: string): string {
  return address.length <= 4 ? address : address.slice(-4);
}

/**
 * Reads the stored tri-state cross-check result.
 *
 * Falls back to the timestamp for rows written before verified_match existed:
 * only a successful comparison sets verified_at, so its presence with no error is
 * a match. Deliberately never compares address tails — two different addresses
 * can share their last four characters, and reading that as verified is exactly
 * the failure this column exists to prevent.
 */
function readVerifiedMatch(row: DestinationRow): boolean | null {
  if (row.verified_match === null || row.verified_match === undefined) {
    if (rowNum(row.verified_at, 0) > 0 && !rowStr(row.last_error, "")) return true;
    return null;
  }
  return rowBool(row.verified_match);
}

/**
 * Decrypts a row into a usable record, or null when the secret cannot be read.
 *
 * A missing password makes every stored address unreadable, which is the safe
 * failure mode: no destination resolves, so nothing is sent.
 */
function toRecord(row: DestinationRow): DestinationRecord | null {
  try {
    const memoCipher = rowStr(row.memo_cipher, "");
    return {
      id: rowStr(row.id),
      exchange: rowStr(row.exchange) as ExchangeId,
      token: rowStr(row.token) as TransferToken,
      network: rowStr(row.network) as NetworkId,
      address: decryptSecret(rowStr(row.address_cipher)),
      memo: memoCipher ? decryptSecret(memoCipher) : null,
      label: rowStr(row.label, "") || null,
      confirmed: rowBool(row.confirmed),
      verifiedAt: rowNum(row.verified_at, 0) || null,
      verifiedAddressTail: rowStr(row.verified_address_tail, "") || null,
      verifiedMatch: readVerifiedMatch(row),
      lastError: rowStr(row.last_error, "") || null,
    };
  } catch {
    return null;
  }
}

/** Every stored destination, decrypted. Server-only. */
export function destinationRecords(): DestinationRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM rebalance_destinations ORDER BY exchange, token, network")
    .all() as DestinationRow[];
  return rows
    .map(toRecord)
    .filter((entry): entry is DestinationRecord => entry !== null);
}

/**
 * One destination for a route, or null. Unconfirmed rows are returned here so the
 * UI can show them; `resolveDestination` is what refuses to use them.
 */
export function destinationFor(
  exchange: ExchangeId,
  token: TransferToken,
  network: NetworkId,
): DestinationRecord | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM rebalance_destinations WHERE exchange = ? AND token = ? AND network = ?",
    )
    .get(exchange, token, network) as DestinationRow | undefined;
  return row ? toRecord(row) : null;
}

/** The masked view the browser is allowed to see. */
export function destinationStatuses(): AllowlistedDestination[] {
  const rows = getDb()
    .prepare("SELECT * FROM rebalance_destinations ORDER BY exchange, token, network")
    .all() as DestinationRow[];

  return rows.map((row) => {
    const record = toRecord(row);
    const tail = rowStr(row.address_tail, "");
    const verifiedAt = rowNum(row.verified_at, 0) || null;
    const verifiedMatch = readVerifiedMatch(row);
    return {
      id: rowStr(row.id),
      exchange: rowStr(row.exchange) as ExchangeId,
      token: rowStr(row.token) as TransferToken,
      network: rowStr(row.network) as NetworkId,
      // A row whose address cannot be decrypted still shows its tail, so the
      // operator can tell which route is broken rather than seeing it vanish.
      addressMasked: record ? maskAddress(record.address) : `••••${tail}`,
      requiresMemo: rowStr(row.memo_cipher, "").length > 0,
      label: rowStr(row.label, "") || null,
      confirmed: rowBool(row.confirmed),
      verifiedAt,
      verifiedMatch,
      // A match old enough that the venue could have rotated the address since is
      // reported separately rather than downgraded to "unchecked": the operator
      // needs to know a check happened and when, not just that it is not current.
      verifiedStale:
        verifiedMatch === true && verifiedAt !== null
          ? Date.now() - verifiedAt > VERIFICATION_TTL_MS
          : false,
      lastError: record
        ? rowStr(row.last_error, "") || null
        : "Stored address cannot be decrypted. Re-enter it, or restore the original APP_PASSWORD.",
    };
  });
}

export interface SaveDestinationInput {
  exchange: ExchangeId;
  token: TransferToken;
  network: NetworkId;
  address: string;
  memo?: string | null;
  label?: string | null;
}

/**
 * Creates or replaces a destination.
 *
 * A saved row always starts unconfirmed, including when it overwrites a confirmed
 * one: changing the address is exactly the moment the previous confirmation stops
 * meaning anything.
 */
export function saveDestination(input: SaveDestinationInput): DestinationRecord {
  if (!encryptionAvailable()) {
    throw new Error("APP_PASSWORD is not set; cannot store a withdrawal destination");
  }
  const address = input.address.trim();
  if (!address) throw new Error("Address cannot be empty");

  const now = Date.now();
  const existing = getDb()
    .prepare("SELECT id FROM rebalance_destinations WHERE exchange = ? AND token = ? AND network = ?")
    .get(input.exchange, input.token, input.network) as { id?: unknown } | undefined;
  const id = existing ? rowStr(existing.id) : `DST-${randomUUID().slice(0, 8)}`;
  const memo = input.memo?.trim() || null;
  const label = input.label?.trim() || null;

  getDb()
    .prepare(
      "INSERT INTO rebalance_destinations (id, exchange, token, network, address_cipher, address_tail, memo_cipher, label, confirmed, verified_at, verified_address_tail, verified_match, last_error, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, ?, ?) " +
        "ON CONFLICT(exchange, token, network) DO UPDATE SET address_cipher = excluded.address_cipher, address_tail = excluded.address_tail, " +
        "memo_cipher = excluded.memo_cipher, label = excluded.label, confirmed = 0, verified_at = NULL, " +
        "verified_address_tail = NULL, verified_match = NULL, last_error = NULL, updated_at = excluded.updated_at",
    )
    .run(
      id,
      input.exchange,
      input.token,
      input.network,
      encryptSecret(address),
      addressTail(address),
      memo ? encryptSecret(memo) : null,
      label,
      now,
      now,
    );

  const saved = destinationFor(input.exchange, input.token, input.network);
  if (!saved) throw new Error("Destination was saved but could not be read back");
  return saved;
}

/** Arms or disarms a destination. Disarming takes effect immediately. */
export function setDestinationConfirmed(id: string, confirmed: boolean): void {
  getDb()
    .prepare("UPDATE rebalance_destinations SET confirmed = ?, updated_at = ? WHERE id = ?")
    .run(confirmed ? 1 : 0, Date.now(), id);
}

export function deleteDestination(id: string): void {
  getDb().prepare("DELETE FROM rebalance_destinations WHERE id = ?").run(id);
}

export function destinationById(id: string): DestinationRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM rebalance_destinations WHERE id = ?")
    .get(id) as DestinationRow | undefined;
  return row ? toRecord(row) : null;
}

/**
 * Records what the venue said its own deposit address is.
 *
 * The address is stored as a tail rather than in full: it is only ever compared
 * against our own, and keeping a second copy serves no purpose. `match` carries
 * the comparison the caller already performed on the full strings, so no reader
 * has to re-derive it from four characters.
 */
export function recordDestinationVerification(
  id: string,
  venueAddressTail: string | null,
  error: string | null,
  match: boolean | null = error === null ? true : null,
): void {
  getDb()
    .prepare(
      "UPDATE rebalance_destinations SET verified_at = ?, verified_address_tail = ?, verified_match = ?, last_error = ?, updated_at = ? WHERE id = ?",
    )
    .run(
      error === null ? Date.now() : null,
      venueAddressTail,
      match === null ? null : match ? 1 : 0,
      error,
      Date.now(),
      id,
    );
}
