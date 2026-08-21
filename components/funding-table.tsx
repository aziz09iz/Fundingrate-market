"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ArrowDownLeft,
  ArrowUpRight,
  Timer,
  Zap,
} from "lucide-react";
import type {
  ExchangeId,
  FundingRateRow,
  PriceSide,
  SortDir,
  SortKey,
  SortState,
  Ticker,
} from "@/lib/types";
import {
  EXCHANGES,
  cn,
  exchangeName,
  formatCountdown,
  formatPrice,
  formatRate,
  formatSignedPct,
  rateColorClass,
  signClass,
} from "@/lib/utils";
import { useValueFlash } from "@/lib/hooks/use-value-flash";
import { executablePriceSide, priceForSide } from "@/lib/market/derive";

interface FundingTableProps {
  rows: FundingRateRow[];
  enabled: Record<ExchangeId, boolean>;
  sort: SortState;
  onSort: (key: SortKey) => void;
  nowMs: number;
  /**
   * False when the current view cannot form a venue pair, which makes Diff FR,
   * Direction, Spread and Trade meaningless. Defaults to true.
   */
  showPairColumns?: boolean;
  /**
   * True until the first snapshot arrives. Skeleton rows say "connecting", where
   * an empty table said "there is nothing here" — two different situations that
   * previously looked identical.
   */
  loading?: boolean;
}

