"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { apiFetch } from "@/lib/api/client";
import type { AccountType, LogChannel, LogEntry, LogLevel } from "@/lib/types";
import { STRATEGY_META } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Pause, Play, TerminalSquare } from "lucide-react";

const LEVEL_STYLE: Record<LogLevel, string> = {
  INFO: "text-positive",
  WARN: "text-warning",
  ERROR: "text-negative",
  EXEC: "text-info",
};

type SourceFilter = "all" | AccountType;
type ChannelFilter = "all" | LogChannel;

const SOURCE_TAB: { id: SourceFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "live", label: "Live" },
  { id: "paper", label: "Paper" },
];

/** `system` covers funding settlement, which belongs to the account, not a bot. */
const CHANNEL_TAB: { id: ChannelFilter; label: string }[] = [
  { id: "all", label: "All strategies" },
  { id: "fundingsync", label: STRATEGY_META.fundingsync.name },
  { id: "perpbridge", label: STRATEGY_META.perpbridge.name },
  { id: "fundingbridge", label: STRATEGY_META.fundingbridge.name },
  { id: "fundingyield", label: STRATEGY_META.fundingyield.name },
  { id: "system", label: "Account" },
];

/** Short tag shown on each line, so mixed output stays readable. */
const CHANNEL_TAG: Record<LogChannel, string> = {
  fundingsync: "FS",
  perpbridge: "PB",
  fundingbridge: "FB",
  fundingyield: "FY",
  system: "ACCT",
};

const CHANNEL_STYLE: Record<LogChannel, string> = {
  fundingsync: "text-violet-400/80",
  perpbridge: "text-orange-400/80",
  fundingbridge: "text-teal-400/80",
  fundingyield: "text-pink-400/80",
  system: "text-muted-foreground/70",
};

const POLL_MS = 3_000;

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export default function AutoLogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [source, setSource] = useState<SourceFilter>("all");
  const [channel, setChannel] = useState<ChannelFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const load = useCallback(async () => {
    // Nothing is set before the first await, so calling this from an effect
    // cannot trigger a cascading render.
    try {
      const result = await apiFetch<{ logs: LogEntry[] }>("/api/auto/logs?limit=400");
      setLogs(result.logs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  // Polled rather than streamed: these lines carry position sizes and PnL, and
  // EventSource cannot send the Authorization header the endpoint requires.
  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [paused, load]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, autoScroll]);

  // Both filters run client-side on one fetch, so switching between them is
  // instant and does not depend on the poll landing.
  const visible = useMemo(
    () =>
      logs.filter(
        (l) =>
          (source === "all" || l.source === source) &&
          (channel === "all" || (l.strategy ?? "fundingsync") === channel),
      ),
    [logs, source, channel],
  );

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-6">
      <PageHeader
        title="Auto Logs"
        description="Decisions the strategies actually made, including the candidates they refused and why."
        actions={
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              aria-pressed={paused}
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? (
                <Play aria-hidden className="size-3.5" />
              ) : (
                <Pause aria-hidden className="size-3.5" />
              )}
              {paused ? "Resume" : "Pause"}
            </Button>
          </div>
        }
      />

      {error && <Alert variant="error">{error}</Alert>}

      <div className="flex flex-wrap items-center gap-1">
        {SOURCE_TAB.map((t) => (
          <Button
            key={t.id}
            variant={source === t.id ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={source === t.id}
            className="h-7 px-2.5 text-xs"
            onClick={() => setSource(t.id)}
          >
            {t.label}
          </Button>
        ))}
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        {CHANNEL_TAB.map((t) => (
          <Button
            key={t.id}
            variant={channel === t.id ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={channel === t.id}
            className="h-7 px-2.5 text-xs"
            onClick={() => setChannel(t.id)}
          >
            {t.label}
          </Button>
        ))}
        <Badge variant="secondary" className="ml-2 text-[10px]">
          {visible.length} lines
        </Badge>
      </div>

      <div
        ref={containerRef}
        onScroll={onScroll}
        // A log console is a live region, but announcing every polled line would
        // be unusable; the polite role plus the manual "jump to latest" control is
        // the compromise.
        role="log"
        aria-label="Strategy decision log"
        aria-busy={!loaded || undefined}
        className="h-[60vh] overflow-y-auto rounded-lg border border-border bg-black/60 p-3 font-mono text-xs leading-relaxed"
      >
        {!loaded ? (
          // Shaped like log lines rather than one grey block, so the console reads
          // as "filling in" instead of "broken".
          <div className="flex flex-col gap-1.5">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="h-3.5" style={{ width: `${45 + ((i * 13) % 50)}%` }} />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
            <TerminalSquare aria-hidden className="size-4" />
            <span>
              {logs.length === 0
                ? "No decisions logged yet. Start a strategy on the paper account to see it work."
                : "No lines match these filters."}
            </span>
          </div>
        ) : (
          visible.map((l) => {
            const ch = (l.strategy ?? "fundingsync") as LogChannel;
            return (
              <div
                key={l.id}
                className="flex gap-2 whitespace-pre-wrap break-words hover:bg-white/5"
              >
                <span className="shrink-0 text-muted-foreground/70">{fmtTime(l.ts)}</span>
                <span className={cn("shrink-0 font-semibold", LEVEL_STYLE[l.level])}>
                  {l.level.padEnd(5, " ")}
                </span>
                <span className="shrink-0 text-muted-foreground/80">[{l.source}]</span>
                <span className={cn("shrink-0", CHANNEL_STYLE[ch])}>
                  {CHANNEL_TAG[ch].padEnd(4, " ")}
                </span>
                {l.coin && <span className="shrink-0 text-info">{l.coin}</span>}
                <span className="text-foreground/90">{l.message}</span>
              </div>
            );
          })
        )}
        {!paused && visible.length > 0 && (
          <div className="flex items-center gap-1.5 py-1 text-positive">
            <span aria-hidden className="inline-block size-1.5 animate-pulse rounded-full bg-current" />
            <span className="text-[10px] uppercase">polling</span>
          </div>
        )}
      </div>
      {!autoScroll && (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              setAutoScroll(true);
              const el = containerRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            ↓ Jump to latest
          </Button>
        </div>
      )}
    </div>
  );
}
