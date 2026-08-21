import type { ExchangeId } from "@/lib/types";

/**
 * Standard taker fees, percent of notional, lowest tier, no discounts.
 *
 * Lives in its own module so the browser can import it without pulling in
 * lib/db/fees.ts, which opens the database. The authoritative values are the ones
 * saved in fee_config and read server-side; these are the shipped defaults, used
 * for UI hints and as the fallback when no row exists yet.
 */
export const DEFAULT_TAKER_FEES: Record<ExchangeId, number> = {
  binance: 0.05,
  bybit: 0.055,
  okx: 0.05,
  kucoin: 0.06,
  gateio: 0.05,
  bitget: 0.06,
  hyperliquid: 0.045,
  aster: 0.035,
  // Lighter's metadata reports 0.0000 for both maker and taker, and its docs
  // describe a zero-fee model. Left at zero rather than padded with a guess: an
  // invented fee would understate every spread it touches.
  lighter: 0,
  edgex: 0.038,
};
