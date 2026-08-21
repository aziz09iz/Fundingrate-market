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
import { gateioWsAuth, sendSigned, signGateio } from "@/lib/private/signing";
import { normalizeChain } from "@/lib/rebalance/chains";
import { num } from "@/lib/exchanges/adapter";

/**
 * Gate.io USDT futures, authenticated.
 *
 * Gate signs with HMAC-SHA512 and requires the user id for private websocket
 * subscriptions, which is read once from the accounts endpoint.
 *
 * Order sizes are in contracts and use the sign for direction, so a short is a
 * negative size rather than a side field.
 */

interface GatePosition {
  contract?: string;
  size?: number;
  entry_price?: string;
  mark_price?: string;
  unrealised_pnl?: string;
  leverage?: string;
  liq_price?: string;
  user?: number;
}

interface GateAccount {
  total?: string;
  available?: string;
  position_margin?: string;
  unrealised_pnl?: string;
  currency?: string;
  user?: number;
}

interface GateOrder {
  id?: number | string;
  text?: string;
  contract?: string;
  size?: number;
  left?: number;
  price?: string;
  fill_price?: string;
  status?: string;
  is_reduce_only?: boolean;
  finish_as?: string;
  create_time?: number;
  update_time?: number;
}

interface GateContract {
  name?: string;
  quanto_multiplier?: string;
}

// ─── Wallet shapes ──────────────────────────────────────────────────────────

interface GateSpotAccount {
  currency?: string;
  available?: string;
  locked?: string;
}

interface GateChainRow {
  chain?: string;
  name_cn?: string;
  name_en?: string;
  is_disabled?: number;
  is_deposit_disabled?: number;
  is_withdraw_disabled?: number;
}

interface GateWithdrawFeeRow {
  currency?: string;
  withdraw_fix?: string;
  withdraw_fix_on_chains?: Record<string, string>;
}

type GateWithdrawFee = GateWithdrawFeeRow[];

interface GateTransferRow {
  id?: string;
  txid?: string;
  currency?: string;
  chain?: string;
  address?: string;
  amount?: string;
  fee?: string;
  status?: string;
  timestamp?: string;
}

/**
 * Gate status codes: DONE/ok settled, CANCEL/FAIL/INVALID failed, everything
 * else is still moving.
 */
function mapTransferStatus(status: string | undefined): TransferHistoryEntry["status"] {
  switch (status) {
    case "DONE":
    case "done":
      return "completed";
    case "CANCEL":
    case "FAIL":
    case "INVALID":
      return "failed";
    case "BCODE":
    case "EXTPEND":
    case "SPLITPEND":
      return "processing";
    default:
      return "pending";
  }
}

function contractName(coin: string): string {
  return `${coin.toUpperCase()}_USDT`;
}

function coinFromContract(name: string | undefined): string | null {
  if (!name) return null;
  const [base, quote] = name.split("_");
  return quote === "USDT" && base ? base : null;
}

const multiplierCache = new Map<string, { value: number; at: number }>();
const MULTIPLIER_TTL_MS = 10 * 60 * 1000;

async function quantoMultiplier(contract: string, signal: AbortSignal): Promise<number> {
  const cached = multiplierCache.get(contract);
  if (cached && Date.now() - cached.at < MULTIPLIER_TTL_MS) return cached.value;
  const res = await fetch(
    `https://api.gateio.ws/api/v4/futures/usdt/contracts/${encodeURIComponent(contract)}`,
    { headers: { accept: "application/json" }, signal },
  );
  if (!res.ok) throw new Error(`gateio/contract: HTTP ${res.status}`);
  const body = (await res.json()) as GateContract;
  const multiplier = num(body.quanto_multiplier);
  if (multiplier === null || multiplier <= 0) {
    throw new Error(`gateio/contract: missing multiplier for ${contract}`);
  }
  multiplierCache.set(contract, { value: multiplier, at: Date.now() });
  return multiplier;
}

let cachedUserId: { value: number; at: number } | null = null;

async function accountUserId(
  creds: Parameters<PrivateAdapter["fetchBalances"]>[0],
  signal: AbortSignal,
): Promise<number | null> {
  if (cachedUserId && Date.now() - cachedUserId.at < MULTIPLIER_TTL_MS) return cachedUserId.value;
  const account = await sendSigned<GateAccount>(
    "gateio/accounts",
    signGateio(creds, "GET", "/api/v4/futures/usdt/accounts"),
    signal,
  );
  const user = num(account.user);
  if (user === null) return null;
  cachedUserId = { value: user, at: Date.now() };
  return user;
}

