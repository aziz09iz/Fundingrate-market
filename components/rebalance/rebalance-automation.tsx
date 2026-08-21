"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  ExchangeBalance,
  ExchangeId,
  NetworkId,
  RebalanceAutomationStatus,
  RebalanceConfig,
  RebalanceSuggestion,
} from "@/lib/types";
import { cn, exchangeInfo, exchangeName, formatAgo } from "@/lib/utils";
import { NETWORK_LABELS, TRANSFER_TOKENS } from "@/lib/rebalance/chains";
import { actionableSuggestions } from "@/lib/rebalance/engine";
import { ArrowRight, Bot, Loader2, ShieldCheck } from "lucide-react";

interface RebalanceAutomationProps {
  config: RebalanceConfig;
  onChange: (config: RebalanceConfig) => void;
  /** Suggestions the current config would act on right now. */
  suggestions: RebalanceSuggestion[];
  /** Balances, so the preview can apply the same guard rails as the server. */
  balances: ExchangeBalance[];
  /** Server-side automation state, including whether the env arm is set. */
  automation: RebalanceAutomationStatus;
  /** Venues funds can be sent from: credentials, wallet reads and signing. */
  sourceVenues: ExchangeId[];
  /** Venues funds can be sent to: an armed destination address exists. */
  destinationVenues: ExchangeId[];
  saving?: boolean;
  evaluating?: boolean;
  onSave: () => void;
  onEvaluate: () => void;
}

