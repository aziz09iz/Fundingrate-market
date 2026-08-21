"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Loader2, Radio, RefreshCw, WifiOff } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { FiltersBar } from "@/components/filters-bar";
import { StatsSummary, computeSummary } from "@/components/stats-summary";
import { FundingTable } from "@/components/funding-table";
import { useMarketStream, type StreamStatus } from "@/lib/hooks/use-market-stream";
import type {
  ExchangeId,
  FundingRateRow,
  PairScope,
  SortKey,
  SortState,
  VenueHealth,
  VenueStatus,
} from "@/lib/types";
import {
  EXCHANGE_IDS,
  cn,
  exchangeName,
  formatAgo,
  pairInScope,
  scopeVenues,
  venueTypeOf,
} from "@/lib/utils";
import { derivePriceSpread, deriveScopedDirection } from "@/lib/market/derive";

const STATUS_LABEL: Record<StreamStatus, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

const STATUS_CLASS: Record<StreamStatus, string> = {
  connecting: "text-warning",
  live: "text-positive",
  reconnecting: "text-warning",
  offline: "text-negative",
};

/** An icon per state so the badge does not rely on its colour alone. */
const STATUS_ICON: Record<StreamStatus, typeof Radio> = {
  connecting: Loader2,
  live: Radio,
  reconnecting: Loader2,
  offline: WifiOff,
};

// Per-venue health was a coloured dot with no label; the word is what a reader
// actually needs, and it stays legible when the colour does not carry.
const VENUE_HEALTH_LABEL: Record<VenueHealth, string> = {
  ok: "ok",
  degraded: "degraded",
  connecting: "conn",
  down: "down",
};

const VENUE_HEALTH_CLASS: Record<VenueHealth, string> = {
  ok: "text-positive",
  degraded: "text-warning",
  connecting: "text-info",
  down: "text-negative",
};

interface FundingDashboardProps {
  /** Which venue combinations this view quotes hedges across. */
  scope: PairScope;
  title: string;
  description: string;
}

/**
 * The funding rate comparison table for one pair scope.
 *
 * All three views render this: they differ only in which venue combinations a
 * hedge may span, and a single component keeps sorting, filtering and stream
 * handling identical between them.
 */
