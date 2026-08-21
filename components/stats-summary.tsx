"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { ExchangeId, FundingRateRow } from "@/lib/types";
import { EXCHANGE_IDS, exchangeName, formatRate, rateColorClass } from "@/lib/utils";

interface SummaryHighlight {
  coin: string;
  exchange: ExchangeId;
  rate: number;
  nextFundingTime: number;
}

interface Summary {
  highest: SummaryHighlight | null;
  lowest: SummaryHighlight | null;
  bestDiff: { coin: string; diff: number; direction: FundingRateRow["direction"] } | null;
}

export function computeSummary(rows: FundingRateRow[], enabled?: Record<ExchangeId, boolean>): Summary {
  const exchanges = enabled ? EXCHANGE_IDS.filter((ex) => enabled[ex]) : EXCHANGE_IDS;
  let highest: SummaryHighlight | null = null;
  let lowest: SummaryHighlight | null = null;
  let bestDiff: Summary["bestDiff"] = null;

  for (const row of rows) {
    for (const ex of exchanges) {
      const v = row.rates[ex];
      if (v.rate === null) continue;
      if (!highest || v.rate > highest.rate) {
        highest = { coin: row.coin, exchange: ex, rate: v.rate, nextFundingTime: v.nextFundingTime };
      }
      if (!lowest || v.rate < lowest.rate) {
        lowest = { coin: row.coin, exchange: ex, rate: v.rate, nextFundingTime: v.nextFundingTime };
      }
    }

    const normalized = exchanges
      .map((ex) => ({ exchange: ex, rate: row.normalizedRates[ex] }))
      .filter((value): value is { exchange: ExchangeId; rate: number } => value.rate !== null);
    if (normalized.length >= 2) {
      const lowestNormalized = normalized.reduce((a, b) => (b.rate < a.rate ? b : a));
      const highestNormalized = normalized.reduce((a, b) => (b.rate > a.rate ? b : a));
      const diff = Number((highestNormalized.rate - lowestNormalized.rate).toFixed(4));
      if (!bestDiff || diff > bestDiff.diff) {
        bestDiff = {
          coin: row.coin,
          diff,
          direction: {
            longExchange: lowestNormalized.exchange,
            shortExchange: highestNormalized.exchange,
            longRate: lowestNormalized.rate,
            shortRate: highestNormalized.rate,
            intervalHours: Math.min(...normalized.map(({ exchange }) => row.rates[exchange].intervalHours)),
            diff,
          },
        };
      }
    }
  }

  return { highest, lowest, bestDiff };
}

interface StatsSummaryProps {
  summary: Summary;
  /**
   * False when fewer than two venues are on screen. Best Diff FR needs a pair, so
   * the card is dropped rather than left showing a permanent dash.
   */
  showDiff?: boolean;
  /**
   * True before the first snapshot arrives. Without it these cards rendered
   * zeroed values that were indistinguishable from a real reading of zero.
   */
  loading?: boolean;
}

export function StatsSummary({ summary, showDiff = true, loading = false }: StatsSummaryProps) {
  const { highest, lowest, bestDiff } = summary;
  const grid = `grid grid-cols-1 gap-3 ${showDiff ? "sm:grid-cols-3" : "sm:grid-cols-2"}`;

  if (loading) {
    return (
      <div className={grid} aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading funding summary…</span>
        {Array.from({ length: showDiff ? 3 : 2 }).map((_, i) => (
          <SummaryCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  return (
    <div className={grid}>
      <SummaryCard
        title="Highest funding"
        coin={highest?.coin}
        sub={highest ? exchangeName(highest.exchange) : undefined}
        value={highest ? formatRate(highest.rate) : "—"}
        valueClass={highest ? rateColorClass(highest.rate) : "text-muted-foreground"}
        tone="positive"
      />
      <SummaryCard
        title="Lowest funding"
        coin={lowest?.coin}
        sub={lowest ? exchangeName(lowest.exchange) : undefined}
        value={lowest ? formatRate(lowest.rate) : "—"}
        valueClass={lowest ? rateColorClass(lowest.rate) : "text-muted-foreground"}
        tone="negative"
      />
      {showDiff && (
        <SummaryCard
          title="Best Diff FR"
          coin={bestDiff?.coin}
          sub={bestDiff?.direction
            ? `Long ${exchangeName(bestDiff.direction.longExchange)} · Short ${exchangeName(bestDiff.direction.shortExchange)}`
            : "normalized opportunity"}
          value={bestDiff ? formatRate(bestDiff.diff) : "—"}
          valueClass="text-info"
          tone="neutral"
        />
      )}
    </div>
  );
}

/** Mirrors SummaryCard's shape so the layout does not jump when data lands. */
function SummaryCardSkeleton() {
  return (
    <Card className="border-border bg-card/60">
      <CardContent className="flex flex-col gap-2 p-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-5 w-12 rounded-md" />
        </div>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-3 w-20" />
      </CardContent>
    </Card>
  );
}

interface SummaryCardProps {
  title: string;
  coin?: string;
  sub?: string;
  value: string;
  valueClass: string;
  tone: "positive" | "negative" | "neutral";
}

function SummaryCard({ title, coin, sub, value, valueClass, tone }: SummaryCardProps) {
  const ring =
    tone === "positive"
      ? "border-positive/20"
      : tone === "negative"
        ? "border-negative/20"
        : "border-info/20";
  return (
    <Card className={`${ring} bg-card/60`}>
      <CardContent className="flex flex-col gap-1 p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">{title}</span>
          {coin && <Badge variant="secondary" className="font-mono">{coin}</Badge>}
        </div>
        <span className={`font-mono text-2xl font-semibold num ${valueClass}`}>{value}</span>
        {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      </CardContent>
    </Card>
  );
}
