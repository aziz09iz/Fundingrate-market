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
import { bitgetWsLogin, sendSigned, signBitget } from "@/lib/private/signing";
import { normalizeChain } from "@/lib/rebalance/chains";
import { baseFromConcatSymbol, num } from "@/lib/exchanges/adapter";

/**
 * Bitget v2 USDT-M futures, authenticated.
 *
 * Bitget wants productType on nearly every call and expects the plaintext
 * passphrase in a header. Its private stream logs in with a signed frame.
 */

const PRODUCT_TYPE = "USDT-FUTURES";
const MARGIN_COIN = "USDT";

interface BitgetEnvelope<T> {
  code?: string;
  msg?: string;
  data?: T;
}

interface BitgetPositionRow {
  symbol?: string;
  holdSide?: string;
  total?: string;
  available?: string;
  openPriceAvg?: string;
  markPrice?: string;
  unrealizedPL?: string;
  leverage?: string;
  liquidationPrice?: string;
}

interface BitgetAccountRow {
  marginCoin?: string;
  available?: string;
  accountEquity?: string;
  locked?: string;
  unrealizedPL?: string;
}

interface BitgetOrderRow {
  orderId?: string;
  clientOid?: string;
  symbol?: string;
  side?: string;
  orderType?: string;
  price?: string;
  priceAvg?: string;
  size?: string;
  baseVolume?: string;
  status?: string;
  reduceOnly?: string;
}

function venueSymbol(coin: string): string {
  return `${coin.toUpperCase()}USDT`;
}

// ─── Wallet shapes ──────────────────────────────────────────────────────────

interface BitgetSpotAsset {
  coin?: string;
  available?: string;
  frozen?: string;
  locked?: string;
}

interface BitgetChainRow {
  chain?: string;
  withdrawable?: string;
  rechargeable?: string;
  withdrawFee?: string;
  minWithdrawAmount?: string;
  withdrawConfirm?: string;
}

interface BitgetCoinRow {
  coin?: string;
  chains?: BitgetChainRow[];
}

interface BitgetTransferRow {
  orderId?: string;
  tradeId?: string;
  coin?: string;
  chain?: string;
  size?: string;
  fee?: string;
  status?: string;
  toAddress?: string;
  cTime?: string;
}

/** Bitget transfer status vocabulary, shared by deposits and withdrawals. */
function mapTransferStatus(status: string | undefined): TransferHistoryEntry["status"] {
  switch (status) {
    case "success":
      return "completed";
    case "fail":
    case "cancel":
      return "failed";
    case "pending":
    case "wallet_processing":
      return "processing";
    default:
      return "pending";
  }
}

function mapStatus(status: string | undefined): PrivateOrderSnapshot["status"] {
  switch (status) {
    case "live":
    case "new":
      return "open";
    case "partially_filled":
      return "partial";
    case "filled":
    case "full_fill":
      return "filled";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "open";
  }
}

/** Bitget returns "00000" on success. */
function unwrap<T>(label: string, body: BitgetEnvelope<T>): T {
  if (body.code !== undefined && body.code !== "00000") {
    throw new Error(`${label}: ${body.code} ${body.msg ?? ""}`.trim());
  }
  if (body.data === undefined) throw new Error(`${label}: empty data`);
  return body.data;
}

