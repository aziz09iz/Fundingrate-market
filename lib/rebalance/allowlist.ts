import type { ExchangeId, NetworkId, TransferToken } from "@/lib/types";
import { isNetworkId, isTransferToken } from "@/lib/rebalance/chains";
import {
  destinationFor,
  destinationRecords,
  maskAddress,
  type DestinationRecord,
} from "@/lib/db/destinations";

/**
 * The withdrawal allowlist.
 *
 * A withdrawal cannot be reversed, so this module exists to make "where can funds
 * go" a single, deliberate answer. Three rules hold regardless of where the data
 * is stored:
 *
 *   1. `resolveDestination` is the only function that may produce an address for a
 *      withdrawal request.
 *   2. An unconfirmed destination is not a destination. Saving an address does not
 *      arm it; an explicit confirm step does.
 *   3. When the destination venue reports its own deposit address, it must match.
 *      A mismatch means the venue rotated the address or the configuration is
 *      stale, and sending is the wrong move in both cases. Callers are expected to
 *      pass `venueReportedAddress`; a stored mismatch is refused regardless, so a
 *      caller that cannot ask the venue still cannot send to a known-bad address.
 *
 * Destinations now live in the database and are managed from the dashboard, which
 * is a real widening of what a compromised session can do compared with the
 * previous env-only scheme. Rules 2 and 3 are what that widening is paid for with.
 */

export interface AllowlistEntry {
  exchange: ExchangeId;
  token: TransferToken;
  network: NetworkId;
  address: string;
  memo?: string;
}

function toEntry(record: DestinationRecord): AllowlistEntry {
  return {
    exchange: record.exchange,
    token: record.token,
    network: record.network,
    address: record.address,
    memo: record.memo ?? undefined,
  };
}

/**
 * One armed destination for a route, or null. Unconfirmed rows are deliberately
 * invisible here: callers of this function are asking "can funds go there", and
 * the answer for an unconfirmed row is no.
 */
export function allowlistEntry(
  exchange: ExchangeId,
  token: TransferToken,
  network: NetworkId,
): AllowlistEntry | null {
  const record = destinationFor(exchange, token, network);
  if (!record || !record.confirmed) return null;
  return toEntry(record);
}

/** Every armed destination, for the UI to show what is possible. */
export function allowlist(): AllowlistEntry[] {
  return destinationRecords()
    .filter((record) => record.confirmed)
    .map(toEntry);
}

/** Venues that can receive funds, i.e. have at least one armed destination. */
export function allowlistedDestinations(): ExchangeId[] {
  const seen = new Set<ExchangeId>();
  for (const entry of allowlist()) seen.add(entry.exchange);
  return [...seen];
}

export class AllowlistViolation extends Error {}

/**
 * Resolves the destination for a transfer, or throws.
 *
 * `venueReportedAddress` is what the destination venue says its deposit address
 * is. When supplied it must match exactly.
 */
export function resolveDestination(input: {
  exchange: ExchangeId;
  token: TransferToken;
  network: NetworkId;
  venueReportedAddress?: string | null;
}): AllowlistEntry {
  if (!isTransferToken(input.token)) {
    throw new AllowlistViolation(`Unsupported token: ${String(input.token)}`);
  }
  if (!isNetworkId(input.network)) {
    throw new AllowlistViolation(`Unsupported network: ${String(input.network)}`);
  }

  const record = destinationFor(input.exchange, input.token, input.network);
  if (!record) {
    throw new AllowlistViolation(
      `No destination is configured for ${input.exchange} ${input.token} on ${input.network}. ` +
        `Add it under Treasury Rebalancing → Destinations.`,
    );
  }
  // Separate message from "not configured": an operator who entered the address
  // but never armed it needs to be told about the confirm step, not sent back to
  // re-enter what is already there.
  if (!record.confirmed) {
    throw new AllowlistViolation(
      `The ${input.exchange} ${input.token}/${input.network} destination is saved but not confirmed. ` +
        `Confirm it under Treasury Rebalancing → Destinations before sending.`,
    );
  }

  // A mismatch is refused rather than warned about, and a destination whose
  // stored verification already says "mismatch" is refused before the venue is
  // even asked again: that flag was written by this same comparison, and the only
  // fix is re-entering the address, not retrying the send.
  if (record.verifiedMatch === false) {
    throw new AllowlistViolation(
      `The ${input.exchange} ${input.token}/${input.network} destination failed its last venue cross-check. ` +
        `Re-verify it under Treasury Rebalancing → Destinations, and re-enter the address if the venue really changed it.`,
    );
  }

  const reported = input.venueReportedAddress?.trim();
  if (reported && reported !== record.address) {
    throw new AllowlistViolation(
      `${input.exchange} reports a different ${input.token}/${input.network} deposit address than the one stored ` +
        `(${maskAddress(record.address)}). Refusing to send. Verify the address on the venue and update the destination if it really changed.`,
    );
  }

  return toEntry(record);
}
export { maskAddress };
