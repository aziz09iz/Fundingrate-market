import { randomUUID } from "node:crypto";
import type {
  PrivateAdapter,
  PrivateOrderSnapshot,
  PrivatePositionSnapshot,
  PrivateUpdate,
  TransferHistoryEntry,
  WalletBalanceSnapshot,
  WithdrawNetworkSnapshot,
} from "@/lib/private/adapter";
import { VENUE_HOSTS, sendSigned, signKucoin } from "@/lib/private/signing";
import { normalizeChain } from "@/lib/rebalance/chains";
import { num } from "@/lib/exchanges/adapter";

/**
 * KuCoin Futures, authenticated.
 *
 * Two quirks that matter: contracts are named XBTUSDTM (XBT, not BTC), and the
 * private websocket needs a signed bullet token before connecting.
 *
 * Order sizes are in contracts, not base units, so a size in coin terms has to
 * be divided by the contract multiplier. That mapping is fetched per symbol.
 */

interface KucoinEnvelope<T> {
  code?: string;
  msg?: string;
  data?: T;
}

interface KucoinPositionRow {
  symbol?: string;
  currentQty?: number;
  avgEntryPrice?: number;
  markPrice?: number;
  unrealisedPnl?: number;
  realLeverage?: number;
  liquidationPrice?: number;
}

interface KucoinAccountOverview {
  currency?: string;
  availableBalance?: number;
  accountEquity?: number;
  positionMargin?: number;
}

interface KucoinOrderRow {
  id?: string;
  clientOid?: string;
  symbol?: string;
  side?: string;
  type?: string;
  price?: string;
  size?: number;
  filledSize?: number;
  status?: string;
  reduceOnly?: boolean;
  isActive?: boolean;
}

interface KucoinContract {
  symbol?: string;
  multiplier?: number;
}

// ─── Wallet shapes (spot host) ──────────────────────────────────────────────

interface KucoinSpotAccount {
  currency?: string;
  type?: string;
  balance?: string;
  available?: string;
}

interface KucoinChainDetail {
  chainId?: string;
  chainName?: string;
  withdrawalMinSize?: string;
  withdrawalMinFee?: string;
  isWithdrawEnabled?: boolean;
  confirms?: number;
}

interface KucoinCurrencyDetail {
  currency?: string;
  chains?: KucoinChainDetail[];
}

interface KucoinWithdrawRow {
  id?: string;
  currency?: string;
  chain?: string;
  amount?: string;
  fee?: string;
  address?: string;
  walletTxId?: string;
  status?: string;
  createdAt?: number;
}

interface KucoinDepositRow {
  currency?: string;
  chain?: string;
  amount?: string;
  fee?: string;
  address?: string;
  walletTxId?: string;
  status?: string;
  createdAt?: number;
}

/** KuCoin uses the same status vocabulary for deposits and withdrawals. */
function mapTransferStatus(status: string | undefined): TransferHistoryEntry["status"] {
  switch (status) {
    case "SUCCESS":
      return "completed";
    case "FAILURE":
      return "failed";
    case "PROCESSING":
      return "processing";
    default:
      return "pending";
  }
}

function venueSymbol(coin: string): string {
  const base = coin.toUpperCase() === "BTC" ? "XBT" : coin.toUpperCase();
  return `${base}USDTM`;
}

function coinFromVenueSymbol(symbol: string | undefined): string | null {
  if (!symbol || !symbol.endsWith("USDTM")) return null;
  const base = symbol.slice(0, -"USDTM".length);
  if (!base) return null;
  return base === "XBT" ? "BTC" : base;
}

function unwrap<T>(label: string, body: KucoinEnvelope<T>): T {
  if (body.code !== undefined && body.code !== "200000") {
    throw new Error(`${label}: ${body.code} ${body.msg ?? ""}`.trim());
  }
  if (body.data === undefined) throw new Error(`${label}: empty data`);
  return body.data;
}

