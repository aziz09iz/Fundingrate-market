import type { CredentialStatus, ExchangeId } from "@/lib/types";
import type { Credentials } from "@/lib/db/credentials";

/**
 * Private (authenticated) venue adapters.
 *
 * Deliberately separate from the public market adapters in lib/exchanges: those
 * never see a credential, and keeping the split explicit means a public code
 * path cannot accidentally gain access to keys.
 */

export interface PrivatePositionSnapshot {
  coin: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice?: number;
  unrealizedPnl?: number;
  leverage?: number;
  liquidationPrice?: number | null;
}

export interface PrivateBalanceSnapshot {
  asset: string;
  available: number;
  inPosition?: number;
  equity?: number;
}

export interface PrivateOrderSnapshot {
  exchangeOrderId: string;
  clientOrderId?: string | null;
  coin: string;
  side: "buy" | "sell";
  orderType: "market" | "limit";
  price: number;
  size: number;
  filled: number;
  status: "pending" | "open" | "partial" | "filled" | "cancelled";
  reduceOnly?: boolean;
}

export interface PrivateFillSnapshot {
  exchangeTradeId?: string | null;
  /** Venue order id this fill belongs to, when the frame carries it. */
  exchangeOrderId?: string | null;
  /** Our own order id echoed back, when the frame carries it. Used to tell an
   * automated fill apart from a manual one — the venue does not know about that
   * distinction, so it has to be recovered from the order we sent. */
  clientOrderId?: string | null;
  coin: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  fee?: number | null;
  realizedPnl?: number | null;
  executedAt: number;
}

/** One parsed private stream event. */
export type PrivateUpdate =
  | { kind: "positions"; snapshot: true; positions: PrivatePositionSnapshot[] }
  | { kind: "position"; position: PrivatePositionSnapshot }
  | { kind: "order"; order: PrivateOrderSnapshot }
  | { kind: "fill"; fill: PrivateFillSnapshot }
  | { kind: "balance"; balances: PrivateBalanceSnapshot[] };

export interface PlaceOrderRequest {
  coin: string;
  side: "buy" | "sell";
  orderType: "market" | "limit";
  size: number;
  /** Required for limit orders. */
  price?: number;
  leverage?: number;
  reduceOnly?: boolean;
  /** Our own id, echoed back by the venue where supported. */
  clientOrderId: string;
}

export interface PlaceOrderResult {
  exchangeOrderId: string;
  status: "pending" | "open" | "partial" | "filled" | "cancelled";
  /** Average fill price when the venue reports one immediately. */
  filledPrice?: number | null;
  filledSize?: number | null;
  raw?: unknown;
}

export interface CancelOrderRequest {
  coin: string;
  exchangeOrderId?: string | null;
  clientOrderId?: string | null;
}

// ─── Wallet / transfer surface ──────────────────────────────────────────────

/**
 * Where a balance sits inside a venue. Only `funding` can be withdrawn on most
 * venues, which is why this distinction is modelled rather than flattened: a
 * rebalance that reads the futures balance and then tries to withdraw it fails
 * at the venue, or worse, looks like it succeeded.
 */
export type WalletKind = "futures" | "funding";

export interface WalletBalanceSnapshot {
  wallet: WalletKind;
  asset: string;
  available: number;
  /** Total including anything locked, when the venue distinguishes them. */
  total?: number;
}

/**
 * A withdrawal chain as the venue describes it, normalised to our NetworkId.
 *
 * Venues name the same chain differently — TRC20 appears as "TRX", "TRC20" and
 * "Tron" depending on who you ask. An unrecognised chain is dropped rather than
 * guessed: sending on the wrong chain loses the funds permanently.
 */
export interface WithdrawNetworkSnapshot {
  /** Our canonical id. */
  network: string;
  /** The venue's own chain string, kept for the withdraw request. */
  venueChain: string;
  asset: string;
  fee: number;
  minAmount: number;
  /** False when the venue has withdrawals paused for this chain. */
  enabled: boolean;
  /** Confirmations the venue quotes, when it reports them. */
  confirmations?: number | null;
}

export interface InternalTransferRequest {
  asset: string;
  amount: number;
  from: WalletKind;
  to: WalletKind;
}

export interface WithdrawRequest {
  asset: string;
  amount: number;
  /** Our canonical network id, for logging. */
  network: string;
  /** The venue's own chain string, taken from fetchNetworks. */
  venueChain: string;
  /** Destination address. Callers must have checked it against the allowlist. */
  address: string;
  /** Memo/tag, for chains that need one. */
  memo?: string | null;
  /** Our own reference, echoed by venues that support it. */
  clientTransferId: string;
}

