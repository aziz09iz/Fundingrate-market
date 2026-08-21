import { requireAuth } from "@/lib/auth/guard";
import { privateAdapter } from "@/lib/private";
import { getCredentials } from "@/lib/db/credentials";
import {
  deleteDestination,
  destinationById,
  destinationStatuses,
  recordDestinationVerification,
  saveDestination,
  setDestinationConfirmed,
} from "@/lib/db/destinations";
import { encryptionAvailable } from "@/lib/db/secrets";
import { isNetworkId, isTransferToken } from "@/lib/rebalance/chains";
import { recordAudit } from "@/lib/db/audit";
import {
  asObject,
  handleRouteError,
  jsonError,
  jsonOk,
  optionalExactString,
  optionalString,
  requireBoolean,
  requireExchange,
  requireString,
} from "@/lib/api/validate";

/**
 * Withdrawal destinations.
 *
 * These used to be environment-only, on the argument that a bug must not be able
 * to introduce a place funds can go. Managing them here keeps that guarantee
 * through a two-step flow instead: `save` stores an address but leaves it inert,
 * and only `confirm` arms it. Nothing — manual or automated — resolves against an
 * unconfirmed row.
 *
 * `verify` asks the destination venue for its own deposit address and compares.
 * That is the check that catches a venue rotating an address, and the one that
 * catches a typo before it costs anything.
 *
 * Addresses are never returned in full. GET yields masked values only.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    return jsonOk({
      destinations: destinationStatuses(),
      encryptionAvailable: encryptionAvailable(),
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const parsed = asObject(await request.json());
    const action = typeof parsed.action === "string" ? parsed.action : "save";

    if (action === "delete") {
      const id = requireString(parsed.id, "id", 40);
      const record = destinationById(id);
      if (!record) return jsonError("No such destination", 404);
      deleteDestination(id);
      recordAudit({
        action: "rebalance.destination.delete",
        exchange: record.exchange,
        payload: { token: record.token, network: record.network },
        outcome: "deleted",
      });
      return jsonOk({ destinations: destinationStatuses() });
    }

    if (action === "confirm") {
      const id = requireString(parsed.id, "id", 40);
      const confirmed = requireBoolean(parsed.confirmed, true);
      const record = destinationById(id);
      if (!record) return jsonError("No such destination", 404);
      // Arming a destination the venue has contradicted is refused here rather
      // than only discouraged in the dialog: the UI can be bypassed, and the flag
      // was written by a full-string comparison the operator cannot see. Disarming
      // is always allowed — removing a capability never needs a gate.
      if (confirmed && record.verifiedMatch === false) {
        return jsonError(
          `${record.exchange} reported a different ${record.token} deposit address on ${record.network} at the last check. ` +
            `Re-verify this destination, and re-enter the address if the venue really rotated it. Arming is refused until they agree.`,
          409,
        );
      }
      setDestinationConfirmed(id, confirmed);
      // Arming a withdrawal target is the single most consequential thing on this
      // page, so it is audited on its own rather than folded into the save.
      recordAudit({
        action: "rebalance.destination.confirm",
        exchange: record.exchange,
        payload: {
          token: record.token,
          network: record.network,
          confirmed,
          // Records whether the operator armed against a verified address or on
          // their own assurance, which is the difference that matters later.
          verifiedMatch: record.verifiedMatch,
        },
        outcome: confirmed ? "armed" : "disarmed",
      });
      return jsonOk({ destinations: destinationStatuses() });
    }

    if (action === "verify") {
      const id = requireString(parsed.id, "id", 40);
      const record = destinationById(id);
      if (!record) return jsonError("No such destination", 404);

      const adapter = privateAdapter(record.exchange);
      const creds = getCredentials(record.exchange);
      if (!creds) {
        const message = `No credentials for ${record.exchange}, so its deposit address cannot be read.`;
        recordDestinationVerification(id, null, message, null);
        return jsonOk({ ok: false, error: message, destinations: destinationStatuses() });
      }
      if (typeof adapter.fetchDepositAddress !== "function") {
        const message = `${record.exchange} does not expose a deposit-address read in this app, so the address cannot be cross-checked automatically. Verify it on the venue before confirming.`;
        recordDestinationVerification(id, null, message, null);
        return jsonOk({ ok: false, error: message, destinations: destinationStatuses() });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const reported = await adapter.fetchDepositAddress(
          creds,
          { token: record.token, network: record.network },
          controller.signal,
        );
        const match = reported !== null && reported.address.trim() === record.address;
        const tail = reported ? reported.address.trim().slice(-4) : null;
        recordDestinationVerification(
          id,
          tail,
          match
            ? null
            : reported === null
              ? `${record.exchange} returned no ${record.token} deposit address on ${record.network}.`
              : `${record.exchange} reports a different deposit address (ending ${tail}). Do not confirm this destination until they agree.`,
          // A venue that returned nothing has not contradicted the address, so it
          // stays "unchecked" rather than being recorded as a mismatch that would
          // block arming.
          match ? true : reported === null ? null : false,
        );
        return jsonOk({ ok: match, destinations: destinationStatuses() });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        recordDestinationVerification(id, null, message, null);
        return jsonOk({ ok: false, error: message, destinations: destinationStatuses() });
      } finally {
        clearTimeout(timer);
      }
    }

    // action === "save"
    if (!encryptionAvailable()) {
      return jsonError(
        "APP_PASSWORD is not set on the server, so an address cannot be encrypted. Set it in .env.local and restart.",
        503,
      );
    }

    const exchange = requireExchange(parsed.exchange);
    const token = parsed.token;
    if (!isTransferToken(token)) return jsonError(`Unsupported token: ${String(token)}`, 400);
    const network = parsed.network;
    if (!isNetworkId(network)) return jsonError(`Unsupported network: ${String(network)}`, 400);

    // Address charset is checked but the format is not tied to a chain: an
    // over-strict pattern that rejects a valid address is a worse failure than a
    // permissive one, because the venue rejects a malformed address anyway and the
    // confirm plus verify steps stand between this and a send.
    const address = requireString(parsed.address, "address", 128);
    if (!/^[A-Za-z0-9:_-]+$/.test(address)) {
      return jsonError("Address contains characters no supported chain uses.", 400);
    }
    const memo = optionalExactString(parsed.memo, "memo", 64) ?? null;
    const label = optionalString(parsed.label, 60) ?? null;

    const saved = saveDestination({ exchange, token, network, address, memo, label });
    recordAudit({
      action: "rebalance.destination.save",
      exchange,
      // The address is recorded by tail only: the audit log is readable from the
      // database, and a full address there would undo storing it encrypted.
      payload: { token, network, addressTail: address.slice(-4), hasMemo: memo !== null },
      outcome: "saved-unconfirmed",
    });

    return jsonOk({ destination: saved.id, destinations: destinationStatuses() });
  } catch (err) {
    return handleRouteError(err);
  }
}
