"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/page-skeleton";
import { LivePositions } from "@/components/account/live-positions";
import type { CloseHedgeInput } from "@/components/account/close-hedge-dialog";
import { apiFetch } from "@/lib/api/client";
import { useTabParam } from "@/lib/hooks/use-tab-param";
import type {
  CredentialStatus,
  ExchangeId,
  LiveAccountSnapshot,
  Order,
  Position,
  PrivateStreamHealth,
  VenueType,
} from "@/lib/types";
import {
  cn,
  exchangeName,
  formatAgo,
  formatPrice,
  formatSignedUsd,
  signClass,
  venueTypeOf,
} from "@/lib/utils";
import { Loader2, RefreshCw } from "lucide-react";

interface LiveResponse {
  snapshot: LiveAccountSnapshot;
  credentials: CredentialStatus[];
}

const HEALTH_CLASS: Record<PrivateStreamHealth, string> = {
  disabled: "text-muted-foreground",
  connecting: "text-info",
  ok: "text-positive",
  degraded: "text-warning",
  down: "text-negative",
};

const VENUE_CLASSES = ["cex", "dex"] as const;

/** A fresh idempotency key per submitted intent, so retries cannot double-send. */
function newIdempotencyKey(): string {
  return `frw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Plain USD with thousands separators, for balances rather than PnL. */
function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function LiveAccountWorkspace() {
  const [data, setData] = useState<LiveResponse | null>(null);
  const [venueClass, setVenueClass] = useTabParam<VenueType>("class", VENUE_CLASSES, "cex");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async (options: { notify?: boolean } = {}) => {
    // Nothing is set before the first await: a synchronous setState inside an
    // effect body counts as a cascading render.
    try {
      const result = await apiFetch<LiveResponse>("/api/live/account");
      setData(result);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      // The 10s poll stays quiet; only a click reports failure as a toast.
      if (options.notify) toast.error("Could not load live account", { description: message });
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
      setNowMs(Date.now());
      void load();
    }, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const onClose = useCallback(
    async ({ position, size }: { position: Position; size: number }) => {
      try {
        const result = await apiFetch<LiveResponse>("/api/live/order/close", {
          method: "POST",
          headers: { "idempotency-key": newIdempotencyKey() },
          json: {
            exchange: position.exchange,
            coin: position.coin,
            side: position.side,
            size,
          },
        });
        if (result.snapshot) {
          setData((prev) => (prev ? { ...prev, snapshot: result.snapshot } : prev));
        }
        toast.success(`Closed ${size} ${position.coin}`, {
          description: `${exchangeName(position.exchange)} · was ${position.side}`,
        });
        await load();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`Could not close ${position.coin}`, { description: message });
        // Rethrown so the confirm dialog keeps itself open and shows the reason.
        throw err;
      }
    },
    [load],
  );

  /**
   * Closes every leg of a hedge, sequentially.
   *
   * Sequential rather than parallel because the legs are not interchangeable: if
   * the first close is rejected there is no point sending the second, and a
   * half-closed hedge is directional exposure. Each leg carries its own
   * idempotency key so a retry of one cannot double-send another.
   */
  const onCloseHedge = useCallback(
    async ({ legs, fraction }: CloseHedgeInput) => {
      const failures: string[] = [];
      let closed = 0;
      let latest: LiveAccountSnapshot | null = null;

      for (const leg of legs) {
        const size = Number((leg.size * fraction).toFixed(8));
        if (!(size > 0)) continue;
        try {
          const result = await apiFetch<LiveResponse>("/api/live/order/close", {
            method: "POST",
            headers: { "idempotency-key": newIdempotencyKey() },
            json: {
              exchange: leg.exchange,
              coin: leg.coin,
              side: leg.side,
              size,
            },
          });
          if (result.snapshot) latest = result.snapshot;
          closed += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push(`${leg.side} ${exchangeName(leg.exchange)}: ${message}`);
        }
      }

      if (latest) setData((prev) => (prev ? { ...prev, snapshot: latest } : prev));
      await load();

      // A partial close is reported as a failure, not a success with a caveat: the
      // account is now holding one side of a hedge, and that needs acting on.
      if (failures.length > 0) {
        const detail = failures.join(" · ");
        setError(detail);
        toast.error(
          closed > 0
            ? `Closed ${closed} of ${legs.length} legs — the rest failed, so this hedge is now unbalanced`
            : "Could not close this position",
          { description: detail },
        );
        throw new Error(detail);
      }

      toast.success(legs.length > 1 ? "Hedge closed" : "Position closed", {
        description: `${legs[0]?.coin ?? ""} · ${Math.round(fraction * 100)}% of ${legs.length} leg${legs.length === 1 ? "" : "s"}`.trim(),
      });
    },
    [load],
  );

  const onCancel = useCallback(
    async (order: Order) => {
      try {
        await apiFetch("/api/live/order/cancel", { method: "POST", json: { id: order.id } });
        toast.success(`Cancelled ${order.id}`, {
          description: `${order.pair} on ${exchangeName(order.exchange)}`,
        });
        await load();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`Could not cancel ${order.id}`, { description: message });
        throw err;
      }
    },
    [load],
  );

  const configured = useMemo(
    () => (data?.credentials ?? []).filter((c) => c.configured),
    [data],
  );

  /**
   * The snapshot restricted to one venue class.
   *
   * Custodial and on-chain venues are separated rather than summed because their
   * capital is not fungible: moving value between them is an on-chain transfer
   * with a fee and a delay, so an "available" figure spanning both overstates what
   * can actually back a new position on either side.
   */
  const scoped = useMemo<LiveAccountSnapshot | null>(() => {
    const snapshot = data?.snapshot;
    if (!snapshot) return null;
    const inScope = (exchange: ExchangeId) => venueTypeOf(exchange) === venueClass;
    return {
      positions: snapshot.positions.filter((p) => inScope(p.exchange)),
      openOrders: snapshot.openOrders.filter((o) => inScope(o.exchange)),
      recentTrades: snapshot.recentTrades.filter((t) => inScope(t.exchange)),
      balances: snapshot.balances.filter((b) => inScope(b.exchange)),
      venues: snapshot.venues.filter((v) => inScope(v.exchange)),
      updatedAt: snapshot.updatedAt,
    };
  }, [data, venueClass]);

  /** Venues of this class that have a credential, for an honest empty state. */
  const scopedConfigured = useMemo(
    () => configured.filter((c) => venueTypeOf(c.exchange) === venueClass),
    [configured, venueClass],
  );

  const totals = useMemo(() => {
    const balances = scoped?.balances ?? [];
    const positions = scoped?.positions ?? [];
    return {
      equity: balances.reduce((s, b) => s + b.equity, 0),
      available: balances.reduce((s, b) => s + b.available, 0),
      inPosition: balances.reduce((s, b) => s + b.inPosition, 0),
      unrealized: positions.reduce((s, p) => s + p.unrealizedPnl, 0),
    };
  }, [scoped]);

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-6">
      <PageHeader
        title="Live Account"
        description="Positions, orders and balances streamed from each venue's private websocket."
        badge="Live"
        actions={
          <>
            {scoped && <StreamBadge venues={scoped.venues} nowMs={nowMs} />}
            <Tabs value={venueClass} onValueChange={(v) => setVenueClass(v as VenueType)}>
              <TabsList>
                <TabsTrigger value="cex" className="text-xs">
                  CEX
                </TabsTrigger>
                <TabsTrigger value="dex" className="text-xs">
                  DEX
                </TabsTrigger>
              </TabsList>
            </Tabs>
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
          </>
        }
      />

      <Alert variant="error" className="text-[11px]">
        Actions on this page send real orders to real venues with real funds. Close and cancel both
        confirm first, but a confirmed order cannot be recalled once it fills.
      </Alert>

      {error && <Alert variant="error">{error}</Alert>}

      {data && scopedConfigured.length === 0 && (
        <Alert variant="warning">
          {venueClass === "cex"
            ? "No centralized venue credentials are configured, so there is nothing to stream. Add API keys under Venue Credentials → CEX API Keys."
            : "No decentralized venue wallets are configured, so there is nothing to stream. Add a wallet address under Venue Credentials → DEX Wallets."}
        </Alert>
      )}

      {!data && loading && <PageSkeleton cards={4} rows={6} filters={false} />}

      {scoped && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Equity" value={fmtUsd(totals.equity)} />
            <StatCard label="Available" value={fmtUsd(totals.available)} />
            <StatCard label="In position" value={fmtUsd(totals.inPosition)} />
            <StatCard
              label="Unrealized PnL"
              value={totals.unrealized === 0 ? "$0.00" : formatSignedUsd(totals.unrealized)}
              valueClass={signClass(totals.unrealized)}
            />
          </div>

          <LivePositions
            snapshot={scoped}
            onClose={onClose}
            onCloseHedge={onCloseHedge}
            onCancel={onCancel}
          />

          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">Balances by Venue</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-8">Venue</TableHead>
                    <TableHead className="h-8">Asset</TableHead>
                    <TableHead className="h-8 text-right">Available</TableHead>
                    <TableHead className="h-8 text-right">In position</TableHead>
                    <TableHead className="h-8 text-right">Equity</TableHead>
                    <TableHead className="h-8 text-right">Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scoped.balances.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                        No balances reported yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {scoped.balances.map((b) => (
                    <TableRow key={`${b.exchange}-${b.asset}`}>
                      <TableCell className="text-xs">{exchangeName(b.exchange)}</TableCell>
                      <TableCell className="font-mono text-xs">{b.asset}</TableCell>
                      <TableCell className="text-right font-mono text-xs num">
                        {formatPrice(b.available)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs num text-muted-foreground">
                        {formatPrice(b.inPosition)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs num">
                        {formatPrice(b.equity)}
                      </TableCell>
                      <TableCell className="text-right text-[10px] text-muted-foreground">
                        {formatAgo(b.updatedAt, nowMs)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">Recent Fills</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-8">Time</TableHead>
                    <TableHead className="h-8">Pair</TableHead>
                    <TableHead className="h-8">Venue</TableHead>
                    <TableHead className="h-8">Side</TableHead>
                    <TableHead className="h-8 text-right">Price</TableHead>
                    <TableHead className="h-8 text-right">Size</TableHead>
                    <TableHead className="h-8 text-right">Fee</TableHead>
                    <TableHead className="h-8 text-right">PnL</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scoped.recentTrades.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                        No fills recorded yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {scoped.recentTrades.map((t) => (
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
                      <TableCell
                        className={cn(
                          "font-mono text-xs",
                          t.side === "buy" ? "text-positive" : "text-negative",
                        )}
                      >
                        {t.side}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs num">
                        {formatPrice(t.price)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs num">{t.size}</TableCell>
                      <TableCell className="text-right font-mono text-xs num text-muted-foreground">
                        {t.fee === null || t.fee === undefined ? "—" : t.fee.toFixed(4)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-mono text-xs num",
                          signClass(t.realizedPnl ?? null),
                        )}
                      >
                        {t.realizedPnl === null || t.realizedPnl === undefined
                          ? "—"
                          : t.realizedPnl === 0
                            ? "$0.00"
                            : formatSignedUsd(t.realizedPnl)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
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

function StreamBadge({
  venues,
  nowMs,
}: {
  venues: LiveAccountSnapshot["venues"];
  nowMs: number;
}) {
  const active = venues.filter((v) => v.health === "ok").length;
  const enabled = venues.filter((v) => v.health !== "disabled").length;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-help" />}>
        <Badge
          variant="secondary"
          className={cn("gap-1.5 text-[10px]", active > 0 ? "text-positive" : "text-muted-foreground")}
        >
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full bg-current", active > 0 && "animate-pulse")}
          />
          private {active}/{enabled} ok
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="font-mono text-xs">
        <div className="flex flex-col gap-0.5">
          {venues.map((v) => (
            <span key={v.exchange} className="flex items-center gap-2">
              <span className={cn("w-16 text-[9px] uppercase", HEALTH_CLASS[v.health])}>
                {v.health}
              </span>
              <span className="w-20">{exchangeName(v.exchange)}</span>
              <span className="text-muted-foreground">
                {v.health !== "disabled" && formatAgo(v.lastMessageAt, nowMs)}
              </span>
            </span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export default function LiveAccountPage() {
  // useSearchParams, which the tab hook uses, needs a Suspense boundary above it.
  return (
    <Suspense fallback={<PageSkeleton cards={4} rows={6} filters={false} />}>
      <LiveAccountWorkspace />
    </Suspense>
  );
}
