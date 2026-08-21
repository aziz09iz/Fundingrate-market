import { requireAuth } from "@/lib/auth/guard";
import {
  claimIdempotencyKey,
  releaseIdempotencyKey,
  storeIdempotentResponse,
} from "@/lib/db/audit";
import { transfers } from "@/lib/db/rebalance";
import { AllowlistViolation } from "@/lib/rebalance/allowlist";
import { isNetworkId, isTransferToken } from "@/lib/rebalance/chains";
import {
  TransferRejected,
  executeTransfer,
  prepareTransfer,
} from "@/lib/rebalance/transfers";
import { maskAddress } from "@/lib/rebalance/allowlist";
import {
  asObject,
  handleRouteError,
  jsonError,
  jsonOk,
  requireBoolean,
  requireExchange,
  requirePositive,
  requireString,
  ValidationError,
} from "@/lib/api/validate";

/**
 * Sends a cross-exchange transfer. This moves real funds and cannot be undone.
 *
 * Three safety properties are enforced here rather than trusted from the client:
 *   - `Idempotency-Key` is mandatory, so a retry or double click cannot send twice.
 *   - The destination address is resolved from the armed destination allowlist
 *     inside the service; the request body cannot specify where funds go.
 *   - The destination venue is asked for its own deposit address and a mismatch
 *     refuses the transfer, so an address the venue has rotated cannot be used.
 *
 * `dryRun: true` runs every precondition and reports what would happen without
 * sending anything.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  let idempotencyKey: string | null = null;
  try {
    const parsed = asObject(await request.json());
    const dryRun = requireBoolean(parsed.dryRun);

    const from = requireExchange(parsed.from);
    const to = requireExchange(parsed.to);
    const token = parsed.token;
    if (!isTransferToken(token)) throw new ValidationError("token must be USDT or USDC");
    const network = parsed.network;
    if (!isNetworkId(network)) throw new ValidationError("network is not a supported chain");
    const amount = requirePositive(parsed.amount, "amount", 1e7);

    if (dryRun) {
      // Reports the venue's live fee and the resolved destination, masked. The
      // address cross-check runs here too, so the confirmation the operator sees
      // already reflects whether the venue vouched for the address.
      const prepared = await prepareTransfer({ from, to, token, network, amount });
      return jsonOk({
        ok: true,
        dryRun: true,
        fee: prepared.fee,
        minAmount: prepared.minAmount,
        received: Number((amount - prepared.fee).toFixed(8)),
        venueChain: prepared.venueChain,
        addressMasked: maskAddress(prepared.address),
        requiresMemo: prepared.memo !== null,
        addressVerified: prepared.addressCheck.verified,
        addressVerifyNote: prepared.addressCheck.note,
      });
    }

    idempotencyKey = requireString(
      request.headers.get("idempotency-key") ?? parsed.idempotencyKey,
      "Idempotency-Key",
      120,
    );
    const cached = claimIdempotencyKey(idempotencyKey, "rebalance.transfer");
    if (cached !== null) {
      return new Response(cached || JSON.stringify({ duplicate: true }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    const record = await executeTransfer({ from, to, token, network, amount });
    const payload = { transfer: record };
    storeIdempotentResponse(idempotencyKey, payload);
    return jsonOk({ ...payload, transfers: transfers(50) });
  } catch (err) {
    // Freeing the key lets the same intent be retried after a rejection.
    if (idempotencyKey) releaseIdempotencyKey(idempotencyKey);
    if (err instanceof AllowlistViolation) return jsonError(err.message, 403);
    if (err instanceof TransferRejected) return jsonError(err.message, 409);
    return handleRouteError(err);
  }
}
