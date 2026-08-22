"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import type { ShardState, ShardTelemetry, StreamFabricStatus, VenueHealth } from "@/lib/types";
import { cn, exchangeName, formatAgo } from "@/lib/utils";
import { RefreshCw, RotateCw } from "lucide-react";

const POLL_MS = 2_000;

const HEALTH_CLASS: Record<VenueHealth, string> = {
  ok: "text-positive",
  degraded: "text-warning",
  connecting: "text-info",
  down: "text-negative",
};

const STATE_CLASS: Record<ShardState, string> = {
  open: "text-positive",
  connecting: "text-info",
  backoff: "text-warning",
  idle: "text-muted-foreground",
  closed: "text-negative",
};

const FOCUS_LABEL = {
  "on-screen": "on screen",
  position: "position",
  "top-gap": "top gap",
} as const;

/**
 * Stream Fabric: the websocket layer, one row per shard.
 *
 * The page exists because "the venue looks fine" stopped being a useful granularity.
 * With every pair subscribed, a venue's market arrives over several sockets — or over
 * one firehose that can go silent while still reporting itself open — so a single
 * degraded shard is a few hundred pairs with no data and nothing above this layer can
 * see it.
 */
export default function StreamFabricPage() {
  const [data, setData] = useState<StreamFabricStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const load = useCallback(async () => {
    try {
      const result = await apiFetch<StreamFabricStatus>("/api/system/streams");
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Split from the interval below and wrapped, matching the other polling pages: a
  // bare `void load()` in an effect body reads as a synchronous setState and trips the
  // cascading-render rule, even though the state lands in a promise callback.
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => {
      setNowMs(Date.now());
      void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const onReconnect = useCallback(
    async (shardId: string) => {
      setBusy(shardId);
      try {
        await apiFetch("/api/system/streams/reconnect", {
          method: "POST",
          json: { shardId },
        });
        toast.success("Reconnecting", { description: shardId });
        await load();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error("Could not reconnect that shard", { description: message });
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const shardsByVenue = useMemo(() => {
    const map = new Map<string, ShardTelemetry[]>();
    for (const shard of data?.shards ?? []) {
      const list = map.get(shard.exchange) ?? [];
      list.push(shard);
      map.set(shard.exchange, list);
    }
    return map;
  }, [data]);

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-6">
      <PageHeader
        title="Stream Fabric"
        description="WebSocket manager: every shard, its coverage, and where order-book data is currently focused."
        actions={
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => void load()}
          >
            <RefreshCw aria-hidden className="size-3.5" />
            Refresh
          </Button>
        }
      />

      {error && (
        <Alert variant="error" className="text-[11px]">
          {error}
        </Alert>
      )}

      {!data && loading && <PageSkeleton cards={3} rows={8} filters={false} />}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-7">
            <Metric
              label="Sockets"
              value={`${data.totals.socketsOpen}/${data.totals.socketsExpected}`}
              tone={data.totals.socketsOpen === data.totals.socketsExpected ? "ok" : "warn"}
            />
            <Metric label="Frames/sec" value={data.totals.msgRate.toLocaleString()} />
            <Metric label="Coins" value={data.totals.coins.toLocaleString()} />
            <Metric
              label="Funding pairs"
              value={`${data.totals.fundingPairs.toLocaleString()}/${data.totals.trackedPairs.toLocaleString()}`}
            />
            <Metric label="Book pairs" value={data.totals.bookPairs.toLocaleString()} />
            <Metric
              label="Loop lag"
              value={`${data.loopLagMs} ms`}
              // Past roughly a quarter second, heartbeats start going out late enough
              // for a venue to close the socket as idle.
              tone={data.loopLagMs > 250 ? "warn" : "ok"}
            />
            <Metric
              label="Registry age"
              value={
                data.registryAgeMs === null
                  ? "—"
                  : `${Math.round(data.registryAgeMs / 1000)}s`
              }
            />
          </div>

          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm">Venues</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table className="w-full">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Venue</TableHead>
                    <TableHead>Health</TableHead>
                    <TableHead>Funding</TableHead>
                    <TableHead className="text-right">Sockets</TableHead>
                    <TableHead className="text-right">Funding / listed</TableHead>
                    <TableHead className="text-right">Book</TableHead>
                    <TableHead className="text-right">Frames/sec</TableHead>
                    <TableHead className="text-right">Last frame</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.venues.map((v) => {
                    // A venue with fewer funding readings than listings is the failure
                    // this column exists for: a shard never came up, and the missing
                    // pairs would otherwise just look like coins nobody trades.
                    const short = v.listedCoins > 0 && v.fundingCoins < v.listedCoins;
                    return (
                      <TableRow key={v.exchange}>
                        <TableCell className="text-sm font-medium">
                          {exchangeName(v.exchange)}
                        </TableCell>
                        <TableCell>
                          <span
                            className={cn("font-mono text-[10px] uppercase", HEALTH_CLASS[v.health])}
                          >
                            {v.health}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className={cn(
                              "text-[9px]",
                              v.fundingSource === "rest" ? "text-warning" : "text-muted-foreground",
                            )}
                          >
                            {v.fundingSource === "rest" ? "REST" : "stream"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs num">
                          {v.socketsOpen}/{v.socketsExpected}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right font-mono text-xs num",
                            short && "text-warning",
                          )}
                        >
                          {v.fundingCoins.toLocaleString()}/{v.listedCoins.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs num text-muted-foreground">
                          {v.bookCoins.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs num">
                          {v.msgRate.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right font-mono text-[11px] text-muted-foreground">
                          {formatAgo(v.lastMessageAt, nowMs)}
                        </TableCell>
                        <TableCell className="text-[10px] text-muted-foreground">
                          <div className="flex flex-col gap-0.5">
                            {v.instrumentsError && (
                              <span className="text-warning">
                                listings: {v.instrumentsError}
                              </span>
                            )}
                            {v.lastError && <span className="text-negative">{v.lastError}</span>}
                          </div>
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
              <CardTitle className="text-sm">Shards</CardTitle>
              <Badge variant="secondary" className="text-[10px]">
                {data.shards.length} connections
              </Badge>
            </CardHeader>
            <CardContent className="p-0">
              <Table className="w-full" containerClassName="max-h-[60vh]" stickyHeader>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Shard</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead className="text-right">Coins</TableHead>
                    <TableHead className="text-right">Topics</TableHead>
                    <TableHead className="text-right">Frames/sec</TableHead>
                    <TableHead className="text-right">KB/sec</TableHead>
                    <TableHead className="text-right">Uptime</TableHead>
                    <TableHead className="text-right">Retries</TableHead>
                    <TableHead>Last error</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...shardsByVenue.values()].map((shards) =>
                    shards.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-mono text-[11px]">
                          <div className="flex flex-col leading-tight">
                            <span>{exchangeName(s.exchange)}</span>
                            <span className="text-[10px] text-muted-foreground">{s.id}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <span className="font-mono text-[11px]">{s.plan}</span>
                            <span className="flex items-center gap-1">
                              <Badge
                                variant="secondary"
                                className={cn(
                                  "text-[9px]",
                                  s.mode === "firehose" ? "text-info" : "text-muted-foreground",
                                )}
                              >
                                {s.mode}
                              </Badge>
                              <span className="text-[9px] text-muted-foreground">
                                {s.carries.join(" + ")}
                              </span>
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span
                            className={cn("font-mono text-[10px] uppercase", STATE_CLASS[s.state])}
                          >
                            {s.state}
                          </span>
                          {s.nextRetryAt !== null && (
                            <span className="ml-1 text-[9px] text-muted-foreground">
                              retry in {Math.max(0, Math.round((s.nextRetryAt - nowMs) / 1000))}s
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs num">
                          {s.mode === "firehose" ? "all" : s.coins.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs num">
                          {s.topics.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs num">
                          {s.msgRate.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs num">
                          {(s.byteRate / 1024).toFixed(1)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-[11px] text-muted-foreground">
                          {s.connectedAt === null
                            ? "—"
                            : formatDuration(nowMs - s.connectedAt)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs num">
                          {s.reconnects}
                        </TableCell>
                        <TableCell className="max-w-[16rem] truncate text-[10px] text-muted-foreground">
                          {s.lastError ?? "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 gap-1 px-1.5 text-[10px]"
                            disabled={busy !== null}
                            onClick={() => void onReconnect(s.id)}
                          >
                            <RotateCw
                              aria-hidden
                              className={cn("size-3", busy === s.id && "animate-spin")}
                            />
                            Reconnect
                          </Button>
                        </TableCell>
                      </TableRow>
                    )),
                  )}
                  {data.shards.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={11} className="py-10 text-center text-muted-foreground">
                        No sockets yet — the first instrument refresh is still in flight.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between py-3">
              <CardTitle className="text-sm">Book Focus</CardTitle>
              <Badge variant="secondary" className="text-[10px]">
                {data.focus.entries.length} pairs · {data.focus.viewers} viewers
              </Badge>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-[11px] text-muted-foreground">
                Funding is subscribed for every pair on every venue. Order books are not: a
                top-of-book channel fires many times a second per pair, so quotes follow the rows
                being looked at, the pairs a position is open in, and the widest funding gaps. A row
                outside this set shows a funding rate but no spread until it comes into view.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {data.focus.entries.map((entry) => (
                  <Badge
                    key={entry.coin}
                    variant="secondary"
                    className={cn(
                      "gap-1 font-mono text-[10px]",
                      entry.reason === "position" && "text-warning",
                    )}
                  >
                    {entry.coin}
                    <span className="text-[9px] text-muted-foreground">
                      {FOCUS_LABEL[entry.reason]}
                      {entry.venues.length > 0 && ` · ${entry.venues.length}`}
                    </span>
                  </Badge>
                ))}
                {data.focus.entries.length === 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    Nothing focused — open a dashboard to subscribe quotes for its rows.
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "neutral";
}) {
  return (
    <Card className="bg-card/60">
      <CardContent className="flex flex-col gap-1 p-3">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
        <span
          className={cn(
            "font-mono text-lg font-semibold num",
            tone === "ok" && "text-positive",
            tone === "warn" && "text-warning",
          )}
        >
          {value}
        </span>
      </CardContent>
    </Card>
  );
}

/** Compact uptime: "4h 12m", "12m 30s", "45s". */
function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${String(sec % 60).padStart(2, "0")}s`;
  const hours = Math.floor(min / 60);
  return `${hours}h ${String(min % 60).padStart(2, "0")}m`;
}
