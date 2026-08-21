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
import { VENUE_HOSTS, sendSigned, signBinance } from "@/lib/private/signing";
import { normalizeChain } from "@/lib/rebalance/chains";
import { baseFromConcatSymbol, num } from "@/lib/exchanges/adapter";

/**
 * Binance USDT-M futures, authenticated.
 *
 * The private user-data stream needs a listenKey obtained over REST, which then
 * has to be refreshed every 30 minutes or the socket is dropped.
 */

const BASE = "https://fapi.binance.com";

function venueSymbol(coin: string): string {
  return `${coin.toUpperCase()}USDT`;
}

interface BinancePositionRow {
  symbol?: string;
  positionAmt?: string;
  entryPrice?: string;
  markPrice?: string;
  unRealizedProfit?: string;
  leverage?: string;
  liquidationPrice?: string;
}

interface BinanceBalanceRow {
  asset?: string;
  availableBalance?: string;
  balance?: string;
  crossUnPnl?: string;
}

interface BinanceOrderRow {
  orderId?: number | string;
  clientOrderId?: string;
  symbol?: string;
  side?: string;
  type?: string;
  price?: string;
  avgPrice?: string;
  origQty?: string;
  executedQty?: string;
  status?: string;
  reduceOnly?: boolean;
}

// ─── Wallet shapes (spot host) ──────────────────────────────────────────────

interface BinanceCoinNetwork {
  network?: string;
  name?: string;
  withdrawEnable?: boolean;
  withdrawFee?: string;
  withdrawMin?: string;
  minConfirm?: number;
}

interface BinanceCoinRow {
  coin?: string;
  free?: string;
  locked?: string;
  networkList?: BinanceCoinNetwork[];
}

interface BinanceWithdrawRow {
  id?: string;
  amount?: string;
  transactionFee?: string;
  coin?: string;
  network?: string;
  address?: string;
  txId?: string;
  status?: number;
  applyTime?: string;
}

interface BinanceDepositRow {
  id?: string;
  amount?: string;
  coin?: string;
  network?: string;
  address?: string;
  txId?: string;
  status?: number;
  insertTime?: number;
}

/**
 * Binance withdraw status: 0 email sent, 2 awaiting approval, 4 processing,
 * 6 completed, 1 cancelled, 3 rejected, 5 failure.
 */
function mapWithdrawStatus(status: number | undefined): TransferHistoryEntry["status"] {
  switch (status) {
    case 6:
      return "completed";
    case 1:
    case 3:
    case 5:
      return "failed";
    case 4:
      return "processing";
    default:
      return "pending";
  }
}

/** Binance deposit status: 0 pending, 6 credited but cannot withdraw, 1 success. */
function mapDepositStatus(status: number | undefined): TransferHistoryEntry["status"] {
  if (status === 1) return "completed";
  if (status === 6) return "processing";
  return "pending";
}

function mapStatus(status: string | undefined): PrivateOrderSnapshot["status"] {
  switch (status) {
    case "NEW":
      return "open";
    case "PARTIALLY_FILLED":
      return "partial";
    case "FILLED":
      return "filled";
    case "CANCELED":
    case "EXPIRED":
    case "REJECTED":
      return "cancelled";
    default:
      return "open";
  }
}

