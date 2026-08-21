"use client";

import { Fragment, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  CloseHedgeDialog,
  type CloseHedgeInput,
} from "@/components/account/close-hedge-dialog";
import type { AccountOverview, TradeSource } from "@/lib/types";
import { groupPositions, groupTrades, sourceShort, type HedgeRow } from "@/lib/hedge-view";
import { cn, exchangeName, formatPrice, formatSignedUsd, signClass } from "@/lib/utils";
import { ArrowRight, ChevronDown, ChevronRight } from "lucide-react";

export type { CloseHedgeInput };

interface AccountDetailProps {
  data: AccountOverview;
  /**
   * Unwinds a hedge. Omitted on views that are read-only.
   *
   * Both legs are closed together rather than one at a time: closing half a hedge
   * leaves naked directional exposure, which is the opposite of what the position
   * was opened for.
   */
  onCloseHedge?: (input: CloseHedgeInput) => Promise<void>;
}

interface StatCardProps {
  label: string;
  value: string;
  valueClass?: string;
}

function StatCard({ label, value, valueClass }: StatCardProps) {
  return (
    <Card className="bg-card/60">
      <CardContent className="flex flex-col gap-1 p-4">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className={cn("font-mono text-lg font-semibold num", valueClass)}>{value}</span>
      </CardContent>
    </Card>
  );
}

/**
 * Names what created a row: the strategy, or Manual. The strategy is recovered
 * from the hedge id prefix, so a FundingSync leg reads as FundingSync rather than
 * a generic "auto".
 */
function SourceTag({
  source,
  hedgeId,
}: {
  source?: TradeSource;
  hedgeId?: string | null;
}) {
  const label = sourceShort(source, hedgeId);
  const auto = source === "auto";
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[10px]",
        auto ? "bg-info/15 text-info" : "bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

/** Both venues of a hedge on one line, in the direction actually traded. */
function Route({
  long,
  short,
}: {
  long?: string | null;
  short?: string | null;
}) {
  if (!long && !short) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
      <span className="text-positive">{long ? exchangeName(long as never) : "—"}</span>
      <ArrowRight aria-hidden className="size-3 text-muted-foreground" />
      <span className="text-negative">{short ? exchangeName(short as never) : "—"}</span>
    </span>
  );
}

