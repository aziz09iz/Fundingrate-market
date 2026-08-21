import type {
  PrivateAdapter,
  PrivateBalanceSnapshot,
  PrivateOrderSnapshot,
  PrivatePositionSnapshot,
  WalletBalanceSnapshot,
} from "@/lib/private/adapter";
import { num } from "@/lib/exchanges/adapter";
import { addressFromPrivateKey, sameAddress } from "@/lib/private/eip712";
import {
  aggressivePrice,
  assetFor,
  cancelAction,
  cancelByCloidAction,
  cloidFrom,
  midPrice,
  orderAction,
  orderWire,
  postAction,
  roundPrice,
  roundSize,
  signAction,
} from "@/lib/private/hyperliquid-exchange";

/**
 * Hyperliquid.
 *
 * Hyperliquid is not an API-key venue: state is read from a public wallet
 * address, and anything that moves funds is signed with the wallet's own private
 * key. So this adapter has two modes, decided by what the stored credential holds:
 *
 *   · **Address only** — positions, balances and open orders. Saving a DEX
 *     credential without a key marks it read-only, and the order path refuses it.
 *   · **Address plus private key** — the same reads, plus orders signed locally.
 *
 * The signing itself is in `hyperliquid-exchange.ts` and is verified against the
 * official SDK's published test vectors before it will sign anything.
 *
 * Withdrawals stay deliberately absent. `withdraw3` is irreversible, its
 * destination cannot be cross-checked against the venue from here the way a CEX
 * deposit address can, and nothing in the treasury path needs Hyperliquid as a
 * source. Reading balances is enough for it to be a destination.
 */

const INFO_URL = "https://api.hyperliquid.xyz/info";

interface HlAssetPosition {
  position?: {
    coin?: string;
    szi?: string;
    entryPx?: string;
    unrealizedPnl?: string;
    liquidationPx?: string;
    leverage?: { value?: number };
  };
}

interface HlClearinghouse {
  assetPositions?: HlAssetPosition[];
  marginSummary?: { accountValue?: string; totalMarginUsed?: string };
  withdrawable?: string;
}

interface HlSpotBalance {
  coin?: string;
  total?: string;
  hold?: string;
}

interface HlSpotState {
  balances?: HlSpotBalance[];
}

interface HlOpenOrder {
  coin?: string;
  side?: string;
  limitPx?: string;
  sz?: string;
  oid?: number;
  cloid?: string | null;
  timestamp?: number;
}

async function info<T>(body: unknown, signal: AbortSignal): Promise<T> {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`hyperliquid/info: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The subject of every query. `apiKey` holds the public wallet address for a DEX
 * credential — the private key, when present, is in `apiSecret`.
 */
function requireWallet(creds: { apiKey?: string; walletAddress?: string }): string {
  const address = (creds.walletAddress ?? creds.apiKey ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(
      "Hyperliquid needs a wallet address (0x…40 hex). Add it under Venue Credentials → DEX Wallets.",
    );
  }
  return address;
}

/**
 * The signing key, checked against the address it is stored beside.
 *
 * The cross-check is the important part. A key and an address that disagree mean
 * the operator pasted one of the two from the wrong wallet, and Hyperliquid would
 * happily accept the signature — it would just trade a different account than the
 * dashboard is showing. That is worse than a refused order, so it is refused here.
 *
 * An agent (API) wallet is the one legitimate reason for them to differ, and it is
 * not supported: an agent signs for the master account, so the position readout
 * would be right while the address field looked wrong, and telling those two cases
 * apart from a stored string is not possible. Sign with the account's own key.
 */
function requireSigner(creds: { apiKey?: string; walletAddress?: string; apiSecret?: string }): {
  address: string;
  privateKey: string;
} {
  const address = requireWallet(creds);
  const privateKey = (creds.apiSecret ?? "").trim();
  if (!privateKey) {
    throw new Error(
      "Hyperliquid orders need the wallet private key. The stored credential has an address only, " +
        "which is read-only by design.",
    );
  }
  let derived: string;
  try {
    derived = addressFromPrivateKey(privateKey);
  } catch (err) {
    throw new Error(
      `Hyperliquid private key is not usable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!sameAddress(derived, address)) {
    throw new Error(
      "The stored Hyperliquid private key controls a different wallet than the stored address. " +
        "Refusing to trade — re-enter the credential so both come from the same wallet.",
    );
  }
  return { address, privateKey };
}

