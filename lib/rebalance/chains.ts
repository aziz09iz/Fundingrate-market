import type { ExchangeId, NetworkId, TransferToken } from "@/lib/types";

/**
 * Chain name normalisation.
 *
 * Every venue spells the same chain differently. Binance calls Tron "TRX",
 * KuCoin calls it "trx", OKX calls it "TRON". Sending USDT on a chain the
 * destination does not credit loses the funds with no recourse, so this mapping
 * is written out per venue rather than derived from a fuzzy match.
 *
 * The rule everywhere: an unrecognised chain string is dropped, never guessed.
 * A missing option is a visible inconvenience; a wrong option is a loss.
 */

/** Canonical ids, matching NetworkId in lib/types. */
export const NETWORK_LABELS: Record<NetworkId, string> = {
  TRC20: "Tron (TRC20)",
  ERC20: "Ethereum (ERC20)",
  BEP20: "BNB Chain (BEP20)",
  ARBITRUM: "Arbitrum One",
  POLYGON: "Polygon PoS",
  SOLANA: "Solana",
};

/**
 * Venue chain string → our NetworkId. Keys are compared lowercased and trimmed.
 * Only chains we are confident about appear here.
 */
const VENUE_CHAINS: Record<ExchangeId, Record<string, NetworkId>> = {
  binance: {
    trx: "TRC20",
    eth: "ERC20",
    bsc: "BEP20",
    arbitrum: "ARBITRUM",
    matic: "POLYGON",
    sol: "SOLANA",
  },
  bybit: {
    trx: "TRC20",
    eth: "ERC20",
    bsc: "BEP20",
    arbi: "ARBITRUM",
    arbitrum: "ARBITRUM",
    matic: "POLYGON",
    sol: "SOLANA",
  },
  okx: {
    "usdt-tron": "TRC20",
    "usdc-tron": "TRC20",
    tron: "TRC20",
    trc20: "TRC20",
    "usdt-erc20": "ERC20",
    "usdc-erc20": "ERC20",
    ethereum: "ERC20",
    erc20: "ERC20",
    "usdt-bsc": "BEP20",
    "usdc-bsc": "BEP20",
    "bnb smart chain (bep20)": "BEP20",
    "usdt-arbitrum one": "ARBITRUM",
    "usdc-arbitrum one": "ARBITRUM",
    "arbitrum one": "ARBITRUM",
    "usdt-polygon": "POLYGON",
    "usdc-polygon": "POLYGON",
    polygon: "POLYGON",
    "usdt-solana": "SOLANA",
    "usdc-solana": "SOLANA",
    solana: "SOLANA",
  },
  kucoin: {
    trx: "TRC20",
    trc20: "TRC20",
    eth: "ERC20",
    erc20: "ERC20",
    bsc: "BEP20",
    bep20: "BEP20",
    arbitrum: "ARBITRUM",
    arbi: "ARBITRUM",
    matic: "POLYGON",
    polygon: "POLYGON",
    sol: "SOLANA",
  },
  gateio: {
    trx: "TRC20",
    trc20: "TRC20",
    eth: "ERC20",
    erc20: "ERC20",
    bsc: "BEP20",
    bep20: "BEP20",
    arbevm: "ARBITRUM",
    arbitrum: "ARBITRUM",
    matic: "POLYGON",
    polygon: "POLYGON",
    sol: "SOLANA",
  },
  bitget: {
    trx: "TRC20",
    "trc20": "TRC20",
    tron: "TRC20",
    eth: "ERC20",
    erc20: "ERC20",
    ethereum: "ERC20",
    bep20: "BEP20",
    bsc: "BEP20",
    arbitrumone: "ARBITRUM",
    arbitrum: "ARBITRUM",
    "arbitrumone(arb)": "ARBITRUM",
    polygon: "POLYGON",
    matic: "POLYGON",
    sol: "SOLANA",
    solana: "SOLANA",
  },
  // On-chain venues: withdrawals need wallet-key signing, which is not
  // implemented, so no chain is mapped. An empty map makes `normalizeChain`
  // return null for every input, which is what keeps them out of the source list.
  hyperliquid: {},
  aster: {},
  lighter: {},
  edgex: {},
};

/**
 * Maps a venue's chain string to our id, or null when we do not recognise it.
 * Returning null is the safe outcome: the caller omits the option.
 */
export function normalizeChain(exchange: ExchangeId, venueChain: string): NetworkId | null {
  const key = venueChain.trim().toLowerCase();
  if (!key) return null;
  return VENUE_CHAINS[exchange][key] ?? null;
}

/** Tokens this app will move. Deliberately only stablecoins. */
export const TRANSFER_TOKENS: TransferToken[] = ["USDT", "USDC"];

export function isTransferToken(value: unknown): value is TransferToken {
  return typeof value === "string" && (TRANSFER_TOKENS as string[]).includes(value);
}

export function isNetworkId(value: unknown): value is NetworkId {
  return typeof value === "string" && value in NETWORK_LABELS;
}
