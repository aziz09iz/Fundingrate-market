"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Alert } from "@/components/ui/alert";
import type { StrategyPositionStatus, StrategyRunState } from "@/lib/types";
import { cn, formatSignedUsd } from "@/lib/utils";
import { Bot, Loader2, Lock, Play, TriangleAlert } from "lucide-react";

/**
 * Pieces both strategy monitors share.
 *
 * Extracted rather than duplicated because the arm banner and the master switch
 * carry safety meaning: if one copy drifted, a live account could show "running"
 * while the other showed the truth.
 */

export const STATUS_CLASS: Record<StrategyPositionStatus, string> = {
  queued: "text-warning",
  opening: "text-info",
  open: "text-positive",
  closing: "text-info",
  closed: "text-muted-foreground",
  cancelled: "text-muted-foreground",
  failed: "text-negative",
};

export function fmtPnl(n: number | null | undefined): string {
  return formatSignedUsd(n ?? null, 2);
}

export function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="bg-card/60">
      <CardContent className="flex flex-col gap-1 p-3">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="font-mono text-sm font-semibold num">{value}</span>
      </CardContent>
    </Card>
  );
}

/**
 * The environment lock, which the UI cannot open. Shown on live only, because
 * paper never needs it.
 */
export function ArmNotice({ armed }: { armed: boolean }) {
  return (
    // The icon is supplied here rather than by the variant: a padlock says "you
    // cannot change this from the UI", which is the whole point of the unarmed
    // state and is not something the generic info glyph conveys.
    <Alert variant={armed ? "error" : "neutral"} hideIcon className="text-[11px]">
      <span className="flex items-start gap-1.5">
        {armed ? (
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        ) : (
          <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        )}
        {armed ? (
          <span>
            <span className="font-medium">AUTO_TRADING is set.</span> With a strategy switched on,
            this server opens and closes real hedged positions on its own.
          </span>
        ) : (
          <span>
            AUTO_TRADING is not set on the server, so no order is sent whatever a switch says. The
            engines still evaluate every cycle and log what they would have done — check those
            decisions first, then set the variable in .env.local and restart to arm it.
          </span>
        )}
      </span>
    </Alert>
  );
}

export function RunBadge({ run }: { run: StrategyRunState }) {
  const isLive = run.accountType === "live";
  return (
    <Badge
      variant="secondary"
      className={cn(
        "text-[10px] uppercase",
        run.active
          ? isLive
            ? "text-negative"
            : "text-positive"
          : run.enabled
            ? "text-warning"
            : "text-muted-foreground",
      )}
    >
      {run.active ? "Running" : run.enabled ? "On, not armed" : "Stopped"}
    </Badge>
  );
}

interface MasterSwitchProps {
  name: string;
  description: string;
  run: StrategyRunState;
  busy?: boolean;
  running?: boolean;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
}

export function MasterSwitch({
  name,
  description,
  run,
  busy = false,
  running = false,
  onToggle,
  onRunNow,
}: MasterSwitchProps) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <Bot aria-hidden className="size-4 text-info" />
            {name}
          </span>
          <span className="text-[11px] text-muted-foreground">{description}</span>
        </div>
        <div className="flex items-center gap-2">
          <RunBadge run={run} />
          <Switch
            checked={run.enabled}
            onCheckedChange={onToggle}
            disabled={busy}
            aria-label={`Enable ${name}`}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={onRunNow}
            // A cycle only acts when the strategy is on, so offering the button
            // while it is off just produces a confusing refusal.
            disabled={running || !run.enabled}
          >
            {running ? (
              <Loader2 aria-hidden className="size-3 animate-spin" />
            ) : (
              <Play aria-hidden className="size-3" />
            )}
            Run now
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function StoppedNotice({ what }: { what: string }) {
  return (
    <Alert variant="neutral" hideIcon className="text-[11px]">
      Stopped. The engine is still {what} below so you can see what it would act on — flip the switch
      above to let it trade.
    </Alert>
  );
}

export function ErrorNotice({ message }: { message: string }) {
  return (
    <Alert variant="error" className="text-[11px]">
      Last cycle error: {message}
    </Alert>
  );
}
