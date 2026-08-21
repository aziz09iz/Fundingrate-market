"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/page-skeleton";
import { apiFetch } from "@/lib/api/client";
import type {
  CredentialStatus,
  LiveAccountSnapshot,
  PrivateStreamHealth,
  VenueType,
} from "@/lib/types";
import { cn, exchangeName, formatPrice, formatSignedUsd, signClass, venueTypeOf } from "@/lib/utils";
import {
  Plug,
  Radio,
  ArrowUpRight,
  ArrowDownRight,
  ArrowRight,
  Loader2,
  RefreshCw,
} from "lucide-react";

interface LiveResponse {
  snapshot: LiveAccountSnapshot;
  credentials: CredentialStatus[];
}

/** Capital and exposure for one venue class. */
interface VenueTotals {
  equity: number;
  available: number;
  inPosition: number;
  unrealized: number;
  positions: number;
}

const HEALTH_CLASS: Record<PrivateStreamHealth, string> = {
  disabled: "text-muted-foreground",
  connecting: "text-info",
  ok: "text-positive",
  degraded: "text-warning",
  down: "text-negative",
};

/** Section headings for the venue split, so the copy lives in one place. */
const VENUE_GROUPS: { type: VenueType; title: string; blurb: string }[] = [
  {
    type: "cex",
    title: "Centralized venues",
    blurb: "Custodial exchanges reached with an API key",
  },
  {
    type: "dex",
    title: "Decentralized venues",
    blurb: "On-chain perpetuals, signed for with a wallet key or the venue's own API key",
  },
];

/** Signed USD for anything that can be a gain or a loss. */
function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "$0.00";
  return formatSignedUsd(n);
}