export function FundingDashboard({ scope, title, description }: FundingDashboardProps) {
  const { snapshot, status, lastUpdate, refresh } = useMarketStream();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "diffFr", dir: "desc" });
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  // The stream has no request/response shape to await, so the pending state is
  // derived: a snapshot newer than the click is the proof the reconnect worked,
  // and the timer is only a ceiling for the case where none arrives.
  const [reconnectAt, setReconnectAt] = useState<number | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnecting =
    reconnectAt !== null && (lastUpdate === null || lastUpdate < reconnectAt);

  // Nothing has arrived yet: distinct from "arrived and empty", which is a real
  // answer the table can state.
  const awaitingFirstSnapshot = snapshot === null;

  // Venues this scope can draw legs from. The stream carries every venue, so the
  // split is a display filter rather than a second subscription.
  const scoped = useMemo(() => scopeVenues(scope), [scope]);

  const [enabled, setEnabled] = useState<Record<ExchangeId, boolean>>(() => enabledFor(scoped));
  const [scopeKey, setScopeKey] = useState(scope);

  // Reset the toggles when the view changes, so a venue hidden on one page does
  // not stay hidden on the other. Adjusted during render rather than in an
  // effect: an effect would paint one frame with the previous view's toggles.
  if (scopeKey !== scope) {
    setScopeKey(scope);
    setEnabled(enabledFor(scoped));
  }

  // Tick "now" every second so countdowns and freshness labels stay live.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => () => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
  }, []);

  const onReconnect = useCallback(() => {
    setReconnectAt(Date.now());
    refresh();
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    // Gives up on the "reconnecting" label if no snapshot lands, so a dead feed
    // does not leave the button disabled forever.
    reconnectTimer.current = setTimeout(() => setReconnectAt(null), 4000);
  }, [refresh]);

  const onSort = useCallback((key: SortKey) => {
    setSort((prev) => ({
      key,
      dir: prev.key === key && prev.dir === "asc" ? "desc" : "asc",
    }));
  }, []);

  const onToggleExchange = useCallback((id: ExchangeId) => {
    setEnabled((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  // Venues currently on screen: in this scope and switched on.
  const visible = useMemo(() => scoped.filter((id) => enabled[id]), [scoped, enabled]);

  /**
   * Can the visible venues still form a pair this scope accepts?
   *
   * Switching venues off can leave a scope with nothing to quote — a cross view
   * with every DEX hidden has only CEX legs left. That is a different state from
   * "no market data", and the table says so rather than printing empty columns.
   */
  const pairable = useMemo(
    () => visible.some((a) => visible.some((b) => a !== b && pairInScope(scope, a, b))),
    [visible, scope],
  );

  const filteredRows = useMemo(() => {
    const rows = snapshot?.rows ?? [];
    // A coin with no rate on any venue in this view would render as a row of
    // dashes, so it is dropped rather than shown as if data were missing.
    const listed = rows.filter((r) => scoped.some((ex) => r.rates[ex]?.rate != null));
    const q = query.trim().toUpperCase();
    const matched = q ? listed.filter((r) => r.coin.includes(q)) : listed;
    // Diff FR, Direction and Spread arrive derived across every venue. Recompute
    // them under this scope: a cross-venue row whose best global pair is two CEX
    // venues is not a cross-venue opportunity, and a row that names a venue whose
    // column is hidden cannot be checked against anything.
    return matched.map((row) => rescope(row, visible, scope));
  }, [snapshot, query, scoped, visible, scope]);

  /** Rows this scope can actually quote a hedge on, for the pair-scoped views. */
  const quotable = useMemo(
    () => (pairable ? filteredRows.filter((r) => r.direction !== null) : filteredRows),
    [filteredRows, pairable],
  );

  const summary = useMemo(() => computeSummary(quotable, enabled), [quotable, enabled]);
  const venues = useMemo(
    () => (snapshot?.venues ?? []).filter((v) => scoped.includes(v.exchange)),
    [snapshot, scoped],
  );

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-6">
      <PageHeader
        title={title}
        description={description}
        actions={
          <>
            <StreamBadge status={status} lastUpdate={lastUpdate} nowMs={nowMs} venues={venues} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onReconnect}
              disabled={reconnecting}
              className="h-8 gap-1.5"
            >
              {reconnecting ? (
                <Loader2 aria-hidden className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw aria-hidden className="size-3.5" />
              )}
              {reconnecting ? "Reconnecting…" : "Reconnect"}
            </Button>
          </>
        }
      />

      <StatsSummary summary={summary} showDiff={pairable} loading={awaitingFirstSnapshot} />

      <FiltersBar
        query={query}
        onQueryChange={setQuery}
        enabled={enabled}
        exchanges={scoped}
        onToggleExchange={onToggleExchange}
        onRefresh={onReconnect}
        refreshing={reconnecting}
      />

      {!pairable && visible.length > 0 && (
        <Alert variant="warning">{scopeHint(scope)}</Alert>
      )}

      <section className="min-h-[40vh]">
        <FundingTable
          rows={quotable}
          enabled={enabled}
          sort={sort}
          onSort={onSort}
          nowMs={nowMs}
          showPairColumns={pairable}
          loading={awaitingFirstSnapshot}
        />
      </section>

      <footer className="pt-1 text-center text-[10px] text-muted-foreground">
        {snapshot
          ? `${quotable.length} ${pairable ? "pairs" : "coins"} in scope · ${snapshot.coins.length} watched overall · ranking every ${snapshot.config.pollIntervalSec}s · nothing stored`
          : "Connecting to market stream…"}
      </footer>    </div>
  );
}

/** What the user has to switch back on for this scope to quote anything. */
function scopeHint(scope: PairScope): string {
  if (scope === "cross") {
    return "A cross-venue hedge needs one centralized and one decentralized leg. Enable at least one of each above.";
  }
  const kind = scope === "cex-cex" ? "centralized" : "decentralized";
  return `This view pairs two ${kind} venues. Enable at least two above to see hedges.`;
}

/** All scope venues on, with the ones outside it off. */
function enabledFor(scoped: ExchangeId[]): Record<ExchangeId, boolean> {
  return EXCHANGE_IDS.reduce(
    (acc, id) => {
      acc[id] = scoped.includes(id);
      return acc;
    },
    {} as Record<ExchangeId, boolean>,
  );
}

/**
 * Re-derive a row's Diff FR, Direction and entry spread under one scope, using
 * only `visible` venues.
 *
 * The stream derives these across all seven venues at once, which is right for a
 * combined view but wrong for a scoped one: on the decentralized page it produced
 * rows headed "Long KuCoin · Short OKX" with neither column present, and on the
 * cross page the best global pair is usually two CEX venues.
 */
function rescope(row: FundingRateRow, visible: ExchangeId[], scope: PairScope): FundingRateRow {
  const { diffFr, direction } = deriveScopedDirection(
    row.normalizedRates,
    // The normalization interval is a property of the reading, so it is taken
    // from the visible venues rather than recomputed from all of them.
    smallestInterval(row, visible),
    scope,
    visible,
  );
  return {
    ...row,
    spread: diffFr,
    diffFr,
    direction,
    priceSpread: derivePriceSpread(direction, row.tickers),
  };
}

/** Shortest funding interval among the visible venues that list this coin. */
function smallestInterval(row: FundingRateRow, visible: ExchangeId[]): number | null {
  const intervals = visible
    .filter((ex) => row.rates[ex]?.rate != null)
    .map((ex) => row.rates[ex].intervalHours);
  return intervals.length > 0 ? Math.min(...intervals) : null;
}

/** Connection state plus a per-venue breakdown, so a dead feed is obvious. */
function StreamBadge({
  status,
  lastUpdate,
  nowMs,
  venues,
}: {
  status: StreamStatus;
  lastUpdate: number | null;
  nowMs: number;
  venues: VenueStatus[];
}) {
  const healthy = venues.filter((v) => v.health === "ok").length;
  const StatusIcon = STATUS_ICON[status];
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-help" />}>
        <Badge variant="secondary" className={cn("gap-1.5 text-[10px]", STATUS_CLASS[status])}>
          {/* An icon alongside the dot, so the state is not colour-only. */}
          <StatusIcon
            aria-hidden
            className={cn("size-2.5", status === "live" && "animate-pulse")}
          />
          {STATUS_LABEL[status]}
          {venues.length > 0 && (
            <span className="text-muted-foreground">
              {healthy}/{venues.length} ok
            </span>
          )}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="font-mono text-xs">
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground">snapshot {formatAgo(lastUpdate, nowMs)}</span>
          {venues.map((v) => (
            <span key={v.exchange} className="flex items-center gap-2">
              <span className={cn("w-14 text-[9px] uppercase", VENUE_HEALTH_CLASS[v.health])}>
                {VENUE_HEALTH_LABEL[v.health]}
              </span>
              <span className="w-20">{exchangeName(v.exchange)}</span>
              <span className="uppercase text-[9px] text-muted-foreground">
                {venueTypeOf(v.exchange)}
              </span>
              <span className="text-muted-foreground">
                {v.subscriptions} pairs · {v.connections} ws · {formatAgo(v.lastMessageAt, nowMs)}
                {v.fundingFromRest && <span className="ml-1 text-warning">· funding via REST</span>}
              </span>
            </span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
