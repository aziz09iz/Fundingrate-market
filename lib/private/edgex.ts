import type {
  PrivateAdapter,
  PrivateBalanceSnapshot,
  PrivateOrderSnapshot,
  PrivatePositionSnapshot,
} from "@/lib/private/adapter";
import type { Credentials } from "@/lib/db/credentials";
import { sendSigned } from "@/lib/private/signing";
import { signEdgexGet, signEdgexPost } from "@/lib/private/edgex-signing";
import { fetchJson, num } from "@/lib/exchanges/adapter";
import { sameAddress } from "@/lib/private/eip712";

/**
 * edgeX: reads and cancels, but does not open positions.
 *
 * The split is deliberate and it follows the venue's own authentication design.
 * edgeX has two layers: an HMAC header layer that authenticates the request, and a
 * separate EIP-712 "L2 signature" over the order itself, signed with a *different*
 * key that edgeX calls the trading private key. Reads and cancellations need only
 * the first layer. Placing an order needs the second.
 *
 * Only the first is implemented, for two reasons that compound:
 *
 *   1. **The L2 payload cannot be verified from here.** It is not a signature over
 *      the request — it is a signature over amounts rescaled by per-contract and
 *      per-collateral resolution factors, inside a nested typed struct, with a
 *      nonce derived from a hash of the client order id and an expiry offset eight
 *      days from the order's own. Every one of those is a place to be silently
 *      wrong, and edgeX's documentation host does not resolve, so the only
 *      reference is Python SDK source. A wrong scaling factor is not a rejected
 *      order; it is an order for the wrong size.
 *
 *   2. **It would need a fifth secret.** The app stores an API key, secret,
 *      passphrase and one address per venue. The trading key is a separate value
 *      again, and adding a field for it only pays off if the signing above it can
 *      be trusted.
 *
 * So edgeX takes part as a readable venue: positions and balances appear in the
 * account view, a stray order can be cancelled, and `supportsTrading: false` keeps
 * it out of every path that would open one. That is strictly more than the previous
 * stub, which reported nothing at all.
 *
 * `accountId` is discovered at runtime rather than stored — `getAccountPage` is
 * scoped by the user the API key belongs to, so the four fields the app already
 * holds are enough.
 */

const REST = "https://edgex-prod-v2.edgex.exchange";

interface EdgexEnvelope<T> {
  code?: string;
  msg?: string;
  data?: T;
}

interface AccountRow {
  id?: string;
  ethAddress?: string;
  clientAccountId?: string;
  isSystemAccount?: boolean;
  status?: string;
}

interface CollateralRow {
  coinId?: string;
  amount?: string;
}

interface PositionRow {
  contractId?: string;
  openSize?: string;
  openValue?: string;
  /** Present on some builds; falls back to openValue/openSize. */
  avgEntryPrice?: string;
  leverage?: string;
  liquidatePrice?: string;
  unrealizePnl?: string;
}

interface OrderRow {
  id?: string;
  clientOrderId?: string;
  contractId?: string;
  side?: string;
  type?: string;
  price?: string;
  size?: string;
  cumFillSize?: string;
  status?: string;
  reduceOnly?: boolean;
}

interface Contract {
  contractId?: string;
  contractName?: string;
  enableTrade?: boolean;
}

interface Coin {
  coinId?: string;
  coinName?: string;
}

interface MetaData {
  contractList?: Contract[];
  coinList?: Coin[];
}

/** edgeX answers HTTP 200 with a non-SUCCESS code for a refused request. */
function unwrap<T>(label: string, body: EdgexEnvelope<T>): T {
  if (body.code && body.code !== "SUCCESS") {
    throw new Error(`${label}: ${body.code} ${body.msg ?? ""}`.trim());
  }
  if (body.data === undefined) throw new Error(`${label}: response carried no data`);
  return body.data;
}

// ─── Market metadata ────────────────────────────────────────────────────────

/**
 * "BTCUSDC" → "BTC", matching the public adapter. edgeX quotes in USDC; the base
 * asset is what the rest of the app compares across venues.
 */
function coinFromContractName(name: string): string | null {
  const upper = name.trim().toUpperCase();
  for (const quote of ["USDC", "USDT", "USD"]) {
    if (!upper.endsWith(quote)) continue;
    const base = upper.slice(0, -quote.length);
    return base.length > 0 ? base : null;
  }
  return null;
}

interface Meta {
  coinByContract: Map<string, string>;
  contractByCoin: Map<string, string>;
  coinNameById: Map<string, string>;
}

let metaCache: { at: number; meta: Meta } | null = null;
const META_TTL_MS = 30 * 60 * 1000;

