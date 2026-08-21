import type {
  ExchangeBalance,
  ExchangeId,
  NetworkId,
  TransferNetworkOption,
  TransferToken,
} from "@/lib/types";
import type { WithdrawNetworkSnapshot } from "@/lib/private/adapter";
import { privateAdapter } from "@/lib/private";
import { getCredentials } from "@/lib/db/credentials";
import { liveBalances, livePositions } from "@/lib/db/live";
import { upsertTransferEvents } from "@/lib/db/rebalance";
import { allowlistEntry, maskAddress } from "@/lib/rebalance/allowlist";
import { NETWORK_LABELS, TRANSFER_TOKENS } from "@/lib/rebalance/chains";
import { EXCHANGE_IDS, venueTypeOf } from "@/lib/utils";

/**
 * Reads wallet state across venues.
 *
 * The distinction that matters here: derivatives collateral (from the private
 * stream, cached in live_balances) is not withdrawable, while the funding/spot
 * wallet is. Conflating them produces recommendations that cannot be executed,
 * so both are surfaced.
 */

const REQUEST_TIMEOUT_MS = 15_000;

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Venues that have credentials and implement the wallet surface. */
export function walletCapableVenues(): ExchangeId[] {
  return EXCHANGE_IDS.filter((id) => {
    const adapter = privateAdapter(id);
    if (!adapter?.supportsWallet) return false;
    if (typeof adapter.fetchWalletBalances !== "function") return false;
    return getCredentials(id) !== null;
  });
}

/** Venues with credentials whose wallet surface is not implemented. */
export function unsupportedWalletVenues(): ExchangeId[] {
  return EXCHANGE_IDS.filter((id) => {
    if (getCredentials(id) === null) return false;
    const adapter = privateAdapter(id);
    return !adapter?.supportsWallet;
  });
}

/**
 * Venues funds can be sent *from*.
 *
 * Reading a wallet and emptying one are different capabilities, and on-chain
 * venues are exactly where they diverge: Hyperliquid reports its balance happily
 * but cannot sign a withdrawal here, so it is a valid destination and never a
 * source. Anything that plans a transfer must filter on this rather than on
 * `walletSupported`.
 */
export function transferSourceVenues(): ExchangeId[] {
  return walletCapableVenues().filter((id) => {
    const adapter = privateAdapter(id);
    return typeof adapter?.withdraw === "function";
  });
}

export interface VenueWallet {
  exchange: ExchangeId;
  /** Funding/spot balance of the stablecoins we move, summed. */
  funding: number;
  perToken: Record<string, number>;
  error: string | null;
}

