"use client";

import { Badge } from "@/components/ui/badge";
import type { ExchangeId, FundingRateRow, PriceSide } from "@/lib/types";
import {
  EXCHANGES,
  cn,
  exchangeName,
  formatAgo,
  formatPrice,
  formatRate,
  formatSignedPct,
  rateColorClass,
  signClass,
} from "@/lib/utils";
import { executablePriceSide } from "@/lib/market/derive";

interface VenueQuotesProps {
  coin: string;
  row: FundingRateRow | null;
  /** Venues involved in the hedge being configured, highlighted in the list. */
  longExchange?: ExchangeId;
  shortExchange?: ExchangeId;
  nowMs: number;
}

/**
 * Top-of-book per venue for one coin.
 *
 * The venues publish best bid/ask on their public streams rather than full
 * depth, so this shows the executable top of book instead of a ladder. That is
 * the number a hedge actually fills at, which is what the spread math uses.
 */
export function VenueQuotes({
  coin,
  row,
  longExchange,
  shortExchange,
  nowMs,
}: VenueQuotesProps) {
  const listed = EXCHANGES.filter((ex) => {
    const rate = row?.rates[ex.id]?.rate ?? null;
    const ticker = row?.tickers[ex.id] ?? null;
    return rate !== null || ticker !== null;
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="font-mono text-sm font-medium">{coin}/USDT</span>
        {row?.priceSpread ? (
          <Badge
            variant="secondary"
            className={cn("text-[10px]", signClass(row.priceSpread.pct))}
          >
            spread {formatSignedPct(row.priceSpread.pct, 4)}
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-[10px] text-muted-foreground">
            no spread yet
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-1 text-[10px] uppercase text-muted-foreground">
        <span>Venue</span>
        <span className="text-right">Bid</span>
        <span className="text-right">Ask</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {listed.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {row ? "No venue quotes yet." : "This coin is not in the watch set."}
          </p>
        )}
        {listed.map((ex) => {
          const value = row?.rates[ex.id] ?? null;
          const ticker = row?.tickers[ex.id] ?? null;
          const isLong = ex.id === longExchange;
          const isShort = ex.id === shortExchange;
          const side: PriceSide = executablePriceSide(
            ex.id,
            value?.rate ?? null,
            row?.direction ?? null,
          );
          return (
            <div
              key={ex.id}
              className={cn(
                "grid grid-cols-[1fr_auto_auto] items-center gap-2 border-b border-border/50 px-3 py-1.5 font-mono text-[11px]",
                (isLong || isShort) && "bg-muted/40",
              )}
            >
              <div className="flex flex-col leading-tight">
                <span className={cn("text-xs", ex.accent)}>{ex.name}</span>
                <span className="flex items-center gap-1">
                  <span className={rateColorClass(value?.rate ?? null)}>
                    {formatRate(value?.rate ?? null)}
                  </span>
                  {value && (
                    <span className="text-[9px] text-muted-foreground">
                      {value.intervalHours}h{value.intervalConfirmed ? "" : "?"}
                    </span>
                  )}
                  {isLong && <span className="text-[9px] text-positive">LONG</span>}
                  {isShort && <span className="text-[9px] text-negative">SHORT</span>}
                </span>
              </div>
              <span
                className={cn(
                  "text-right num",
                  side === "bid" ? "text-negative" : "text-muted-foreground",
                )}
              >
                {formatPrice(ticker?.bid ?? null)}
              </span>
              <span
                className={cn(
                  "text-right num",
                  side === "ask" ? "text-positive" : "text-muted-foreground",
                )}
              >
                {formatPrice(ticker?.ask ?? null)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
        {row?.direction ? (
          <span>
            long {exchangeName(row.direction.longExchange)} ask · short{" "}
            {exchangeName(row.direction.shortExchange)} bid
          </span>
        ) : (
          <span>Direction needs two venues quoting this coin.</span>
        )}
        <span className="ml-2">
          {formatAgo(
            Math.max(
              0,
              ...Object.values(row?.tickers ?? {}).map((t) => t?.ts ?? 0),
            ) || null,
            nowMs,
          )}
        </span>
      </div>
    </div>
  );
}
