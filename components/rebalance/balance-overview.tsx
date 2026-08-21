"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  ExchangeBalance,
  ExchangeId,
  RebalanceSuggestion,
  VenueType,
} from "@/lib/types";
import { cn, exchangeInfo, exchangeName } from "@/lib/utils";
import { totalEquity, venueTotal } from "@/lib/rebalance/engine";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  TriangleAlert,
  WalletMinimal,
} from "lucide-react";

interface BalanceOverviewProps {
  balances: ExchangeBalance[];
  suggestions: RebalanceSuggestion[];
  /** Venues with credentials whose wallet API is not implemented here. */
  unsupportedVenues?: ExchangeId[];
  onApply: (suggestion: RebalanceSuggestion) => void;
}

/** Section headings for the venue split, so the copy lives in one place. */
const VENUE_GROUPS: { type: VenueType; title: string }[] = [
  { type: "cex", title: "Centralized venues" },
  { type: "dex", title: "Decentralized venues" },
];

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function marginClass(ratio: number): string {
  if (ratio >= 0.85) return "text-negative";
  if (ratio >= 0.7) return "text-warning";
  return "text-positive";
}

const URGENCY: Record<RebalanceSuggestion["urgency"], string> = {
  high: "text-negative",
  medium: "text-warning",
  low: "text-muted-foreground",
};

/**
 * Which directions this venue can move funds.
 *
 * Sending and receiving are separate capabilities and a venue commonly has only
 * one. Showing both explicitly avoids the obvious misreading of a healthy balance
 * as a usable one.
 */
function FlowBadges({ balance }: { balance: ExchangeBalance }) {
  const canSend = balance.walletSupported !== false && balance.transferSource !== false;
  const canReceive = balance.destinationAllowlisted === true;
  return (
    <div className="flex items-center gap-1">
      <span
        className={cn(
          "inline-flex items-center gap-0.5 text-[10px]",
          canSend ? "text-positive" : "text-muted-foreground/50",
        )}
        title={canSend ? "Can send withdrawals" : "Cannot sign withdrawals from this venue"}
      >
        <ArrowUpFromLine aria-hidden className="size-3" />
        send
      </span>
      <span
        className={cn(
          "inline-flex items-center gap-0.5 text-[10px]",
          canReceive ? "text-positive" : "text-muted-foreground/50",
        )}
        title={canReceive ? "Has an armed destination address" : "No armed destination address"}
      >
        <ArrowDownToLine aria-hidden className="size-3" />
        receive
      </span>
    </div>
  );
}