export function FundingTable({
  rows,
  enabled,
  sort,
  onSort,
  nowMs,
  showPairColumns = true,
  loading = false,
}: FundingTableProps) {
  const visibleExchanges = useMemo(
    () => EXCHANGES.filter((e) => enabled[e.id]),
    [enabled],
  );

  // Diff FR, Direction, Spread and Trade all describe a hedge across two venues.
  // With no quotable pair on screen there is nothing to describe, so the columns
  // are dropped rather than printed as four columns of dashes.
  const pairable = showPairColumns && visibleExchanges.length >= 2;

  const sorted = useMemo(() => {
    const copy = [...rows];
    const dirMul = sort.dir === "asc" ? 1 : -1;
    copy.sort((a, b) => {
      if (sort.key === "coin") return a.coin.localeCompare(b.coin) * dirMul;
      if (sort.key === "spread" || sort.key === "diffFr") {
        const av = a.diffFr ?? -Infinity;
        const bv = b.diffFr ?? -Infinity;
        return (av - bv) * dirMul;
      }
      if (sort.key === "priceSpread") {
        const av = a.priceSpread?.pct ?? -Infinity;
        const bv = b.priceSpread?.pct ?? -Infinity;
        return (av - bv) * dirMul;
      }
      const ar = a.rates[sort.key]?.rate ?? null;
      const br = b.rates[sort.key]?.rate ?? null;
      if (ar === null && br === null) return 0;
      if (ar === null) return 1; // push "not listed" to bottom
      if (br === null) return -1;
      return (ar - br) * dirMul;
    });
    return copy;
  }, [rows, sort]);

  return (
    // The border lives on the wrapper but the scrolling belongs to Table, which
    // owns the sticky offsets; two nested scrollers would fight each other.
    <div className="rounded-lg border border-border">
      <Table
        className="w-full border-collapse"
        containerClassName="rounded-lg"
        stickyHeader
        stickyFirstColumn
        aria-busy={loading || undefined}
      >
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <SortHead
              label="Coin"
              active={sort.key === "coin"}
              dir={sort.dir}
              onClick={() => onSort("coin")}
              className="min-w-[6rem] text-left"
            />
            {visibleExchanges.map((ex) => (
              <SortHead
                key={ex.id}
                label={ex.name}
                active={sort.key === ex.id}
                dir={sort.dir}
                onClick={() => onSort(ex.id)}
                className={`text-right ${ex.accent}`}
              />
            ))}
            {pairable && (
              <>
                <SortHead
                  label="Diff FR"
                  active={sort.key === "spread" || sort.key === "diffFr"}
                  dir={sort.dir}
                  onClick={() => onSort("diffFr")}
                  className="text-right"
                />
                <TableHead className="text-right">
                  <span className="text-xs font-medium uppercase tracking-wide">Direction</span>
                </TableHead>
                <SortHead
                  label="Spread"
                  active={sort.key === "priceSpread"}
                  dir={sort.dir}
                  onClick={() => onSort("priceSpread")}
                  className="text-right"
                />
                <TableHead className="text-right">
                  <span className="text-xs font-medium uppercase tracking-wide">Trade</span>
                </TableHead>
              </>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading &&
            Array.from({ length: 8 }).map((_, i) => (
              <TableRow key={`skeleton-${i}`} className="hover:bg-transparent">
                <TableCell>
                  <Skeleton className="h-8 w-16" />
                </TableCell>
                {visibleExchanges.map((ex) => (
                  <TableCell key={ex.id} className="text-right">
                    <Skeleton className="ml-auto h-8 w-20" />
                  </TableCell>
                ))}
                {pairable && (
                  <>
                    <TableCell className="text-right">
                      <Skeleton className="ml-auto h-4 w-16" />
                    </TableCell>
                    <TableCell className="text-right">
                      <Skeleton className="ml-auto h-8 w-28" />
                    </TableCell>
                    <TableCell className="text-right">
                      <Skeleton className="ml-auto h-4 w-16" />
                    </TableCell>
                    <TableCell className="text-right">
                      <Skeleton className="ml-auto h-6 w-28" />
                    </TableCell>
                  </>
                )}
              </TableRow>
            ))}
          {!loading && sorted.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={visibleExchanges.length + (pairable ? 5 : 1)}
                className="py-10 text-center text-muted-foreground"
              >
                No coin matches the current filters on the venues you have enabled.
              </TableCell>
            </TableRow>
          )}
          {sorted.map((row) => (
            <TableRow key={row.coin} className="hover:bg-muted/30">
              <TableCell className="font-mono text-sm font-medium">
                <div className="flex flex-col leading-tight">
                  <span>{row.coin}</span>
                  <span className="text-[10px] font-normal text-muted-foreground">USDT perp</span>
                </div>
              </TableCell>
              {visibleExchanges.map((ex) => {
                const v = row.rates[ex.id];
                const side = executablePriceSide(ex.id, v?.rate ?? null, row.direction);
                return (
                  <TableCell key={ex.id} className="text-right font-mono text-sm num">
                    <RateCell
                      rate={v?.rate ?? null}
                      intervalHours={v?.intervalHours ?? 0}
                      intervalConfirmed={v?.intervalConfirmed ?? false}
                      nextFundingTime={v?.nextFundingTime ?? 0}
                      fromRest={v?.fromRest ?? false}
                      ticker={row.tickers[ex.id] ?? null}
                      side={side}
                      nowMs={nowMs}
                    />
                  </TableCell>
                );
              })}
              {pairable && (
                <>
                  <DiffCell value={row.diffFr} />
                  <TableCell className="text-right">
                    {row.direction ? (
                      <div className="flex flex-col items-end gap-0.5 text-[10px] leading-tight">
                        <span className="inline-flex items-center gap-1 whitespace-nowrap text-positive">
                          <ArrowUpRight aria-hidden className="size-3" /> Long{" "}
                          {exchangeName(row.direction.longExchange)}
                        </span>
                        <span className="inline-flex items-center gap-1 whitespace-nowrap text-negative">
                          <ArrowDownLeft aria-hidden className="size-3" /> Short{" "}
                          {exchangeName(row.direction.shortExchange)}
                        </span>
                        <span className="text-muted-foreground">
                          normalized to {row.direction.intervalHours}h
                        </span>
                      </div>
                    ) : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <SpreadCell row={row} />
                  </TableCell>
                  <TableCell className="text-right">
                    {row.direction ? (
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 gap-1 px-1.5 text-[10px]"
                          nativeButton={false}
                          render={<Link href={tradeHref(row, "instant")} />}
                        >
                          <Zap aria-hidden className="size-3" />
                          Instant
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 gap-1 px-1.5 text-[10px]"
                          nativeButton={false}
                          render={<Link href={tradeHref(row, "delay")} />}
                        >
                          <Timer aria-hidden className="size-3" />
                          Delay
                        </Button>
                      </div>
                    ) : "—"}
                  </TableCell>
                </>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Diff FR for the row's pair. Tints on change so a moving spread is visible
 * without diffing two frames by eye.
 */
function DiffCell({ value }: { value: number | null }) {
  const flash = useValueFlash(value);
  return (
    <TableCell
      data-flash={flash ?? undefined}
      className="text-right font-mono text-sm num text-info"
    >
      {value === null ? "—" : formatRate(value)}
    </TableCell>
  );
}

/**
 * Funding rate on top, executable price underneath. The side label is always
 * printed: a bare price in a trading UI is ambiguous about what you would pay.
 */
function RateCell({
  rate,
  intervalHours,
  intervalConfirmed,
  nextFundingTime,
  fromRest,
  ticker,
  side,
  nowMs,
}: {
  rate: number | null;
  intervalHours: number;
  intervalConfirmed: boolean;
  nextFundingTime: number;
  fromRest: boolean;
  ticker: Ticker | null;
  side: PriceSide;
  nowMs: number;
}) {
  if (rate === null) {
    return <span className="text-muted-foreground/60">—</span>;
  }
  const price = priceForSide(ticker, side);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="flex cursor-help flex-col items-end leading-tight" />}
      >
        <span className={cn("underline-offset-4 hover:underline", rateColorClass(rate))}>
          {formatRate(rate)}
          {/* A dot marks a rate that came from REST, not the stream. */}
          {fromRest && (
            <span className="ml-0.5 text-[9px] text-warning" aria-label="rate from REST">
              •
            </span>
          )}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {formatPrice(price)}
          <span className={cn("ml-1", side === "ask" ? "text-positive-muted" : "text-negative-muted")}>
            {side.toUpperCase()}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="font-mono text-xs">
        <div className="flex flex-col gap-0.5">
          <span>
            {intervalHours}h interval{intervalConfirmed ? "" : " (assumed)"}
            {nextFundingTime > 0 ? ` · next in ${formatCountdown(nextFundingTime, nowMs)}` : ""}
          </span>
          <span>
            bid {formatPrice(ticker?.bid ?? null)} · ask {formatPrice(ticker?.ask ?? null)}
          </span>
          {fromRest && (
            <span className="text-warning">
              rate from REST — this venue&apos;s funding stream is unreachable
            </span>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Entry spread for the row's Direction pair using executable prices: the long
 * leg lifts the ask, the short leg hits the bid.
 */
function SpreadCell({ row }: { row: FundingRateRow }) {
  const spread = row.priceSpread;
  const flash = useValueFlash(spread?.pct ?? null);
  if (!spread) return <span className="text-muted-foreground/60">—</span>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-flash={flash ?? undefined}
            className="cursor-help rounded px-1 font-mono text-sm num"
          />
        }
      >
        <span className={signClass(spread.pct)}>{formatSignedPct(spread.pct)}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="font-mono text-xs">
        <div className="flex flex-col gap-0.5">
          <span>
            long {exchangeName(spread.longExchange)} ask {formatPrice(spread.longAsk)}
          </span>
          <span>
            short {exchangeName(spread.shortExchange)} bid {formatPrice(spread.shortBid)}
          </span>
          <span className="text-muted-foreground">(shortBid − longAsk) / longAsk</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function exchangeLabel(id: ExchangeId): string {
  return exchangeName(id);
}

/** Deep link into the trade page with the hedge legs prefilled. */
function tradeHref(row: FundingRateRow, mode: "instant" | "delay"): string {
  const params = new URLSearchParams({
    coin: row.coin,
    long: row.direction!.longExchange,
    short: row.direction!.shortExchange,
    mode,
  });
  return `/trade?${params.toString()}`;
}

interface SortHeadProps {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  className?: string;
}

function SortHead({ label, active, dir, onClick, className }: SortHeadProps) {
  const Icon = !active ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      // aria-sort is how a screen reader learns the table is sorted and by which
      // column; the icon alone conveyed that to sighted users only.
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={`h-9 whitespace-nowrap ${className ?? ""}`}
    >
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1 rounded text-xs font-medium uppercase tracking-wide hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {label}
        <Icon aria-hidden className={`size-3 ${active ? "opacity-100" : "opacity-40"}`} />
        <span className="sr-only">
          {active
            ? `sorted ${dir === "asc" ? "ascending" : "descending"}, activate to reverse`
            : "activate to sort by this column"}
        </span>
      </button>
    </TableHead>
  );
}

export { exchangeLabel };
