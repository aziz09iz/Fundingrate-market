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
import { okxWsLogin, sendSigned, signOkx } from "@/lib/private/signing";
import { normalizeChain } from "@/lib/rebalance/chains";
import { num } from "@/lib/exchanges/adapter";

/**
 * OKX v5 swap, authenticated.
 *
 * OKX needs the passphrase set when the key was created, both for REST headers
 * and for the websocket login frame.
 */

interface OkxEnvelope<T> {
  code?: string;
  msg?: string;
  data?: T;
}

interface OkxPositionRow {
  instId?: string;
  posSide?: string;
  pos?: string;
  avgPx?: string;
  markPx?: string;
  upl?: string;
  lever?: string;
  liqPx?: string;
}

interface OkxBalanceDetail {
  ccy?: string;
  availBal?: string;
  eq?: string;
  frozenBal?: string;
}

interface OkxOrderRow {
  ordId?: string;
  clOrdId?: string;
  instId?: string;
  side?: string;
  ordType?: string;
  px?: string;
  avgPx?: string;
  sz?: string;
  accFillSz?: string;
  state?: string;
  reduceOnly?: string;
  fillPx?: string;
  fillSz?: string;
  tradeId?: string;
  fee?: string;
  pnl?: string;
  uTime?: string;
}

function instId(coin: string): string {
  return `${coin.toUpperCase()}-USDT-SWAP`;
}

// ─── Wallet shapes ──────────────────────────────────────────────────────────

interface OkxFundingRow {
  ccy?: string;
  bal?: string;
  availBal?: string;
}

interface OkxCurrencyRow {
  ccy?: string;
  chain?: string;
  canWd?: boolean;
  minFee?: string;
  minWd?: string;
  minDepArrivalConfirm?: string;
}

interface OkxWithdrawRow {
  wdId?: string;
  ccy?: string;
  chain?: string;
  amt?: string;
  fee?: string;
  to?: string;
  txId?: string;
  state?: string;
  ts?: string;
}

interface OkxDepositRow {
  depId?: string;
  ccy?: string;
  chain?: string;
  amt?: string;
  to?: string;
  txId?: string;
  state?: string;
  ts?: string;
}

/** OKX withdrawal state: 2 success, -1/-2/-3 failed or cancelled. */
function mapWithdrawStatus(state: string | undefined): TransferHistoryEntry["status"] {
  switch (state) {
    case "2":
      return "completed";
    case "-1":
    case "-2":
    case "-3":
      return "failed";
    case "1":
      return "processing";
    default:
      return "pending";
  }
}

/** OKX deposit state: 2 credited, 0/1 pending, 8+ pending review. */
function mapDepositStatus(state: string | undefined): TransferHistoryEntry["status"] {
  if (state === "2") return "completed";
  if (state === "1") return "processing";
  return "pending";
}

function coinFromInstId(id: string | undefined): string | null {
  if (!id) return null;
  const parts = id.split("-");
  if (parts.length < 3 || parts[1] !== "USDT" || parts[2] !== "SWAP") return null;
  return parts[0] || null;
}

function mapStatus(state: string | undefined): PrivateOrderSnapshot["status"] {
  switch (state) {
    case "live":
      return "open";
    case "partially_filled":
      return "partial";
    case "filled":
      return "filled";
    case "canceled":
    case "mmp_canceled":
      return "cancelled";
    default:
      return "open";
  }
}

/** OKX signals failure with a non-"0" code in a 200 response. */
function unwrap<T>(label: string, body: OkxEnvelope<T>): T {
  if (body.code !== undefined && body.code !== "0") {
    throw new Error(`${label}: ${body.code} ${body.msg ?? ""}`.trim());
  }
  return (body.data ?? []) as T;
}