/** Plain USD with thousands separators, for balances rather than PnL. */
function fmtBalance(n: number): string {
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pnlClass(n: number | null | undefined) {
  return signClass(n ?? null);
}

export default function AccountOverviewPage() {
  const [live, setLive] = useState<LiveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (options: { notify?: boolean } = {}) => {
    // Nothing is set before the first await, so calling this from an effect
    // cannot cascade renders.
    try {
      const result = await apiFetch<LiveResponse>("/api/live/account");
      setLive(result);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      // Only a click gets a toast; the 20s poll failing repeatedly would stack up.
      if (options.notify) toast.error("Could not load account", { description: message });
    } finally {
      setLoading(false);
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load({ notify: true });
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => {
      void load();
    }, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const credentials = live?.credentials ?? [];
  const connectedCount = credentials.filter((c) => c.configured && c.enabled).length;
  const venueHealth = useMemo(
    () => new Map((live?.snapshot.venues ?? []).map((v) => [v.exchange, v])),
    [live],
  );

  /**
   * Live totals per venue class.
   *
   * The split is the first thing worth seeing, because the two halves are not
   * interchangeable: a cross-venue hedge holds collateral on both sides, and
   * moving value across takes an on-chain transfer with a fee and a delay. A
   * single combined number hides the constraint that actually governs what can be
   * opened next.
   */
  const byType = useMemo(() => {
    const blank = (): VenueTotals => ({
      equity: 0,
      available: 0,
      inPosition: 0,
      unrealized: 0,
      positions: 0,
    });
    const out: Record<VenueType, VenueTotals> = { cex: blank(), dex: blank() };
    for (const b of live?.snapshot.balances ?? []) {
      const t = out[venueTypeOf(b.exchange)];
      t.equity += b.equity;
      t.available += b.available;
      t.inPosition += b.inPosition;
    }
    for (const p of live?.snapshot.positions ?? []) {
      const t = out[venueTypeOf(p.exchange)];
      t.unrealized += p.unrealizedPnl;
      t.positions += 1;
    }
    return out;
  }, [live]);

  const totals = useMemo(
    () => ({
      equity: byType.cex.equity + byType.dex.equity,
      available: byType.cex.available + byType.dex.available,
      unrealized: byType.cex.unrealized + byType.dex.unrealized,
    }),
    [byType],
  );

  /** Realized PnL from today's fills, across every live venue. */
  const realizedToday = useMemo(() => {
    const trades = live?.snapshot.recentTrades ?? [];
    const startOfDay = new Date().setHours(0, 0, 0, 0);
    return trades
      .filter((t) => t.time >= startOfDay)
      .reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0);
  }, [live]);

  /** Last 5 live fills, newest first. */
  const trades = useMemo(
    () => [...(live?.snapshot.recentTrades ?? [])].sort((a, b) => b.time - a.time).slice(0, 5),
    [live],
  );

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-6">
      <PageHeader
        title="Account Overview"
        description="Live capital, exposure and fills across centralized and on-chain venues."
        badge="Live"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => void onRefresh()}
              disabled={loading || refreshing}
            >
              {refreshing ? (
                <Loader2 aria-hidden className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw aria-hidden className="size-3.5" />
              )}
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              nativeButton={false}
              render={<Link href="/account/live" />}
            >
              Live Account
            </Button>
          </>
        }
      />

      {error && <Alert variant="error">{error}</Alert>}

      {!live && loading ? (
        <PageSkeleton cards={4} rows={6} filters={false} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Live equity" value={fmtBalance(totals.equity)} />
            <StatCard label="Available" value={fmtBalance(totals.available)} />
            <StatCard
              label="Unrealized PnL"
              value={fmtUsd(totals.unrealized)}
              valueClass={pnlClass(totals.unrealized)}
            />
            <StatCard
              label="Realized today"
              value={fmtUsd(realizedToday)}
              valueClass={pnlClass(realizedToday)}
            />
          </div>

          {/* The CEX/DEX split, which is what the combined figures above conceal. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {VENUE_GROUPS.map((group) => (
              <VenueClassCard
                key={group.type}
                title={group.title}
                blurb={group.blurb}
                totals={byType[group.type]}
                venues={credentials.filter(
                  (c) => venueTypeOf(c.exchange) === group.type && c.configured && c.enabled,
                ).length}
              />
            ))}
          </div>
        </>
      )}

      <div className="grid grid-cols-1 gap-4">
        {/* Connected accounts, grouped by venue class. Only venues with stored
            credentials count as connected. */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between py-3">
            <CardTitle className="text-sm">Connected Accounts</CardTitle>
            <Badge variant="secondary">
              {connectedCount}/{credentials.length || 7} connected
            </Badge>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-8">Venue</TableHead>
                  <TableHead className="h-8">Status</TableHead>
                  <TableHead className="h-8">Credential</TableHead>
                  <TableHead className="h-8">Stream</TableHead>
                  <TableHead className="h-8 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {credentials.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                      {loading ? "Loading credential status…" : "Credential status unavailable."}
                    </TableCell>
                  </TableRow>
                )}
                {VENUE_GROUPS.flatMap((group) => {
                  const rows = credentials.filter((c) => venueTypeOf(c.exchange) === group.type);
                  if (rows.length === 0) return [];
                  return [
                    <TableRow key={group.type} className="hover:bg-transparent">
                      <TableCell colSpan={5} className="bg-muted/30 py-1.5">
                        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                          {group.title}
                        </span>
                        <span className="ml-2 text-[10px] text-muted-foreground/70">
                          {group.blurb}
                        </span>
                      </TableCell>
                    </TableRow>,
                    ...rows.map((c) => {
                      const health = venueHealth.get(c.exchange);
                      return (
                        <TableRow key={c.exchange}>
                          <TableCell className="font-medium">{exchangeName(c.exchange)}</TableCell>
                          <TableCell>
                            {!c.accountSupported ? (
                              // Not a state that can be changed from here, so it
                              // reads as a fact rather than as something unconnected.
                              <Badge variant="secondary" className="gap-1 text-info">
                                <Radio aria-hidden className="size-3" />
                                Market data only
                              </Badge>
                            ) : c.configured ? (
                              <Badge
                                variant="secondary"
                                className={cn(
                                  "gap-1",
                                  c.enabled ? "text-positive" : "text-muted-foreground",
                                )}
                              >
                                <Plug aria-hidden className="size-3" />
                                {c.enabled ? "Connected" : "Disabled"}
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="text-muted-foreground">
                                Not connected
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {c.kind === "dex"
                              ? (c.walletAddressMasked ?? "—")
                              : c.keyTail
                                ? `••••${c.keyTail}`
                                : "—"}
                            {c.readOnlyVenue && (
                              // "read-only" would overstate it: cancelling works.
                              <span className="ml-1 text-[10px] text-warning">no order entry</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {/* The health word carries the state; the colour only
                                reinforces it. */}
                            <span
                              className={cn(
                                "font-mono text-[10px] uppercase",
                                HEALTH_CLASS[health?.health ?? "disabled"],
                              )}
                            >
                              {health?.health ?? "disabled"}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            {c.accountSupported ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1 text-xs"
                                nativeButton={false}
                                render={
                                  <Link
                                    href={`/settings/api-keys/${c.kind === "dex" ? "dex" : "cex"}`}
                                  />
                                }
                              >
                                {c.configured ? "Manage" : "Connect"}
                                <ArrowRight aria-hidden className="size-3" />
                              </Button>
                            ) : (
                              <span className="text-[10px] text-muted-foreground">
                                nothing to configure
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    }),
                  ];
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Last 5 Live Fills</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8">Time</TableHead>
                <TableHead className="h-8">Pair</TableHead>
                <TableHead className="h-8">Venue</TableHead>
                <TableHead className="h-8">Class</TableHead>
                <TableHead className="h-8">Side</TableHead>
                <TableHead className="h-8 text-right">Price</TableHead>
                <TableHead className="h-8 text-right">Size</TableHead>
                <TableHead className="h-8 text-right">PnL</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trades.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                    No live fills recorded yet.
                  </TableCell>
                </TableRow>
              )}
              {trades.map((t) => {
                const buy = t.side === "buy";
                return (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {new Date(t.time).toLocaleString(undefined, {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{t.coin}</TableCell>
                    <TableCell className="text-xs">{exchangeName(t.exchange)}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-[10px] uppercase">
                        {venueTypeOf(t.exchange)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 font-mono text-xs",
                          buy ? "text-positive" : "text-negative",
                        )}
                      >
                        {buy ? (
                          <ArrowUpRight aria-hidden className="size-3" />
                        ) : (
                          <ArrowDownRight aria-hidden className="size-3" />
                        )}
                        {t.side}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs num">
                      {formatPrice(t.price)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs num">{t.size}</TableCell>
                    <TableCell
                      className={cn("text-right font-mono text-xs num", pnlClass(t.realizedPnl))}
                    >
                      {fmtUsd(t.realizedPnl)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

/** Equity, exposure and PnL for one venue class. */
function VenueClassCard({
  title,
  blurb,
  totals,
  venues,
}: {
  title: string;
  blurb: string;
  totals: VenueTotals;
  venues: number;
}) {
  return (
    <Card className="bg-card/60">
      <CardHeader className="flex flex-row items-start justify-between py-3">
        <div className="flex flex-col gap-0.5">
          <CardTitle className="text-sm">{title}</CardTitle>
          <span className="text-[10px] text-muted-foreground">{blurb}</span>
        </div>
        <Badge variant="secondary" className="text-[10px]">
          {venues} connected
        </Badge>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Equity" value={fmtBalance(totals.equity)} />
        <Metric label="Available" value={fmtBalance(totals.available)} />
        <Metric label="In position" value={fmtBalance(totals.inPosition)} />
        <Metric
          label={`uPnL · ${totals.positions} pos`}
          value={fmtUsd(totals.unrealized)}
          valueClass={pnlClass(totals.unrealized)}
        />
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-sm font-medium num", valueClass)}>{value}</span>
    </div>
  );
}

function StatCard({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <Card className="bg-card/60">
      <CardContent className="flex flex-col gap-1 p-4">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className={cn("font-mono text-lg font-semibold num", valueClass)}>
          {value}
        </span>
      </CardContent>
    </Card>
  );
}