/**
 * The contractId ↔ coin map, plus coinId → asset name for balances.
 *
 * Public and unsigned, and cached: every private read needs it, because edgeX
 * addresses markets and assets by opaque numeric ids in both directions.
 */
async function meta(signal: AbortSignal): Promise<Meta> {
  if (metaCache && Date.now() - metaCache.at < META_TTL_MS) return metaCache.meta;

  const body = await fetchJson<EdgexEnvelope<MetaData>>(
    "edgex/getMetaData",
    `${REST}/api/v2/public/meta/getMetaData`,
    signal,
  );
  const data = unwrap("edgex/getMetaData", body);

  const coinByContract = new Map<string, string>();
  const contractByCoin = new Map<string, string>();
  for (const row of data.contractList ?? []) {
    const contractId = row.contractId?.trim();
    const coin = coinFromContractName(row.contractName ?? "");
    if (!contractId || !coin) continue;
    coinByContract.set(contractId, coin);
    if (!contractByCoin.has(coin)) contractByCoin.set(coin, contractId);
  }

  const coinNameById = new Map<string, string>();
  for (const row of data.coinList ?? []) {
    const id = row.coinId?.trim();
    const name = row.coinName?.trim().toUpperCase();
    if (id && name) coinNameById.set(id, name);
  }

  if (coinByContract.size === 0) throw new Error("edgex/getMetaData: no contracts");
  const built = { coinByContract, contractByCoin, coinNameById };
  metaCache = { at: Date.now(), meta: built };
  return built;
}

// ─── Account discovery ──────────────────────────────────────────────────────

/**
 * The numeric account id every private endpoint needs.
 *
 * Not stored, because it is derivable: `getAccountPage` is scoped by the user the
 * API key belongs to. When the key sees more than one account the stored wallet
 * address decides which, and if it cannot decide, the read is refused rather than
 * guessed — reporting another account's positions as this one's would be worse than
 * reporting none.
 *
 * Cached per API key so a key change is picked up without a restart.
 */
const accountIdCache = new Map<string, { at: number; id: string }>();
const ACCOUNT_TTL_MS = 30 * 60 * 1000;

async function accountId(creds: Credentials, signal: AbortSignal): Promise<string> {
  const cacheKey = creds.apiKey;
  const hit = accountIdCache.get(cacheKey);
  if (hit && Date.now() - hit.at < ACCOUNT_TTL_MS) return hit.id;

  const body = await sendSigned<EdgexEnvelope<{ dataList?: AccountRow[] }>>(
    "edgex/getAccountPage",
    signEdgexGet(creds, "/api/v2/private/account/getAccountPage"),
    signal,
  );
  const rows = (unwrap("edgex/getAccountPage", body).dataList ?? []).filter(
    (row) => row.id && row.isSystemAccount !== true,
  );
  if (rows.length === 0) {
    throw new Error(
      "edgex/getAccountPage: the API key sees no accounts. Check the key was created for this account.",
    );
  }

  let chosen: AccountRow | undefined;
  const address = (creds.walletAddress ?? "").trim();
  if (rows.length === 1) {
    chosen = rows[0];
  } else if (address) {
    chosen = rows.find((row) => sameAddress(row.ethAddress, address));
  } else {
    chosen = rows.find((row) => row.clientAccountId === "main");
  }
  if (!chosen?.id) {
    throw new Error(
      `edgex: the API key sees ${rows.length} accounts and none matched the stored wallet address. ` +
        `Add the account's address to the credential so the right one can be chosen.`,
    );
  }

  accountIdCache.set(cacheKey, { at: Date.now(), id: chosen.id });
  return chosen.id;
}

function mapStatus(status: string | undefined): PrivateOrderSnapshot["status"] {
  switch (status) {
    case "OPEN":
    case "UNTRIGGERED":
      return "open";
    case "PARTIALLY_FILLED":
      return "partial";
    case "FILLED":
      return "filled";
    case "CANCELED":
    case "CANCELLED":
    case "EXPIRED":
      return "cancelled";
    default:
      return "open";
  }
}

