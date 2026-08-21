import { randomUUID } from "node:crypto";
import type {
  PrivateAdapter,
  PrivateBalanceSnapshot,
  PrivateOrderSnapshot,
  PrivatePositionSnapshot,
  PrivateUpdate,
  TransferHistoryEntry,
  WalletBalanceSnapshot,
  WithdrawNetworkSnapshot,
} from "@/lib/private/adapter";
import { bybitWsAuth, sendSigned, signBybit } from "@/lib/private/signing";
import { normalizeChain } from "@/lib/rebalance/chains";
import { baseFromConcatSymbol, num } from "@/lib/exchanges/adapter";

/**
 * Bybit v5 linear (USDT perpetual), authenticated.
 *
 * The private stream authenticates with a signed `auth` frame after open, then
 * subscribes to position, order and wallet topics on one socket.
 */

interface BybitEnvelope<T> {
  retCode?: number;
  retMsg?: string;
  result?: T;
}

interface BybitPositionRow {
  symbol?: string;
  side?: string;
  size?: string;
  avgPrice?: string;
  markPrice?: string;
  unrealisedPnl?: string;
  leverage?: string;
  liqPrice?: string;
}

interface BybitCoinRow {
  coin?: string;
  availableToWithdraw?: string;
  walletBalance?: string;
  equity?: string;
  unrealisedPnl?: string;
}

interface BybitOrderRow {
  orderId?: string;
  orderLinkId?: string;
  symbol?: string;
  side?: string;
  orderType?: string;
  price?: string;
  avgPrice?: string;
  qty?: string;
  cumExecQty?: string;
  orderStatus?: string;
  reduceOnly?: boolean;
}

function venueSymbol(coin: string): string {
  return `${coin.toUpperCase()}USDT`;
}

// ─── Wallet shapes ──────────────────────────────────────────────────────────

interface BybitChainRow {
  chain?: string;
  chainType?: string;
  withdrawFee?: string;
  withdrawMin?: string;
  chainWithdraw?: string;
  confirmation?: string;
}

interface BybitCoinInfoRow {
  coin?: string;
  chains?: BybitChainRow[];
}

interface BybitFundRow {
  coin?: string;
  walletBalance?: string;
  transferBalance?: string;
}

interface BybitWithdrawRow {
  withdrawId?: string;
  coin?: string;
  chain?: string;
  amount?: string;
  withdrawFee?: string;
  address?: string;
  txID?: string;
  status?: string;
  createTime?: string;
}

interface BybitDepositRow {
  coin?: string;
  chain?: string;
  amount?: string;
  txID?: string;
  status?: number;
  successAt?: string;
  toAddress?: string;
}

/** Bybit withdraw status strings. */
function mapWithdrawStatus(status: string | undefined): TransferHistoryEntry["status"] {
  switch (status) {
    case "success":
    case "SUCCESS":
      return "completed";
    case "CancelByUser":
    case "Reject":
    case "Fail":
      return "failed";
    case "BlockchainConfirmed":
    case "Pending":
      return "processing";
    default:
      return "pending";
  }
}

/** Bybit deposit status: 1 processing, 2 success, 3 failed, 4 credit. */
function mapDepositStatus(status: number | undefined): TransferHistoryEntry["status"] {
  if (status === 2) return "completed";
  if (status === 3) return "failed";
  if (status === 1) return "processing";
  return "pending";
}

function mapStatus(status: string | undefined): PrivateOrderSnapshot["status"] {
  switch (status) {
    case "New":
    case "Untriggered":
      return "open";
    case "PartiallyFilled":
      return "partial";
    case "Filled":
      return "filled";
    case "Cancelled":
    case "Rejected":
    case "Deactivated":
    case "PartiallyFilledCanceled":
      return "cancelled";
    default:
      return "open";
  }
}

/** Bybit returns 200 with a non-zero retCode on failure, so check the body. */
function unwrap<T>(label: string, body: BybitEnvelope<T>): T {
  if (body.retCode !== undefined && body.retCode !== 0) {
    throw new Error(`${label}: ${body.retCode} ${body.retMsg ?? ""}`.trim());
  }
  if (!body.result) throw new Error(`${label}: empty result`);
  return body.result;
}