export const okxPrivate: PrivateAdapter = {
  id: "okx",
  supportsTrading: true,
  supportsWallet: true,

  async verify(creds, signal) {
    const body = await sendSigned<OkxEnvelope<unknown>>(
      "okx/balance",
      signOkx(creds, "GET", "/api/v5/account/balance"),
      signal,
    );
    unwrap("okx/balance", body);
  },

  async fetchPositions(creds, signal) {
    const body = await sendSigned<OkxEnvelope<OkxPositionRow[]>>(
      "okx/positions",
      signOkx(creds, "GET", "/api/v5/account/positions", { instType: "SWAP" }),
      signal,
    );
    const rows = unwrap("okx/positions", body);
    const out: PrivatePositionSnapshot[] = [];
    for (const row of rows) {
      const coin = coinFromInstId(row.instId);
      const size = num(row.pos);
      if (!coin || size === null || size === 0) continue;
      // net mode reports direction through the sign of `pos`.
      const side = row.posSide === "short" || size < 0 ? "short" : "long";
      out.push({
        coin,
        side,
        size: Math.abs(size),
        entryPrice: num(row.avgPx) ?? 0,
        markPrice: num(row.markPx) ?? 0,
        unrealizedPnl: num(row.upl) ?? 0,
        leverage: num(row.lever) ?? 1,
        liquidationPrice: num(row.liqPx),
      });
    }
    return out;
  },

  async fetchBalances(creds, signal) {
    const body = await sendSigned<OkxEnvelope<{ details?: OkxBalanceDetail[] }[]>>(
      "okx/balance",
      signOkx(creds, "GET", "/api/v5/account/balance"),
      signal,
    );
    const rows = unwrap("okx/balance", body);
    const out: PrivateBalanceSnapshot[] = [];
    for (const account of rows) {
      for (const detail of account.details ?? []) {
        const asset = detail.ccy ?? "";
        const available = num(detail.availBal) ?? 0;
        const equity = num(detail.eq) ?? available;
        if (!asset || (available === 0 && equity === 0)) continue;
        out.push({ asset, available, inPosition: num(detail.frozenBal) ?? 0, equity });
      }
    }
    return out;
  },

  async fetchOpenOrders(creds, signal) {
    const body = await sendSigned<OkxEnvelope<OkxOrderRow[]>>(
      "okx/orders-pending",
      signOkx(creds, "GET", "/api/v5/trade/orders-pending", { instType: "SWAP" }),
      signal,
    );
    const rows = unwrap("okx/orders-pending", body);
    const out: PrivateOrderSnapshot[] = [];
    for (const row of rows) {
      const coin = coinFromInstId(row.instId);
      if (!coin) continue;
      out.push({
        exchangeOrderId: row.ordId ?? "",
        clientOrderId: row.clOrdId ?? null,
        coin,
        side: row.side === "sell" ? "sell" : "buy",
        orderType: row.ordType === "market" ? "market" : "limit",
        price: num(row.px) ?? num(row.avgPx) ?? 0,
        size: num(row.sz) ?? 0,
        filled: num(row.accFillSz) ?? 0,
        status: mapStatus(row.state),
        reduceOnly: row.reduceOnly === "true",
      });
    }
    return out;
  },

  async placeOrder(creds, request, signal) {
    const payload: Record<string, unknown> = {
      instId: instId(request.coin),
      tdMode: "cross",
      side: request.side,
      ordType: request.orderType,
      sz: String(request.size),
      // OKX rejects clOrdId with punctuation, so keep it alphanumeric.
      clOrdId: request.clientOrderId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32),
    };
    if (request.orderType === "limit") {
      if (request.price === undefined) throw new Error("limit order requires a price");
      payload.px = String(request.price);
    }
    if (request.reduceOnly) payload.reduceOnly = true;

    const body = await sendSigned<OkxEnvelope<{ ordId?: string; sCode?: string; sMsg?: string }[]>>(
      "okx/order",
      signOkx(creds, "POST", "/api/v5/trade/order", {}, payload),
      signal,
    );
    const rows = unwrap("okx/order", body);
    const first = rows[0];
    // Per-order errors arrive in sCode even when the envelope code is "0".
    if (first?.sCode && first.sCode !== "0") {
      throw new Error(`okx/order: ${first.sCode} ${first.sMsg ?? ""}`.trim());
    }
    return {
      exchangeOrderId: first?.ordId ?? "",
      status: request.orderType === "market" ? "pending" : "open",
      raw: first,
    };
  },

  async cancelOrder(creds, request, signal) {
    const payload: Record<string, unknown> = { instId: instId(request.coin) };
    if (request.exchangeOrderId) payload.ordId = request.exchangeOrderId;
    else if (request.clientOrderId) {
      payload.clOrdId = request.clientOrderId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
    } else throw new Error("cancel requires an order id");

    const body = await sendSigned<OkxEnvelope<{ sCode?: string; sMsg?: string }[]>>(
      "okx/cancel-order",
      signOkx(creds, "POST", "/api/v5/trade/cancel-order", {}, payload),
      signal,
    );
    const rows = unwrap("okx/cancel-order", body);
    const first = rows[0];
    if (first?.sCode && first.sCode !== "0") {
      throw new Error(`okx/cancel-order: ${first.sCode} ${first.sMsg ?? ""}`.trim());
    }
  },

  // ─── Wallet ───────────────────────────────────────────────────────────────
  // OKX withdraws from the funding account (account "6"); trading uses the
  // unified trading account ("18").

  async fetchWalletBalances(creds, signal) {
    const body = await sendSigned<OkxEnvelope<OkxFundingRow[]>>(
      "okx/funding-balance",
      signOkx(creds, "GET", "/api/v5/asset/balances"),
      signal,
    );
    const rows = unwrap("okx/funding-balance", body);
    const out: WalletBalanceSnapshot[] = [];
    for (const row of rows) {
      const asset = row.ccy ?? "";
      const available = num(row.availBal) ?? 0;
      const total = num(row.bal) ?? available;
      if (!asset || (available === 0 && total === 0)) continue;
      out.push({ wallet: "funding", asset, available, total });
    }
    return out;
  },

  async fetchWithdrawNetworks(creds, asset, signal) {
    const body = await sendSigned<OkxEnvelope<OkxCurrencyRow[]>>(
      "okx/currencies",
      signOkx(creds, "GET", "/api/v5/asset/currencies", { ccy: asset.toUpperCase() }),
      signal,
    );
    const rows = unwrap("okx/currencies", body);
    const out: WithdrawNetworkSnapshot[] = [];
    for (const row of rows) {
      if ((row.ccy ?? "").toUpperCase() !== asset.toUpperCase()) continue;
      // OKX chain strings look like "USDT-TRON"; both forms are in the map.
      const venueChain = row.chain ?? "";
      const network = normalizeChain("okx", venueChain);
      if (!network) continue;
      out.push({
        network,
        venueChain,
        asset: asset.toUpperCase(),
        fee: num(row.minFee) ?? 0,
        minAmount: num(row.minWd) ?? 0,
        enabled: row.canWd !== false,
        confirmations: num(row.minDepArrivalConfirm),
      });
    }
    return out;
  },

  async internalTransfer(creds, request, signal) {
    const body = await sendSigned<OkxEnvelope<unknown>>(
      "okx/transfer",
      signOkx(creds, "POST", "/api/v5/asset/transfer", {}, {
        ccy: request.asset,
        amt: String(request.amount),
        from: request.from === "futures" ? "18" : "6",
        to: request.to === "funding" ? "6" : "18",
      }),
      signal,
    );
    unwrap("okx/transfer", body);
  },

  async withdraw(creds, request, signal) {
    const body = await sendSigned<OkxEnvelope<{ wdId?: string }[]>>(
      "okx/withdrawal",
      signOkx(creds, "POST", "/api/v5/asset/withdrawal", {}, {
        ccy: request.asset,
        amt: String(request.amount),
        // dest 4 = on-chain withdrawal, as opposed to an internal OKX transfer.
        dest: "4",
        toAddr: request.memo ? `${request.address}:${request.memo}` : request.address,
        chain: request.venueChain,
        clientId: request.clientTransferId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 32),
      }),
      signal,
    );
    const rows = unwrap("okx/withdrawal", body);
    const id = rows[0]?.wdId;
    if (!id) throw new Error("okx/withdrawal: no withdrawal id returned");
    return { venueWithdrawId: String(id), raw: rows[0] };
  },

  async fetchTransferHistory(creds, asset, signal) {
    const [withdrawBody, depositBody] = await Promise.all([
      sendSigned<OkxEnvelope<OkxWithdrawRow[]>>(
        "okx/withdrawal-history",
        signOkx(creds, "GET", "/api/v5/asset/withdrawal-history", { ccy: asset.toUpperCase() }),
        signal,
      ),
      sendSigned<OkxEnvelope<OkxDepositRow[]>>(
        "okx/deposit-history",
        signOkx(creds, "GET", "/api/v5/asset/deposit-history", { ccy: asset.toUpperCase() }),
        signal,
      ),
    ]);

    const out: TransferHistoryEntry[] = [];
    for (const row of unwrap("okx/withdrawal-history", withdrawBody)) {
      out.push({
        direction: "withdraw",
        venueId: String(row.wdId ?? ""),
        asset: row.ccy ?? asset,
        amount: num(row.amt) ?? 0,
        fee: num(row.fee),
        venueChain: row.chain ?? null,
        address: row.to ?? null,
        txId: row.txId ?? null,
        status: mapWithdrawStatus(row.state),
        at: num(row.ts) ?? Date.now(),
      });
    }
    for (const row of unwrap("okx/deposit-history", depositBody)) {
      out.push({
        direction: "deposit",
        venueId: String(row.depId ?? row.txId ?? ""),
        asset: row.ccy ?? asset,
        amount: num(row.amt) ?? 0,
        fee: null,
        venueChain: row.chain ?? null,
        address: row.to ?? null,
        txId: row.txId ?? null,
        status: mapDepositStatus(row.state),
        at: num(row.ts) ?? Date.now(),
      });
    }
    return out;
  },

  async resolveWs(creds) {
    return {
      url: "wss://ws.okx.com:8443/ws/v5/private",
      onOpenMessages: [
        okxWsLogin(creds),
        {
          op: "subscribe",
          args: [
            { channel: "positions", instType: "SWAP" },
            { channel: "orders", instType: "SWAP" },
            { channel: "account" },
          ],
        },
      ],
      heartbeat: { intervalMs: 20_000, message: "ping" },
    };
  },

  parseWsMessage(raw) {
    if (raw === "pong") return [];
    let frame: { arg?: { channel?: string }; data?: unknown; event?: string; code?: string };
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
        const coin = coinFromInstId(typeof row.instId === "string" ? row.instId : undefined);
        const size = num(row.pos as string);
        if (!coin || size === null) continue;
        out.push({
          kind: "position",
          position: {
            coin,
            side: row.posSide === "short" || size < 0 ? "short" : "long",
            size: Math.abs(size),
            entryPrice: num(row.avgPx as string) ?? 0,
            markPrice: num(row.markPx as string) ?? 0,
            unrealizedPnl: num(row.upl as string) ?? 0,
            leverage: num(row.lever as string) ?? 1,
            liquidationPrice: num(row.liqPx as string),
          },
        });
      }
    }

    if (channel === "orders") {
      for (const row of rows) {
        const coin = coinFromInstId(typeof row.instId === "string" ? row.instId : undefined);
        if (!coin) continue;
        out.push({
          kind: "order",
          order: {
            exchangeOrderId: String(row.ordId ?? ""),
            clientOrderId: typeof row.clOrdId === "string" ? row.clOrdId : null,
            coin,
            side: row.side === "sell" ? "sell" : "buy",
            orderType: row.ordType === "market" ? "market" : "limit",
            price: num(row.px as string) ?? num(row.avgPx as string) ?? 0,
            size: num(row.sz as string) ?? 0,
            filled: num(row.accFillSz as string) ?? 0,
            status: mapStatus(typeof row.state === "string" ? row.state : undefined),
            reduceOnly: row.reduceOnly === "true",
          },
        });

        const fillSz = num(row.fillSz as string);
        const fillPx = num(row.fillPx as string);
        if (fillSz && fillPx) {
          out.push({
            kind: "fill",
            fill: {
              exchangeTradeId: row.tradeId !== undefined ? String(row.tradeId) : null,
              exchangeOrderId: row.ordId !== undefined ? String(row.ordId) : null,
              clientOrderId: typeof row.clOrdId === "string" ? row.clOrdId : null,
              coin,
              side: row.side === "sell" ? "sell" : "buy",
              price: fillPx,
              size: fillSz,
              fee: num(row.fee as string),
              realizedPnl: num(row.pnl as string),
              executedAt: num(row.uTime as string) ?? Date.now(),
            },
          });
        }
      }
    }

    if (channel === "account") {
      const balances: PrivateBalanceSnapshot[] = [];
      for (const row of rows) {
        const details = Array.isArray(row.details) ? (row.details as Record<string, unknown>[]) : [];
        for (const detail of details) {
          const asset = typeof detail.ccy === "string" ? detail.ccy : "";
          const available = num(detail.availBal as string);
          if (!asset || available === null) continue;
          balances.push({
            asset,
            available,
            inPosition: num(detail.frozenBal as string) ?? 0,
            equity: num(detail.eq as string) ?? available,
          });
        }
      }
      if (balances.length > 0) out.push({ kind: "balance", balances });
    }

    return out;
  },
};
