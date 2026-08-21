"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FundingYieldConfig, StrategySnapshot } from "@/lib/types";
import { cn, exchangeName, formatAgo, formatSignedPct, signClass } from "@/lib/utils";
import { ArrowRight, ShieldAlert } from "lucide-react";
import {
  ArmNotice,
  ErrorNotice,
  fmtPnl,
  MasterSwitch,
  StatCard,
  STATUS_CLASS,
  StoppedNotice,
} from "@/components/auto/strategy-bits";

interface FundingYieldCardProps {
  snapshot: StrategySnapshot;
  nowMs: number;
  busy?: boolean;
  running?: boolean;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
}

function pct(value: number | null | undefined): string {
  return formatSignedPct(value ?? null, 4);
}

function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(2)}`;
}

/**
 * FundingYield monitor.
 *
 * Shows the two things that make this strategy different from the other three, because
 * without them its decisions look wrong: the round trip's *cost* rather than the entry
 * spread as a pass/fail, and how far each position has been under water against its
 * stop-loss.
 *
 * The candidate table therefore leads with the spread cost and the projected net, not
 * with the funding difference — ranking by the difference alone is exactly the mistake
 * this engine avoids.
 */
export function FundingYieldCard({
  snapshot,
  nowMs,
  busy = false,
  running = false,
  onToggle,
  onRunNow,
}: FundingYieldCardProps) {
  const { run, positions, history, candidates } = snapshot;
  // Safe: the workspace only renders this card for the fundingyield snapshot.
  const config = snapshot.config as FundingYieldConfig;
  const isLive = run.accountType === "live";
  const actionable = candidates.filter((c) => !c.blockedReason);
  const collected = positions.reduce((sum, p) => sum + (p.fundingCollected ?? 0), 0);

  return (
    <div className="flex flex-col gap-4">
      {isLive && <ArmNotice armed={run.armed} />}

      <MasterSwitch
        name="FundingYield"
        description={`Prices the round trip instead of vetoing a negative entry spread, then holds across about ${config.targetSettlements} settlements so the four taker fills are paid once rather than per payment. Closes when collected funding reaches ${config.profitTargetMultiple}× the round trip, when funding reverses, or on a $${config.stopLossUsd} stop-loss.`}
        run={run}
        busy={busy}
        running={running}
        onToggle={onToggle}
        onRunNow={onRunNow}
      />

      {run.lastError && <ErrorNotice message={run.lastError} />}
      {!run.enabled && <StoppedNotice what="ranking net yields" />}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Open" value={`${positions.length}/${config.maxPositions}`} />
        <StatCard label="Entries ready" value={String(actionable.length)} />
        <StatCard label="Funding collected" value={usd(collected)} />
        <StatCard label="Last cycle" value={formatAgo(run.lastRunAt, nowMs)} />
      </div>

      {/* Open positions, with the stop-loss distance made explicit */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Positions</CardTitle>
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="gap-1 text-[10px] text-warning">
              <ShieldAlert aria-hidden className="size-3" />
              stop ${config.stopLossUsd}
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              ${config.marginPerLeg.toLocaleString()} × {config.leverage} per leg
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8">Coin</TableHead>
                <TableHead className="h-8">Route</TableHead>
                <TableHead className="h-8 text-right">Entry diff</TableHead>
                <TableHead className="h-8 text-right">Entry spread</TableHead>
                <TableHead className="h-8 text-right">Funding in</TableHead>
                <TableHead className="h-8 text-right">Worst</TableHead>
                <TableHead className="h-8">Held</TableHead>
                <TableHead className="h-8">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                    No position open.
                  </TableCell>
                </TableRow>
              )}
              {positions.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono text-xs">{p.coin}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
                      <span className="text-positive">{exchangeName(p.longExchange)}</span>
                      <ArrowRight aria-hidden className="size-3 text-muted-foreground" />
                      <span className="text-negative">{exchangeName(p.shortExchange)}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs num">
                    {pct(p.entryDiffFr)}
                  </TableCell>
                  {/* Not colour-coded by sign: a negative entry spread is normal here and
                      marking it red would contradict the whole premise. */}
                  <TableCell className="text-right font-mono text-xs num text-muted-foreground">
                    {pct(p.entrySpread)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-mono text-xs num",
                      p.fundingCollected === null || p.fundingCollected === undefined
                        ? "text-muted-foreground"
                        : signClass(p.fundingCollected),
                    )}
                  >
                    {p.fundingCollected === null || p.fundingCollected === undefined ? (
                      <Tooltip>
                        <TooltipTrigger render={<span className="cursor-help" />}>—</TooltipTrigger>
                        <TooltipContent side="left" className="max-w-56 text-xs">
                          Live venues fold funding into their balance and report no per-position
                          figure, so the engine pro-rates it for the exit rather than storing a
                          guess here.
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      usd(p.fundingCollected)
                    )}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-mono text-xs num",
                      p.worstNetUsd === null || p.worstNetUsd === undefined
                        ? "text-muted-foreground"
                        : "text-warning",
                    )}
                  >
                    {usd(p.worstNetUsd)}
                  </TableCell>
                  <TableCell className="font-mono text-[10px] text-muted-foreground">
                    {p.openedAt ? formatAgo(p.openedAt, nowMs) : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="secondary"
                      className={cn("text-[10px] uppercase", STATUS_CLASS[p.status])}
                    >
                      {p.status}
                    </Badge>
                    {p.error && (
                      <span className="mt-0.5 block max-w-56 text-[9px] text-negative">
                        {p.error}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {positions.length > 0 && (
            <p className="px-3 py-2 text-[10px] text-muted-foreground">
              Worst is the lowest mark-to-market each position has been through, against the $
              {config.stopLossUsd} stop. A column of small numbers means the stop is set far wider
              than the strategy actually swings.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Ranked by projected net USD, not by funding difference */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Net yield ranking (last cycle)</CardTitle>
          <Badge variant="secondary" className="text-[10px]">
            floor {usd(config.minNetYieldUsd)} over {config.targetSettlements} settlements
          </Badge>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8">Coin</TableHead>
                <TableHead className="h-8">Long → Short</TableHead>
                <TableHead className="h-8 text-right">Diff FR</TableHead>
                <TableHead className="h-8 text-right">Entry spread</TableHead>
                <TableHead className="h-8 text-right">Round trip cost</TableHead>
                <TableHead className="h-8">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                    No coin has a priceable funding difference on the selected venues yet.
                  </TableCell>
                </TableRow>
              )}
              {candidates.slice(0, 12).map((c) => {
                // Exit minus entry, matching the engine: the exit side of both books is
                // always the worse one, so this is the positive cost of a round trip.
                const spreadCost =
                  c.spread === null || c.exitSpread === null || c.exitSpread === undefined
                    ? null
                    : Number((c.exitSpread - c.spread).toFixed(4));
                return (
                  <TableRow key={`${c.coin}-${c.longExchange}-${c.shortExchange}`}>
                    <TableCell className="font-mono text-xs">{c.coin}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
                        <span className="text-positive">{exchangeName(c.longExchange)}</span>
                        <ArrowRight aria-hidden className="size-3 text-muted-foreground" />
                        <span className="text-negative">{exchangeName(c.shortExchange)}</span>
                      </span>
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right font-mono text-xs num",
                        c.diffFr !== null && c.diffFr >= config.minDiffFr
                          ? "text-positive"
                          : "text-muted-foreground",
                      )}
                    >
                      {pct(c.diffFr)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs num text-muted-foreground">
                      {pct(c.spread)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right font-mono text-xs num",
                        spreadCost !== null && spreadCost > config.maxSpreadCostPct
                          ? "text-negative"
                          : "text-muted-foreground",
                      )}
                    >
                      {spreadCost === null ? "—" : `${spreadCost.toFixed(4)}%`}
                    </TableCell>
                    <TableCell className="text-[10px]">
                      {c.blockedReason ? (
                        <span className="text-muted-foreground">{c.blockedReason}</span>
                      ) : (
                        <span className="text-positive">ready</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {candidates.length > 12 && (
            <p className="px-3 py-2 text-[10px] text-muted-foreground">
              + {candidates.length - 12} more candidates not shown
            </p>
          )}
          <p className="px-3 py-2 text-[10px] text-muted-foreground">
            Round trip cost is the exit spread minus the entry spread — the sum of both venues&apos;
            bid-ask widths, and what getting in and out actually costs. A deeply negative entry
            spread is not disqualifying here, which is why this strategy can trade rows the other
            three refuse.
          </p>
        </CardContent>
      </Card>

      {/* Results */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Recent Results</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8">Closed</TableHead>
                <TableHead className="h-8">Coin</TableHead>
                <TableHead className="h-8">Route</TableHead>
                <TableHead className="h-8 text-right">Entry diff</TableHead>
                <TableHead className="h-8 text-right">Worst</TableHead>
                <TableHead className="h-8 text-right">PnL</TableHead>
                <TableHead className="h-8">Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                    Nothing settled yet.
                  </TableCell>
                </TableRow>
              )}
              {history.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono text-[10px] text-muted-foreground">
                    {p.closedAt ? formatAgo(p.closedAt, nowMs) : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{p.coin}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {exchangeName(p.longExchange)} → {exchangeName(p.shortExchange)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs num">
                    {pct(p.entryDiffFr)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-mono text-xs num",
                      p.worstNetUsd === null || p.worstNetUsd === undefined
                        ? "text-muted-foreground"
                        : "text-warning",
                    )}
                  >
                    {usd(p.worstNetUsd)}
                  </TableCell>
                  <TableCell
                    className={cn("text-right font-mono text-xs num", signClass(p.realizedPnl ?? null))}
                  >
                    {fmtPnl(p.realizedPnl)}
                  </TableCell>
                  <TableCell className="text-[10px]">
                    <Badge
                      variant="secondary"
                      className={cn("text-[10px] uppercase", STATUS_CLASS[p.status])}
                    >
                      {p.status}
                    </Badge>
                    {(p.exitReason || p.error) && (
                      <span className="mt-0.5 block max-w-64 text-[9px] text-muted-foreground">
                        {p.error ?? p.exitReason}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