export function AccountDetail({ data, onCloseHedge }: AccountDetailProps) {
  const isPaper = data.accountType === "paper";
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [closing, setClosing] = useState<HedgeRow | null>(null);

  // One row per hedge rather than per leg: a hedge is one decision, and reading it
  // as two rows makes a long and a short look like two opposing bets.
  const hedges = groupPositions(
    data.positions,
    data.fundingByHedge ?? {},
    data.fundingByCoin ?? {},
  );
  const trades = groupTrades(
    data.recentTrades,
    data.fundingByHedge ?? {},
    data.fundingByCoin ?? {},
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Balance" value={`$${data.balance.toLocaleString()}`} />
        <StatCard label="Equity" value={`$${data.equity.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
        <StatCard label="Margin Used" value={`$${data.marginUsed.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
        <StatCard label="Available" value={`$${data.available.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
        <StatCard
          label="PnL Today"
          value={formatSignedUsd(data.pnl.daily, 2)}
          valueClass={signClass(data.pnl.daily)}
        />
        <StatCard
          label="Realized Total"
          value={formatSignedUsd(data.pnl.total, 2)}
          valueClass={signClass(data.pnl.total)}
        />
        <StatCard label="Open Hedges" value={String(hedges.length)} />
        {/* Both of these are already inside Realized Total; they show where it came
            from rather than adding to it. */}
        <StatCard
          label="Funding"
          value={formatSignedUsd(data.fundingPnl ?? 0, 2)}
          valueClass={signClass(data.fundingPnl ?? 0)}
        />
        <StatCard
          label="Fees Paid"
          value={`$${(data.feesPaid ?? 0).toFixed(2)}`}
          valueClass="text-muted-foreground"
        />
      </div>

      {/* Open hedges */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Open Positions</CardTitle>
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="text-[10px]">
              {hedges.length} hedge{hedges.length === 1 ? "" : "s"}
            </Badge>
            {isPaper && <Badge variant="secondary" className="text-[10px] uppercase">Paper</Badge>}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table stickyHeader>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 w-8" />
                <TableHead className="h-8">Pair</TableHead>
                <TableHead className="h-8">Route (long → short)</TableHead>
                <TableHead className="h-8">Source</TableHead>
                <TableHead className="h-8 text-right">Size</TableHead>
                <TableHead className="h-8 text-right">Notional</TableHead>
                <TableHead className="h-8 text-right">Lev</TableHead>
                <TableHead className="h-8 text-right">Funding</TableHead>
                <TableHead className="h-8 text-right">uPnL</TableHead>
                {onCloseHedge && <TableHead className="h-8 text-right">Action</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {hedges.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={onCloseHedge ? 10 : 9}
                    className="py-6 text-center text-muted-foreground"
                  >
                    No open positions.
                  </TableCell>
                </TableRow>
              )}
              {hedges.map((h) => {
                const expanded = openRow === h.key;
                const unpaired = !h.longLeg || !h.shortLeg;
                return (
                  // Fragment needs the key: two sibling rows per hedge means the
                  // key belongs on their wrapper, not on the first row.
                  <Fragment key={h.key}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => setOpenRow(expanded ? null : h.key)}
                    >
                      <TableCell className="py-1.5">
                        {expanded ? (
                          <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight aria-hidden className="size-3.5 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {h.coin}
                        {unpaired && (
                          <span className="ml-1.5 rounded bg-warning/15 px-1 py-0.5 text-[9px] text-warning">
                            one leg
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Route long={h.longLeg?.exchange} short={h.shortLeg?.exchange} />
                      </TableCell>
                      <TableCell>
                        <SourceTag source={h.source} hedgeId={h.hedgeId} />
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs num">{h.size}</TableCell>
                      <TableCell className="text-right font-mono text-xs num text-muted-foreground">
                        ${h.notional.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs num">{h.leverage}×</TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-mono text-xs num",
                          h.fundingPnl === undefined ? "text-muted-foreground" : signClass(h.fundingPnl),
                        )}
                      >
                        {h.fundingPnl === undefined ? "—" : formatSignedUsd(h.fundingPnl, 2)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-mono text-xs num",
                          h.markStale ? "text-warning" : signClass(h.unrealizedPnl),
                        )}
                      >
                        {h.markStale ? "no quote" : formatSignedUsd(h.unrealizedPnl, 2)}
                      </TableCell>
                      {onCloseHedge && (
                        <TableCell className="text-right">
                          <CloseCell hedge={h} onClick={() => setClosing(h)} />
                        </TableCell>
                      )}
                    </TableRow>

                    {expanded && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={onCloseHedge ? 10 : 9} className="bg-muted/20 p-0">
                          <div className="px-4 py-2">
                            <p className="pb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                              Legs {h.hedgeId ? `· ${h.hedgeId}` : ""}
                            </p>
                            <div className="flex flex-col gap-1">
                              {[h.longLeg, h.shortLeg, ...h.extraLegs]
                                .filter((l): l is NonNullable<typeof l> => l !== null)
                                .map((leg, i) => (
                                  <div
                                    key={`${leg.exchange}-${leg.side}-${i}`}
                                    className="flex flex-wrap items-center gap-x-4 gap-y-0.5 font-mono text-[11px]"
                                  >
                                    <span
                                      className={cn(
                                        "w-12 shrink-0",
                                        leg.side === "long" ? "text-positive" : "text-negative",
                                      )}
                                    >
                                      {leg.side}
                                    </span>
                                    <span className="w-20 shrink-0 text-xs">
                                      {exchangeName(leg.exchange)}
                                    </span>
                                    <span className="text-muted-foreground">
                                      entry {formatPrice(leg.entryPrice)}
                                    </span>
                                    <span className="text-muted-foreground">
                                      mark{" "}
                                      {leg.markStale ? (
                                        <span className="text-warning">no quote</span>
                                      ) : (
                                        formatPrice(leg.markPrice)
                                      )}
                                    </span>
                                    <span className="text-muted-foreground">size {leg.size}</span>
                                    <span className={signClass(leg.unrealizedPnl)}>
                                      {leg.markStale ? "—" : formatSignedUsd(leg.unrealizedPnl, 2)}
                                    </span>
                                  </div>
                                ))}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Recent hedges, grouped */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Recent Trades</CardTitle>
          <Badge variant="secondary" className="text-[10px]">
            grouped by hedge
          </Badge>
        </CardHeader>
        <CardContent className="p-0">
          <Table stickyHeader>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 w-8" />
                <TableHead className="h-8">Time</TableHead>
                <TableHead className="h-8">Pair</TableHead>
                <TableHead className="h-8">Route (long → short)</TableHead>
                <TableHead className="h-8">Source</TableHead>
                <TableHead className="h-8 text-right">Fills</TableHead>
                <TableHead className="h-8 text-right">Fees</TableHead>
                <TableHead className="h-8 text-right">Funding</TableHead>
                <TableHead className="h-8 text-right">Trade PnL</TableHead>
                <TableHead className="h-8 text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="py-6 text-center text-muted-foreground">
                    No trades yet.
                  </TableCell>
                </TableRow>
              )}
              {trades.map((t) => {
                const expanded = openRow === t.key;
                return (
                  <Fragment key={t.key}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => setOpenRow(expanded ? null : t.key)}
                    >
                      <TableCell className="py-1.5">
                        {expanded ? (
                          <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight aria-hidden className="size-3.5 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {new Date(t.time).toLocaleString(undefined, {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {t.coin}
                        {!t.closed && (
                          <span className="ml-1.5 rounded bg-info/15 px-1 py-0.5 text-[9px] text-info">
                            open
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Route long={t.buyExchanges[0]} short={t.sellExchanges[0]} />
                      </TableCell>
                      <TableCell>
                        <SourceTag source={t.source} hedgeId={t.hedgeId} />
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {t.fills.length}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        -${t.fee.toFixed(4)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-mono text-xs",
                          t.fundingPnl === undefined ? "text-muted-foreground" : signClass(t.fundingPnl),
                        )}
                      >
                        {t.fundingPnl === undefined ? "—" : formatSignedUsd(t.fundingPnl, 2)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-mono text-xs",
                          t.realizedPnl === null ? "text-muted-foreground" : signClass(t.realizedPnl),
                        )}
                      >
                        {t.realizedPnl === null ? "—" : formatSignedUsd(t.realizedPnl, 2)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-mono text-xs font-semibold",
                          t.totalPnl === null ? "text-muted-foreground" : signClass(t.totalPnl),
                        )}
                      >
                        {t.totalPnl === null ? "—" : formatSignedUsd(t.totalPnl, 2)}
                      </TableCell>
                    </TableRow>

                    {expanded && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={10} className="bg-muted/20 p-0">
                          <div className="px-4 py-2">
                            <p className="pb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                              Fills {t.hedgeId ? `· ${t.hedgeId}` : ""}
                            </p>
                            <div className="flex flex-col gap-1">
                              {t.fills.map((f) => (
                                <div
                                  key={f.id}
                                  className="flex flex-wrap items-center gap-x-4 gap-y-0.5 font-mono text-[11px]"
                                >
                                  <span className="w-14 shrink-0 text-muted-foreground">
                                    {new Date(f.time).toLocaleTimeString(undefined, {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                      second: "2-digit",
                                      hour12: false,
                                    })}
                                  </span>
                                  <span
                                    className={cn(
                                      "w-10 shrink-0",
                                      f.side === "buy" ? "text-positive" : "text-negative",
                                    )}
                                  >
                                    {f.side}
                                  </span>
                                  <span className="w-20 shrink-0 text-xs">
                                    {exchangeName(f.exchange)}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {formatPrice(f.price)} × {f.size}
                                  </span>
                                  <span className="text-muted-foreground">
                                    fee -${(f.fee ?? 0).toFixed(4)}
                                  </span>
                                  <span
                                    className={
                                      f.realizedPnl === null || f.realizedPnl === undefined
                                        ? "text-muted-foreground"
                                        : signClass(f.realizedPnl)
                                    }
                                  >
                                    {f.realizedPnl === null || f.realizedPnl === undefined
                                      ? "opening"
                                      : formatSignedUsd(f.realizedPnl, 2)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
          <p className="px-4 py-2 text-[10px] text-muted-foreground">
            Trade PnL is net of trading fees. Total adds funding received or paid, which is what the
            hedge actually earned.
          </p>
        </CardContent>
      </Card>

      {onCloseHedge && (
        <CloseHedgeDialog
          hedge={closing}
          onOpenChange={(open) => !open && setClosing(null)}
          accountType={data.accountType}
          onConfirm={async (input) => {
            await onCloseHedge(input);
            setClosing(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * The close button, or the reason there is none.
 *
 * A hedge with a stale mark on any leg cannot be closed: a market fill needs a
 * quote, and inventing one would book a PnL that never happened.
 */
export function CloseCell({ hedge, onClick }: { hedge: HedgeRow; onClick: () => void }) {
  if (hedge.markStale) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="cursor-help text-[10px] text-warning" />}>
          no quote
        </TooltipTrigger>
        <TooltipContent side="left" className="max-w-56 text-xs">
          One leg has no live quote, so a market close cannot be priced. It becomes closable as soon
          as the venue quotes again.
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 text-xs text-negative hover:text-negative/85"
      onClick={(e) => {
        // The row itself toggles the leg detail, so the click must not reach it.
        e.stopPropagation();
        onClick();
      }}
    >
      Close
    </Button>
  );
}