export function RebalanceAutomation({
  config,
  onChange,
  suggestions,
  balances,
  automation,
  sourceVenues,
  destinationVenues,
  saving = false,
  evaluating = false,
  onSave,
  onEvaluate,
}: RebalanceAutomationProps) {
  const patch = (next: Partial<RebalanceConfig>) => onChange({ ...config, ...next });

  const toggleVenue = (
    key: "allowedSources" | "allowedDestinations",
    exchange: ExchangeId,
  ) => {
    const list = config[key];
    patch({
      [key]: list.includes(exchange)
        ? list.filter((e) => e !== exchange)
        : [...list, exchange],
    } as Partial<RebalanceConfig>);
  };

  // The same filter the server applies, so the count shown is the count that
  // would execute rather than an optimistic subset.
  const actionable = actionableSuggestions(suggestions, balances, config);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_18rem]">
      <div className="flex flex-col gap-4">
        {/* Env arm: the lock the UI cannot open */}
        <Alert variant={automation.armed ? "error" : "neutral"} className="text-[11px]">
          {automation.armed ? (
            <span>
              <span className="font-medium">REBALANCE_AUTOMATION is set.</span> With the switch below
              on, this server will send real on-chain withdrawals unattended.
            </span>
          ) : (
            <span>
              REBALANCE_AUTOMATION is not set on the server, so nothing is sent whatever the switch
              below says. The engine still evaluates and logs what it would have done — tune the
              guard rails here first, then set the variable in .env.local and restart to arm it.
            </span>
          )}
        </Alert>

        {/* Master switch */}
        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <Bot aria-hidden className="size-4 text-info" />
                Automatic rebalancing
              </span>
              <span className="text-[11px] text-muted-foreground">
                Move stablecoins between venues when thresholds are breached.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant="secondary"
                className={cn(
                  "text-[10px] uppercase",
                  automation.active
                    ? "text-negative"
                    : config.enabled
                      ? "text-warning"
                      : "text-muted-foreground",
                )}
              >
                {automation.active ? "Live" : config.enabled ? "On, not armed" : "Disabled"}
              </Badge>
              <Switch
                checked={config.enabled}
                onCheckedChange={(v) => patch({ enabled: v })}
                aria-label="Enable automatic rebalancing"
              />
            </div>
          </CardContent>
        </Card>

        {/* Server-side state */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Automation State</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StateCell
              label="Sent today"
              value={`${automation.transfersToday}/${config.maxTransfersPerDay}`}
            />
            <StateCell label="Last evaluated" value={formatAgo(automation.lastRunAt)} />
            <StateCell label="Last transfer" value={formatAgo(automation.lastTransferAt)} />
            <StateCell
              label="Arm"
              value={automation.armed ? "set" : "not set"}
              valueClass={automation.armed ? "text-negative" : "text-muted-foreground"}
            />
            {automation.lastSkippedReason && (
              <p className="col-span-2 text-[10px] text-muted-foreground sm:col-span-4">
                Last cycle did nothing: {automation.lastSkippedReason}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Triggers */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Triggers</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <RangeField
              label="Imbalance threshold"
              value={config.imbalanceThresholdPct}
              min={5}
              max={50}
              suffix="%"
              hint="Trigger when a venue drifts this far above the equal-weight target."
              onChange={(v) => patch({ imbalanceThresholdPct: v })}
            />
            <RangeField
              label="Margin ratio trigger"
              value={config.marginRatioTriggerPct}
              min={50}
              max={95}
              suffix="%"
              hint="Top up a venue once margin utilisation exceeds this level."
              onChange={(v) => patch({ marginRatioTriggerPct: v })}
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="min-idle-balance" className="text-xs text-muted-foreground">
                Minimum idle balance to keep
              </Label>
              <Input
                id="min-idle-balance"
                type="number"
                value={config.minIdleBalance}
                onChange={(e) => patch({ minIdleBalance: Number(e.target.value) })}
                className="max-w-[10rem] font-mono num text-xs"
                min={0}
                step={50}
              />
              <p className="text-[10px] text-muted-foreground">
                Never drain a venue below this amount.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Guard rails */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Guard Rails</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="max-transfers-per-day" className="text-xs text-muted-foreground">
                Max transfers / day
              </Label>
              <Input
                id="max-transfers-per-day"
                type="number"
                value={config.maxTransfersPerDay}
                onChange={(e) => patch({ maxTransfersPerDay: Number(e.target.value) })}
                className="font-mono num text-xs"
                min={1}
                max={50}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="max-amount-per-transfer" className="text-xs text-muted-foreground">
                Max amount / transfer
              </Label>
              <Input
                id="max-amount-per-transfer"
                type="number"
                value={config.maxAmountPerTransfer}
                onChange={(e) => patch({ maxAmountPerTransfer: Number(e.target.value) })}
                className="font-mono num text-xs"
                min={100}
                step={100}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cooldown-minutes" className="text-xs text-muted-foreground">
                Cooldown (minutes)
              </Label>
              <Input
                id="cooldown-minutes"
                type="number"
                value={config.cooldownMinutes}
                onChange={(e) => patch({ cooldownMinutes: Number(e.target.value) })}
                className="font-mono num text-xs"
                min={5}
                step={5}
              />
            </div>
          </CardContent>
        </Card>

        {/* Preferred networks */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Preferred Network per Token</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {TRANSFER_TOKENS.map((t) => (
              <div key={t} className="flex flex-col gap-1.5">
                <Label className="font-mono text-xs text-muted-foreground">{t}</Label>
                <Select
                  value={config.preferredNetwork[t]}
                  onValueChange={(v) =>
                    v &&
                    patch({
                      preferredNetwork: {
                        ...config.preferredNetwork,
                        [t]: String(v) as NetworkId,
                      },
                    })
                  }
                >
                  <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(NETWORK_LABELS) as NetworkId[]).map((id) => (
                      <SelectItem key={id} value={id} className="text-xs">
                        {NETWORK_LABELS[id]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
            <p className="text-[10px] text-muted-foreground sm:col-span-2">
              The automation uses this chain. Fees are read from the venue at send time, and a
              transfer is refused if the chain is unavailable or has no armed destination address.
            </p>
          </CardContent>
        </Card>

        {/* Whitelists */}
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Venue Whitelist</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <VenueRow
              label="Allowed sources"
              venues={sourceVenues}
              selected={config.allowedSources}
              onToggle={(ex) => toggleVenue("allowedSources", ex)}
            />
            {sourceVenues.length === 0 && (
              <Alert variant="warning" className="text-[10px]">
                No venue can send: a source needs stored credentials, wallet reads and withdrawal
                signing. On-chain venues can receive but not send.
              </Alert>
            )}
            <Separator />
            <VenueRow
              label="Allowed destinations"
              venues={destinationVenues}
              selected={config.allowedDestinations}
              onToggle={(ex) => toggleVenue("allowedDestinations", ex)}
            />
            {destinationVenues.length === 0 && (
              <Alert variant="warning" className="text-[10px]">
                No venue can receive: a destination needs an armed address under the Destinations tab.
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Preview */}
      <Card className="flex flex-col">
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Preview</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-3">
          <p className="text-[11px] text-muted-foreground">
            With the current configuration, {actionable.length === 0 ? "no transfer" : `${actionable.length} transfer${actionable.length > 1 ? "s" : ""}`}{" "}
            would trigger right now.
          </p>
          {actionable.map((s) => (
            <div key={s.id} className="flex flex-col gap-1 rounded-md border border-border p-2">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="font-mono num font-medium">
                  ${s.amount.toLocaleString()} {s.token}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className={exchangeInfo(s.from).accent}>{exchangeName(s.from)}</span>
                <ArrowRight aria-hidden className="size-3 text-muted-foreground" />
                <span className={exchangeInfo(s.to).accent}>{exchangeName(s.to)}</span>
                <span className="ml-auto font-mono text-muted-foreground">
                  {config.preferredNetwork[s.token]}
                </span>
              </div>
            </div>
          ))}
          {!automation.armed && (
            <Badge variant="secondary" className="justify-center text-[10px] text-muted-foreground">
              Not armed — evaluation only
            </Badge>
          )}
          {automation.armed && !config.enabled && (
            <Badge variant="secondary" className="justify-center text-[10px] text-warning">
              Armed but switched off
            </Badge>
          )}
          {automation.active && (
            <Badge variant="secondary" className="justify-center text-[10px] text-negative">
              Live — transfers will be sent
            </Badge>
          )}
          <div className="mt-auto flex flex-col gap-2">
            <Button size="sm" className="w-full gap-1.5 text-xs" onClick={onSave} disabled={saving}>
              {saving ? (
                <Loader2 aria-hidden className="size-3 animate-spin" />
              ) : (
                <ShieldCheck aria-hidden className="size-3" />
              )}
              Save guard rails
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-1.5 text-xs"
              onClick={onEvaluate}
              disabled={evaluating}
            >
              {evaluating && <Loader2 aria-hidden className="size-3 animate-spin" />}
              Evaluate now
            </Button>
            <p className="text-[10px] leading-snug text-muted-foreground">
              Evaluate applies every guard rail the scheduled loop applies, including the env arm, so
              it cannot send something the loop would refuse.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StateCell({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn("font-mono num text-xs", valueClass)}>{value}</span>
    </div>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  suffix,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  hint?: string;
  onChange: (v: number) => void;
}) {
  const id = `range-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id} className="text-xs text-muted-foreground">
          {label}
        </Label>
        <span className="font-mono num text-xs font-medium">
          {value}
          {suffix}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-primary"
      />
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function VenueRow({
  label,
  venues,
  selected,
  onToggle,
}: {
  label: string;
  venues: ExchangeId[];
  selected: ExchangeId[];
  onToggle: (exchange: ExchangeId) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {venues.map((id) => {
          const on = selected.includes(id);
          return (
            <Button
              key={id}
              variant={on ? "outline" : "secondary"}
              size="sm"
              className={cn(
                "h-7 gap-1.5 px-2.5 text-xs",
                on ? exchangeInfo(id).accent : "text-muted-foreground opacity-60",
              )}
              onClick={() => onToggle(id)}
              aria-pressed={on}
            >
              <span
                aria-hidden
                className={cn("size-1.5 rounded-full", on ? "bg-current" : "bg-muted-foreground")}
              />
              {exchangeName(id)}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
