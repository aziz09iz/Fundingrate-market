"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Alert } from "@/components/ui/alert";
import type { ExchangeId, PerpBridgeConfig } from "@/lib/types";
import { EXCHANGES, cn, exchangeInfo, exchangeName } from "@/lib/utils";
import { Loader2, Save } from "lucide-react";

interface PerpBridgeConfigProps {
  config: PerpBridgeConfig;
  onChange: (config: PerpBridgeConfig) => void;
  saving?: boolean;
  error?: string | null;
  /** Round trip taker fees for the selected venues, so the UI can show the floor. */
  feeCostPct: number;
  onSave: () => void;
}

/**
 * PerpBridge configuration: six fields, because the strategy has six decisions.
 *
 * The fee figure is shown next to both spread fields rather than left implicit.
 * For this strategy the gap is the only income, so an entry floor below the fees
 * is not a risky setting — it is a losing one, and the number makes that visible
 * before it is saved.
 */
export function PerpBridgeConfigForm({
  config,
  onChange,
  saving = false,
  error,
  feeCostPct,
  onSave,
}: PerpBridgeConfigProps) {
  const patch = (next: Partial<PerpBridgeConfig>) => onChange({ ...config, ...next });

  const toggleVenue = (exchange: ExchangeId) => {
    const next = config.venues.includes(exchange)
      ? config.venues.filter((v) => v !== exchange)
      : [...config.venues, exchange];
    patch({ venues: next });
  };

  const notional = config.marginPerLeg * config.leverage;
  const entryTooTight = config.minEntrySpread <= feeCostPct;
  const targetTooBig = config.minProfitSpread > config.minEntrySpread;
  const netPerTrade = config.minProfitSpread;

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
              Every pair among these venues is compared, so adding one widens the search rather than
              replacing anything. At least two are required.
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
                hint="Open gaps held at once."
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
              across two venues. At {config.maxPositions} positions that is $
              {(config.marginPerLeg * 2 * config.maxPositions).toLocaleString()} committed.
            </p>
          </CardContent>
        </Card>

        {/* Entry and exit */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Entry &amp; Exit</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <NumberField
                label="Min gap to enter (%)"
                value={config.minEntrySpread}
                min={0.01}
                step={0.05}
                hint={`How far apart the two venues must be before opening. Fees on a round trip are about ${feeCostPct.toFixed(3)}%.`}
                onChange={(v) => patch({ minEntrySpread: v })}
              />
              <NumberField
                label="Profit target (%)"
                value={config.minProfitSpread}
                min={0.01}
                step={0.05}
                hint="How much of the gap must close, after fees. The round trip's fees are added on top, so this is what you keep."
                onChange={(v) => patch({ minProfitSpread: v })}
              />
            </div>

            <Separator />

            <p className="text-[10px] leading-relaxed text-muted-foreground">
              No entry window and no funding clock: a gap is tradable the moment it appears, and the
              position closes when the gap narrows enough — not on a schedule. Orders are sent
              immediately at market on both venues.
            </p>

            {entryTooTight && (
              <Alert variant="error" className="text-[10px]">
                A {config.minEntrySpread}% gap does not cover the {feeCostPct.toFixed(3)}% round trip
                in fees. The gap is this strategy&apos;s only income, so entering here loses money
                even when it works exactly as intended.
              </Alert>
            )}
            {targetTooBig && (
              <Alert variant="error" className="text-[10px]">
                The target cannot exceed the entry gap — profit is measured as how much of that gap
                closes, so {config.minProfitSpread}% out of {config.minEntrySpread}% is unreachable.
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
          <Row
            label="Enter at gap"
            value={`≥ ${config.minEntrySpread}%`}
            valueClass={entryTooTight ? "text-negative" : "text-positive"}
          />
          <Row label="Exit at profit" value={`${config.minProfitSpread}% net`} />
          <Row label="Round trip fees" value={`${feeCostPct.toFixed(3)}%`} />
          <Separator />
          <Row
            label="Per closed trade"
            value={`≈ $${((netPerTrade / 100) * notional).toFixed(2)}`}
            valueClass="text-positive"
          />
          <p className="text-[10px] leading-snug text-muted-foreground">
            The target is net of fees, so a closed position keeps about that much on the notional
            above. Nothing here accounts for a gap that widens instead of closing.
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
