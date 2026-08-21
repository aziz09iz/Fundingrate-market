"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Alert } from "@/components/ui/alert";
import type { ExchangeId, ExecutionMode, StrategyConfig } from "@/lib/types";
import { EXCHANGES, cn, exchangeInfo, exchangeName } from "@/lib/utils";
import { Loader2, Save, Timer, Zap } from "lucide-react";

interface FundingSyncConfigProps {
  config: StrategyConfig;
  onChange: (config: StrategyConfig) => void;
  saving?: boolean;
  error?: string | null;
  onSave: () => void;
}

export function FundingSyncConfig({
  config,
  onChange,
  saving = false,
  error,
  onSave,
}: FundingSyncConfigProps) {
  const patch = (next: Partial<StrategyConfig>) => onChange({ ...config, ...next });

  const toggleVenue = (exchange: ExchangeId) => {
    const next = config.venues.includes(exchange)
      ? config.venues.filter((v) => v !== exchange)
      : [...config.venues, exchange];
    patch({ venues: next });
  };

  const notional = config.marginPerLeg * config.leverage;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_18rem]">
      <div className="flex flex-col gap-4">
        {/* Venues */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Venues</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
              {EXCHANGES.map((ex) => {
                const on = config.venues.includes(ex.id);
                return (
                  <Button
                    key={ex.id}
                    variant={on ? "outline" : "secondary"}
                    size="sm"
                    className={cn(
                      "h-7 gap-1.5 px-2.5 text-xs",
                      on ? exchangeInfo(ex.id).accent : "text-muted-foreground opacity-60",
                    )}
                    onClick={() => toggleVenue(ex.id)}
                    aria-pressed={on}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        on ? "bg-current" : "bg-muted-foreground",
                      )}
                    />
                    {exchangeName(ex.id)}
                  </Button>
                );
              })}
            </div>
            <p className="text-[10px] text-muted-foreground">
              Direction and funding difference are recomputed across only these venues, so a pair the
              strategy cannot trade is never picked. At least two are required.
            </p>
            {config.venues.length < 2 && (
              <Alert variant="error" className="text-[10px]">
                Pick at least two venues — a hedge needs both sides.
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Sizing */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Sizing</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <NumberField
              label="Max positions"
              value={config.maxPositions}
              min={1}
              max={20}
              step={1}
              hint="Hedges held at once."
              onChange={(v) => patch({ maxPositions: v })}
            />
            <NumberField
              label="Margin per leg (USD)"
              value={config.marginPerLeg}
              min={1}
              step={10}
              hint="Collateral committed to each side."
              onChange={(v) => patch({ marginPerLeg: v })}
            />
            <NumberField
              label="Leverage"
              value={config.leverage}
              min={1}
              max={25}
              step={1}
              hint={`Notional per leg: $${notional.toLocaleString()}.`}
              onChange={(v) => patch({ leverage: v })}
            />
            <p className="text-[10px] text-muted-foreground sm:col-span-3">
              One hedge uses ${(config.marginPerLeg * 2).toLocaleString()} of margin and carries $
              {(notional * 2).toLocaleString()} of exposure across two venues. At {config.maxPositions}{" "}
              positions that is ${(config.marginPerLeg * 2 * config.maxPositions).toLocaleString()} committed.
            </p>
          </CardContent>
        </Card>

        {/* Entry */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Entry</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Order type</Label>
              <div className="flex gap-1">
                {(["delay", "instant"] as ExecutionMode[]).map((mode) => (
                  <Button
                    key={mode}
                    variant={config.entryMode === mode ? "secondary" : "outline"}
                    size="sm"
                    className="h-8 flex-1 gap-1.5 text-xs capitalize"
                    onClick={() => patch({ entryMode: mode })}
                    aria-pressed={config.entryMode === mode}
                  >
                    {mode === "delay" ? (
                      <Timer aria-hidden className="size-3" />
                    ) : (
                      <Zap aria-hidden className="size-3" />
                    )}
                    {mode}
                  </Button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">
                {config.entryMode === "delay"
                  ? "Waits for the spread to reach the floor below, then sends both legs."
                  : "Sends as soon as a candidate is in the window and the spread clears the floor below."}{" "}
                Both modes refuse an entry spread under the floor; the mode only changes how the exit
                is decided.
              </p>
            </div>

            <Separator />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <NumberField
                label="Entry window (minutes)"
                value={config.entryWindowMin}
                min={1}
                max={240}
                step={5}
                hint="Only enter this close to the settlement being harvested."
                onChange={(v) => patch({ entryWindowMin: v })}
              />
              <NumberField
                label="Min funding difference (%)"
                value={config.minDiffFr}
                min={0.001}
                step={0.01}
                hint="Below this a coin is not a candidate at all."
                onChange={(v) => patch({ minDiffFr: v })}
              />
              <NumberField
                label="Min entry spread (%)"
                value={config.minEntrySpread}
                min={-5}
                step={0.01}
                hint="Short venue's bid minus long venue's ask. Positive means the hedge opens in credit; a negative entry is a loss that convergence realises rather than recovers."
                onChange={(v) => patch({ minEntrySpread: v })}
              />
              <NumberField
                label="Cancel below difference (%)"
                value={config.cancelDiffFr}
                min={0}
                step={0.01}
                hint="Abandon a queued entry if the edge decays this far. Must be under the minimum."
                onChange={(v) => patch({ cancelDiffFr: v })}
              />
            </div>
            {config.cancelDiffFr >= config.minDiffFr && (
              <Alert variant="error" className="text-[10px]">
                Cancel threshold must be below the minimum difference, or every queued entry cancels
                immediately.
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Exit */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Exit</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <label className="flex items-start justify-between gap-3 rounded-md bg-muted/30 px-2.5 py-2">
              <span className="flex flex-col gap-0.5">
                <span className="text-xs">Act on the funding payment</span>
                <span className="text-[10px] text-muted-foreground">
                  Off means the position ignores its settlement entirely and only leaves on the spread
                  or difference rules — risky for legs on different intervals, since the
                  shorter-interval leg keeps paying.
                </span>
              </span>
              <Switch
                checked={config.exitAfterFunding}
                onCheckedChange={(v) => patch({ exitAfterFunding: v })}
                aria-label="Act on the funding payment"
              />
            </label>

            <label
              className={cn(
                "flex items-start justify-between gap-3 rounded-md px-2.5 py-2",
                config.exitAfterFunding ? "bg-muted/30" : "bg-muted/10 opacity-50",
              )}
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-xs">Hold for a better spread after the payment</span>
                <span className="text-[10px] text-muted-foreground">
                  The payment is already banked when the settlement passes, so closing at that exact
                  second means taking whatever spread happens to exist — which regularly turned a
                  collected payment into a net loss. With this on the position waits for the profit
                  target instead, and closes at the next settlement if it never arrives. Both sources
                  then pay: the funding and the spread.
                </span>
              </span>
              <Switch
                checked={config.holdForSpreadAfterFunding}
                onCheckedChange={(v) => patch({ holdForSpreadAfterFunding: v })}
                disabled={!config.exitAfterFunding}
                aria-label="Hold for a better spread after funding"
              />
            </label>

            <label className="flex items-start justify-between gap-3 rounded-md bg-muted/30 px-2.5 py-2">
              <span className="flex flex-col gap-0.5">
                <span className="text-xs">Hold for a fee-covering spread when the edge decays</span>
                <span className="text-[10px] text-muted-foreground">
                  Same problem, different trigger: closing the moment the difference slips under the
                  threshold means accepting that second&apos;s spread. With this on the position starts
                  leaving but waits until the spread at least covers fees. The bar is break-even, not
                  the profit target — with no edge left, holding out for profit is a directional bet.
                  Closes at the settlement either way.
                </span>
              </span>
              <Switch
                checked={config.holdForSpreadAfterDecay}
                onCheckedChange={(v) => patch({ holdForSpreadAfterDecay: v })}
                aria-label="Hold for a fee-covering spread after decay"
              />
            </label>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <NumberField
                label="Exit at difference (%)"
                value={config.exitDiffFr}
                min={0}
                step={0.01}
                hint="Close once the edge has decayed to this. Must be under the minimum."
                onChange={(v) => patch({ exitDiffFr: v })}
              />
              <NumberField
                label="Profit target (%)"
                value={config.minProfitSpread}
                min={0.001}
                step={0.05}
                hint="Instant exit: profit kept after fees. The round trip's four taker fees are added on top of this, so 0.2 means 0.2% actually earned."
                onChange={(v) => patch({ minProfitSpread: v })}
              />
              <NumberField
                label="Max exit spread (%)"
                value={config.maxExitSpread}
                min={0.001}
                step={0.01}
                hint="Delay exit waits until |exit spread| is at or below this. The exit spread uses the other side of both books, which is what the unwind actually trades."
                onChange={(v) => patch({ maxExitSpread: v })}
              />
            </div>
            {config.exitDiffFr >= config.minDiffFr && (
              <Alert variant="error" className="text-[10px]">
                Exit threshold must be below the minimum difference, or a position closes the moment
                it opens.
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Summary */}
      <Card className="flex flex-col">
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Summary</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-3 text-xs">
          <Row label="Venues" value={String(config.venues.length)} />
          <Row label="Max positions" value={String(config.maxPositions)} />
          <Row label="Notional / leg" value={`$${notional.toLocaleString()}`} />
          <Row label="Entry" value={`${config.entryMode}, ≤${config.entryWindowMin}m`} />
          <Row label="Min difference" value={`${config.minDiffFr}%`} />
          <Row
            label="Min entry spread"
            value={`${config.minEntrySpread}%`}
            valueClass={config.minEntrySpread < 0 ? "text-warning" : "text-positive"}
          />
          <Row
            label="Exit at"
            value={`${config.exitDiffFr}%${config.holdForSpreadAfterDecay ? " then wait" : ""}`}
            valueClass={config.holdForSpreadAfterDecay ? "text-positive" : undefined}
          />
          <Row
            label="After funding"
            value={
              !config.exitAfterFunding
                ? "ignore"
                : config.holdForSpreadAfterFunding
                  ? "hold for spread"
                  : "close at once"
            }
            valueClass={
              !config.exitAfterFunding
                ? "text-warning"
                : config.holdForSpreadAfterFunding
                  ? "text-positive"
                  : "text-info"
            }
          />

          {error && (
            <Alert variant="error" className="text-[10px]">
              {error}
            </Alert>
          )}

          <div className="mt-auto">
            <Button size="sm" className="w-full gap-1.5 text-xs" onClick={onSave} disabled={saving}>
              {saving ? (
                <Loader2 aria-hidden className="size-3 animate-spin" />
              ) : (
                <Save aria-hidden className="size-3" />
              )}
              Save configuration
            </Button>
            <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
              Saved on the server per account, so the engine keeps these values with no tab open.
              Live and paper are configured separately.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const next = Number(e.target.value);
          // An empty field yields NaN; keeping the previous value avoids writing
          // a broken config while the user is mid-edit.
          if (Number.isFinite(next)) onChange(next);
        }}
        className="font-mono text-xs"
      />
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Row({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-mono", valueClass)}>{value}</span>
    </div>
  );
}
