"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ExchangeId, TransferRecord, TransferStage, TransferStatus } from "@/lib/types";
import { cn, exchangeName, signGlyph } from "@/lib/utils";
import { NETWORK_LABELS } from "@/lib/rebalance/chains";
import { ArrowRight, BadgeCheck, Bot, ShieldQuestionMark } from "lucide-react";

/** One venue-reported withdraw/deposit row, as returned by the history route. */
export interface TransferEventView {
  exchange: ExchangeId;
  direction: "withdraw" | "deposit";
  venueId: string;
  asset: string;
  amount: number;
  fee?: number | null;
  venueChain?: string | null;
  txId?: string | null;
  status: TransferStatus;
  at: number;
}

interface TransferHistoryProps {
  transfers: TransferRecord[];
  /** Venue-reported events, used to show the deposit side of each transfer. */
  events?: TransferEventView[];
  syncErrors?: string[];
}

const STATUS_CLASS: Record<TransferStatus, string> = {
  pending: "text-warning",
  processing: "text-info",
  completed: "text-positive",
  failed: "text-negative",
};

const STAGE_LABEL: Record<TransferStage, string> = {
  internal: "moving to funding wallet",
  withdraw: "withdrawing on-chain",
  settled: "settled",
};

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function maskHash(value: string | null | undefined): string {
  if (!value) return "—";
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function TransferHistory({ transfers, events = [], syncErrors = [] }: TransferHistoryProps) {
  const inFlight = transfers.filter(
    (t) => t.status === "pending" || t.status === "processing",
  ).length;

  /**
   * Matches each transfer to the destination venue's deposit. Withdraw and
   * deposit are reported by different venues, so pairing them is the only way to
   * show that funds actually arrived rather than merely left.
   */
  const depositFor = useMemo(() => {
    const map = new Map<string, TransferEventView>();
    const deposits = events.filter((e) => e.direction === "deposit");
    for (const transfer of transfers) {
      const match = deposits.find(
        (d) =>
          d.exchange === transfer.to &&
          d.asset.toUpperCase() === transfer.token &&
          d.at >= transfer.time - 60_000 &&
          // The deposited amount is the sent amount minus the network fee.
          Math.abs(d.amount - transfer.received) <= Math.max(0.5, transfer.received * 0.01),
      );
      if (match) map.set(transfer.id, match);
    }
    return map;
  }, [transfers, events]);

  return (
    <div className="flex flex-col gap-4">
      {syncErrors.length > 0 && (
        <Alert variant="warning">
          <ul className="flex flex-col gap-1">
            {syncErrors.map((error) => (
              <li key={error} className="text-[11px]">
                {error}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Transfers</CardTitle>
          <div className="flex items-center gap-1.5">
            {inFlight > 0 && (
              <Badge variant="secondary" className="text-[10px] text-info">
                {inFlight} in flight
              </Badge>
            )}
            <Badge variant="secondary" className="text-[10px]">
              {transfers.length} total
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table stickyHeader>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8">Time</TableHead>
                <TableHead className="h-8">Route</TableHead>
                <TableHead className="h-8">Token</TableHead>
                <TableHead className="h-8">Network</TableHead>
                <TableHead className="h-8">Address check</TableHead>
                <TableHead className="h-8 text-right">Amount</TableHead>
                <TableHead className="h-8 text-right">Fee</TableHead>
                <TableHead className="h-8 text-right">Received</TableHead>
                <TableHead className="h-8">Status</TableHead>
                <TableHead className="h-8">Arrived</TableHead>
                <TableHead className="h-8">Tx</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transfers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">
                    No transfers initiated from this app yet.
                  </TableCell>
                </TableRow>
              )}
              {transfers.map((t) => {
                const deposit = depositFor.get(t.id);
                return (
                  <TableRow key={t.id} className="hover:bg-muted/30">
                    <TableCell className="font-mono num text-xs text-muted-foreground">
                      {fmtTime(t.time)}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
                        {t.auto && (
                          <>
                            <Bot className="size-3 text-info" aria-hidden />
                            <span className="sr-only">Sent by automation</span>
                          </>
                        )}
                        {exchangeName(t.from)}
                        <ArrowRight aria-hidden className="size-3 text-muted-foreground" />
                        {exchangeName(t.to)}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{t.token}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {NETWORK_LABELS[t.network] ?? t.network}
                    </TableCell>
                    <TableCell className="text-[10px]">
                      {t.addressVerified === true ? (
                        <span className="inline-flex items-center gap-1 whitespace-nowrap text-positive">
                          <BadgeCheck aria-hidden className="size-3" />
                          venue confirmed
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 whitespace-nowrap text-warning"
                          title={t.addressVerifyNote ?? undefined}
                        >
                          <ShieldQuestionMark aria-hidden className="size-3" />
                          not cross-checked
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono num text-xs">
                      {t.amount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-mono num text-xs text-negative">
                      {signGlyph(-t.fee)}
                      {t.fee}
                    </TableCell>
                    <TableCell className="text-right font-mono num text-xs text-positive">
                      {t.received.toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={cn("text-[10px] uppercase", STATUS_CLASS[t.status])}
                      >
                        {t.status}
                      </Badge>
                      {t.status !== "completed" && (
                        <span className="mt-0.5 block whitespace-nowrap text-[9px] text-muted-foreground">
                          {STAGE_LABEL[t.stage]}
                        </span>
                      )}
                      {t.error && (
                        <span className="mt-0.5 block max-w-56 text-[9px] text-negative">
                          {t.error}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-[10px]">
                      {deposit ? (
                        <span className="num text-positive">
                          {deposit.amount.toLocaleString()} at {fmtTime(deposit.at)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          {t.status === "failed" ? "—" : "not seen yet"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono num text-[10px] text-muted-foreground">
                      {maskHash(t.txId ?? deposit?.txId ?? null)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Venue Withdraw &amp; Deposit Records</CardTitle>
          <Badge variant="secondary" className="text-[10px]">
            {events.length} cached
          </Badge>
        </CardHeader>
        <CardContent className="p-0">
          <Table stickyHeader>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8">Time</TableHead>
                <TableHead className="h-8">Venue</TableHead>
                <TableHead className="h-8">Direction</TableHead>
                <TableHead className="h-8">Asset</TableHead>
                <TableHead className="h-8">Chain</TableHead>
                <TableHead className="h-8 text-right">Amount</TableHead>
                <TableHead className="h-8 text-right">Fee</TableHead>
                <TableHead className="h-8">Status</TableHead>
                <TableHead className="h-8">Tx</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                    Nothing reported by the venues yet. These are the exchanges&apos; own records,
                    including transfers made outside this app.
                  </TableCell>
                </TableRow>
              )}
              {events.map((e) => (
                <TableRow key={`${e.exchange}-${e.direction}-${e.venueId}`} className="hover:bg-muted/30">
                  <TableCell className="font-mono num text-xs text-muted-foreground">
                    {fmtTime(e.at)}
                  </TableCell>
                  <TableCell className="text-xs">{exchangeName(e.exchange)}</TableCell>
                  <TableCell
                    className={cn(
                      "text-xs",
                      e.direction === "deposit" ? "text-positive" : "text-negative",
                    )}
                  >
                    {e.direction}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{e.asset}</TableCell>
                  <TableCell className="font-mono text-[10px] text-muted-foreground">
                    {e.venueChain ?? "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono num text-xs">
                    {e.amount.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right font-mono num text-xs text-muted-foreground">
                    {e.fee === null || e.fee === undefined ? "—" : e.fee}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="secondary"
                      className={cn("text-[10px] uppercase", STATUS_CLASS[e.status])}
                    >
                      {e.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono num text-[10px] text-muted-foreground">
                    {maskHash(e.txId)}
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