export const bybitPrivate: PrivateAdapter = {
  id: "bybit",
  supportsTrading: true,
  supportsWallet: true,

  async verify(creds, signal) {
    const body = await sendSigned<BybitEnvelope<unknown>>(
      "bybit/wallet-balance",
      signBybit(creds, "GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" }),
      signal,
    );
    unwrap("bybit/wallet-balance", body);
  },

  async fetchPositions(creds, signal) {
    const body = await sendSigned<BybitEnvelope<{ list?: BybitPositionRow[] }>>(
      "bybit/position-list",
      signBybit(creds, "GET", "/v5/position/list", { category: "linear", settleCoin: "USDT" }),
      signal,
    );
    const list = unwrap("bybit/position-list", body).list ?? [];
    const out: PrivatePositionSnapshot[] = [];
    for (const row of list) {
      const coin = baseFromConcatSymbol(row.symbol ?? "");
      const size = num(row.size);
      if (!coin || size === null || size === 0) continue;
      out.push({
        coin,
        side: row.side === "Sell" ? "short" : "long",
        size,
        entryPrice: num(row.avgPrice) ?? 0,
        markPrice: num(row.markPrice) ?? 0,
        unrealizedPnl: num(row.unrealisedPnl) ?? 0,
        leverage: num(row.leverage) ?? 1,
        liquidationPrice: num(row.liqPrice),
      });
    }
    return out;
  },

  async fetchBalances(creds, signal) {
    const body = await sendSigned<BybitEnvelope<{ list?: { coin?: BybitCoinRow[] }[] }>>(
      "bybit/wallet-balance",
      signBybit(creds, "GET", "/v5/account/wallet-balance", { accountType: "UNIFIED" }),
      signal,
    );
    const list = unwrap("bybit/wallet-balance", body).list ?? [];
    const out: PrivateBalanceSnapshot[] = [];
    for (const account of list) {
      for (const row of account.coin ?? []) {
        const asset = row.coin ?? "";
        const available = num(row.availableToWithdraw) ?? 0;
        const wallet = num(row.walletBalance) ?? 0;
        if (!asset || (available === 0 && wallet === 0)) continue;
        out.push({
          asset,
          available,
          inPosition: Math.max(0, wallet - available),
          equity: num(row.equity) ?? wallet,
        });
      }
    }
    return out;
  },

  async fetchOpenOrders(creds, signal) {
    const body = await sendSigned<BybitEnvelope<{ list?: BybitOrderRow[] }>>(
      "bybit/open-orders",
      signBybit(creds, "GET", "/v5/order/realtime", { category: "linear", settleCoin: "USDT" }),
      signal,
    );
    const list = unwrap("bybit/open-orders", body).list ?? [];
    const out: PrivateOrderSnapshot[] = [];
    for (const row of list) {
      const coin = baseFromConcatSymbol(row.symbol ?? "");
      if (!coin) continue;
      out.push({
        exchangeOrderId: row.orderId ?? "",
        clientOrderId: row.orderLinkId ?? null,
        coin,
        side: row.side === "Sell" ? "sell" : "buy",
        orderType: row.orderType === "Market" ? "market" : "limit",
        price: num(row.price) ?? num(row.avgPrice) ?? 0,
        size: num(row.qty) ?? 0,
        filled: num(row.cumExecQty) ?? 0,
        status: mapStatus(row.orderStatus),
        reduceOnly: row.reduceOnly === true,
      });
    }
    return out;
  },

  async placeOrder(creds, request, signal) {
    const payload: Record<string, unknown> = {
      category: "linear",
      symbol: venueSymbol(request.coin),
      side: request.side === "buy" ? "Buy" : "Sell",
      orderType: request.orderType === "market" ? "Market" : "Limit",
      qty: String(request.size),
      orderLinkId: request.clientOrderId,
    };
    if (request.orderType === "limit") {
      if (request.price === undefined) throw new Error("limit order requires a price");
      payload.price = String(request.price);
      payload.timeInForce = "GTC";
    }
    if (request.reduceOnly) payload.reduceOnly = true;

    const body = await sendSigned<BybitEnvelope<{ orderId?: string }>>(
      "bybit/create-order",
      signBybit(creds, "POST", "/v5/order/create", {}, payload),
      signal,
    );
    const result = unwrap("bybit/create-order", body);
    return {
      exchangeOrderId: result.orderId ?? "",
      // Bybit acknowledges acceptance; the stream reports the fill.
      status: request.orderType === "market" ? "pending" : "open",
      raw: result,
    };
  },

  async cancelOrder(creds, request, signal) {
    const payload: Record<string, unknown> = {
      category: "linear",
      symbol: venueSymbol(request.coin),
    };
    if (request.exchangeOrderId) payload.orderId = request.exchangeOrderId;
    else if (request.clientOrderId) payload.orderLinkId = request.clientOrderId;
    else throw new Error("cancel requires an order id");

    const body = await sendSigned<BybitEnvelope<unknown>>(
      "bybit/cancel-order",
      signBybit(creds, "POST", "/v5/order/cancel", {}, payload),
      signal,
    );
    unwrap("bybit/cancel-order", body);
  },

  // ─── Wallet ───────────────────────────────────────────────────────────────
  // Bybit withdraws from the FUND account, while trading uses UNIFIED, so the
  // internal transfer moves between those two account types.

  async fetchWalletBalances(creds, signal) {
    const body = await sendSigned<BybitEnvelope<{ balance?: BybitFundRow[] }>>(
      "bybit/fund-balance",
      signBybit(creds, "GET", "/v5/asset/transfer/query-account-coins-balance", {
        accountType: "FUND",
      }),
      signal,
    );
    const rows = unwrap("bybit/fund-balance", body).balance ?? [];
    const out: WalletBalanceSnapshot[] = [];
    for (const row of rows) {
      const asset = row.coin ?? "";
      const available = num(row.transferBalance) ?? 0;
      const total = num(row.walletBalance) ?? available;
      if (!asset || (available === 0 && total === 0)) continue;
      out.push({ wallet: "funding", asset, available, total });
    }
    return out;
  },

  async fetchWithdrawNetworks(creds, asset, signal) {
    const body = await sendSigned<BybitEnvelope<{ rows?: BybitCoinInfoRow[] }>>(
      "bybit/coin-info",
      signBybit(creds, "GET", "/v5/asset/coin/query-info", { coin: asset.toUpperCase() }),
      signal,
    );
    const rows = unwrap("bybit/coin-info", body).rows ?? [];
    const coin = rows.find((r) => (r.coin ?? "").toUpperCase() === asset.toUpperCase());
    if (!coin) return [];
    const out: WithdrawNetworkSnapshot[] = [];
    for (const chain of coin.chains ?? []) {
      const venueChain = chain.chain ?? chain.chainType ?? "";
      const network = normalizeChain("bybit", venueChain);
      if (!network) continue;
      out.push({
        network,
        venueChain,
        asset: asset.toUpperCase(),
        fee: num(chain.withdrawFee) ?? 0,
        minAmount: num(chain.withdrawMin) ?? 0,
        // "1" means withdrawals are open on this chain.
        enabled: chain.chainWithdraw === "1",
        confirmations: num(chain.confirmation),
      });
    }
    return out;
  },

  async internalTransfer(creds, request, signal) {
    const body = await sendSigned<BybitEnvelope<unknown>>(
      "bybit/internal-transfer",
      signBybit(creds, "POST", "/v5/asset/transfer/inter-transfer", {}, {
        transferId: randomUUID(),
        coin: request.asset,
        amount: String(request.amount),
        fromAccountType: request.from === "futures" ? "UNIFIED" : "FUND",
        toAccountType: request.to === "funding" ? "FUND" : "UNIFIED",
      }),
      signal,
    );
    unwrap("bybit/internal-transfer", body);
  },

  async withdraw(creds, request, signal) {
    const body = await sendSigned<BybitEnvelope<{ id?: string }>>(
      "bybit/withdraw",
      signBybit(creds, "POST", "/v5/asset/withdraw/create", {}, {
        coin: request.asset,
        chain: request.venueChain,
        address: request.address,
        amount: String(request.amount),
        timestamp: Date.now(),
        // forceChain 1 = treat `address` as an on-chain address, not a UID.
        forceChain: 1,
        accountType: "FUND",
        requestId: request.clientTransferId,
        ...(request.memo ? { tag: request.memo } : {}),
      }),
      signal,
    );
    const result = unwrap("bybit/withdraw", body);
    if (!result.id) throw new Error("bybit/withdraw: no withdrawal id returned");
    return { venueWithdrawId: String(result.id), raw: result };
  },

  async fetchTransferHistory(creds, asset, signal) {
    const [withdrawBody, depositBody] = await Promise.all([
      sendSigned<BybitEnvelope<{ rows?: BybitWithdrawRow[] }>>(
        "bybit/withdraw-history",
        signBybit(creds, "GET", "/v5/asset/withdraw/query-record", { coin: asset.toUpperCase() }),
        signal,
      ),
      sendSigned<BybitEnvelope<{ rows?: BybitDepositRow[] }>>(
        "bybit/deposit-history",
        signBybit(creds, "GET", "/v5/asset/deposit/query-record", { coin: asset.toUpperCase() }),
        signal,
      ),
    ]);

    const out: TransferHistoryEntry[] = [];
    for (const row of unwrap("bybit/withdraw-history", withdrawBody).rows ?? []) {
      out.push({
        direction: "withdraw",
        venueId: String(row.withdrawId ?? ""),
        asset: row.coin ?? asset,
        amount: num(row.amount) ?? 0,
        fee: num(row.withdrawFee),
        venueChain: row.chain ?? null,
        address: row.address ?? null,
        txId: row.txID ?? null,
        status: mapWithdrawStatus(row.status),
        at: num(row.createTime) ?? Date.now(),
      });
    }
    for (const row of unwrap("bybit/deposit-history", depositBody).rows ?? []) {
      out.push({
        direction: "deposit",
        venueId: String(row.txID ?? ""),
        asset: row.coin ?? asset,
        amount: num(row.amount) ?? 0,
        fee: null,
        venueChain: row.chain ?? null,
        address: row.toAddress ?? null,
        txId: row.txID ?? null,
        status: mapDepositStatus(row.status),
        at: num(row.successAt) ?? Date.now(),
      });
    }
    return out;
  },

  async resolveWs(creds) {
    return {
      url: "wss://stream.bybit.com/v5/private",
      onOpenMessages: [
        bybitWsAuth(creds),
        { op: "subscribe", args: ["position.linear", "order.linear", "wallet", "execution.linear"] },
      ],
      heartbeat: { intervalMs: 20_000, message: { op: "ping" } },
    };
  },

  parseWsMessage(raw) {
    let frame: { topic?: string; data?: unknown };
    try {
      frame = JSON.parse(raw) as { topic?: string; data?: unknown };
    } catch {
      return [];
    }
    const topic = frame.topic ?? "";
    const rows = Array.isArray(frame.data) ? (frame.data as Record<string, unknown>[]) : [];
    if (rows.length === 0) return [];
    const out: PrivateUpdate[] = [];

    if (topic.startsWith("position")) {
      for (const row of rows) {
        const coin = baseFromConcatSymbol(typeof row.symbol === "string" ? row.symbol : "");
        const size = num(row.size as string);
        if (!coin || size === null) continue;
        out.push({
          kind: "position",
          position: {
            coin,
            side: row.side === "Sell" ? "short" : "long",
            size,
            entryPrice: num(row.entryPrice as string) ?? num(row.avgPrice as string) ?? 0,
            markPrice: num(row.markPrice as string) ?? 0,
            unrealizedPnl: num(row.unrealisedPnl as string) ?? 0,
            leverage: num(row.leverage as string) ?? 1,
            liquidationPrice: num(row.liqPrice as string),
          },
        });
      }
    }

    if (topic.startsWith("order")) {
      for (const row of rows) {
        const coin = baseFromConcatSymbol(typeof row.symbol === "string" ? row.symbol : "");
        if (!coin) continue;
        out.push({
          kind: "order",
          order: {
            exchangeOrderId: String(row.orderId ?? ""),
            clientOrderId: typeof row.orderLinkId === "string" ? row.orderLinkId : null,
            coin,
            side: row.side === "Sell" ? "sell" : "buy",
            orderType: row.orderType === "Market" ? "market" : "limit",
            price: num(row.price as string) ?? num(row.avgPrice as string) ?? 0,
            size: num(row.qty as string) ?? 0,
            filled: num(row.cumExecQty as string) ?? 0,
            status: mapStatus(typeof row.orderStatus === "string" ? row.orderStatus : undefined),
            reduceOnly: row.reduceOnly === true,
          },
        });
      }
    }

    if (topic.startsWith("execution")) {
      for (const row of rows) {
        const coin = baseFromConcatSymbol(typeof row.symbol === "string" ? row.symbol : "");
        const size = num(row.execQty as string);
        const price = num(row.execPrice as string);
        if (!coin || !size || !price) continue;
        out.push({
          kind: "fill",
          fill: {
            exchangeTradeId: row.execId !== undefined ? String(row.execId) : null,
            exchangeOrderId: row.orderId !== undefined ? String(row.orderId) : null,
            clientOrderId: typeof row.orderLinkId === "string" ? row.orderLinkId : null,
            coin,
            side: row.side === "Sell" ? "sell" : "buy",
            price,
            size,
            fee: num(row.execFee as string),
            realizedPnl: num(row.closedPnl as string),
            executedAt: num(row.execTime as string) ?? Date.now(),
          },
        });
      }
    }

    if (topic === "wallet") {
      const balances: PrivateBalanceSnapshot[] = [];
      for (const row of rows) {
        const coins = Array.isArray(row.coin) ? (row.coin as Record<string, unknown>[]) : [];
        for (const c of coins) {
          const asset = typeof c.coin === "string" ? c.coin : "";
          const wallet = num(c.walletBalance as string);
          if (!asset || wallet === null) continue;
          balances.push({
            asset,
            available: num(c.availableToWithdraw as string) ?? wallet,
            equity: num(c.equity as string) ?? wallet,
          });
        }
      }
      if (balances.length > 0) out.push({ kind: "balance", balances });
    }

    return out;
  },
};
