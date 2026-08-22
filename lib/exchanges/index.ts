import type { ExchangeId } from "@/lib/types";
import type { ExchangeAdapter } from "@/lib/exchanges/adapter";
import { bybitAdapter } from "@/lib/exchanges/bybit";
import { okxAdapter } from "@/lib/exchanges/okx";
import { kucoinAdapter } from "@/lib/exchanges/kucoin";
import { gateioAdapter } from "@/lib/exchanges/gateio";
import { bitgetAdapter } from "@/lib/exchanges/bitget";
import { hyperliquidAdapter } from "@/lib/exchanges/hyperliquid";
import { asterAdapter } from "@/lib/exchanges/aster";
import { lighterAdapter } from "@/lib/exchanges/lighter";

export const ADAPTERS: Record<ExchangeId, ExchangeAdapter> = {
  bybit: bybitAdapter,
  okx: okxAdapter,
  kucoin: kucoinAdapter,
  gateio: gateioAdapter,
  bitget: bitgetAdapter,
  hyperliquid: hyperliquidAdapter,
  aster: asterAdapter,
  lighter: lighterAdapter,
};

export const ADAPTER_LIST: ExchangeAdapter[] = Object.values(ADAPTERS);