export interface WithdrawResult {
  /** The venue's withdrawal id, used to poll status later. */
  venueWithdrawId: string;
  raw?: unknown;
}

/** A deposit address as the venue itself reports it. */
export interface DepositAddressSnapshot {
  address: string;
  memo?: string | null;
  /** The venue's own chain string, for the operator to sanity-check. */
  venueChain?: string | null;
}

export interface TransferHistoryEntry {
  direction: "withdraw" | "deposit";
  venueId: string;
  asset: string;
  amount: number;
  fee?: number | null;
  /** The venue's chain string; may not map to a known NetworkId. */
  venueChain?: string | null;
  address?: string | null;
  txId?: string | null;
  status: "pending" | "processing" | "completed" | "failed";
  at: number;
}

export interface PrivateWsTarget {
  url: string;
  /** Frames sent right after open, typically the auth handshake. */
  onOpenMessages?: unknown[];
  heartbeat?: { intervalMs: number; message: unknown };
  /** Some venues need a periodic REST call to keep the stream alive. */
  keepAlive?: { intervalMs: number; run: () => Promise<void> };
}

export interface PrivateAdapter {
  id: ExchangeId;
  /** False when order placement is not implemented for this venue. */
  supportsTrading: boolean;
  /**
   * False when wallet reads are not implemented. Note this is about *reading*: a
   * venue can report balances and receive deposits while still being unable to
   * send, which is the case for on-chain venues whose withdrawals need wallet-key
   * signing. `withdraw` being present is what makes a venue a transfer source.
   */
  supportsWallet?: boolean;

  /** Cheap authenticated call used to verify a credential works. */
  verify(creds: Credentials, signal: AbortSignal): Promise<void>;

  fetchPositions(creds: Credentials, signal: AbortSignal): Promise<PrivatePositionSnapshot[]>;
  fetchBalances(creds: Credentials, signal: AbortSignal): Promise<PrivateBalanceSnapshot[]>;
  fetchOpenOrders(creds: Credentials, signal: AbortSignal): Promise<PrivateOrderSnapshot[]>;

  placeOrder?(
    creds: Credentials,
    request: PlaceOrderRequest,
    signal: AbortSignal,
  ): Promise<PlaceOrderResult>;

  cancelOrder?(
    creds: Credentials,
    request: CancelOrderRequest,
    signal: AbortSignal,
  ): Promise<void>;

  /** Funding/spot wallet balances, which is what can actually be withdrawn. */
  fetchWalletBalances?(
    creds: Credentials,
    signal: AbortSignal,
  ): Promise<WalletBalanceSnapshot[]>;

  /** Withdrawal chains for one asset, with the venue's own fees and minimums. */
  fetchWithdrawNetworks?(
    creds: Credentials,
    asset: string,
    signal: AbortSignal,
  ): Promise<WithdrawNetworkSnapshot[]>;

  /** Moves funds between wallets inside one venue. No chain involved. */
  internalTransfer?(
    creds: Credentials,
    request: InternalTransferRequest,
    signal: AbortSignal,
  ): Promise<void>;

  /**
   * Sends an on-chain withdrawal. Irreversible. Callers must have resolved the
   * address through the confirmed destination allowlist before reaching this.
   */
  withdraw?(
    creds: Credentials,
    request: WithdrawRequest,
    signal: AbortSignal,
  ): Promise<WithdrawResult>;

  /**
   * The venue's own deposit address for a token and chain.
   *
   * Used to cross-check a stored destination against what the venue actually
   * expects. Returning null means the venue has no address for that route, which
   * is itself a useful answer — it usually means the chain is wrong.
   */
  fetchDepositAddress?(
    creds: Credentials,
    request: { token: string; network: string },
    signal: AbortSignal,
  ): Promise<DepositAddressSnapshot | null>;

  /** Withdraw and deposit history, for reconciling transfers. */
  fetchTransferHistory?(
    creds: Credentials,
    asset: string,
    signal: AbortSignal,
  ): Promise<TransferHistoryEntry[]>;

  /** Resolves the private websocket, including any listen-key handshake. */
  resolveWs?(creds: Credentials, signal: AbortSignal): Promise<PrivateWsTarget>;

  /** Parses a private frame. Must never throw. */
  parseWsMessage?(raw: string): PrivateUpdate[];
}

export function credentialStatusFor(
  statuses: CredentialStatus[],
  exchange: ExchangeId,
): CredentialStatus | undefined {
  return statuses.find((s) => s.exchange === exchange);
}
