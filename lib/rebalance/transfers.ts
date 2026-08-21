import { randomUUID } from "node:crypto";
import type { ExchangeId, NetworkId, TransferRecord, TransferToken } from "@/lib/types";
import { privateAdapter } from "@/lib/private";
import { getCredentials } from "@/lib/db/credentials";
import { completeAudit, recordAudit } from "@/lib/db/audit";
import {
  insertTransfer,
  transferById,
  updateTransfer,
} from "@/lib/db/rebalance";
import { AllowlistViolation, resolveDestination } from "@/lib/rebalance/allowlist";
import { venueChainFor } from "@/lib/rebalance/wallets";
import { notifyTransfer } from "@/lib/notify/dispatch";
import { exchangeName } from "@/lib/utils";

/**
 * Transfer execution — the only code in this app that moves funds off an
 * exchange.
 *
 * An on-chain withdrawal cannot be recalled, so the ordering here is deliberate:
 *
 *   1. Resolve the destination from the confirmed destination allowlist. If the
 *      venue reports a different deposit address, refuse rather than warn.
 *   2. Confirm the source venue still offers this chain, and read its live fee
 *      and minimum. Never trust a fee the caller supplied.
 *   3. Write the intent to the database and the audit log *before* any request.
 *   4. Move funds futures → funding inside the source venue.
 *   5. Withdraw on-chain.
 *
 * A failure between 4 and 5 leaves money in the source venue's funding wallet,
 * which is recoverable. That is why `stage` is persisted: it tells you where the
 * money actually is.
 */

const REQUEST_TIMEOUT_MS = 30_000;
/** Time allowed for the internal transfer to land before withdrawing. */
const SETTLE_POLL_MS = 1_500;
const SETTLE_ATTEMPTS = 12;
/**
 * Budget for the destination cross-check. Deliberately short: it runs before
 * anything is sent, and a slow venue should not hold up a transfer for the full
 * request timeout when the result is advisory unless it comes back as a mismatch.
 */
const VERIFY_TIMEOUT_MS = 10_000;

export class TransferRejected extends Error {}

/**
 * What the destination venue said about its own deposit address.
 *
 * `verified` is tri-state on purpose. A mismatch is positive evidence something
 * is wrong and refuses the transfer; a venue that cannot be asked is no evidence
 * at all, and refusing there would make transfers impossible to any venue whose
 * adapter has no deposit-address read. The distinction is recorded so history
 * shows which transfers went out without a cross-check.
 */
export interface AddressCheck {
  verified: boolean | null;
  note: string | null;
}

