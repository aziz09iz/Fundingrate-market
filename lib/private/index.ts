import type { ExchangeId } from "@/lib/types";
import type { PrivateAdapter } from "@/lib/private/adapter";
import { bybitPrivate } from "@/lib/private/bybit";
import { okxPrivate } from "@/lib/private/okx";
import { kucoinPrivate } from "@/lib/private/kucoin";
import { gateioPrivate } from "@/lib/private/gateio";
import { bitgetPrivate } from "@/lib/private/bitget";
import { hyperliquidPrivate } from "@/lib/private/hyperliquid";
import { asterPrivate } from "@/lib/private/aster";
import { unsupportedPrivateAdapter } from "@/lib/private/unsupported";

export const PRIVATE_ADAPTERS: Record<ExchangeId, PrivateAdapter> = {
  bybit: bybitPrivate,
  okx: okxPrivate,
  kucoin: kucoinPrivate,
  gateio: gateioPrivate,
  bitget: bitgetPrivate,
  // DEX venues. Hyperliquid and Aster sign orders with a wallet key.
  hyperliquid: hyperliquidPrivate,
  aster: asterPrivate,
  // Market data only: Lighter's signing curve has no JavaScript implementation.
  lighter: unsupportedPrivateAdapter("lighter"),
};

export const PRIVATE_ADAPTER_LIST: PrivateAdapter[] = Object.values(PRIVATE_ADAPTERS);

export function privateAdapter(exchange: ExchangeId): PrivateAdapter {
  return PRIVATE_ADAPTERS[exchange];
}
