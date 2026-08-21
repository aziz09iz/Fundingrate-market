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
import type { FundingBridgeConfig, StrategyPosition, StrategySnapshot } from "@/lib/types";
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

interface FundingBridgeCardProps {
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

function minutesLabel(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return "—";
  if (minutes < 0) return `${Math.abs(minutes).toFixed(0)}m ago`;
  return `in ${minutes.toFixed(0)}m`;
}

/**
 * Phase of one position, which is the thing worth seeing at a glance here.
 *
 * The status column alone cannot say it: `queued` and `open` both cover two very
 * different situations in this strategy — a target waiting on price versus a hedge
 * waiting on funding, and a settled position judged on estimated PnL versus one
 * leaving because its edge decayed.
 */
function phase(position: StrategyPosition): { label: string; hint: string; className: string } {
  if (position.status === "queued") {
    return {
      label: "locked",
      hint: "waiting for the entry spread",
      className: "text-warning",
    };
  }
  if (position.status === "open" && position.harvestedAt) {
    return {
      label: "settled",
      hint: "payment in, exiting on estimated PnL",
      className: "text-positive",
    };
  }
  if (position.status === "open" && position.exitingSince) {
    return {
      label: "exiting",
      hint: "edge gone, waiting for a fee-covering spread",
      className: "text-warning",
    };
  }
  if (position.status === "open") {
    return { label: "holding", hint: "collecting the difference", className: "text-positive" };
  }
  return { label: position.status, hint: "", className: STATUS_CLASS[position.status] };
}

/**
 * FundingBridge monitor.
 *
 * Built around the two-phase shape of the strategy rather than around a position
 * table: a locked target and an open hedge are at different points in the same
 * lifecycle, so both live in one list with the phase spelled out. The countdown to
 * settlement stays visible after entry too — on the mismatched-cadence path it is what
 * arms the estimate-based exit, not just a detail of the entry.
 */
export function FundingBridgeCard({
  snapshot,
  nowMs,
  busy = false,
  running = false,
  onToggle,
  onRunNow,
}: FundingBridgeCardProps) {
  const { run, positions, history, candidates } = snapshot;
  // Safe: the workspace only renders this card for the fundingbridge snapshot.
  const config = snapshot.config as FundingBridgeConfig;
  const isLive = run.accountType === "live";
  const actionable = candidates.filter((c) => !c.blockedReason);
  const locked = positions.filter((p) => p.status === "queued");
  const bestDiff = candidates[0]?.diffFr ?? null;

  return (
    <div className="flex flex-col gap-4">
      {isLive && <ArmNotice armed={run.armed} />}

      <MasterSwitch
        name="FundingBridge"
        description={`Locks the best funding pair within ${config.entryWindowMin} minutes of its settlement, then enters once the spread reaches ${config.entrySpread}%. Legs on one cadence exit on the edge decaying; legs on different cadences exit on estimated PnL, capped at ${config.maxHoldMin} minutes.`}
        run={run}
        busy={busy}
        running={running}
        onToggle={onToggle}
        onRunNow={onRunNow}
      />

      {run.lastError && <ErrorNotice message={run.lastError} />}
      {!run.enabled && <StoppedNotice what="ranking targets" />}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Held" value={`${positions.length}/${config.maxPositions}`} />
        <StatCard label="Locked, waiting" value={String(locked.length)} />
        <StatCard label="Best difference" value={pct(bestDiff)} />
        <StatCard label="Last cycle" value={formatAgo(run.lastRunAt, nowMs)} />
      </div>

      {/* Locked targets and open hedges, in one lifecycle */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Targets &amp; positions</CardTitle>
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
                <TableHead className="h-8">Clock</TableHead>
                <TableHead className="h-8 text-right">Locked diff</TableHead>
                <TableHead className="h-8 text-right">Entry spread</TableHead>
                <TableHead className="h-8 text-right">Size</TableHead>
                <TableHead className="h-8">Settles</TableHead>
                <TableHead className="h-8">Phase</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                    Nothing locked or held.
                  </TableCell>
                </TableRow>
              )}
              {positions.map((p) => {
                const ph = phase(p);
                return (
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
                      {p.status === "queued" ? (
                        <span className="text-muted-foreground">pending</span>
                      ) : (
                        pct(p.entrySpread)
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {p.size > 0 ? p.size : "—"}
                    </TableCell>
                    <TableCell className="font-mono text-[10px] text-muted-foreground">
                      {minutesLabel(
                        p.fundingTime === null ? null : (p.fundingTime - nowMs) / 60_000,
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={cn("text-[10px] uppercase", ph.className)}
                      >
                        {ph.label}
                      </Badge>
                      {ph.hint && (
                        <span className="mt-0.5 block max-w-56 text-[9px] text-muted-foreground">
                          {ph.hint}
                        </span>
                      )}
                      {p.error && (
                        <span className="mt-0.5 block max-w-56 text-[9px] text-negative">
                          {p.error}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* What the last cycle ranked, and why it did not lock */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Ranked targets (last cycle)</CardTitle>
          <Badge variant="secondary" className="text-[10px]">
            {actionable.length} of {candidates.length} lockable
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
                <TableHead className="h-8 text-right">Cost to unwind</TableHead>
                <TableHead className="h-8">Settles</TableHead>
                <TableHead className="h-8">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                    No coin currently clears the {config.minDiffFr}% difference threshold on the
                    selected venues.
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
                  <TableCell className="text-right font-mono text-xs">{pct(c.diffFr)}</TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-mono text-xs",
                      c.spread === null
                        ? ""
                        : c.spread >= config.entrySpread
                          ? "text-positive"
                          : "text-muted-foreground",
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
                      <span className="text-positive">lockable</span>
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
                <TableHead className="h-8 text-right">Locked diff</TableHead>
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

      <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
        Realized PnL above is trading PnL only. On paper, funding is credited separately to the
        account as each settlement passes, so a hedge that earned its difference shows that income
        on the account page rather than in this table.
      </p>
    </div>
  );
}