function mapStatus(row: GateOrder): PrivateOrderSnapshot["status"] {
  if (row.status === "finished") {
    return row.finish_as === "filled" ? "filled" : "cancelled";
  }
  const size = Math.abs(num(row.size) ?? 0);
  const left = Math.abs(num(row.left) ?? 0);
  if (size > 0 && left < size) return "partial";
  return "open";
}

export const gateioPrivate: PrivateAdapter = {
  id: "gateio",
  supportsTrading: true,
  supportsWallet: true,

  async verify(creds, signal) {
    await sendSigned<GateAccount>(
      "gateio/accounts",
      signGateio(creds, "GET", "/api/v4/futures/usdt/accounts"),
      signal,
    );
  },

  async fetchPositions(creds, signal) {
    const rows = await sendSigned<GatePosition[]>(
      "gateio/positions",
      signGateio(creds, "GET", "/api/v4/futures/usdt/positions"),
      signal,
    );
    const out: PrivatePositionSnapshot[] = [];
    for (const row of rows) {
      const coin = coinFromContract(row.contract);
      const size = num(row.size);
      if (!coin || size === null || size === 0) continue;
      let coinSize = Math.abs(size);
      try {
        coinSize = Math.abs(size) * (await quantoMultiplier(row.contract ?? "", signal));
      } catch {
        // Keep contracts rather than dropping the position.
      }
      out.push({
        coin,
        // Gate encodes direction in the sign of size.
        side: size > 0 ? "long" : "short",
        size: coinSize,
        entryPrice: num(row.entry_price) ?? 0,
        markPrice: num(row.mark_price) ?? 0,
        unrealizedPnl: num(row.unrealised_pnl) ?? 0,
        leverage: num(row.leverage) ?? 1,
        liquidationPrice: num(row.liq_price),
      });
    }
    return out;
  },

  async fetchBalances(creds, signal) {
    const account = await sendSigned<GateAccount>(
      "gateio/accounts",
      signGateio(creds, "GET", "/api/v4/futures/usdt/accounts"),
      signal,
    );
    const available = num(account.available) ?? 0;
    const total = num(account.total) ?? available;
    return [
      {
        asset: account.currency ?? "USDT",
        available,
        inPosition: num(account.position_margin) ?? 0,
        equity: total + (num(account.unrealised_pnl) ?? 0),
      },
    ];
  },

  async fetchOpenOrders(creds, signal) {
    const rows = await sendSigned<GateOrder[]>(
      "gateio/orders",
      signGateio(creds, "GET", "/api/v4/futures/usdt/orders", { status: "open" }),
      signal,
    );
    const out: PrivateOrderSnapshot[] = [];
    for (const row of rows) {
      const coin = coinFromContract(row.contract);
      if (!coin) continue;
      const size = num(row.size) ?? 0;
      const left = num(row.left) ?? 0;
      out.push({
        exchangeOrderId: String(row.id ?? ""),
        clientOrderId: row.text ?? null,
        coin,
        side: size >= 0 ? "buy" : "sell",
        orderType: num(row.price) === 0 ? "market" : "limit",
        price: num(row.price) ?? num(row.fill_price) ?? 0,
        size: Math.abs(size),
        filled: Math.abs(size) - Math.abs(left),
        status: mapStatus(row),
        reduceOnly: row.is_reduce_only === true,
      });
    }
    return out;
  },

  async placeOrder(creds, request, signal) {
    const contract = contractName(request.coin);
    const multiplier = await quantoMultiplier(contract, signal);
    const contracts = Math.max(1, Math.round(request.size / multiplier));
    // Gate takes a signed size instead of a side field.
    const signedSize = request.side === "buy" ? contracts : -contracts;

    const payload: Record<string, unknown> = {
      contract,
      size: signedSize,
      // Gate requires text to start with "t-".
      text: `t-${request.clientOrderId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`,
      tif: request.orderType === "market" ? "ioc" : "gtc",
      // Price "0" means market order for Gate futures.
      price: request.orderType === "market" ? "0" : String(request.price ?? 0),
    };
    if (request.orderType === "limit" && request.price === undefined) {
      throw new Error("limit order requires a price");
    }
    if (request.reduceOnly) payload.reduce_only = true;

    const row = await sendSigned<GateOrder>(
      "gateio/order",
      signGateio(creds, "POST", "/api/v4/futures/usdt/orders", {}, payload),
      signal,
    );
    return {
      exchangeOrderId: String(row.id ?? ""),
      status: mapStatus(row),
      filledPrice: num(row.fill_price),
      raw: row,
    };
  },

  async cancelOrder(creds, request, signal) {
    if (!request.exchangeOrderId) throw new Error("cancel requires the venue order id");
    await sendSigned(
      "gateio/cancel",
      signGateio(
        creds,
        "DELETE",
        `/api/v4/futures/usdt/orders/${encodeURIComponent(request.exchangeOrderId)}`,
      ),
      signal,
    );
  },

  // ─── Wallet ───────────────────────────────────────────────────────────────
  // Gate withdraws from the spot account, so the internal step moves
  // futures → spot first.

  async fetchWalletBalances(creds, signal) {
    const rows = await sendSigned<GateSpotAccount[]>(
      "gateio/spot-accounts",
      signGateio(creds, "GET", "/api/v4/spot/accounts"),
      signal,
    );
    const out: WalletBalanceSnapshot[] = [];
    for (const row of rows) {
      const asset = row.currency ?? "";
      const available = num(row.available) ?? 0;
      const locked = num(row.locked) ?? 0;
      if (!asset || (available === 0 && locked === 0)) continue;
      out.push({ wallet: "funding", asset, available, total: available + locked });
    }
    return out;
  },

  async fetchWithdrawNetworks(creds, asset, signal) {
    // Gate splits this across two endpoints: chain list, and the fee table.
    const [chains, fees] = await Promise.all([
      sendSigned<GateChainRow[]>(
        "gateio/chains",
        signGateio(creds, "GET", `/api/v4/wallet/currency_chains`, {
          currency: asset.toUpperCase(),
        }),
        signal,
      ),
      sendSigned<GateWithdrawFee>(
        "gateio/withdraw-status",
        signGateio(creds, "GET", "/api/v4/wallet/withdraw_status", {
          currency: asset.toUpperCase(),
        }),
        signal,
      ).catch(() => null),
    ]);

    const feeMap = Array.isArray(fees) ? fees[0]?.withdraw_fix_on_chains : undefined;
    const out: WithdrawNetworkSnapshot[] = [];
    for (const chain of chains) {
      const venueChain = chain.chain ?? "";
      const network = normalizeChain("gateio", venueChain);
      if (!network) continue;
      out.push({
        network,
        venueChain,
        asset: asset.toUpperCase(),
        fee: num(feeMap?.[venueChain]) ?? 0,
        // Gate does not publish a per-chain minimum here; the venue enforces it
        // and rejects an undersized request rather than silently keeping funds.
        minAmount: 0,
        enabled: chain.is_withdraw_disabled !== 1 && chain.is_disabled !== 1,
        confirmations: null,
      });
    }
    return out;
  },

  async internalTransfer(creds, request, signal) {
    await sendSigned(
      "gateio/transfer",
      signGateio(creds, "POST", "/api/v4/wallet/transfers", {}, {
        currency: request.asset,
        from: request.from === "futures" ? "futures" : "spot",
        to: request.to === "funding" ? "spot" : "futures",
        amount: String(request.amount),
        settle: "usdt",
      }),
      signal,
    );
  },

  async withdraw(creds, request, signal) {
    const row = await sendSigned<{ id?: string | number }>(
      "gateio/withdraw",
      signGateio(creds, "POST", "/api/v4/withdrawals", {}, {
        currency: request.asset,
        address: request.address,
        amount: String(request.amount),
        chain: request.venueChain,
        withdraw_order_id: request.clientTransferId.slice(0, 32),
        ...(request.memo ? { memo: request.memo } : {}),
      }),
      signal,
    );
    if (row.id === undefined) throw new Error("gateio/withdraw: no withdrawal id returned");
    return { venueWithdrawId: String(row.id), raw: row };
  },

  async fetchTransferHistory(creds, asset, signal) {
    const [withdrawals, deposits] = await Promise.all([
      sendSigned<GateTransferRow[]>(
        "gateio/withdrawals",
        signGateio(creds, "GET", "/api/v4/wallet/withdrawals", {
          currency: asset.toUpperCase(),
        }),
        signal,
      ),
      sendSigned<GateTransferRow[]>(
        "gateio/deposits",
        signGateio(creds, "GET", "/api/v4/wallet/deposits", { currency: asset.toUpperCase() }),
        signal,
      ),
    ]);

    const out: TransferHistoryEntry[] = [];
    for (const row of withdrawals) {
      out.push({
        direction: "withdraw",
        venueId: String(row.id ?? ""),
        asset: row.currency ?? asset,
        amount: num(row.amount) ?? 0,
        fee: num(row.fee),
        venueChain: row.chain ?? null,
        address: row.address ?? null,
        txId: row.txid ?? null,
        status: mapTransferStatus(row.status),
        at: (num(row.timestamp) ?? 0) * 1000 || Date.now(),
      });
    }
    for (const row of deposits) {
      out.push({
        direction: "deposit",
        venueId: String(row.id ?? row.txid ?? ""),
        asset: row.currency ?? asset,
        amount: num(row.amount) ?? 0,
        fee: num(row.fee),
        venueChain: row.chain ?? null,
        address: row.address ?? null,
        txId: row.txid ?? null,
        status: mapTransferStatus(row.status),
        at: (num(row.timestamp) ?? 0) * 1000 || Date.now(),
      });
    }
    return out;
  },

  async resolveWs(creds, signal) {
    const userId = await accountUserId(creds, signal);
    if (userId === null) throw new Error("gateio: could not resolve account user id");
    const user = String(userId);
    return {
      url: "wss://fx-ws.gateio.ws/v4/ws/usdt",
      onOpenMessages: [
        { ...(gateioWsAuth(creds, "futures.positions", "subscribe") as object), payload: [user, "!all"] },
        { ...(gateioWsAuth(creds, "futures.orders", "subscribe") as object), payload: [user, "!all"] },
        { ...(gateioWsAuth(creds, "futures.balances", "subscribe") as object), payload: [user] },
        { ...(gateioWsAuth(creds, "futures.usertrades", "subscribe") as object), payload: [user, "!all"] },
      ],
      heartbeat: {
        intervalMs: 20_000,
        message: { time: Math.floor(Date.now() / 1000), channel: "futures.ping" },
      },
    };
  },

  parseWsMessage(raw) {
    let frame: { channel?: string; event?: string; result?: unknown };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return [];
    }
    if (frame.event !== "update" || !frame.result) return [];
    const rows = Array.isArray(frame.result)
      ? (frame.result as Record<string, unknown>[])
      : [frame.result as Record<string, unknown>];
    const out: PrivateUpdate[] = [];

    if (frame.channel === "futures.positions") {
      for (const row of rows) {
        const coin = coinFromContract(typeof row.contract === "string" ? row.contract : undefined);
        const size = num(row.size as number);
        if (!coin || size === null) continue;
        out.push({
          kind: "position",
          position: {
            coin,
            side: size >= 0 ? "long" : "short",
            size: Math.abs(size),
            entryPrice: num(row.entry_price as string) ?? 0,
            markPrice: num(row.mark_price as string) ?? 0,
            unrealizedPnl: num(row.unrealised_pnl as string) ?? 0,
            leverage: num(row.leverage as string) ?? 1,
            liquidationPrice: num(row.liq_price as string),
          },
        });
      }
    }

    if (frame.channel === "futures.orders") {
      for (const row of rows) {
        const coin = coinFromContract(typeof row.contract === "string" ? row.contract : undefined);
        if (!coin) continue;
        const size = num(row.size as number) ?? 0;
        const left = num(row.left as number) ?? 0;
        out.push({
          kind: "order",
          order: {
            exchangeOrderId: String(row.id ?? ""),
            clientOrderId: typeof row.text === "string" ? row.text : null,
            coin,
            side: size >= 0 ? "buy" : "sell",
            orderType: num(row.price as string) === 0 ? "market" : "limit",
            price: num(row.price as string) ?? 0,
            size: Math.abs(size),
            filled: Math.abs(size) - Math.abs(left),
            status: mapStatus(row as GateOrder),
            reduceOnly: row.is_reduce_only === true,
          },
        });
      }
    }

    if (frame.channel === "futures.usertrades") {
      for (const row of rows) {
        const coin = coinFromContract(typeof row.contract === "string" ? row.contract : undefined);
        const size = num(row.size as number);
        const price = num(row.price as string);
        if (!coin || !size || !price) continue;
        out.push({
          kind: "fill",
          fill: {
            exchangeTradeId: row.id !== undefined ? String(row.id) : null,
            exchangeOrderId: row.order_id !== undefined ? String(row.order_id) : null,
            clientOrderId: typeof row.text === "string" ? row.text : null,
            coin,
            side: size >= 0 ? "buy" : "sell",
            price,
            size: Math.abs(size),
            executedAt: Math.round((num(row.create_time as number) ?? Date.now() / 1000) * 1000),
          },
        });
      }
    }

    if (frame.channel === "futures.balances") {
      const balances: PrivateBalanceSnapshot[] = [];
      for (const row of rows) {
        const balance = num(row.balance as string);
        if (balance === null) continue;
        balances.push({
          asset: typeof row.currency === "string" ? row.currency : "USDT",
          available: balance,
          equity: balance,
        });
      }
      if (balances.length > 0) out.push({ kind: "balance", balances });
    }

    return out;
  },
};
