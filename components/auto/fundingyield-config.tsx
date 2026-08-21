"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Alert } from "@/components/ui/alert";
import type { ExchangeId, FundingYieldConfig } from "@/lib/types";
import { EXCHANGES, cn, exchangeInfo, exchangeName } from "@/lib/utils";
import { Loader2, Save } from "lucide-react";

interface FundingYieldConfigProps {
  config: FundingYieldConfig;
  onChange: (config: FundingYieldConfig) => void;
  saving?: boolean;
  error?: string | null;
  /** Round trip taker fees for the selected venues, which every figure here is measured against. */
  feeCostPct: number;
  onSave: () => void;
}

/**
 * FundingYield configuration.
 *
 * The summary panel does the real work here. Every other strategy's settings can be read
 * one at a time; this one's only make sense together, because the entry test is a single
 * sum of three numbers with different units. So the panel shows that sum worked through
 * — gross funding, minus fees, at the configured size — and says how many settlements it
 * takes before the position is ahead.
 */
export function FundingYieldConfigForm({
  config,
  onChange,
  saving = false,
  error,
  feeCostPct,
  onSave,
}: FundingYieldConfigProps) {
  const patch = (next: Partial<FundingYieldConfig>) => onChange({ ...config, ...next });

  const toggleVenue = (exchange: ExchangeId) => {
    const next = config.venues.includes(exchange)
      ? config.venues.filter((v) => v !== exchange)
      : [...config.venues, exchange];
    patch({ venues: next });
  };

  const notional = config.marginPerLeg * config.leverage;
  const feeUsd = (feeCostPct / 100) * notional;
  const perSettlementUsd = (config.minDiffFr / 100) * notional;
  const grossUsd = perSettlementUsd * config.targetSettlements;
  const netUsd = grossUsd - feeUsd;
  // How many payments at the minimum difference it takes to cover the round trip. The
  // number this strategy exists to make small.
  const breakEvenSettlements =
    perSettlementUsd > 0 ? Math.ceil(feeUsd / perSettlementUsd) : Number.POSITIVE_INFINITY;
  const targetUsd = feeUsd * config.profitTargetMultiple;

  const targetTooShort =
    Number.isFinite(breakEvenSettlements) && config.targetSettlements < breakEvenSettlements;
  const yieldUnreachable = config.minNetYieldUsd >= grossUsd;
  const stopTooTight = config.stopLossUsd < feeUsd;

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
                    {exchangeName(ex.id)}
                  </Button>
                );
              })}
            </div>
            <p className="text-[10px] text-muted-foreground">
              Fees dominate every figure on this page, so the venue set matters more here than for
              the other strategies: the worst pair among these decides the round trip cost the
              entry test has to clear.
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
                hint="Hedges held at once."
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
                hint="Multiplies the notional, and with it the funding earned."
                onChange={(v) => patch({ leverage: v })}
              />
            </div>
            <p className="text-[10px] text-muted-foreground">
              ${config.marginPerLeg.toLocaleString()} × {config.leverage} = $
              {notional.toLocaleString()} per leg. Funding is earned on the notional, and so are the
              fees — raising leverage scales both, so it does not change how many settlements it
              takes to break even.
            </p>
          </CardContent>
        </Card>

        {/* Entry */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Entry</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <NumberField
                label="Min funding difference (%)"
                value={config.minDiffFr}
                min={0.001}
                step={0.01}
                hint="Lower than the other funding strategies use, because this one amortises the fees over several payments instead of needing one to cover them."
                onChange={(v) => patch({ minDiffFr: v })}
              />
              <NumberField
                label="Target settlements"
                value={config.targetSettlements}
                min={1}
                max={30}
                step={1}
                hint="How many payments the projection assumes. A target, not a deadline — the exit fires on collected funding."
                onChange={(v) => patch({ targetSettlements: v })}
              />
              <NumberField
                label="Min net yield ($)"
                value={config.minNetYieldUsd}
                min={0}
                step={0.25}
                hint="Projected funding minus fees minus the round trip's spread cost, in dollars."
                onChange={(v) => patch({ minNetYieldUsd: v })}
              />
              <NumberField
                label="Max round trip spread (%)"
                value={config.maxSpreadCostPct}
                min={0.01}
                step={0.05}
                hint="Ceiling on both venues' bid-ask widths combined. A wide book is a liquidity warning, not just an expense."
                onChange={(v) => patch({ maxSpreadCostPct: v })}
              />
            </div>

            <Separator />

            <p className="text-[10px] leading-relaxed text-muted-foreground">
              There is no entry spread floor here, and that is the deliberate difference from
              FundingSync and FundingBridge. Both of those require the entry to open in credit, which
              rejects the widest funding differences on the board — a wide difference exists
              <em> because</em> the two venues disagree about price. This strategy prices that
              disagreement instead: what a round trip costs is the entry spread minus the exit
              spread, and only that number is capped.
            </p>

            {targetTooShort && (
              <Alert variant="warning" className="text-[10px]">
                At a {config.minDiffFr}% difference it takes {breakEvenSettlements} settlements to
                cover ${feeUsd.toFixed(2)} in fees, but the target is {config.targetSettlements}.
                Entries will be projected to lose money and the net-yield floor will block them all.
              </Alert>
            )}
            {yieldUnreachable && (
              <Alert variant="error" className="text-[10px]">
                A ${config.minNetYieldUsd} floor is unreachable: {config.targetSettlements}{" "}
                settlements at {config.minDiffFr}% is only ${grossUsd.toFixed(2)} gross, before the $
                {feeUsd.toFixed(2)} in fees. Lower the floor, or raise the difference or the
                settlement target.
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Exit and risk */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Exit &amp; Risk</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <NumberField
                label="Profit target (× fees)"
                value={config.profitTargetMultiple}
                min={1}
                max={20}
                step={0.1}
                hint={`Close once collected funding reaches this multiple of the $${feeUsd.toFixed(2)} round trip.`}
                onChange={(v) => patch({ profitTargetMultiple: v })}
              />
              <NumberField
                label="Stop-loss ($)"
                value={config.stopLossUsd}
                min={0.5}
                step={1}
                hint="Closes when price against the hedge, net of funding already collected, reaches this loss."
                onChange={(v) => patch({ stopLossUsd: v })}
              />
              <NumberField
                label="Max hold (hours)"
                value={config.maxHoldHours}
                min={0}
                max={720}
                step={1}
                hint="Backstop for a position going nowhere. Zero disables it."
                onChange={(v) => patch({ maxHoldHours: v })}
              />
            </div>

            <label className="flex items-center justify-between rounded-md bg-muted/30 px-2.5 py-2">
              <span className="flex flex-col gap-0.5">
                <span className="text-xs">Close when funding reverses</span>
                <span className="text-[10px] text-muted-foreground">
                  The venue that was paying is now being paid, so the reason to hold is gone. Leaving
                  this off means waiting for the stop-loss instead.
                </span>
              </span>
              <Switch
                checked={config.exitOnReversal}
                onCheckedChange={(v) => patch({ exitOnReversal: v })}
                aria-label="Close when funding reverses"
              />
            </label>

            <Separator />

            <p className="text-[10px] leading-relaxed text-muted-foreground">
              This is the only strategy here with a stop-loss, and it needs one. The other three are
              bounded by something else — FundingSync by its settlement and the one after,
              FundingBridge by the next settlement or its hold limit, PerpBridge by nothing at all.
              This one holds for days on purpose, so an unbounded loss has time to become a large
              one.
            </p>

            {stopTooTight && (
              <Alert variant="warning" className="text-[10px]">
                A ${config.stopLossUsd} stop is tighter than the ${feeUsd.toFixed(2)} round trip
                itself. Positions will stop out on ordinary spread noise before any funding has been
                collected, paying the fees each time.
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Summary: the entry sum, worked through */}
      <Card className="flex flex-col">
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Summary</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-3 text-xs">
          <Row label="Venues" value={String(config.venues.length)} />
          <Row label="Notional / leg" value={`$${notional.toLocaleString()}`} />
          <Row label="Round trip fees" value={`$${feeUsd.toFixed(2)}`} valueClass="text-negative" />
          <Separator />
          <Row
            label={`Funding × ${config.targetSettlements}`}
            value={`+$${grossUsd.toFixed(2)}`}
            valueClass="text-positive"
          />
          <Row label="Less fees" value={`−$${feeUsd.toFixed(2)}`} valueClass="text-negative" />
          <Row
            label="Projected net"
            value={`${netUsd >= 0 ? "+" : "−"}$${Math.abs(netUsd).toFixed(2)}`}
            valueClass={netUsd >= 0 ? "text-positive" : "text-negative"}
          />
          <Separator />
          <Row
            label="Break even at"
            value={
              Number.isFinite(breakEvenSettlements)
                ? `${breakEvenSettlements} settlement${breakEvenSettlements === 1 ? "" : "s"}`
                : "—"
            }
            valueClass={targetTooShort ? "text-negative" : undefined}
          />
          <Row label="Exit at funding" value={`$${targetUsd.toFixed(2)}`} valueClass="text-positive" />
          <Row
            label="Stop-loss"
            value={`−$${config.stopLossUsd.toFixed(2)}`}
            valueClass="text-negative"
          />
          <p className="text-[10px] leading-snug text-muted-foreground">
            The projected net excludes the round trip&apos;s spread cost, which is measured per coin
            at entry rather than configured — the {config.maxSpreadCostPct}% ceiling is what bounds
            it. Nothing here accounts for price moving against the hedge, which is what the stop-loss
            is for.
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
              Saved on the server per deployment, so the engine keeps these values with no tab open.
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
        className="font-mono text-xs num"
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
      <span className={cn("font-mono num", valueClass)}>{value}</span>
    </div>
  );
}
