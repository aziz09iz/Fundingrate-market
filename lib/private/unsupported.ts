import type { ExchangeId } from "@/lib/types";
import type { PrivateAdapter } from "@/lib/private/adapter";
import { exchangeInfo } from "@/lib/utils";

/**
 * A private adapter for a venue whose authenticated API is not implemented.
 *
 * Only Lighter uses this. Hyperliquid and Aster both trade; Lighter is the one venue
 * where the obstacle is cryptographic rather than a matter of work.
 *
 * Lighter does not sign requests — it signs L2 transactions, with a Schnorr
 * signature over the ECgFp5 curve using Poseidon2 hashing over the Goldilocks
 * field. There is no JavaScript implementation of that curve, official or
 * otherwise: Lighter ships Python and Go SDKs, and the Go one is distributed to
 * Python as a platform-native shared library. The only route into Node would be
 * loading Lighter's Go-compiled WebAssembly signer, or an unofficial npm package
 * that bundles the same binary. The npm package that looks official
 * (`zklighter-perps`, published by Lighter's own org) contains REST models and no
 * signer at all, so it cannot place an order.
 *
 * Shipping an unaudited WASM blob into the path that moves real money is a worse
 * trade than saying the venue is market-data only, so that is what this says.
 *
 * The stub fails loudly and specifically rather than degrading quietly. A venue that
 * returns an empty position list looks like a flat account; one that says why it
 * cannot read is honest. `supportsTrading: false` and the absence of
 * `supportsWallet` keep it out of the order path and the treasury source list
 * without any caller needing to special-case it.
 */
export function unsupportedPrivateAdapter(id: ExchangeId): PrivateAdapter {
  const name = exchangeInfo(id).name;
  const reason = () =>
    new Error(
      `${name} account access is not implemented in this app. Market data for ${name} works; ` +
        `positions, balances, orders and transfers do not. ${name} signs orders with a curve ` +
        `(ECgFp5 Schnorr, Poseidon2 hashing) that has no JavaScript implementation.`,
    );

  return {
    id,
    supportsTrading: false,
    // supportsWallet deliberately unset: no balance read, so it is neither a
    // transfer source nor a destination.

    async verify() {
      throw reason();
    },
    async fetchPositions() {
      throw reason();
    },
    async fetchBalances() {
      throw reason();
    },
    async fetchOpenOrders() {
      throw reason();
    },
  };
}