export function BalanceOverview({
  balances,
  suggestions,
  unsupportedVenues = [],
  onApply,
}: BalanceOverviewProps) {
  const equity = totalEquity(balances);
  const target = balances.length ? equity / balances.length : 0;
  const totalFunding = balances.reduce((sum, b) => sum + (b.funding ?? 0), 0);
  const walletErrors = balances.filter((b) => b.walletError);

  /**
   * Capital per venue class.
   *
   * Worth its own line because the two are not interchangeable: shifting value
   * between a custodial venue and a chain costs a withdrawal fee and a wait, so a
   * combined total hides the constraint that actually governs a cross-venue hedge.
   */
  const byType = balances.reduce(
    (acc, b) => {
      acc[b.venueType] = (acc[b.venueType] ?? 0) + venueTotal(b);
      return acc;
    },
    {} as Record<VenueType, number>,
  );

  /** Venues grouped by class, in declaration order within each group. */
  const groups = VENUE_GROUPS.map((group) => ({
    ...group,
    rows: balances.filter((b) => b.venueType === group.type),
  })).filter((group) => group.rows.length > 0);

  return (
    <div className="flex flex-col gap-4">
      {balances.length === 0 && (
        <Alert variant="warning">
          No venue has credentials configured, so there are no balances to rebalance. Add them under
          Venue Credentials.
        </Alert>
      )}

      {unsupportedVenues.length > 0 && (
        <p className="flex items-start gap-1.5 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <WalletMinimal aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          Wallet reads are not implemented for{" "}
          {unsupportedVenues.map((id) => exchangeName(id)).join(", ")}, so those venues are excluded
          from recommendations.
        </p>
      )}

      {walletErrors.length > 0 && (
        <Alert variant="error">
          <ul className="flex flex-col gap-1">
            {walletErrors.map((b) => (
              <li key={b.exchange} className="text-[11px]">
                {exchangeName(b.exchange)} funding wallet could not be read: {b.walletError}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Balance per venue, grouped by class */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 py-3">
            <CardTitle className="text-sm">Capital per Venue</CardTitle>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="font-mono num text-[10px]">
                {usd(equity)} total
              </Badge>
              <Badge variant="secondary" className="font-mono num text-[10px]">
                {usd(byType.cex ?? 0)} CEX
              </Badge>
              <Badge variant="secondary" className="font-mono num text-[10px]">
                {usd(byType.dex ?? 0)} DEX
              </Badge>
              <Badge variant="secondary" className="font-mono num text-[10px] text-info">
                {usd(totalFunding)} withdrawable
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table stickyHeader>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-8">Venue</TableHead>
                  <TableHead className="h-8 text-right">Available</TableHead>
                  <TableHead className="h-8 text-right">In position</TableHead>
                  <TableHead className="h-8 text-right">Funding</TableHead>
                  <TableHead className="h-8 text-right">Total</TableHead>
                  <TableHead className="h-8 text-right">Share</TableHead>
                  <TableHead className="h-8 text-right">Margin</TableHead>
                  <TableHead className="h-8">Flow</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {balances.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                      No credentialed venues.
                    </TableCell>
                  </TableRow>
                )}
                {groups.flatMap((group) => [
                  <TableRow key={group.type} className="hover:bg-transparent">
                    <TableCell colSpan={8} className="bg-muted/30 py-1.5">
                      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        {group.title}
                      </span>
                    </TableCell>
                  </TableRow>,
                  ...group.rows.map((b) => {
                    const total = venueTotal(b);
                    const share = equity === 0 ? 0 : (total / equity) * 100;
                    return (
                      <TableRow key={b.exchange}>
                        <TableCell
                          className={cn("text-xs font-medium", exchangeInfo(b.exchange).accent)}
                        >
                          {exchangeName(b.exchange)}
                        </TableCell>
                        <TableCell className="text-right font-mono num text-xs">
                          {usd(b.available)}
                        </TableCell>
                        <TableCell className="text-right font-mono num text-xs text-muted-foreground">
                          {usd(b.inPosition)}
                        </TableCell>
                        <TableCell className="text-right font-mono num text-xs text-info">
                          {b.walletSupported === false ? "—" : usd(b.funding ?? 0)}
                        </TableCell>
                        <TableCell className="text-right font-mono num text-xs">
                          {usd(total)}
                        </TableCell>
                        <TableCell className="text-right font-mono num text-xs">
                          {share.toFixed(1)}%
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right font-mono num text-xs",
                            marginClass(b.marginRatio),
                          )}
                        >
                          {(b.marginRatio * 100).toFixed(0)}%
                        </TableCell>
                        <TableCell>
                          <FlowBadges balance={b} />
                        </TableCell>
                      </TableRow>
                    );
                  }),
                ])}
              </TableBody>
            </Table>
            <p className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
              Only the Funding column can be withdrawn; derivatives collateral is moved there first,
              which a transfer does automatically. Send needs withdrawal signing, receive needs an
              armed destination address.
            </p>
          </CardContent>
        </Card>

        {/* Distribution */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Distribution</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {balances.map((b) => {
              const total = venueTotal(b);
              const share = equity === 0 ? 0 : (total / equity) * 100;
              const targetShare = balances.length ? 100 / balances.length : 0;
              return (
                <div key={b.exchange} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className={exchangeInfo(b.exchange).accent}>{exchangeName(b.exchange)}</span>
                    <span className="font-mono num">{share.toFixed(1)}%</span>
                  </div>
                  <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-info/70"
                      style={{ width: `${Math.min(100, share)}%` }}
                    />
                    <div
                      className="absolute inset-y-0 w-px bg-foreground/50"
                      style={{ left: `${targetShare}%` }}
                    />
                  </div>
                </div>
              );
            })}
            <p className="text-[10px] text-muted-foreground">
              Vertical line marks the equal-weight target ({usd(target)} each).
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Suggestions */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Rebalance Recommendations</CardTitle>
          <Badge variant="secondary" className="text-[10px]">
            {suggestions.length} suggested
          </Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {suggestions.length === 0 && (
            <p className="py-4 text-center text-xs text-muted-foreground">
              Balances are within thresholds — nothing to move.
            </p>
          )}
          {suggestions.map((s) => (
            <div
              key={s.id}
              className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono num font-medium">
                    {usd(s.amount)} {s.token}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-xs">
                    <span className={exchangeInfo(s.from).accent}>{exchangeName(s.from)}</span>
                    <ArrowRight aria-hidden className="size-3 text-muted-foreground" />
                    <span className={exchangeInfo(s.to).accent}>{exchangeName(s.to)}</span>
                  </span>
                  <span className={cn("inline-flex items-center gap-1 text-[10px] uppercase", URGENCY[s.urgency])}>
                    {s.urgency === "high" && <TriangleAlert aria-hidden className="size-3" />}
                    {s.urgency}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground">{s.reason}</p>
              </div>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => onApply(s)}>
                Apply
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
