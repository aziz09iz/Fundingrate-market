"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Alert } from "@/components/ui/alert";
import type { ExchangeId, FundingBridgeConfig } from "@/lib/types";
import { EXCHANGES, cn, exchangeInfo, exchangeName } from "@/lib/utils";
import { Loader2, Save } from "lucide-react";

interface FundingBridgeConfigProps {
  config: FundingBridgeConfig;
  onChange: (config: FundingBridgeConfig) => void;
  saving?: boolean;
  error?: string | null;
  /** Round trip taker fees for the selected venues, so the targets can be judged. */
  feeCostPct: number;
  onSave: () => void;
}

/**
 * FundingBridge configuration, grouped the way the strategy actually decides: what to
 * lock, when to enter, and then two separate exits — because a pair whose legs settle
 * together and a pair whose legs do not are different problems, and one set of
 * thresholds cannot serve both.
 */
export function FundingBridgeConfigForm({
  config,
  onChange,
  saving = false,
  error,
  feeCostPct,
  onSave,
}: FundingBridgeConfigProps) {
  const patch = (next: Partial<FundingBridgeConfig>) => onChange({ ...config, ...next });

  const toggleVenue = (exchange: ExchangeId) => {
    const next = config.venues.includes(exchange)
      ? config.venues.filter((v) => v !== exchange)
      : [...config.venues, exchange];
    patch({ venues: next });
  };

  const notional = config.marginPerLeg * config.leverage;
  const cancelTooHigh = config.cancelDiffFr >= config.minDiffFr;
  const exitTooHigh = config.exitDiffFr >= config.minDiffFr;
  const holdTooShort = config.maxHoldMin <= config.settleGraceMin;
  const negativeEntry = config.entrySpread < 0;

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
              The funding difference is recomputed across only these venues, so a pair the strategy
              cannot trade is never locked. At least two are required.
            </p>
            {config.venues.length < 2 && (
              <Alert variant="error" className="text-[10px]">
                Two venues minimum — a hedge needs a side to buy and a side to sell.
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Size */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Size</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <NumberField
                label="Max positions"
                value={config.maxPositions}
                min={1}
                max={20}
                step={1}
                hint="Locked targets and open hedges together."
                onChange={(v) => patch({ maxPositions: v })}
              />
              <NumberField
                label="Margin per leg ($)"
                value={config.marginPerLeg}
                min={1}
                step={10}
                hint="Committed on each side."
                onChange={(v) => patch({ marginPerLeg: v })}
              />
              <NumberField
                label="Leverage"
                value={config.leverage}
                min={1}
                max={25}
                step={1}
                hint="Multiplies the notional traded."
                onChange={(v) => patch({ leverage: v })}
              />
            </div>
            <p className="text-[10px] text-muted-foreground">
              ${config.marginPerLeg.toLocaleString()} × {config.leverage} = $
              {notional.toLocaleString()} per leg, so ${(notional * 2).toLocaleString()} of exposure
              across two venues. A locked target counts against the limit before anything is sent,
              so at {config.maxPositions} the most committed is $
              {(config.marginPerLeg * 2 * config.maxPositions).toLocaleString()}.
            </p>
          </CardContent>
        </Card>

        {/* Lock */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Locking a target</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <NumberField
                label="Lock window (minutes)"
                value={config.entryWindowMin}
                min={1}
                max={240}
                step={5}
                hint="Only lock this close to the settlement being collected. The clock is the leg paying the larger rate."
                onChange={(v) => patch({ entryWindowMin: v })}
              />
              <NumberField
                label="Min funding difference (%)"
                value={config.minDiffFr}
                min={0.001}
                step={0.01}
                hint="Below this a coin is not a target at all. Price is not consulted when locking."
                onChange={(v) => patch({ minDiffFr: v })}
              />
              <NumberField
                label="Drop below difference (%)"
                value={config.cancelDiffFr}
                min={0}
                step={0.01}
                hint="Release a locked target if the edge collapses this far while waiting for a cheap entry."
                onChange={(v) => patch({ cancelDiffFr: v })}
              />
            </div>
            {cancelTooHigh && (
              <Alert variant="error" className="text-[10px]">
                The drop threshold must be below the minimum difference, or a target is released on
                the cycle after it is locked.
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Entry */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Entering</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <NumberField
              label="Enter at entry spread (%)"
              value={config.entrySpread}
              min={-5}
              step={0.01}
              hint="Short venue's bid minus long venue's ask. Positive means the hedge opens in credit. Both legs go at market the moment this is reached."
              onChange={(v) => patch({ entrySpread: v })}
            />
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              This is the release condition, not a filter: a target that does not meet it sits and
              waits rather than being discarded, until either the spread arrives or the settlement
              passes.
            </p>
            {negativeEntry && (
              <Alert variant="warning" className="text-[10px]">
                A negative entry spread is a loss booked the moment the hedge opens, and prices
                converging toward zero realises it rather than recovering it. Only worth it when the
                funding difference is large enough to pay for it.
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Exit: same cadence */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Exit — legs on the same cadence</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Both legs settle together, so funding is paid and received on one clock and holding on
              costs nothing beyond price risk. The position is left alone until the edge is gone —
              decayed past the threshold, or reversed outright — and only then does price decide.
              The wait ends at the next settlement either way.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <NumberField
                label="Edge gone at difference (%)"
                value={config.exitDiffFr}
                min={0}
                step={0.01}
                hint="Start leaving once the difference has decayed to this. Must be under the minimum."
                onChange={(v) => patch({ exitDiffFr: v })}
              />
              <NumberField
                label="Profit target (%)"
                value={config.minProfitSpread}
                min={0.001}
                step={0.05}
                hint={`How much of the entry spread must come back, after fees. The round trip costs about ${feeCostPct.toFixed(3)}% and is added on top, so this is what you keep.`}
                onChange={(v) => patch({ minProfitSpread: v })}
              />
            </div>
            {exitTooHigh && (
              <Alert variant="error" className="text-[10px]">
                The exit threshold must be below the minimum difference, or a position starts leaving
                the moment it opens.
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Exit: different cadence */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Exit — legs on different cadences</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Here there is no shared deadline: the faster leg keeps paying funding while the slower
              one has not settled, so waiting has a running cost. Once the awaited settlement has
              passed the position closes as soon as exiting would realise a profit — price movement
              plus funding collected, minus the round trip&apos;s fees. The hold limit closes it
              regardless, which is the only thing standing between a position that never turns
              profitable and an open-ended loss.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <NumberField
                label="Settlement grace (minutes)"
                value={config.settleGraceMin}
                min={0}
                max={60}
                step={1}
                hint="Wait this long after the settlement before judging the exit — the venue credits the payment on its own schedule."
                onChange={(v) => patch({ settleGraceMin: v })}
              />
              <NumberField
                label="Max hold (minutes)"
                value={config.maxHoldMin}
                min={5}
                max={1440}
                step={15}
                hint="Close regardless of profit after this long. Protects against the faster leg paying funding indefinitely."
                onChange={(v) => patch({ maxHoldMin: v })}
              />
            </div>
            {holdTooShort && (
              <Alert variant="error" className="text-[10px]">
                Max hold must exceed the grace period, or the limit fires before the payment has had
                time to land.
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
          <Separator />
          <Row label="Lock at diff" value={`≥ ${config.minDiffFr}%`} />
          <Row label="Lock window" value={`≤ ${config.entryWindowMin}m`} />
          <Row
            label="Enter at spread"
            value={`≥ ${config.entrySpread}%`}
            valueClass={negativeEntry ? "text-warning" : "text-positive"}
          />
          <Row
            label="Drop target below"
            value={`${config.cancelDiffFr}%`}
            valueClass={cancelTooHigh ? "text-negative" : undefined}
          />
          <Separator />
          <Row label="Same cadence" value={`${config.exitDiffFr}% then wait`} />
          <Row label="Profit target" value={`${config.minProfitSpread}% net`} />
          <Row label="Different cadence" value={`PnL > 0, ≤ ${config.maxHoldMin}m`} />
          <Row label="Round trip fees" value={`${feeCostPct.toFixed(3)}%`} />
          <Separator />
          <Row
            label="Per closed trade"
            value={`≈ $${((config.minProfitSpread / 100) * notional).toFixed(2)}`}
            valueClass="text-positive"
          />
          <p className="text-[10px] leading-snug text-muted-foreground">
            That figure is the spread half of the profit only. The funding difference is collected
            on top of it as each settlement passes, which is the reason this strategy waits for one.
          </p>

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
          // An empty field yields NaN; keeping the previous value avoids writing a
          // broken config while the user is mid-edit.
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