export const binancePrivate: PrivateAdapter = {
  id: "binance",
  supportsTrading: true,
  supportsWallet: true,

  async verify(creds, signal) {
    // Lightweight authenticated read; fails fast on a bad key or permission.
    await sendSigned("binance/balance", signBinance(creds, "GET", "/fapi/v2/balance"), signal);
  },

  async fetchPositions(creds, signal) {
    const rows = await sendSigned<BinancePositionRow[]>(
      "binance/positionRisk",
      signBinance(creds, "GET", "/fapi/v2/positionRisk"),
      signal,
    );
    const out: PrivatePositionSnapshot[] = [];
    for (const row of rows) {
      const coin = baseFromConcatSymbol(row.symbol ?? "");
      const amount = num(row.positionAmt);
      if (!coin || amount === null || amount === 0) continue;
      out.push({
        coin,
        // Binance encodes direction in the sign of positionAmt.
        side: amount > 0 ? "long" : "short",
        size: Math.abs(amount),
        entryPrice: num(row.entryPrice) ?? 0,
        markPrice: num(row.markPrice) ?? 0,
        unrealizedPnl: num(row.unRealizedProfit) ?? 0,
        leverage: num(row.leverage) ?? 1,
        liquidationPrice: num(row.liquidationPrice),
      });
    }
    return out;
  },

  async fetchBalances(creds, signal) {
    const rows = await sendSigned<BinanceBalanceRow[]>(
      "binance/balance",
      signBinance(creds, "GET", "/fapi/v2/balance"),
      signal,
    );
    const out: PrivateBalanceSnapshot[] = [];
    for (const row of rows) {
      const asset = row.asset ?? "";
      const available = num(row.availableBalance) ?? 0;
      const total = num(row.balance) ?? 0;
      if (!asset || (available === 0 && total === 0)) continue;
      out.push({
        asset,
        available,
        inPosition: Math.max(0, total - available),
        equity: total + (num(row.crossUnPnl) ?? 0),
      });
    }
    return out;
  },

  async fetchOpenOrders(creds, signal) {
    const rows = await sendSigned<BinanceOrderRow[]>(
      "binance/openOrders",
      signBinance(creds, "GET", "/fapi/v1/openOrders"),
      signal,
    );
    const out: PrivateOrderSnapshot[] = [];
    for (const row of rows) {
      const coin = baseFromConcatSymbol(row.symbol ?? "");
      if (!coin) continue;
      out.push({
        exchangeOrderId: String(row.orderId ?? ""),
        clientOrderId: row.clientOrderId ?? null,
        coin,
        side: row.side === "SELL" ? "sell" : "buy",
        orderType: row.type === "MARKET" ? "market" : "limit",
        price: num(row.price) ?? num(row.avgPrice) ?? 0,
        size: num(row.origQty) ?? 0,
        filled: num(row.executedQty) ?? 0,
        status: mapStatus(row.status),
        reduceOnly: row.reduceOnly === true,
      });
    }
    return out;
  },

  async placeOrder(creds, request, signal) {
    const params: Record<string, string | number | boolean> = {
      symbol: venueSymbol(request.coin),
      side: request.side.toUpperCase(),
      type: request.orderType.toUpperCase(),
      quantity: request.size,
      newClientOrderId: request.clientOrderId,
    };
    if (request.orderType === "limit") {
      if (request.price === undefined) throw new Error("limit order requires a price");
      params.price = request.price;
      params.timeInForce = "GTC";
    }
    if (request.reduceOnly) params.reduceOnly = "true";

    const row = await sendSigned<BinanceOrderRow>(
      "binance/order",
      signBinance(creds, "POST", "/fapi/v1/order", params),
      signal,
    );
    return {
      exchangeOrderId: String(row.orderId ?? ""),
      status: mapStatus(row.status),
      filledPrice: num(row.avgPrice),
      filledSize: num(row.executedQty),
      raw: row,
    };
  },

  async cancelOrder(creds, request, signal) {
    const params: Record<string, string | number> = { symbol: venueSymbol(request.coin) };
    if (request.exchangeOrderId) params.orderId = request.exchangeOrderId;
    else if (request.clientOrderId) params.origClientOrderId = request.clientOrderId;
    else throw new Error("cancel requires an order id");

    await sendSigned("binance/cancel", signBinance(creds, "DELETE", "/fapi/v1/order", params), signal);
  },

  // ─── Wallet ───────────────────────────────────────────────────────────────
  // Withdrawals happen on the spot host, from the spot wallet. The futures
  // wallet cannot withdraw, hence the internal transfer step.

  async fetchWalletBalances(creds, signal) {
    const rows = await sendSigned<BinanceCoinRow[]>(
      "binance/capitalConfig",
      signBinance(creds, "GET", "/sapi/v1/capital/config/getall", {}, VENUE_HOSTS.binanceSpot),
      signal,
    );
    const out: WalletBalanceSnapshot[] = [];
    for (const row of rows) {
      const asset = row.coin ?? "";
      const free = num(row.free) ?? 0;
      const locked = num(row.locked) ?? 0;
      if (!asset || (free === 0 && locked === 0)) continue;
      out.push({ wallet: "funding", asset, available: free, total: free + locked });
    }
    return out;
  },

  async fetchWithdrawNetworks(creds, asset, signal) {
    const rows = await sendSigned<BinanceCoinRow[]>(
      "binance/capitalConfig",
      signBinance(creds, "GET", "/sapi/v1/capital/config/getall", {}, VENUE_HOSTS.binanceSpot),
      signal,
    );
    const coin = rows.find((r) => (r.coin ?? "").toUpperCase() === asset.toUpperCase());
    if (!coin) return [];
    const out: WithdrawNetworkSnapshot[] = [];
    for (const entry of coin.networkList ?? []) {
      const venueChain = entry.network ?? "";
      const network = normalizeChain("binance", venueChain);
      // An unmapped chain is skipped rather than offered under a guessed name.
      if (!network) continue;
      out.push({
        network,
        venueChain,
        asset: asset.toUpperCase(),
        fee: num(entry.withdrawFee) ?? 0,
        minAmount: num(entry.withdrawMin) ?? 0,
        enabled: entry.withdrawEnable !== false,
        confirmations: entry.minConfirm ?? null,
      });
    }
    return out;
  },

  async internalTransfer(creds, request, signal) {
    // type 2 = UMFUTURE_MAIN (futures → spot), type 1 = MAIN_UMFUTURE.
    const type = request.from === "futures" ? 2 : 1;
    await sendSigned(
      "binance/futuresTransfer",
      signBinance(
        creds,
        "POST",
        "/sapi/v1/futures/transfer",
        { asset: request.asset, amount: request.amount, type },
        VENUE_HOSTS.binanceSpot,
      ),
      signal,
    );
  },

  async withdraw(creds, request, signal) {
    const row = await sendSigned<{ id?: string }>(
      "binance/withdraw",
      signBinance(
        creds,
        "POST",
        "/sapi/v1/capital/withdraw/apply",
        {
          coin: request.asset,
          network: request.venueChain,
          address: request.address,
          amount: request.amount,
          withdrawOrderId: request.clientTransferId,
          ...(request.memo ? { addressTag: request.memo } : {}),
        },
        VENUE_HOSTS.binanceSpot,
      ),
      signal,
    );
    if (!row.id) throw new Error("binance/withdraw: no withdrawal id returned");
    return { venueWithdrawId: String(row.id), raw: row };
  },

  async fetchTransferHistory(creds, asset, signal) {
    const [withdrawals, deposits] = await Promise.all([
      sendSigned<BinanceWithdrawRow[]>(
        "binance/withdrawHistory",
        signBinance(
          creds,
          "GET",
          "/sapi/v1/capital/withdraw/history",
          { coin: asset },
          VENUE_HOSTS.binanceSpot,
        ),
        signal,
      ),
      sendSigned<BinanceDepositRow[]>(
        "binance/depositHistory",
        signBinance(
          creds,
          "GET",
          "/sapi/v1/capital/deposit/hisrec",
          { coin: asset },
          VENUE_HOSTS.binanceSpot,
        ),
        signal,
      ),
    ]);

    const out: TransferHistoryEntry[] = [];
    for (const row of withdrawals) {
      out.push({
        direction: "withdraw",
        venueId: String(row.id ?? ""),
        asset: row.coin ?? asset,
        amount: num(row.amount) ?? 0,
        fee: num(row.transactionFee),
        venueChain: row.network ?? null,
        address: row.address ?? null,
        txId: row.txId ?? null,
        status: mapWithdrawStatus(row.status),
        at: row.applyTime ? Date.parse(`${row.applyTime}Z`) || Date.now() : Date.now(),
      });
    }
    for (const row of deposits) {
      out.push({
        direction: "deposit",
        venueId: String(row.id ?? row.txId ?? ""),
        asset: row.coin ?? asset,
        amount: num(row.amount) ?? 0,
        fee: null,
        venueChain: row.network ?? null,
        address: row.address ?? null,
        txId: row.txId ?? null,
        status: mapDepositStatus(row.status),
        at: row.insertTime ?? Date.now(),
      });
    }
    return out;
  },

  async resolveWs(creds, signal) {
    const { listenKey } = await sendSigned<{ listenKey?: string }>(
      "binance/listenKey",
      signBinance(creds, "POST", "/fapi/v1/listenKey"),
      signal,
    );
    if (!listenKey) throw new Error("binance/listenKey: missing key");
    return {
      url: `wss://fstream.binance.com/ws/${listenKey}`,
      // Binance expires a listenKey after 60 minutes; refresh well inside that.
      keepAlive: {
        intervalMs: 25 * 60 * 1000,
        run: async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          try {
            await sendSigned(
              "binance/listenKey-keepalive",
              signBinance(creds, "PUT", "/fapi/v1/listenKey"),
              controller.signal,
            );
          } finally {
            clearTimeout(timer);
          }
        },
      },
    };
  },

  parseWsMessage(raw) {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return [];
    }
    const event = frame.e;
    const out: PrivateUpdate[] = [];

    if (event === "ACCOUNT_UPDATE") {
      const a = frame.a as Record<string, unknown> | undefined;
      const balances = Array.isArray(a?.B) ? (a?.B as Record<string, unknown>[]) : [];
      const mapped: PrivateBalanceSnapshot[] = [];
      for (const b of balances) {
        const asset = typeof b.a === "string" ? b.a : "";
        const wallet = num(b.wb as string);
        if (!asset || wallet === null) continue;
        mapped.push({ asset, available: wallet, equity: wallet });
      }
      if (mapped.length > 0) out.push({ kind: "balance", balances: mapped });

      const positions = Array.isArray(a?.P) ? (a?.P as Record<string, unknown>[]) : [];
      for (const p of positions) {
        const coin = baseFromConcatSymbol(typeof p.s === "string" ? p.s : "");
        const amount = num(p.pa as string);
        if (!coin || amount === null) continue;
        out.push({
          kind: "position",
          position: {
            coin,
            side: amount >= 0 ? "long" : "short",
            size: Math.abs(amount),
            entryPrice: num(p.ep as string) ?? 0,
            unrealizedPnl: num(p.up as string) ?? 0,
          },
        });
      }
    }

    if (event === "ORDER_TRADE_UPDATE") {
      const o = frame.o as Record<string, unknown> | undefined;
      const coin = baseFromConcatSymbol(typeof o?.s === "string" ? o.s : "");
      if (o && coin) {
        out.push({
          kind: "order",
          order: {
            exchangeOrderId: String(o.i ?? ""),
            clientOrderId: typeof o.c === "string" ? o.c : null,
            coin,
            side: o.S === "SELL" ? "sell" : "buy",
            orderType: o.o === "MARKET" ? "market" : "limit",
            price: num(o.p as string) ?? num(o.ap as string) ?? 0,
            size: num(o.q as string) ?? 0,
            filled: num(o.z as string) ?? 0,
            status: mapStatus(typeof o.X === "string" ? o.X : undefined),
            reduceOnly: o.R === true,
          },
        });

        // `x === "TRADE"` marks an actual fill rather than a status change.
        if (o.x === "TRADE") {
          const lastQty = num(o.l as string);
          const lastPrice = num(o.L as string);
          if (lastQty && lastPrice) {
            out.push({
              kind: "fill",
              fill: {
                exchangeTradeId: o.t !== undefined ? String(o.t) : null,
                exchangeOrderId: o.i !== undefined ? String(o.i) : null,
                clientOrderId: typeof o.c === "string" ? o.c : null,
                coin,
                side: o.S === "SELL" ? "sell" : "buy",
                price: lastPrice,
                size: lastQty,
                fee: num(o.n as string),
                realizedPnl: num(o.rp as string),
                executedAt: num(o.T as number) ?? Date.now(),
              },
            });
          }
        }
      }
    }

    return out;
  },
};

export { BASE as BINANCE_FUTURES_BASE };