export const hyperliquidPrivate: PrivateAdapter = {
  id: "hyperliquid",
  supportsTrading: true,
  // Balances are readable, so the venue takes part in the treasury view and can
  // be a transfer destination. `withdraw` is absent, which is what stops it from
  // being used as a source.
  supportsWallet: true,

  async verify(creds, signal) {
    const user = requireWallet(creds);
    // A stored key is checked against the address here, so a mismatched pair is
    // reported by the Verify button rather than discovered by a refused order.
    if ((creds.apiSecret ?? "").trim()) requireSigner(creds);
    await info<HlClearinghouse>({ type: "clearinghouseState", user }, signal);
  },

  async fetchPositions(creds, signal) {
    const user = requireWallet(creds);
    const state = await info<HlClearinghouse>({ type: "clearinghouseState", user }, signal);
    const out: PrivatePositionSnapshot[] = [];
    for (const entry of state.assetPositions ?? []) {
      const position = entry.position;
      const coin = position?.coin;
      const szi = num(position?.szi);
      if (!coin || szi === null || szi === 0) continue;
      out.push({
        coin,
        // Hyperliquid signs size for direction.
        side: szi > 0 ? "long" : "short",
        size: Math.abs(szi),
        entryPrice: num(position?.entryPx) ?? 0,
        unrealizedPnl: num(position?.unrealizedPnl) ?? 0,
        leverage: num(position?.leverage?.value) ?? 1,
        liquidationPrice: num(position?.liquidationPx),
      });
    }
    return out;
  },

  async fetchBalances(creds, signal) {
    const user = requireWallet(creds);
    const state = await info<HlClearinghouse>({ type: "clearinghouseState", user }, signal);
    const equity = num(state.marginSummary?.accountValue) ?? 0;
    const withdrawable = num(state.withdrawable) ?? equity;
    const balances: PrivateBalanceSnapshot[] = [
      {
        asset: "USDC",
        available: withdrawable,
        inPosition: num(state.marginSummary?.totalMarginUsed) ?? 0,
        equity,
      },
    ];
    return balances;
  },

  /**
   * Perp collateral and spot balance, reported as the two wallets the rest of the
   * app already understands.
   *
   * `futures` is the perp account's withdrawable collateral; `funding` is the spot
   * balance, which is where an incoming deposit lands. The naming is the CEX
   * vocabulary rather than Hyperliquid's, because the treasury view compares
   * venues and one set of words is worth more than a literal translation.
   */
  async fetchWalletBalances(creds, signal) {
    const user = requireWallet(creds);
    const [perp, spot] = await Promise.all([
      info<HlClearinghouse>({ type: "clearinghouseState", user }, signal),
      info<HlSpotState>({ type: "spotClearinghouseState", user }, signal),
    ]);

    const out: WalletBalanceSnapshot[] = [
      {
        wallet: "futures",
        asset: "USDC",
        available: num(perp.withdrawable) ?? 0,
      },
    ];
    for (const row of spot.balances ?? []) {
      const asset = row.coin?.trim().toUpperCase();
      const total = num(row.total);
      if (!asset || total === null) continue;
      const hold = num(row.hold) ?? 0;
      out.push({
        wallet: "funding",
        asset,
        available: Math.max(0, total - hold),
      });
    }
    return out;
  },

  async fetchOpenOrders(creds, signal) {
    const user = requireWallet(creds);
    const rows = await info<HlOpenOrder[]>({ type: "openOrders", user }, signal);
    const out: PrivateOrderSnapshot[] = [];
    for (const row of rows) {
      const coin = row.coin;
      const size = num(row.sz);
      if (!coin || size === null) continue;
      out.push({
        exchangeOrderId: String(row.oid ?? ""),
        clientOrderId: row.cloid ?? null,
        coin,
        side: row.side === "A" ? "sell" : "buy",
        orderType: "limit",
        price: num(row.limitPx) ?? 0,
        size,
        filled: 0,
        status: "open",
      });
    }
    return out;
  },

  /**
   * Places an order.
   *
   * Hyperliquid has no market order type, so a market request becomes an IoC limit
   * crossed 5% through the mid — the venue's own convention, and the reason a
   * market order here needs a live mid price. If the mid cannot be read the order
   * is refused rather than sent at a guessed price.
   *
   * `leverage` is ignored on purpose. Hyperliquid stores leverage per asset as
   * account state, changed by a separate `updateLeverage` action; silently issuing
   * that action as a side effect of an order would change the risk profile of any
   * other position the operator holds in the same asset.
   */
  async placeOrder(creds, request, signal) {
    const { privateKey } = requireSigner(creds);
    const asset = await assetFor(request.coin, signal);
    const isBuy = request.side === "buy";

    let price: number;
    if (request.orderType === "limit") {
      if (request.price === undefined) throw new Error("limit order requires a price");
      price = roundPrice(request.price, asset.szDecimals);
    } else {
      price = aggressivePrice(await midPrice(asset.name, signal), isBuy, asset.szDecimals);
    }

    const size = roundSize(request.size, asset.szDecimals);
    if (size <= 0) {
      throw new Error(
        `hyperliquid: ${request.size} rounds to zero at ${asset.szDecimals} decimals for ${asset.name}`,
      );
    }

    const cloid = cloidFrom(request.clientOrderId);
    const action = orderAction([
      orderWire({
        asset: asset.index,
        isBuy,
        price,
        size,
        reduceOnly: request.reduceOnly === true,
        // A limit order rests; a market order must not.
        tif: request.orderType === "limit" ? "Gtc" : "Ioc",
        cloid,
      }),
    ]);

    const nonce = Date.now();
    const signature = signAction(privateKey, action, nonce);
    const result = await postAction(action, signature, nonce, signal);

    const status = result.response?.data?.statuses?.[0];
    if (status?.filled) {
      const filledSize = num(status.filled.totalSz);
      return {
        exchangeOrderId: String(status.filled.oid ?? ""),
        // A partial IoC fill is reported by the venue as `filled` with a smaller
        // size, so "filled" here means "no longer working", not "fully filled".
        status: filledSize !== null && filledSize + 1e-12 < size ? "partial" : "filled",
        filledPrice: num(status.filled.avgPx),
        filledSize,
        raw: result,
      };
    }
    if (status?.resting) {
      return {
        exchangeOrderId: String(status.resting.oid ?? ""),
        status: "open",
        raw: result,
      };
    }
    // An IoC that crossed nothing comes back with neither, which is a real
    // outcome: the order existed and filled zero.
    return { exchangeOrderId: "", status: "cancelled", filledSize: 0, raw: result };
  },

  async cancelOrder(creds, request, signal) {
    const { privateKey } = requireSigner(creds);
    const asset = await assetFor(request.coin, signal);

    const oid = request.exchangeOrderId ? Number(request.exchangeOrderId) : null;
    const action =
      oid !== null && Number.isFinite(oid)
        ? cancelAction([{ a: asset.index, o: oid }])
        : request.clientOrderId
          ? cancelByCloidAction([{ asset: asset.index, cloid: cloidFrom(request.clientOrderId) }])
          : null;
    if (!action) throw new Error("cancel requires an order id");

    const nonce = Date.now();
    await postAction(action, signAction(privateKey, action, nonce), nonce, signal);
  },

  // `withdraw` and `internalTransfer` are intentionally absent; see the note at
  // the top of this file.
};