function mapStatus(row: KucoinOrderRow): PrivateOrderSnapshot["status"] {
  if (row.status === "done") {
    return (row.filledSize ?? 0) > 0 ? "filled" : "cancelled";
  }
  if ((row.filledSize ?? 0) > 0) return "partial";
  return "open";
}

/** Contract multipliers change rarely, so a short-lived cache is enough. */
const multiplierCache = new Map<string, { value: number; at: number }>();
const MULTIPLIER_TTL_MS = 10 * 60 * 1000;

async function contractMultiplier(symbol: string, signal: AbortSignal): Promise<number> {
  const cached = multiplierCache.get(symbol);
  if (cached && Date.now() - cached.at < MULTIPLIER_TTL_MS) return cached.value;

  const res = await fetch(
    `https://api-futures.kucoin.com/api/v1/contracts/${encodeURIComponent(symbol)}`,
    { headers: { accept: "application/json" }, signal },
  );
  if (!res.ok) throw new Error(`kucoin/contract: HTTP ${res.status}`);
  const body = (await res.json()) as KucoinEnvelope<KucoinContract>;
  const multiplier = num(unwrap("kucoin/contract", body).multiplier);
  if (multiplier === null || multiplier <= 0) {
    throw new Error(`kucoin/contract: missing multiplier for ${symbol}`);
  }
  multiplierCache.set(symbol, { value: multiplier, at: Date.now() });
  return multiplier;
}

