import type { ExchangeId } from "@/lib/types";
import type { ExchangeAdapter } from "@/lib/exchanges/adapter";
import { binanceAdapter } from "@/lib/exchanges/binance";
import { bybitAdapter } from "@/lib/exchanges/bybit";
import { okxAdapter } from "@/lib/exchanges/okx";
import { kucoinAdapter } from "@/lib/exchanges/kucoin";
import { gateioAdapter } from "@/lib/exchanges/gateio";
import { bitgetAdapter } from "@/lib/exchanges/bitget";
import { hyperliquidAdapter } from "@/lib/exchanges/hyperliquid";
import { asterAdapter } from "@/lib/exchanges/aster";
import { lighterAdapter } from "@/lib/exchanges/lighter";
import { edgexAdapter } from "@/lib/exchanges/edgex";

export const ADAPTERS: Record<ExchangeId, ExchangeAdapter> = {
  binance: binanceAdapter,
  bybit: bybitAdapter,
  okx: okxAdapter,
  kucoin: kucoinAdapter,
  gateio: gateioAdapter,
  bitget: bitgetAdapter,
  hyperliquid: hyperliquidAdapter,
  aster: asterAdapter,
  lighter: lighterAdapter,
  edgex: edgexAdapter,
};

export const ADAPTER_LIST: ExchangeAdapter[] = Object.values(ADAPTERS);
