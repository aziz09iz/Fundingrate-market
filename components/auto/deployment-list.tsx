"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Alert } from "@/components/ui/alert";
import type { ExposureState, StrategyListItem } from "@/lib/types";
import { cn, exchangeName, signClass } from "@/lib/utils";
import { Bot, ChevronRight, Coins, PiggyBank, Plus, Timer, TrendingUp } from "lucide-react";
import { fmtPnl, RunBadge } from "@/components/auto/strategy-bits";

interface DeploymentListProps {
  items: StrategyListItem[];
  exposure: ExposureState | null;
  busy?: string | null;
  onOpen: (deploymentId: string) => void;
  onToggle: (deploymentId: string, enabled: boolean) => void;
  onDeploy: () => void;
}

const ICON = {
  fundingsync: Coins,
  perpbridge: TrendingUp,
  fundingbridge: Timer,
  fundingyield: PiggyBank,
} as const;

function usd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/**
 * The deployment list: one row per running deployment.
 *
 * A strategy can appear several times, which is the point — each row is a separate
 * configuration with its own venues and thresholds. The label is what distinguishes
 * them, so it leads and the strategy name is secondary.
 *
 * The switch sits inside a clickable row, so its handlers stop propagation —
 * otherwise flipping it would also navigate into the detail view.
 */
export function DeploymentList({
  items,
  exposure,
  busy = null,
  onOpen,
  onToggle,
  onDeploy,
}: DeploymentListProps) {
  const running = items.filter((i) => i.run.active).length;
  const ceilingHit =
    exposure !== null &&
    exposure.maxNotional > 0 &&
    exposure.committedNotional >= exposure.maxNotional;

  return (
    <div className="flex flex-col gap-4">
      {exposure && (
        <Card className="bg-card/60">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Account exposure
              </span>
              <span className="font-mono text-sm">
                {usd(exposure.committedNotional)}
                {exposure.maxNotional > 0 ? (
                  <span className={cn("text-muted-foreground", ceilingHit && "text-negative")}>
                    {" "}
                    / {usd(exposure.maxNotional)}
                  </span>
                ) : (
                  <span className="text-muted-foreground"> · no ceiling set</span>
                )}
              </span>
            </div>
            <div className="flex items-center gap-5">
              <Metric label="Open" value={String(exposure.openPositions)} />
              <Metric
                label="Deployments on"
                value={`${exposure.activeDeployments}/${items.length}`}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {ceilingHit && (
        <Alert variant="warning">
          The account is at its notional ceiling, so no deployment will open anything new until
          something closes. Raise the limit under General Setting if that is not what you want.
        </Alert>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Deployments</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-[10px]">
              {running} of {items.length} running
            </Badge>
            <Button size="sm" className="h-7 gap-1.5 text-xs" onClick={onDeploy}>
              <Plus aria-hidden className="size-3" />
              Deploy strategy
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 p-3 pt-0">
          {items.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              Nothing deployed yet. Deploy a strategy to configure and run it — you can run several
              of the same one on different venues.
            </p>
          )}

          {items.map((item) => {
            const Icon = ICON[item.strategy] ?? Bot;
            return (
              <div
                key={item.deploymentId}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(item.deploymentId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(item.deploymentId);
                  }
                }}
                className={cn(
                  "flex cursor-pointer flex-col gap-3 rounded-md border px-3 py-3 transition-colors",
                  "hover:border-primary/40 hover:bg-secondary/40",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  item.run.active ? "border-positive/30 bg-positive/[0.03]" : "border-border",
                  "sm:flex-row sm:items-center",
                )}
              >
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  <Icon
                    aria-hidden
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      item.run.active ? "text-positive" : "text-muted-foreground",
                    )}
                  />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {item.label}
                      <Badge variant="secondary" className="text-[9px]">
                        {item.strategyName}
                      </Badge>
                      <RunBadge run={item.run} />
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {item.venues.length > 0
                        ? item.venues.map((v) => exchangeName(v)).join(" · ")
                        : item.tagline}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-4 sm:gap-5">
                  <Metric label="Open" value={`${item.openPositions}/${item.maxPositions}`} />
                  <Metric label="Ready" value={String(item.actionable)} />
                  <Metric
                    label="Realized"
                    value={fmtPnl(item.realizedPnl)}
                    valueClass={signClass(item.realizedPnl)}
                  />
                  <Metric label="Per leg" value={`$${item.notionalPerLeg.toLocaleString()}`} />

                  <div
                    // The row is a button; the switch must not trigger it.
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <Switch
                      checked={item.run.enabled}
                      onCheckedChange={(v) => onToggle(item.deploymentId, v)}
                      disabled={busy === item.deploymentId}
                      aria-label={`Enable ${item.label}`}
                    />
                  </div>
                  <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                </div>
              </div>
            );
          })}

          <p className="px-1 pt-1 text-[10px] leading-snug text-muted-foreground">
            Deployments share the account and compete for venue legs: an exchange holds one position
            per coin and side, so whichever deployment claims a leg first keeps it until that hedge
            closes. Two deployments can hold the same coin on different venues.
          </p>
        </CardContent>
      </Card>
    </div>
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
    <div className="flex flex-col items-end gap-0.5">
      <span className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-xs num", valueClass)}>{value}</span>
    </div>
  );
}
