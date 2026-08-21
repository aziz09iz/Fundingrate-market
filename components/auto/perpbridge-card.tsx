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
import type { PerpBridgeConfig, StrategySnapshot } from "@/lib/types";
import { cn, exchangeName, formatAgo, formatSignedPct, signClass } from "@/lib/utils";
import { ArrowRight } from "lucide-react";
import {
  ArmNotice,
  ErrorNotice,
  fmtPnl,
  MasterSwitch,
  StatCard,
  STATUS_CLASS,
  StoppedNotice,
} from "@/components/auto/strategy-bits";

interface PerpBridgeCardProps {
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

/**
 * PerpBridge monitor.
 *
 * Shows less than the FundingSync card on purpose: there is no funding clock, no
 * settlement countdown, and no queue, so those columns would be permanently empty.
 * What matters here is the gap at entry against the gap now, because the
 * difference between them is the entire profit.
 */
export function PerpBridgeCard({
  snapshot,
  nowMs,
  busy = false,
  running = false,
  onToggle,
  onRunNow,
}: PerpBridgeCardProps) {
  const { run, positions, history, candidates } = snapshot;
  // Safe: the workspace only renders this card for the perpbridge snapshot.
  const config = snapshot.config as PerpBridgeConfig;
  const isLive = run.accountType === "live";
  const actionable = candidates.filter((c) => !c.blockedReason);
  const widest = candidates[0]?.spread ?? null;

  return (
    <div className="flex flex-col gap-4">
      {isLive && <ArmNotice armed={run.armed} />}

      <MasterSwitch
        name="PerpBridge"
        description={`Buys the cheaper venue and sells the dearer one whenever the gap reaches ${config.minEntrySpread}%, then closes once ${config.minProfitSpread}% of it has closed net of fees. Funding is not considered.`}
        run={run}
        busy={busy}
        running={running}
        onToggle={onToggle}
        onRunNow={onRunNow}
      />

      {run.lastError && <ErrorNotice message={run.lastError} />}
      {!run.enabled && <StoppedNotice what="ranking gaps" />}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Open" value={`${positions.length}/${config.maxPositions}`} />
        <StatCard label="Gaps ready" value={String(actionable.length)} />
        <StatCard label="Widest gap" value={pct(widest)} />
        <StatCard label="Last cycle" value={formatAgo(run.lastRunAt, nowMs)} />
      </div>

      {/* Open positions: entry gap vs where the gap is now */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Positions</CardTitle>
          <Badge variant="secondary" className="text-[10px]">
            ${config.marginPerLeg.toLocaleString()} × {config.leverage} per leg
          </Badge>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8">Coin</TableHead>
                <TableHead className="h-8">Route</TableHead>
                <TableHead className="h-8 text-right">Entry gap</TableHead>
                <TableHead className="h-8 text-right">Size</TableHead>
                <TableHead className="h-8">Opened</TableHead>
                <TableHead className="h-8">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
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
                  <TableCell className="text-right font-mono text-xs">
                    {pct(p.entrySpread)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {p.size > 0 ? p.size : "—"}
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
        </CardContent>
      </Card>

      {/* Ranked gaps, including the ones that were refused and why */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Gaps (last cycle)</CardTitle>
          <Badge variant="secondary" className="text-[10px]">
            floor {config.minEntrySpread}%
          </Badge>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8">Coin</TableHead>
                <TableHead className="h-8">Buy → Sell</TableHead>
                <TableHead className="h-8 text-right">Gap now</TableHead>
                <TableHead className="h-8 text-right">Cost to unwind</TableHead>
                <TableHead className="h-8">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                    No coin has a measurable gap on the selected venues yet.
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
                  <TableCell
                    className={cn(
                      "text-right font-mono text-xs",
                      c.spread === null
                        ? ""
                        : c.spread >= config.minEntrySpread
                          ? "text-positive"
                          : "text-muted-foreground",
                    )}
                  >
                    {pct(c.spread)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {pct(c.exitSpread)}
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
                <TableHead className="h-8 text-right">Entry gap</TableHead>
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
                    {pct(p.entrySpread)}
                  </TableCell>
                  <TableCell
                    className={cn("text-right font-mono text-xs", signClass(p.realizedPnl ?? null))}
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
