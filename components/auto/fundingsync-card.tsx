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
import type { StrategyConfig, StrategySnapshot } from "@/lib/types";
import {
  cn,
  exchangeName,
  formatAgo,
  formatPrice,
  formatSignedPct,
  signClass,
  signGlyph,
} from "@/lib/utils";
import { ArrowRight } from "lucide-react";
import {
  ArmNotice,
  ErrorNotice,
  MasterSwitch,
  StatCard,
  STATUS_CLASS,
  StoppedNotice,
} from "@/components/auto/strategy-bits";

interface FundingSyncCardProps {
  snapshot: StrategySnapshot;
  nowMs: number;
  busy?: boolean;
  running?: boolean;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
}

function minutesLabel(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return "—";
  if (minutes < 0) return `${Math.abs(minutes).toFixed(0)}m ago`;
  return `in ${minutes.toFixed(0)}m`;
}

function pct(value: number | null | undefined): string {
  return formatSignedPct(value ?? null, 4);
}

export function FundingSyncCard({
  snapshot,
  nowMs,
  busy = false,
  running = false,
  onToggle,
  onRunNow,
}: FundingSyncCardProps) {
  const { run, positions, history, candidates } = snapshot;
  // Safe: the workspace only renders this card for the fundingsync snapshot.
  const config = snapshot.config as StrategyConfig;
  const isLive = run.accountType === "live";
  const actionable = candidates.filter((c) => !c.blockedReason);

  return (
    <div className="flex flex-col gap-4">
      {isLive && <ArmNotice armed={run.armed} />}

      <MasterSwitch
        name="FundingSync"
        description={`Hedges the largest normalized funding difference across ${config.venues.length} venues, entering within ${config.entryWindowMin} minutes of the settlement it targets.`}
        run={run}
        busy={busy}
        running={running}
        onToggle={onToggle}
        onRunNow={onRunNow}
      />

      {run.lastError && <ErrorNotice message={run.lastError} />}
      {!run.enabled && <StoppedNotice what="ranking candidates" />}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Open hedges" value={`${positions.length}/${config.maxPositions}`} />
        <StatCard label="Actionable now" value={String(actionable.length)} />
        <StatCard
          label="Notional per leg"
          value={`$${(config.marginPerLeg * config.leverage).toLocaleString()}`}
        />
        <StatCard label="Last cycle" value={formatAgo(run.lastRunAt, nowMs)} />
      </div>

      {/* Live positions and the delay queue */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Positions</CardTitle>
          <Badge variant="secondary" className="text-[10px]">
            {positions.filter((p) => p.status === "queued").length} queued
          </Badge>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8">Coin</TableHead>
                <TableHead className="h-8">Route</TableHead>
                <TableHead className="h-8">Clock</TableHead>
                <TableHead className="h-8 text-right">Entry diff</TableHead>
                <TableHead className="h-8 text-right">Entry spread</TableHead>
                <TableHead className="h-8 text-right">Size</TableHead>
                <TableHead className="h-8">Settles</TableHead>
                <TableHead className="h-8">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                    No hedge open or queued.
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
                  <TableCell className="text-xs text-muted-foreground">
                    {p.clockExchange ? exchangeName(p.clockExchange) : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {pct(p.entryDiffFr)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {pct(p.entrySpread)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {p.size > 0 ? p.size : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-[10px] text-muted-foreground">
                    {minutesLabel(p.fundingTime === null ? null : (p.fundingTime - nowMs) / 60_000)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="secondary"
                      className={cn("text-[10px] uppercase", STATUS_CLASS[p.status])}
                    >
                      {/* A harvested or exiting position is still open, but it is
                          waiting on the spread rather than on funding. */}
                      {p.status === "open" && p.harvestedAt
                        ? "holding"
                        : p.status === "open" && p.exitingSince
                          ? "exiting"
                          : p.status}
                    </Badge>
                    {p.status === "open" && p.harvestedAt && (
                      <span className="mt-0.5 block text-[9px] text-positive/80">
                        funding collected, waiting for spread
                      </span>
                    )}
                    {p.status === "open" && !p.harvestedAt && p.exitingSince && (
                      <span className="mt-0.5 block max-w-56 text-[9px] text-warning/80">
                        edge gone, waiting for a fee-covering spread
                      </span>
                    )}
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
        </CardContent>
      </Card>

      {/* What the last cycle considered, and why it passed */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Candidates (last cycle)</CardTitle>
          <Badge variant="secondary" className="text-[10px]">
            {candidates.length} above {config.minDiffFr}%
          </Badge>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8">Coin</TableHead>
                <TableHead className="h-8">Route</TableHead>
                <TableHead className="h-8 text-right">Diff FR</TableHead>
                <TableHead className="h-8 text-right">Entry spread</TableHead>
                <TableHead className="h-8 text-right">Exit spread</TableHead>
                <TableHead className="h-8">Settles</TableHead>
                <TableHead className="h-8">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                    No coin currently clears the {config.minDiffFr}% difference threshold.
                  </TableCell>
                </TableRow>
              )}
              {candidates.slice(0, 12).map((c) => (
                <TableRow key={`${c.coin}-${c.longExchange}-${c.shortExchange}`}>
                  <TableCell className="font-mono text-xs">{c.coin}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
                      <span className="text-positive">{exchangeName(c.longExchange)}</span>
                      <ArrowRight aria-hidden className="size-3 text-muted-foreground" />
                      <span className="text-negative">{exchangeName(c.shortExchange)}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {pct(c.diffFr)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-mono text-xs",
                      c.spread === null
                        ? ""
                        : c.spread >= config.minEntrySpread
                          ? "text-positive"
                          : "text-negative",
                    )}
                  >
                    {pct(c.spread)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {pct(c.exitSpread)}
                  </TableCell>
                  <TableCell className="font-mono text-[10px] text-muted-foreground">
                    {minutesLabel(c.minutesToFunding)}
                  </TableCell>
                  <TableCell className="text-[10px]">
                    {c.blockedReason ? (
                      <span className="text-muted-foreground">{c.blockedReason}</span>
                    ) : (
                      <span className="text-positive">ready</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {candidates.length > 12 && (
            <p className="px-3 py-2 text-[10px] text-muted-foreground">
              + {candidates.length - 12} more candidates not shown
            </p>
          )}
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
                <TableHead className="h-8 text-right">PnL</TableHead>
                <TableHead className="h-8">Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
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
                  <TableCell className="text-right font-mono text-xs">
                    {pct(p.entryDiffFr)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-mono text-xs",
                      signClass(p.realizedPnl ?? null),
                    )}
                  >
                    {p.realizedPnl === null || p.realizedPnl === undefined
                      ? "—"
                      : `${signGlyph(p.realizedPnl)}${formatPrice(Math.abs(p.realizedPnl))}`}
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