/** Funding balances for one venue. Errors are returned, not thrown. */
async function readWallet(exchange: ExchangeId): Promise<VenueWallet> {
  const adapter = privateAdapter(exchange);
  const creds = getCredentials(exchange);
  const empty: VenueWallet = { exchange, funding: 0, perToken: {}, error: null };
  if (!adapter?.fetchWalletBalances || !creds) {
    return { ...empty, error: "wallet reads are not available for this venue" };
  }
  try {
    const rows = await withTimeout((signal) => adapter.fetchWalletBalances!(creds, signal));
    const perToken: Record<string, number> = {};
    for (const row of rows) {
      const asset = row.asset.toUpperCase();
      if (!(TRANSFER_TOKENS as string[]).includes(asset)) continue;
      perToken[asset] = (perToken[asset] ?? 0) + row.available;
    }
    const funding = Object.values(perToken).reduce((sum, v) => sum + v, 0);
    return { exchange, funding: Number(funding.toFixed(2)), perToken, error: null };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Balances per venue, combining the cached derivatives collateral with a live
 * funding-wallet read. Wallet reads run in parallel and a failing venue is
 * reported rather than dropped, so a partial view is visibly partial.
 */
export async function exchangeBalances(): Promise<ExchangeBalance[]> {
  const capable = walletCapableVenues();
  const wallets = await Promise.all(capable.map((id) => readWallet(id)));
  const walletById = new Map(wallets.map((w) => [w.exchange, w]));

  const balances = liveBalances();
  const positions = livePositions();

  const out: ExchangeBalance[] = [];
  for (const exchange of EXCHANGE_IDS) {
    if (getCredentials(exchange) === null) continue;
    const venueBalances = balances.filter((b) => b.exchange === exchange);
    const available = venueBalances.reduce((sum, b) => sum + b.available, 0);
    // Margin actually committed, from the venue's own position report.
    const inPosition = positions
      .filter((p) => p.exchange === exchange)
      .reduce((sum, p) => sum + (p.size * p.entryPrice) / Math.max(1, p.leverage), 0);
    const total = available + inPosition;
    const wallet = walletById.get(exchange);
    const adapter = privateAdapter(exchange);

    out.push({
      exchange,
      venueType: venueTypeOf(exchange),
      available: Number(available.toFixed(2)),
      inPosition: Number(inPosition.toFixed(2)),
      marginRatio: total === 0 ? 0 : Number((inPosition / total).toFixed(4)),
      funding: wallet?.funding ?? 0,
      walletSupported: adapter?.supportsWallet === true,
      // Can be sent from, not merely read. Hyperliquid reports balances but
      // cannot sign a withdrawal here, so it is a destination only.
      transferSource: typeof adapter?.withdraw === "function",
      destinationAllowlisted: hasAnyDestination(exchange),
      walletError: wallet?.error ?? null,
    });
  }
  return out;
}

/** Does this venue have at least one armed destination on any token/chain? */
function hasAnyDestination(exchange: ExchangeId): boolean {
  for (const token of TRANSFER_TOKENS) {
    for (const network of Object.keys(NETWORK_LABELS) as NetworkId[]) {
      if (allowlistEntry(exchange, token, network)) return true;
    }
  }
  return false;
}

/**
 * Withdrawal chains available for a token when sending from `from` to `to`.
 *
 * A chain is only offered when the source venue supports it *and* a destination
 * address is configured for it. That intersection is the whole point: an option
 * you cannot complete is worse than no option.
 */
export async function transferNetworks(input: {
  from: ExchangeId;
  to: ExchangeId;
  token: TransferToken;
}): Promise<TransferNetworkOption[]> {
  const adapter = privateAdapter(input.from);
  const creds = getCredentials(input.from);
  if (!adapter?.fetchWithdrawNetworks || !creds) return [];

  let chains: WithdrawNetworkSnapshot[];
  try {
    chains = await withTimeout((signal) =>
      adapter.fetchWithdrawNetworks!(creds, input.token, signal),
    );
  } catch {
    // A failed chain read must not be presented as "no chains exist"; the caller
    // distinguishes an empty list from an error by checking the venue status.
    return [];
  }

  const out: TransferNetworkOption[] = [];
  for (const chain of chains) {
    const network = chain.network as NetworkId;
    if (!(network in NETWORK_LABELS)) continue;
    const destination = allowlistEntry(input.to, input.token, network);
    out.push({
      network,
      label: NETWORK_LABELS[network],
      asset: input.token,
      fee: chain.fee,
      minAmount: chain.minAmount,
      enabled: chain.enabled,
      confirmations: chain.confirmations ?? null,
      destinationAllowlisted: destination !== null,
      addressMasked: destination ? maskAddress(destination.address) : undefined,
    });
  }
  return out.sort((a, b) => a.fee - b.fee);
}

/** The venue's own chain string for a network, needed by the withdraw call. */
export async function venueChainFor(input: {
  exchange: ExchangeId;
  token: TransferToken;
  network: NetworkId;
}): Promise<WithdrawNetworkSnapshot | null> {
  const adapter = privateAdapter(input.exchange);
  const creds = getCredentials(input.exchange);
  if (!adapter?.fetchWithdrawNetworks || !creds) return null;
  const chains = await withTimeout((signal) =>
    adapter.fetchWithdrawNetworks!(creds, input.token, signal),
  );
  return chains.find((c) => c.network === input.network) ?? null;
}

/**
 * Polls withdraw/deposit history from every wallet-capable venue and caches it.
 * Cached because venues trim their own history, and because matching a
 * withdrawal on one venue to the deposit on another needs both sides retained.
 */
export async function syncTransferHistory(): Promise<{ synced: number; errors: string[] }> {
  const venues = EXCHANGE_IDS.filter((id) => {
    const adapter = privateAdapter(id);
    return adapter?.supportsWallet && typeof adapter.fetchTransferHistory === "function";
  });

  let synced = 0;
  const errors: string[] = [];

  await Promise.all(
    venues.map(async (exchange) => {
      const adapter = privateAdapter(exchange);
      const creds = getCredentials(exchange);
      if (!adapter?.fetchTransferHistory || !creds) return;
      for (const token of TRANSFER_TOKENS) {
        try {
          const entries = await withTimeout((signal) =>
            adapter.fetchTransferHistory!(creds, token, signal),
          );
          upsertTransferEvents(
            entries.map((entry) => ({
              exchange,
              direction: entry.direction,
              venueId: entry.venueId || `${entry.txId ?? "unknown"}-${entry.at}`,
              asset: entry.asset,
              amount: entry.amount,
              fee: entry.fee ?? null,
              venueChain: entry.venueChain ?? null,
              address: entry.address ?? null,
              txId: entry.txId ?? null,
              status: entry.status,
              at: entry.at,
            })),
          );
          synced += entries.length;
        } catch (err) {
          errors.push(`${exchange}/${token}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }),
  );

  return { synced, errors };
}