export const bitgetPrivate: PrivateAdapter = {
  id: "bitget",
  supportsTrading: true,
  supportsWallet: true,

  async verify(creds, signal) {
    const body = await sendSigned<BitgetEnvelope<unknown>>(
      "bitget/accounts",
      signBitget(creds, "GET", "/api/v2/mix/account/accounts", { productType: PRODUCT_TYPE }),
      signal,
    );
    unwrap("bitget/accounts", body);
  },

  async fetchPositions(creds, signal) {
    const body = await sendSigned<BitgetEnvelope<BitgetPositionRow[]>>(
      "bitget/all-position",
      signBitget(creds, "GET", "/api/v2/mix/position/all-position", {
        productType: PRODUCT_TYPE,
        marginCoin: MARGIN_COIN,
      }),
      signal,
    );
    const rows = unwrap("bitget/all-position", body);
    const out: PrivatePositionSnapshot[] = [];
    for (const row of rows) {
      const coin = baseFromConcatSymbol(row.symbol ?? "");
      const size = num(row.total);
      if (!coin || size === null || size === 0) continue;
      out.push({
        coin,
        side: row.holdSide === "short" ? "short" : "long",
        size: Math.abs(size),
        entryPrice: num(row.openPriceAvg) ?? 0,
        markPrice: num(row.markPrice) ?? 0,
        unrealizedPnl: num(row.unrealizedPL) ?? 0,
        leverage: num(row.leverage) ?? 1,
        liquidationPrice: num(row.liquidationPrice),
      });
    }
    return out;
  },

  async fetchBalances(creds, signal) {
    const body = await sendSigned<BitgetEnvelope<BitgetAccountRow[]>>(
      "bitget/accounts",
      signBitget(creds, "GET", "/api/v2/mix/account/accounts", { productType: PRODUCT_TYPE }),
      signal,
    );
    const rows = unwrap("bitget/accounts", body);
    const out: PrivateBalanceSnapshot[] = [];
    for (const row of rows) {
      const asset = row.marginCoin ?? MARGIN_COIN;
      const available = num(row.available) ?? 0;
      const equity = num(row.accountEquity) ?? available;
      if (available === 0 && equity === 0) continue;
      out.push({ asset, available, inPosition: num(row.locked) ?? 0, equity });
    }
    return out;
  },

  async fetchOpenOrders(creds, signal) {
    const body = await sendSigned<BitgetEnvelope<{ entrustedList?: BitgetOrderRow[] }>>(
      "bitget/orders-pending",
      signBitget(creds, "GET", "/api/v2/mix/order/orders-pending", { productType: PRODUCT_TYPE }),
      signal,
    );
    const rows = unwrap("bitget/orders-pending", body).entrustedList ?? [];
    const out: PrivateOrderSnapshot[] = [];
    for (const row of rows) {
      const coin = baseFromConcatSymbol(row.symbol ?? "");
      if (!coin) continue;
      out.push({
        exchangeOrderId: row.orderId ?? "",
        clientOrderId: row.clientOid ?? null,
        coin,
        side: row.side === "sell" ? "sell" : "buy",
        orderType: row.orderType === "market" ? "market" : "limit",
        price: num(row.price) ?? num(row.priceAvg) ?? 0,
        size: num(row.size) ?? 0,
        filled: num(row.baseVolume) ?? 0,
        status: mapStatus(row.status),
        reduceOnly: row.reduceOnly === "YES",
      });
    }
    return out;
  },

  async placeOrder(creds, request, signal) {
    const payload: Record<string, unknown> = {
      symbol: venueSymbol(request.coin),
      productType: PRODUCT_TYPE,
      marginMode: "crossed",
      marginCoin: MARGIN_COIN,
      size: String(request.size),
      side: request.side,
      orderType: request.orderType,
      clientOid: request.clientOrderId,
    };
    if (request.orderType === "limit") {
      if (request.price === undefined) throw new Error("limit order requires a price");
      payload.price = String(request.price);
      payload.force = "gtc";
    }
    // Bitget expresses reduce-only through tradeSide in one-way mode.
    if (request.reduceOnly) payload.reduceOnly = "YES";

    const body = await sendSigned<BitgetEnvelope<{ orderId?: string; clientOid?: string }>>(
      "bitget/place-order",
      signBitget(creds, "POST", "/api/v2/mix/order/place-order", {}, payload),
      signal,
    );
    const data = unwrap("bitget/place-order", body);
    return {
      exchangeOrderId: data.orderId ?? "",
      status: request.orderType === "market" ? "pending" : "open",
      raw: data,
    };
  },

  async cancelOrder(creds, request, signal) {
    const payload: Record<string, unknown> = {
      symbol: venueSymbol(request.coin),
      productType: PRODUCT_TYPE,
    };
    if (request.exchangeOrderId) payload.orderId = request.exchangeOrderId;
    else if (request.clientOrderId) payload.clientOid = request.clientOrderId;
    else throw new Error("cancel requires an order id");

    const body = await sendSigned<BitgetEnvelope<unknown>>(
      "bitget/cancel-order",
      signBitget(creds, "POST", "/api/v2/mix/order/cancel-order", {}, payload),
      signal,
    );
    unwrap("bitget/cancel-order", body);
  },

  // ─── Wallet ───────────────────────────────────────────────────────────────
  // Bitget withdraws from the spot account, so futures funds must be moved
  // across first via the internal transfer endpoint.

  async fetchWalletBalances(creds, signal) {
    const body = await sendSigned<BitgetEnvelope<BitgetSpotAsset[]>>(
      "bitget/spot-assets",
      signBitget(creds, "GET", "/api/v2/spot/account/assets"),
      signal,
    );
    const rows = unwrap("bitget/spot-assets", body);
    const out: WalletBalanceSnapshot[] = [];
    for (const row of rows) {
      const asset = row.coin ?? "";
      const available = num(row.available) ?? 0;
      const frozen = num(row.frozen) ?? 0;
      const locked = num(row.locked) ?? 0;
      if (!asset || (available === 0 && frozen === 0 && locked === 0)) continue;
      out.push({ wallet: "funding", asset, available, total: available + frozen + locked });
    }
    return out;
  },

  async fetchWithdrawNetworks(creds, asset, signal) {
    const body = await sendSigned<BitgetEnvelope<BitgetCoinRow[]>>(
      "bitget/coins",
      signBitget(creds, "GET", "/api/v2/spot/public/coins", { coin: asset.toUpperCase() }),
      signal,
    );
    const rows = unwrap("bitget/coins", body);
    const coin = rows.find((r) => (r.coin ?? "").toUpperCase() === asset.toUpperCase());
    if (!coin) return [];
    const out: WithdrawNetworkSnapshot[] = [];
    for (const chain of coin.chains ?? []) {
      const venueChain = chain.chain ?? "";
      const network = normalizeChain("bitget", venueChain);
      if (!network) continue;
      out.push({
        network,
        venueChain,
        asset: asset.toUpperCase(),
        fee: num(chain.withdrawFee) ?? 0,
        minAmount: num(chain.minWithdrawAmount) ?? 0,
        enabled: chain.withdrawable === "true",
        confirmations: num(chain.withdrawConfirm),
      });
    }
    return out;
  },

  async internalTransfer(creds, request, signal) {
    const body = await sendSigned<BitgetEnvelope<unknown>>(
      "bitget/transfer",
      signBitget(creds, "POST", "/api/v2/spot/wallet/transfer", {}, {
        fromType: request.from === "futures" ? "usdt_futures" : "spot",
        toType: request.to === "funding" ? "spot" : "usdt_futures",
        amount: String(request.amount),
        coin: request.asset,
      }),
      signal,
    );
    unwrap("bitget/transfer", body);
  },

  async withdraw(creds, request, signal) {
    const body = await sendSigned<BitgetEnvelope<{ orderId?: string }>>(
      "bitget/withdraw",
      signBitget(creds, "POST", "/api/v2/spot/wallet/withdrawal", {}, {
        coin: request.asset,
        // on_chain, as opposed to Bitget's internal transfer by uid.
        transferType: "on_chain",
        address: request.address,
        chain: request.venueChain,
        size: String(request.amount),
        clientOid: request.clientTransferId,
        ...(request.memo ? { tag: request.memo } : {}),
      }),
      signal,
    );
    const result = unwrap("bitget/withdraw", body);
    if (!result.orderId) throw new Error("bitget/withdraw: no withdrawal id returned");
    return { venueWithdrawId: String(result.orderId), raw: result };
  },

  async fetchTransferHistory(creds, asset, signal) {
    // Bitget requires an explicit window; 30 days is enough to reconcile.
    const endTime = Date.now();
    const startTime = endTime - 30 * 24 * 60 * 60 * 1000;
    const [withdrawBody, depositBody] = await Promise.all([
      sendSigned<BitgetEnvelope<BitgetTransferRow[]>>(
        "bitget/withdrawal-records",
        signBitget(creds, "GET", "/api/v2/spot/wallet/withdrawal-records", {
          coin: asset.toUpperCase(),
          startTime,
          endTime,
        }),
        signal,
      ),
      sendSigned<BitgetEnvelope<BitgetTransferRow[]>>(
        "bitget/deposit-records",
        signBitget(creds, "GET", "/api/v2/spot/wallet/deposit-records", {
          coin: asset.toUpperCase(),
          startTime,
          endTime,
        }),
        signal,
      ),
    ]);

    const out: TransferHistoryEntry[] = [];
    for (const row of unwrap("bitget/withdrawal-records", withdrawBody)) {
      out.push({
        direction: "withdraw",
        venueId: String(row.orderId ?? ""),
        asset: row.coin ?? asset,
        amount: num(row.size) ?? 0,
        fee: num(row.fee),
        venueChain: row.chain ?? null,
        address: row.toAddress ?? null,
        txId: row.tradeId ?? null,
        status: mapTransferStatus(row.status),
        at: num(row.cTime) ?? Date.now(),
      });
    }
    for (const row of unwrap("bitget/deposit-records", depositBody)) {
      out.push({
        direction: "deposit",
        venueId: String(row.orderId ?? row.tradeId ?? ""),
        asset: row.coin ?? asset,
        amount: num(row.size) ?? 0,
        fee: num(row.fee),
        venueChain: row.chain ?? null,
        address: row.toAddress ?? null,
        txId: row.tradeId ?? null,
        status: mapTransferStatus(row.status),
        at: num(row.cTime) ?? Date.now(),
      });
    }
    return out;
  },

  async resolveWs(creds) {
    return {
      url: "wss://ws.bitget.com/v2/ws/private",
      onOpenMessages: [
        bitgetWsLogin(creds),
        {
          op: "subscribe",
          args: [
            { instType: PRODUCT_TYPE, channel: "positions", coin: "default" },
            { instType: PRODUCT_TYPE, channel: "orders", instId: "default" },
            { instType: PRODUCT_TYPE, channel: "account", coin: "default" },
            { instType: PRODUCT_TYPE, channel: "fill", instId: "default" },
          ],
        },
      ],
      heartbeat: { intervalMs: 25_000, message: "ping" },
    };
  },

  parseWsMessage(raw) {
    if (raw === "pong") return [];
    let frame: { arg?: { channel?: string }; data?: unknown; event?: string };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return [];
    }
    if (frame.event) return [];
    const channel = frame.arg?.channel ?? "";
    const rows = Array.isArray(frame.data) ? (frame.data as Record<string, unknown>[]) : [];
    if (rows.length === 0) return [];
    const out: PrivateUpdate[] = [];

    if (channel === "positions") {
      for (const row of rows) {
        const coin = baseFromConcatSymbol(typeof row.instId === "string" ? row.instId : "");
        const size = num(row.total as string);
        if (!coin || size === null) continue;
        out.push({
          kind: "position",
          position: {
            coin,
            side: row.holdSide === "short" ? "short" : "long",
            size: Math.abs(size),
            entryPrice: num(row.openPriceAvg as string) ?? 0,
            markPrice: num(row.markPrice as string) ?? 0,
            unrealizedPnl: num(row.unrealizedPL as string) ?? 0,
            leverage: num(row.leverage as string) ?? 1,
            liquidationPrice: num(row.liquidationPrice as string),
          },
        });
      }
    }

    if (channel === "orders") {
      for (const row of rows) {
        const coin = baseFromConcatSymbol(typeof row.instId === "string" ? row.instId : "");
        if (!coin) continue;
        out.push({
          kind: "order",
          order: {
            exchangeOrderId: String(row.orderId ?? ""),
            clientOrderId: typeof row.clientOid === "string" ? row.clientOid : null,
            coin,
            side: row.side === "sell" ? "sell" : "buy",
            orderType: row.orderType === "market" ? "market" : "limit",
            price: num(row.price as string) ?? num(row.priceAvg as string) ?? 0,
            size: num(row.size as string) ?? 0,
            filled: num(row.accBaseVolume as string) ?? num(row.baseVolume as string) ?? 0,
            status: mapStatus(typeof row.status === "string" ? row.status : undefined),
            reduceOnly: row.reduceOnly === "YES",
          },
        });
      }
    }

    if (channel === "fill") {
      for (const row of rows) {
        const coin = baseFromConcatSymbol(typeof row.symbol === "string" ? row.symbol : "");
        const size = num(row.baseVolume as string);
        const price = num(row.price as string);
        if (!coin || !size || !price) continue;
        out.push({
          kind: "fill",
          fill: {
            exchangeTradeId: row.tradeId !== undefined ? String(row.tradeId) : null,
            exchangeOrderId: row.orderId !== undefined ? String(row.orderId) : null,
            clientOrderId: typeof row.clientOid === "string" ? row.clientOid : null,
            coin,
            side: row.side === "sell" ? "sell" : "buy",
            price,
            size,
            executedAt: num(row.cTime as string) ?? Date.now(),
          },
        });
      }
    }

    if (channel === "account") {
      const balances: PrivateBalanceSnapshot[] = [];
      for (const row of rows) {
        const available = num(row.available as string);
        if (available === null) continue;
        balances.push({
          asset: typeof row.marginCoin === "string" ? row.marginCoin : MARGIN_COIN,
          available,
          inPosition: num(row.locked as string) ?? 0,
          equity: num(row.equity as string) ?? available,
        });
      }
      if (balances.length > 0) out.push({ kind: "balance", balances });
    }

    return out;
  },
};