export const edgexPrivate: PrivateAdapter = {
  id: "edgex",
  // Order placement needs the L2 signature layer; see the note at the top.
  supportsTrading: false,

  async verify(creds, signal) {
    // Resolving the account id is itself the cheapest authenticated read, and it
    // fails with a specific message for each way the credential can be wrong.
    await accountId(creds, signal);
  },

  async fetchPositions(creds, signal) {
    const [id, market] = await Promise.all([accountId(creds, signal), meta(signal)]);
    const body = await sendSigned<EdgexEnvelope<{ positionList?: PositionRow[] } | PositionRow[]>>(
      "edgex/getAccountById",
      signEdgexGet(creds, "/api/v2/private/account/getAccountById", { accountId: id }),
      signal,
    );
    const data = unwrap("edgex/getAccountById", body);
    const rows = Array.isArray(data) ? data : (data.positionList ?? []);

    const out: PrivatePositionSnapshot[] = [];
    for (const row of rows) {
      const coin = market.coinByContract.get(row.contractId?.trim() ?? "");
      const size = num(row.openSize);
      if (!coin || size === null || size === 0) continue;
      const value = num(row.openValue);
      const entry =
        num(row.avgEntryPrice) ??
        (value !== null && size !== 0 ? Math.abs(value / size) : null) ??
        0;
      out.push({
        // edgeX signs openSize for direction.
        coin,
        side: size > 0 ? "long" : "short",
        size: Math.abs(size),
        entryPrice: entry,
        unrealizedPnl: num(row.unrealizePnl) ?? 0,
        leverage: num(row.leverage) ?? 1,
        liquidationPrice: num(row.liquidatePrice),
      });
    }
    return out;
  },

  async fetchBalances(creds, signal) {
    const [id, market] = await Promise.all([accountId(creds, signal), meta(signal)]);
    const body = await sendSigned<
      EdgexEnvelope<{ collateralList?: CollateralRow[]; collateralAssetModelList?: CollateralRow[] }>
    >(
      "edgex/getAccountAsset",
      signEdgexGet(creds, "/api/v2/private/account/getAccountAsset", { accountId: id }),
      signal,
    );
    const data = unwrap("edgex/getAccountAsset", body);
    const rows = data.collateralList ?? data.collateralAssetModelList ?? [];

    const out: PrivateBalanceSnapshot[] = [];
    for (const row of rows) {
      const amount = num(row.amount);
      if (amount === null || amount === 0) continue;
      // An unmapped coin id is reported under its id rather than dropped: a
      // balance that exists and cannot be named is still a balance.
      const asset = market.coinNameById.get(row.coinId?.trim() ?? "") ?? `coin:${row.coinId}`;
      out.push({ asset, available: amount, equity: amount });
    }
    return out;
  },

  async fetchOpenOrders(creds, signal) {
    const [id, market] = await Promise.all([accountId(creds, signal), meta(signal)]);
    const body = await sendSigned<EdgexEnvelope<{ dataList?: OrderRow[] }>>(
      "edgex/getActiveOrderPage",
      signEdgexGet(creds, "/api/v2/private/order/getActiveOrderPage", {
        accountId: id,
        size: "100",
      }),
      signal,
    );
    const rows = unwrap("edgex/getActiveOrderPage", body).dataList ?? [];

    const out: PrivateOrderSnapshot[] = [];
    for (const row of rows) {
      const coin = market.coinByContract.get(row.contractId?.trim() ?? "");
      if (!coin) continue;
      out.push({
        exchangeOrderId: String(row.id ?? ""),
        clientOrderId: row.clientOrderId ?? null,
        coin,
        side: row.side === "SELL" ? "sell" : "buy",
        orderType: (row.type ?? "").includes("MARKET") ? "market" : "limit",
        price: num(row.price) ?? 0,
        size: num(row.size) ?? 0,
        filled: num(row.cumFillSize) ?? 0,
        status: mapStatus(row.status),
        reduceOnly: row.reduceOnly === true,
      });
    }
    return out;
  },

  /**
   * Cancels an order. Needs only the HMAC layer — no L2 signature, which is why
   * this is present while `placeOrder` is not.
   */
  async cancelOrder(creds, request, signal) {
    const id = await accountId(creds, signal);
    if (request.exchangeOrderId) {
      const body = await sendSigned<EdgexEnvelope<unknown>>(
        "edgex/cancelOrderById",
        signEdgexPost(creds, "/api/v2/private/order/cancelOrderById", {
          accountId: id,
          orderIdList: [request.exchangeOrderId],
        }),
        signal,
      );
      unwrap("edgex/cancelOrderById", body);
      return;
    }
    if (request.clientOrderId) {
      const body = await sendSigned<EdgexEnvelope<unknown>>(
        "edgex/cancelOrderByClientOrderId",
        signEdgexPost(creds, "/api/v2/private/order/cancelOrderByClientOrderId", {
          accountId: id,
          clientOrderIdList: [request.clientOrderId],
        }),
        signal,
      );
      unwrap("edgex/cancelOrderByClientOrderId", body);
      return;
    }
    throw new Error("cancel requires an order id");
  },
};
