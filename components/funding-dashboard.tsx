"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Loader2, Radio, RefreshCw, WifiOff } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { FiltersBar } from "@/components/filters-bar";
import { StatsSummary } from "@/components/stats-summary";
import { FundingTable } from "@/components/funding-table";
import { MarketPagination } from "@/components/market-pagination";
import { useMarketView, type StreamStatus } from "@/lib/hooks/use-market-view";
import type {
  ExchangeId,
  MarketSummary,
  MarketViewQuery,
  PairScope,
  SortKey,
  SortState,
  VenueHealth,
  VenueStatus,
} from "@/lib/types";
import { EXCHANGE_IDS, cn, exchangeName, formatAgo, scopeVenues, venueTypeOf } from "@/lib/utils";

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

/** Placeholder while the first frame is in flight, so the cards can show skeletons. */
const EMPTY_SUMMARY: MarketSummary = { highest: null, lowest: null, bestDiff: null };

/**
 * The funding rate comparison table for one pair scope.
 *
 * All three views render this: they differ only in which venue combinations a hedge may
 * span, and a single component keeps sorting, filtering and stream handling identical
 * between them.
 *
 * Filtering, scoping, sorting and paging all happen on the server now. That is not only
 * about payload size — Diff FR and Direction are derived from the venues in view, so
 * sorting by Diff FR in the browser over one page would order rows by a number computed
 * from a different venue set than the one on screen. The derivation and the sort have to
 * agree, so both live server-side and this component renders what it is given.
 */
export function FundingDashboard({ scope, title, description }: FundingDashboardProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "diffFr", dir: "desc" });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [reconnectAt, setReconnectAt] = useState<number | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Venues this scope can draw legs from.
  const scoped = useMemo(() => scopeVenues(scope), [scope]);
  const [enabled, setEnabled] = useState<Record<ExchangeId, boolean>>(() => enabledFor(scoped));
  const [scopeKey, setScopeKey] = useState(scope);

  // Reset the toggles when the view changes, so a venue hidden on one page does not
  // stay hidden on the other. Adjusted during render rather than in an effect: an
  // effect would paint one frame with the previous view's toggles.
  if (scopeKey !== scope) {
    setScopeKey(scope);
    setEnabled(enabledFor(scoped));
    setPage(1);
  }

  const visible = useMemo(() => scoped.filter((id) => enabled[id]), [scoped, enabled]);

  const viewQuery = useMemo<MarketViewQuery>(
    () => ({
      scope,
      venues: visible,
      search: query.trim() || undefined,
      sort: sort.key,
      dir: sort.dir,
      page,
      pageSize,
    }),
    [scope, visible, query, sort.key, sort.dir, page, pageSize],
  );

  const { view, status, lastUpdate, refresh } = useMarketView(viewQuery);

  const reconnecting = reconnectAt !== null && (lastUpdate === null || lastUpdate < reconnectAt);
  // Nothing has arrived yet: distinct from "arrived and empty", which is a real answer
  // the table can state.
  const awaitingFirstFrame = view === null;

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
    // Gives up on the "reconnecting" label if no frame lands, so a dead feed does not
    // leave the button disabled forever.
    reconnectTimer.current = setTimeout(() => setReconnectAt(null), 4000);
  }, [refresh]);

  const onSort = useCallback((key: SortKey) => {
    setSort((prev) => ({
      key,
      dir: prev.key === key && prev.dir === "asc" ? "desc" : "asc",
    }));
    // A new sort order makes the current page number meaningless.
    setPage(1);
  }, []);

  const onToggleExchange = useCallback((id: ExchangeId) => {
    setEnabled((prev) => ({ ...prev, [id]: !prev[id] }));
    setPage(1);
  }, []);

  const onQueryChange = useCallback((next: string) => {
    setQuery(next);
    setPage(1);
  }, []);

  const onPageSize = useCallback((size: number) => {
    setPageSize(size);
    setPage(1);
  }, []);

  // Memoised so the identity is stable when a frame arrives with the same rows, which
  // is what lets the memoised table rows skip work.
  const rows = useMemo(() => view?.rows ?? [], [view]);
  const pairable = view?.pairable ?? visible.length >= 2;
  const venues = useMemo(
    () => (view?.venues ?? []).filter((v) => scoped.includes(v.exchange)),
    [view, scoped],
  );
  const totalStreams = useMemo(
    () => (view?.venues ?? []).reduce((sum, v) => sum + v.subscriptions, 0),
    [view],
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

      <StatsSummary
        summary={view?.summary ?? EMPTY_SUMMARY}
        showDiff={pairable}
        loading={awaitingFirstFrame}
      />

      <FiltersBar
        query={query}
        onQueryChange={onQueryChange}
        enabled={enabled}
        exchanges={scoped}
        onToggleExchange={onToggleExchange}
        onRefresh={onReconnect}
        refreshing={reconnecting}
      />

      {!pairable && visible.length > 0 && <Alert variant="warning">{scopeHint(scope)}</Alert>}

      <section className="flex min-h-[40vh] flex-col gap-3">
        <FundingTable
          rows={rows}
          enabled={enabled}
          sort={sort}
          onSort={onSort}
          nowMs={nowMs}
          showPairColumns={pairable}
          loading={awaitingFirstFrame}
        />
        <MarketPagination
          page={view?.page ?? page}
          pageSize={view?.pageSize ?? pageSize}
          total={view?.total ?? 0}
          onPage={setPage}
          onPageSize={onPageSize}
          disabled={awaitingFirstFrame}
        />
      </section>

      <footer className="pt-1 text-center text-[10px] text-muted-foreground">
        {view
          ? `${view.total.toLocaleString()} ${pairable ? "pairs" : "coins"} in scope · ` +
            `${view.universe.toLocaleString()} coins tracked · ` +
            `${totalStreams.toLocaleString()} live subscriptions across ${venues.length} venues · nothing stored`
          : "Connecting to market stream…"}
      </footer>
    </div>
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
          <span className="text-muted-foreground">frame {formatAgo(lastUpdate, nowMs)}</span>
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