export const kucoinPrivate: PrivateAdapter = {
  id: "kucoin",
  supportsTrading: true,
  supportsWallet: true,

  async verify(creds, signal) {
    const body = await sendSigned<KucoinEnvelope<unknown>>(
      "kucoin/account-overview",
      signKucoin(creds, "GET", "/api/v1/account-overview", { currency: "USDT" }),
      signal,
    );
    unwrap("kucoin/account-overview", body);
  },

  async fetchPositions(creds, signal) {
    const body = await sendSigned<KucoinEnvelope<KucoinPositionRow[]>>(
      "kucoin/positions",
      signKucoin(creds, "GET", "/api/v1/positions"),
      signal,
    );
    const rows = unwrap("kucoin/positions", body);
    const out: PrivatePositionSnapshot[] = [];
    for (const row of rows) {
      const coin = coinFromVenueSymbol(row.symbol);
      const qty = num(row.currentQty);
      if (!coin || qty === null || qty === 0) continue;
      let size = Math.abs(qty);
      try {
        // currentQty is in contracts; convert to coin units for consistency.
        size = Math.abs(qty) * (await contractMultiplier(row.symbol ?? "", signal));
      } catch {
        // Fall back to raw contracts rather than dropping the position.
      }
      out.push({
        coin,
        side: qty > 0 ? "long" : "short",
        size,
        entryPrice: num(row.avgEntryPrice) ?? 0,
        markPrice: num(row.markPrice) ?? 0,
        unrealizedPnl: num(row.unrealisedPnl) ?? 0,
        leverage: num(row.realLeverage) ?? 1,
        liquidationPrice: num(row.liquidationPrice),
      });
    }
    return out;
  },

  async fetchBalances(creds, signal) {
    const body = await sendSigned<KucoinEnvelope<KucoinAccountOverview>>(
      "kucoin/account-overview",
      signKucoin(creds, "GET", "/api/v1/account-overview", { currency: "USDT" }),
      signal,
    );
    const row = unwrap("kucoin/account-overview", body);
    const available = num(row.availableBalance) ?? 0;
    return [
      {
        asset: row.currency ?? "USDT",
        available,
        inPosition: num(row.positionMargin) ?? 0,
        equity: num(row.accountEquity) ?? available,
      },
    ];
  },

  async fetchOpenOrders(creds, signal) {
    const body = await sendSigned<KucoinEnvelope<{ items?: KucoinOrderRow[] }>>(
      "kucoin/orders",
      signKucoin(creds, "GET", "/api/v1/orders", { status: "active" }),
      signal,
    );
    const items = unwrap("kucoin/orders", body).items ?? [];
    const out: PrivateOrderSnapshot[] = [];
    for (const row of items) {
      const coin = coinFromVenueSymbol(row.symbol);
      if (!coin) continue;
      out.push({
        exchangeOrderId: row.id ?? "",
        clientOrderId: row.clientOid ?? null,
        coin,
        side: row.side === "sell" ? "sell" : "buy",
        orderType: row.type === "market" ? "market" : "limit",
        price: num(row.price) ?? 0,
        size: num(row.size) ?? 0,
        filled: num(row.filledSize) ?? 0,
        status: mapStatus(row),
        reduceOnly: row.reduceOnly === true,
      });
    }
    return out;
  },

  async placeOrder(creds, request, signal) {
    const symbol = venueSymbol(request.coin);
    const multiplier = await contractMultiplier(symbol, signal);
    // KuCoin sizes orders in whole contracts.
    const contracts = Math.max(1, Math.round(request.size / multiplier));

    const payload: Record<string, unknown> = {
      clientOid: request.clientOrderId,
      symbol,
      side: request.side,
      type: request.orderType,
      size: contracts,
      leverage: String(request.leverage ?? 1),
    };
    if (request.orderType === "limit") {
      if (request.price === undefined) throw new Error("limit order requires a price");
      payload.price = String(request.price);
    }
    if (request.reduceOnly) payload.reduceOnly = true;

    const body = await sendSigned<KucoinEnvelope<{ orderId?: string }>>(
      "kucoin/order",
      signKucoin(creds, "POST", "/api/v1/orders", {}, payload),
      signal,
    );
    const data = unwrap("kucoin/order", body);
    return {
      exchangeOrderId: data.orderId ?? "",
      status: request.orderType === "market" ? "pending" : "open",
      raw: data,
    };
  },

  async cancelOrder(creds, request, signal) {
    if (!request.exchangeOrderId) throw new Error("cancel requires the venue order id");
    const body = await sendSigned<KucoinEnvelope<unknown>>(
      "kucoin/cancel",
      signKucoin(creds, "DELETE", `/api/v1/orders/${encodeURIComponent(request.exchangeOrderId)}`),
      signal,
    );
    unwrap("kucoin/cancel", body);
  },

  // ─── Wallet ───────────────────────────────────────────────────────────────
  // KuCoin splits futures and spot across two hosts. Withdrawals live on the
  // spot host and draw from the "main" account, so the internal step transfers
  // futures → main before any chain activity.

  async fetchWalletBalances(creds, signal) {
    const body = await sendSigned<KucoinEnvelope<KucoinSpotAccount[]>>(
      "kucoin/spot-accounts",
      signKucoin(creds, "GET", "/api/v1/accounts", { type: "main" }, undefined, VENUE_HOSTS.kucoinSpot),
      signal,
    );
    const rows = unwrap("kucoin/spot-accounts", body);
    const out: WalletBalanceSnapshot[] = [];
    for (const row of rows) {
      const asset = row.currency ?? "";
      const available = num(row.available) ?? 0;
      const total = num(row.balance) ?? available;
      if (!asset || (available === 0 && total === 0)) continue;
      out.push({ wallet: "funding", asset, available, total });
    }
    return out;
  },

  async fetchWithdrawNetworks(creds, asset, signal) {
    const body = await sendSigned<KucoinEnvelope<KucoinCurrencyDetail>>(
      "kucoin/currency",
      signKucoin(
        creds,
        "GET",
        `/api/v3/currencies/${encodeURIComponent(asset.toUpperCase())}`,
        {},
        undefined,
        VENUE_HOSTS.kucoinSpot,
      ),
      signal,
    );
    const detail = unwrap("kucoin/currency", body);
    const out: WithdrawNetworkSnapshot[] = [];
    for (const chain of detail.chains ?? []) {
      const venueChain = chain.chainId ?? chain.chainName ?? "";
      const network = normalizeChain("kucoin", venueChain);
      if (!network) continue;
      out.push({
        network,
        venueChain,
        asset: asset.toUpperCase(),
        fee: num(chain.withdrawalMinFee) ?? 0,
        minAmount: num(chain.withdrawalMinSize) ?? 0,
        enabled: chain.isWithdrawEnabled !== false,
        confirmations: num(chain.confirms),
      });
    }
    return out;
  },

  async internalTransfer(creds, request, signal) {
    // Futures → spot uses the futures host's transfer-out endpoint; the reverse
    // is initiated from the spot side.
    if (request.from === "futures") {
      const body = await sendSigned<KucoinEnvelope<unknown>>(
        "kucoin/transfer-out",
        signKucoin(creds, "POST", "/api/v3/transfer-out", {}, {
          bizNo: randomUUID().replace(/-/g, "").slice(0, 24),
          amount: request.amount,
          currency: request.asset,
          recAccountType: "MAIN",
        }),
        signal,
      );
      unwrap("kucoin/transfer-out", body);
      return;
    }
    const body = await sendSigned<KucoinEnvelope<unknown>>(
      "kucoin/transfer-in",
      signKucoin(creds, "POST", "/api/v1/transfer-in", {}, {
        amount: request.amount,
        currency: request.asset,
        payAccountType: "MAIN",
      }),
      signal,
    );
    unwrap("kucoin/transfer-in", body);
  },

  async withdraw(creds, request, signal) {
    const body = await sendSigned<KucoinEnvelope<{ withdrawalId?: string }>>(
      "kucoin/withdraw",
      signKucoin(
        creds,
        "POST",
        "/api/v3/withdrawals",
        {},
        {
          currency: request.asset,
          chain: request.venueChain,
          toAddress: request.address,
          amount: request.amount,
          withdrawType: "ADDRESS",
          ...(request.memo ? { memo: request.memo } : {}),
        },
        VENUE_HOSTS.kucoinSpot,
      ),
      signal,
    );
    const result = unwrap("kucoin/withdraw", body);
    if (!result.withdrawalId) throw new Error("kucoin/withdraw: no withdrawal id returned");
    return { venueWithdrawId: String(result.withdrawalId), raw: result };
  },

  async fetchTransferHistory(creds, asset, signal) {
    const [withdrawBody, depositBody] = await Promise.all([
      sendSigned<KucoinEnvelope<{ items?: KucoinWithdrawRow[] }>>(
        "kucoin/withdrawals",
        signKucoin(
          creds,
          "GET",
          "/api/v1/withdrawals",
          { currency: asset.toUpperCase() },
          undefined,
          VENUE_HOSTS.kucoinSpot,
        ),
        signal,
      ),
      sendSigned<KucoinEnvelope<{ items?: KucoinDepositRow[] }>>(
        "kucoin/deposits",
        signKucoin(
          creds,
          "GET",
          "/api/v1/deposits",
          { currency: asset.toUpperCase() },
          undefined,
          VENUE_HOSTS.kucoinSpot,
        ),
        signal,
      ),
    ]);

    const out: TransferHistoryEntry[] = [];
    for (const row of unwrap("kucoin/withdrawals", withdrawBody).items ?? []) {
      out.push({
        direction: "withdraw",
        venueId: String(row.id ?? ""),
        asset: row.currency ?? asset,
        amount: num(row.amount) ?? 0,
        fee: num(row.fee),
        venueChain: row.chain ?? null,
        address: row.address ?? null,
        txId: row.walletTxId ?? null,
        status: mapTransferStatus(row.status),
        at: num(row.createdAt) ?? Date.now(),
      });
    }
    for (const row of unwrap("kucoin/deposits", depositBody).items ?? []) {
      out.push({
        direction: "deposit",
        venueId: String(row.walletTxId ?? ""),
        asset: row.currency ?? asset,
        amount: num(row.amount) ?? 0,
        fee: num(row.fee),
        venueChain: row.chain ?? null,
        address: row.address ?? null,
        txId: row.walletTxId ?? null,
        status: mapTransferStatus(row.status),
        at: num(row.createdAt) ?? Date.now(),
      });
    }
    return out;
  },

  async resolveWs(creds, signal) {
    // The private stream needs a signed bullet, unlike the public one.
    const body = await sendSigned<
      KucoinEnvelope<{
        token?: string;
        instanceServers?: { endpoint?: string; pingInterval?: number }[];
      }>
    >("kucoin/bullet-private", signKucoin(creds, "POST", "/api/v1/bullet-private"), signal);
    const data = unwrap("kucoin/bullet-private", body);
    const server = data.instanceServers?.[0];
    if (!server?.endpoint || !data.token) {
      throw new Error("kucoin/bullet-private: missing endpoint or token");
    }
    const connectId = `frw-priv-${Date.now()}`;
    const pingInterval = server.pingInterval ?? 18_000;
    return {
      url: `${server.endpoint}?token=${data.token}&connectId=${connectId}`,
      onOpenMessages: [
        {
          id: `${connectId}-pos`,
          type: "subscribe",
          topic: "/contractAccount/wallet",
          privateChannel: true,
          response: true,
        },
        {
          id: `${connectId}-ord`,
          type: "subscribe",
          topic: "/contractMarket/tradeOrders",
          privateChannel: true,
          response: true,
        },
      ],
      heartbeat: {
        intervalMs: Math.max(5_000, pingInterval - 3_000),
        message: { id: connectId, type: "ping" },
      },
    };
  },

  parseWsMessage(raw) {
    let frame: { type?: string; topic?: string; subject?: string; data?: Record<string, unknown> };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return [];
    }
    if (frame.type !== "message" || !frame.data) return [];
    const data = frame.data;
    const out: PrivateUpdate[] = [];

    if (frame.topic?.startsWith("/contractAccount/wallet")) {
      const available = num(data.availableBalance as number);
      if (available !== null) {
        out.push({
          kind: "balance",
          balances: [
            {
              asset: typeof data.currency === "string" ? data.currency : "USDT",
              available,
              equity: num(data.accountEquity as number) ?? available,
            },
          ],
        });
      }
    }

    if (frame.topic?.startsWith("/contractMarket/tradeOrders")) {
      const coin = coinFromVenueSymbol(typeof data.symbol === "string" ? data.symbol : undefined);
      if (coin) {
        const filled = num(data.filledSize as number) ?? 0;
        const size = num(data.size as number) ?? 0;
        const type = typeof data.type === "string" ? data.type : "";
        const status: PrivateOrderSnapshot["status"] =
          type === "canceled"
            ? "cancelled"
            : type === "filled" || (size > 0 && filled >= size)
              ? "filled"
              : filled > 0
                ? "partial"
                : "open";
        out.push({
          kind: "order",
          order: {
            exchangeOrderId: String(data.orderId ?? ""),
            clientOrderId: typeof data.clientOid === "string" ? data.clientOid : null,
            coin,
            side: data.side === "sell" ? "sell" : "buy",
            orderType: data.orderType === "market" ? "market" : "limit",
            price: num(data.price as string) ?? 0,
            size,
            filled,
            status,
          },
        });

        const matchSize = num(data.matchSize as number);
        const matchPrice = num(data.matchPrice as string);
        if (matchSize && matchPrice) {
          out.push({
            kind: "fill",
            fill: {
              exchangeTradeId: data.tradeId !== undefined ? String(data.tradeId) : null,
              exchangeOrderId: data.orderId !== undefined ? String(data.orderId) : null,
              clientOrderId: typeof data.clientOid === "string" ? data.clientOid : null,
              coin,
              side: data.side === "sell" ? "sell" : "buy",
              price: matchPrice,
              size: matchSize,
              executedAt: num(data.ts as number) ?? Date.now(),
            },
          });
        }
      }
    }

    return out;
  },
};