export interface ExecuteTransferInput {
  from: ExchangeId;
  to: ExchangeId;
  token: TransferToken;
  network: NetworkId;
  amount: number;
  /** True when the automation initiated this rather than a person. */
  auto?: boolean;
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks the destination venue what its own deposit address is for this route.
 *
 * Returns the address for `resolveDestination` to compare, or null when the venue
 * cannot be asked — no adapter support, no credentials, or a failed read. The
 * caller decides what to do with each case; this only reports.
 */
async function readVenueAddress(
  exchange: ExchangeId,
  token: TransferToken,
  network: NetworkId,
): Promise<{ address: string | null; note: string | null }> {
  const adapter = privateAdapter(exchange);
  if (!adapter || typeof adapter.fetchDepositAddress !== "function") {
    return {
      address: null,
      note: `${exchangeName(exchange)} does not expose a deposit-address read in this app, so the stored address could not be cross-checked.`,
    };
  }
  // A destination venue may legitimately have no credentials: it only has to
  // receive. Reading its deposit address needs them, so this is expected rather
  // than a misconfiguration.
  const creds = getCredentials(exchange);
  if (!creds) {
    return {
      address: null,
      note: `No ${exchangeName(exchange)} credentials, so its deposit address could not be read for a cross-check.`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const reported = await adapter.fetchDepositAddress(
      creds,
      { token, network },
      controller.signal,
    );
    if (!reported) {
      return {
        address: null,
        note: `${exchangeName(exchange)} reported no ${token} deposit address on ${network}, so no cross-check was possible.`,
      };
    }
    return { address: reported.address.trim(), note: null };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      address: null,
      note: `The ${exchangeName(exchange)} deposit-address read failed, so no cross-check was possible: ${detail}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every precondition that can be checked without sending anything. Exported so
 * a dry run can report exactly what a real attempt would do or refuse.
 */
export async function prepareTransfer(input: ExecuteTransferInput): Promise<{
  address: string;
  memo: string | null;
  venueChain: string;
  fee: number;
  minAmount: number;
  addressCheck: AddressCheck;
}> {
  if (input.from === input.to) {
    throw new TransferRejected("Source and destination must be different venues");
  }
  if (!(input.amount > 0)) throw new TransferRejected("Amount must be positive");

  // The destination is checked first, before credentials or venue capability.
  // Where funds would go is the property worth failing on earliest, and checking
  // it first means the allowlist is provably the gate regardless of what else is
  // configured.
  //
  // The venue is asked for its own deposit address here rather than trusting the
  // stored verification: that check may be days old, and a venue can rotate an
  // address at any time. resolveDestination refuses on a mismatch.
  const venueReported = await readVenueAddress(input.to, input.token, input.network);
  const destination = resolveDestination({
    exchange: input.to,
    token: input.token,
    network: input.network,
    venueReportedAddress: venueReported.address,
  });
  const addressCheck: AddressCheck = {
    verified: venueReported.address === null ? null : true,
    note: venueReported.note,
  };

  const adapter = privateAdapter(input.from);
  if (!adapter?.supportsWallet) {
    throw new TransferRejected(
      `${exchangeName(input.from)} transfers are not implemented in this app.`,
    );
  }
  if (typeof adapter.internalTransfer !== "function" || typeof adapter.withdraw !== "function") {
    throw new TransferRejected(`${exchangeName(input.from)} withdrawal is not implemented.`);
  }
  const creds = getCredentials(input.from);
  if (!creds) throw new TransferRejected(`No credentials configured for ${input.from}`);
  if (creds.readOnly) {
    throw new TransferRejected(
      `${exchangeName(input.from)} credentials are marked read-only. Transfers are refused.`,
    );
  }

  const chain = await venueChainFor({
    exchange: input.from,
    token: input.token,
    network: input.network,
  });
  if (!chain) {
    throw new TransferRejected(
      `${exchangeName(input.from)} does not offer ${input.token} on ${input.network}, or the chain could not be identified.`,
    );
  }
  if (!chain.enabled) {
    throw new TransferRejected(
      `${exchangeName(input.from)} has ${input.token} withdrawals paused on ${input.network}.`,
    );
  }
  if (chain.minAmount > 0 && input.amount < chain.minAmount) {
    throw new TransferRejected(
      `Below the ${input.network} minimum of ${chain.minAmount} ${input.token}.`,
    );
  }
  if (chain.fee >= input.amount) {
    throw new TransferRejected(
      `The ${chain.fee} ${input.token} network fee is not covered by a ${input.amount} transfer.`,
    );
  }

  return {
    address: destination.address,
    memo: destination.memo ?? null,
    venueChain: chain.venueChain,
    fee: chain.fee,
    minAmount: chain.minAmount,
    addressCheck,
  };
}

/**
 * Executes a transfer. Real funds leave the venue when this succeeds.
 */
export async function executeTransfer(input: ExecuteTransferInput): Promise<TransferRecord> {
  const prepared = await prepareTransfer(input);
  const adapter = privateAdapter(input.from);
  const creds = getCredentials(input.from);
  if (!adapter || !creds) throw new TransferRejected("Credentials disappeared mid-request");

  const id = `TRF-${randomUUID().slice(0, 8)}`;
  const clientTransferId = `frw${Date.now().toString(36)}${randomUUID().replace(/-/g, "").slice(0, 8)}`;

  // Audit and persist before anything is sent. The address is recorded because
  // for an irreversible transfer, where it went is the single most important
  // fact; the audit layer redacts secrets but an address is not a secret.
  const auditId = recordAudit({
    action: "rebalance.transfer",
    exchange: input.from,
    payload: {
      to: input.to,
      token: input.token,
      network: input.network,
      venueChain: prepared.venueChain,
      amount: input.amount,
      fee: prepared.fee,
      address: prepared.address,
      // Whether the destination venue vouched for the address is part of what was
      // known at the moment of sending, so it belongs in the audit trail.
      addressVerified: prepared.addressCheck.verified,
      addressVerifyNote: prepared.addressCheck.note,
      auto: input.auto === true,
      transferId: id,
    },
    outcome: "submitting",
  });

  insertTransfer({
    id,
    from: input.from,
    to: input.to,
    token: input.token,
    network: input.network,
    venueChain: prepared.venueChain,
    amount: input.amount,
    fee: prepared.fee,
    address: prepared.address,
    memo: prepared.memo,
    auto: input.auto,
    addressVerified: prepared.addressCheck.verified,
    addressVerifyNote: prepared.addressCheck.note,
  });

  // ── Step 1: futures → funding inside the source venue ──
  try {
    await withTimeout((signal) =>
      adapter.internalTransfer!(
        creds,
        { asset: input.token, amount: input.amount, from: "futures", to: "funding" },
        signal,
      ),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // A failure here means nothing left the venue at all.
    updateTransfer(id, { status: "failed", stage: "internal", error: detail });
    completeAudit(auditId, "failed-internal", detail);
    void notifyTransfer({
      from: input.from,
      to: input.to,
      token: input.token,
      amount: input.amount,
      network: input.network,
      auto: input.auto === true,
      error: `Internal transfer to the funding wallet failed: ${detail}`,
    });
    throw new TransferRejected(`Internal transfer to the funding wallet failed: ${detail}`);
  }

  updateTransfer(id, { stage: "withdraw", status: "processing" });

  // Give the venue a moment to credit the funding wallet; withdrawing too early
  // is rejected for insufficient balance even though the funds are in transit.
  await waitForFunding(input, adapter, creds);

  // ── Step 2: on-chain withdrawal ──
  try {
    const result = await withTimeout((signal) =>
      adapter.withdraw!(
        creds,
        {
          asset: input.token,
          amount: input.amount,
          network: input.network,
          venueChain: prepared.venueChain,
          address: prepared.address,
          memo: prepared.memo,
          clientTransferId,
        },
        signal,
      ),
    );
    updateTransfer(id, {
      status: "processing",
      stage: "withdraw",
      venueWithdrawId: result.venueWithdrawId,
    });
    completeAudit(auditId, "submitted");
    void notifyTransfer({
      from: input.from,
      to: input.to,
      token: input.token,
      amount: input.amount,
      network: input.network,
      auto: input.auto === true,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Money is now in the source venue's funding wallet: not lost, but moved.
    updateTransfer(id, {
      status: "failed",
      stage: "withdraw",
      error: `${detail} — funds are in the ${exchangeName(input.from)} funding wallet, not withdrawn.`,
    });
    completeAudit(auditId, "failed-withdraw", detail);
    void notifyTransfer({
      from: input.from,
      to: input.to,
      token: input.token,
      amount: input.amount,
      network: input.network,
      auto: input.auto === true,
      error:
        `Withdrawal failed after the internal transfer succeeded — ${input.amount} ${input.token} ` +
        `is in the ${exchangeName(input.from)} funding wallet. ${detail}`,
    });
    throw new TransferRejected(
      `Withdrawal failed after the internal transfer succeeded. ` +
        `${input.amount} ${input.token} is sitting in the ${exchangeName(input.from)} funding wallet. ${detail}`,
    );
  }

  const record = transferById(id);
  if (!record) throw new Error("transfer was not persisted");
  return record;
}

/**
 * Polls the funding wallet until the internal transfer is visible. Returns
 * regardless after the attempt budget: the withdrawal call is the real
 * authority on whether the balance is sufficient, and it fails safely.
 */
async function waitForFunding(
  input: ExecuteTransferInput,
  adapter: NonNullable<ReturnType<typeof privateAdapter>>,
  creds: NonNullable<ReturnType<typeof getCredentials>>,
): Promise<void> {
  if (typeof adapter.fetchWalletBalances !== "function") return;
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    try {
      const rows = await withTimeout((signal) => adapter.fetchWalletBalances!(creds, signal));
      const available = rows
        .filter((r) => r.asset.toUpperCase() === input.token)
        .reduce((sum, r) => sum + r.available, 0);
      if (available + 1e-8 >= input.amount) return;
    } catch {
      // A transient read failure is not a reason to abort a transfer that has
      // already moved funds internally.
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
}

export { AllowlistViolation };
