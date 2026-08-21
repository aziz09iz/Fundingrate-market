import type {
  PrivateAdapter,
  PrivateBalanceSnapshot,
  PrivateOrderSnapshot,
  PrivatePositionSnapshot,
  PrivateUpdate,
  PrivateWsTarget,
} from "@/lib/private/adapter";
import { sendSigned } from "@/lib/private/signing";
import { signAster } from "@/lib/private/aster-signing";
import { baseFromConcatSymbol, num } from "@/lib/exchanges/adapter";

/**
 * Aster, authenticated.
 *
 * The response shapes here are Binance's, because Aster's futures API is a clone
 * of it down to the field names — so this file reads much like
 * `lib/private/binance.ts`. What differs is entirely in `aster-signing.ts`: there
 * is no API secret, and every request is signed with an API wallet's Ethereum key
 * over EIP-712.
 *
 * The wallet surface is deliberately absent. Aster's deposits and withdrawals are
 * on-chain transfers rather than exchange withdrawals, so there is no equivalent of
 * `/sapi/v1/capital/withdraw/apply` to call and no venue-reported deposit address
 * to cross-check a destination against. Without that cross-check the rebalancing
 * path would be sending real funds to an address nothing has verified, so Aster
 * takes part in trading only: `supportsWallet` is unset, which keeps it out of the
 * treasury source and destination lists without any caller special-casing it.
 */

function venueSymbol(coin: string): string {
  return `${coin.toUpperCase()}USDT`;
}

interface AsterPositionRow {
  symbol?: string;
  positionAmt?: string;
  entryPrice?: string;
  markPrice?: string;
  unRealizedProfit?: string;
  leverage?: string;
  liquidationPrice?: string;
  positionSide?: string;
}

interface AsterBalanceRow {
  asset?: string;
  balance?: string;
  availableBalance?: string;
  crossUnPnl?: string;
}

interface AsterOrderRow {
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

export const asterPrivate: PrivateAdapter = {
  id: "aster",
  supportsTrading: true,
  // No withdrawal or deposit-address API to verify against; see the note above.

  async verify(creds, signal) {
    await sendSigned("aster/balance", signAster(creds, "GET", "/fapi/v3/balance"), signal);
  },

  async fetchPositions(creds, signal) {
    const rows = await sendSigned<AsterPositionRow[]>(
      "aster/positionRisk",
      signAster(creds, "GET", "/fapi/v3/positionRisk"),
      signal,
    );
    const out: PrivatePositionSnapshot[] = [];
    for (const row of rows) {
      const coin = baseFromConcatSymbol(row.symbol ?? "");
      const amount = num(row.positionAmt);
      if (!coin || amount === null || amount === 0) continue;
      out.push({
        coin,
        // One-way mode signs the amount. In hedge mode the sign can be positive on
        // a SHORT row, so positionSide wins when it says which side this is.
        side:
          row.positionSide === "SHORT"
            ? "short"
            : row.positionSide === "LONG"
              ? "long"
              : amount > 0
                ? "long"
                : "short",
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
    const rows = await sendSigned<AsterBalanceRow[]>(
      "aster/balance",
      signAster(creds, "GET", "/fapi/v3/balance"),
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
    const rows = await sendSigned<AsterOrderRow[]>(
      "aster/openOrders",
      signAster(creds, "GET", "/fapi/v3/openOrders"),
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
    // Aster refuses reduceOnly in hedge mode. The account is expected to be in
    // one-way mode, which is the default, and a hedge-mode account gets a clear
    // rejection from the venue rather than a silently unprotected close here.
    if (request.reduceOnly) params.reduceOnly = "true";

    const row = await sendSigned<AsterOrderRow>(
      "aster/order",
      signAster(creds, "POST", "/fapi/v3/order", params),
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

    await sendSigned("aster/cancel", signAster(creds, "DELETE", "/fapi/v3/order", params), signal);
  },

  /**
   * The user data stream, keyed by a listenKey like Binance's.
   *
   * Aster expires the key after 60 minutes and a PUT extends it, so the keepalive
   * runs well inside that window.
   */
  async resolveWs(creds, signal) {
    const { listenKey } = await sendSigned<{ listenKey?: string }>(
      "aster/listenKey",
      signAster(creds, "POST", "/fapi/v3/listenKey"),
      signal,
    );
    if (!listenKey) throw new Error("aster/listenKey: missing key");
    const target: PrivateWsTarget = {
      url: `wss://fstream.asterdex.com/ws/${listenKey}`,
      keepAlive: {
        intervalMs: 25 * 60 * 1000,
        run: async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          try {
            await sendSigned(
              "aster/listenKey-keepalive",
              signAster(creds, "PUT", "/fapi/v3/listenKey"),
              controller.signal,
            );
          } finally {
            clearTimeout(timer);
          }
        },
      },
    };
    return target;
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
            side: p.ps === "SHORT" ? "short" : p.ps === "LONG" ? "long" : amount >= 0 ? "long" : "short",
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
