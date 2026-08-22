"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  AccountType,
  ExchangeId,
  ExecutionMode,
  MarketView,
  OrderSide,
  OrderType,
} from "@/lib/types";
import {
  EXCHANGES,
  cn,
  exchangeName,
  formatPrice,
  formatSignedPct,
} from "@/lib/utils";
import {
  SPREAD_RELEASE_THRESHOLD_PCT,
  findRow,
  hedgeEntrySpreadPct,
  nextOrderId,
  venueAsk,
  venueBid,
  venueReferencePrice,
  type OrderIntent,
} from "@/lib/trade-orders";
import { ArrowDown, ArrowUp, Loader2, Timer, TriangleAlert, Zap } from "lucide-react";

export interface OrderFormPrefill {
  /** Hedge venues chosen from the funding dashboard's Direction column. */
  longExchange: ExchangeId;
  shortExchange: ExchangeId;
  mode: ExecutionMode;
}

interface OrderFormProps {
  pair: string;
  onPairChange: (pair: string) => void;
  /** Coins any venue lists; the form cannot trade anything outside this. */
  availablePairs: string[];
  /** The current market page, which pins the selected pair so its quotes are present. */
  view: MarketView | null;
  defaultExchange: ExchangeId;
  /** Which account the order is destined for, shown on the submit button. */
  account: AccountType;
  /** Venues with usable credentials — a live order elsewhere would be refused. */
  tradableVenues?: ExchangeId[];
  /**
   * Free collateral in USD for the selected account, or null when it is not
   * known yet. Typing a size with no idea what is affordable meant finding out
   * from a server rejection.
   */
  availableUsd?: number | null;
  /** True while a submission is in flight, so the button cannot be double-fired. */
  submitting?: boolean;
  /**
   * Seeds the hedge legs and execution mode from a dashboard deep link. The
   * page remounts this component when the link changes, so this is read once.
   */
  prefill?: OrderFormPrefill;
  onSubmit: (intents: OrderIntent[]) => void;
}

type FormMode = "standard" | "hedge";

/** Quick sizes, so the common case is a click rather than typing digits. */
const AMOUNT_PRESETS_USD = [100, 500, 1000, 5000] as const;

export function OrderForm({
  pair,
  onPairChange,
  availablePairs,
  view,
  defaultExchange,
  account,
  tradableVenues,
  availableUsd = null,
  submitting = false,
  prefill,
  onSubmit,
}: OrderFormProps) {
  const [mode, setMode] = useState<FormMode>(prefill ? "hedge" : "standard");
  const [side, setSide] = useState<OrderSide>("buy");
  const [orderType, setOrderType] = useState<OrderType>("limit");
  const [amountUsd, setAmountUsd] = useState<string>("1000");
  // Track which pair a typed price belongs to so switching pair re-seeds the
  // field during render instead of needing an effect.
  const [priceInput, setPriceInput] = useState<{ pair: string; value: string } | null>(null);
  const [leverage, setLeverage] = useState(3);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [execution, setExecution] = useState<ExecutionMode>(prefill?.mode ?? "instant");
  const [exchangeA, setExchangeA] = useState<ExchangeId>(
    prefill?.longExchange ?? defaultExchange,
  );
  const [exchangeB, setExchangeB] = useState<ExchangeId>(prefill?.shortExchange ?? "bybit");
  const [aIsLong, setAIsLong] = useState(true);
  const [standardExchange, setStandardExchange] = useState<ExchangeId>(defaultExchange);

  const isHedge = mode === "hedge";
  const isLimit = orderType === "limit";
  const longExchange = aIsLong ? exchangeA : exchangeB;
  const shortExchange = aIsLong ? exchangeB : exchangeA;

  const row = findRow(view, pair);
  // Reference price follows the venue that would actually fill this order.
  const reference = isHedge
    ? venueAsk(view, pair, longExchange)
    : side === "buy"
      ? venueAsk(view, pair, standardExchange)
      : venueBid(view, pair, standardExchange);
  const fallbackReference = venueReferencePrice(view, pair, standardExchange);
  const markPrice = reference ?? fallbackReference;

  const price =
    priceInput?.pair === pair ? priceInput.value : markPrice !== null ? String(markPrice) : "";
  const setPrice = (value: string) => setPriceInput({ pair, value });

  const liveSpread = isHedge
    ? hedgeEntrySpreadPct(view, pair, longExchange, shortExchange)
    : null;
  const spreadConverged =
    liveSpread !== null && Math.abs(liveSpread) <= SPREAD_RELEASE_THRESHOLD_PCT;

  const longQuoted = row?.tickers[longExchange]?.ask ?? null;
  const shortQuoted = row?.tickers[shortExchange]?.bid ?? null;
  const hedgeQuotesMissing = isHedge && (longQuoted === null || shortQuoted === null);
  const standardQuoteMissing = !isHedge && markPrice === null;

  const usdAmount = Number(amountUsd);
  const limitPrice = Number(price);
  const effectivePrice = isLimit ? limitPrice : markPrice ?? 0;
  // The form is denominated in USD; venues take base size, so convert with the
  // price this order would actually fill at.
  const size =
    usdAmount > 0 && effectivePrice > 0 ? roundBaseSize(usdAmount / effectivePrice) : 0;

  // A hedge is delta-neutral and posts the same notional on both legs, so it ties
  // up twice the collateral of a standard order of the same size.
  const notionalUsd = usdAmount > 0 ? usdAmount * (isHedge ? 2 : 1) : 0;
  // Hedge legs are sent unlevered (leverage: 1 below), so only a standard order
  // divides its margin by the slider.
  const marginUsd = notionalUsd > 0 ? notionalUsd / (isHedge ? 1 : leverage) : 0;
  const liquidationPrice = estimateLiquidationPrice(
    effectivePrice,
    isHedge ? 1 : leverage,
    isHedge ? "buy" : side,
  );
  const overAvailable = availableUsd !== null && marginUsd > availableUsd;

  const errors: string[] = [];
  if (!pair) errors.push("Pick a coin that is currently streaming.");
  if (!usdAmount || usdAmount <= 0) errors.push("Amount (USD) must be greater than zero.");
  if (isLimit && (!limitPrice || limitPrice <= 0)) errors.push("Enter a limit price.");
  if (usdAmount > 0 && effectivePrice > 0 && size <= 0)
    errors.push("Amount is too small to buy any of this coin.");
  if (isHedge && longExchange === shortExchange) errors.push("Hedge legs must use two venues.");
  if (hedgeQuotesMissing) errors.push("One hedge venue has no live quote for this coin.");
  if (standardQuoteMissing && !isLimit) errors.push("No live quote to fill a market order against.");
  // A live order to a venue without credentials is refused server-side; saying
  // so here is better than letting the request fail after a confirmation.
  if (account === "live" && tradableVenues) {
    for (const venue of isHedge ? [longExchange, shortExchange] : [standardExchange]) {
      if (!tradableVenues.includes(venue)) {
        errors.push(`${exchangeName(venue)} has no trading credentials configured.`);
      }
    }
  }
  if (overAvailable) {
    errors.push(
      `Needs ${formatUsd(marginUsd)} of margin but only ${formatUsd(availableUsd)} is free.`,
    );
  }
  const valid = errors.length === 0;

  const submit = () => {
    if (!valid || submitting) return;
    if (isHedge) {
      const hedgeId = `HDG-${nextOrderId()}`;
      onSubmit([
        {
          pair, exchange: longExchange, side: "buy",
          orderType, price: isLimit ? limitPrice : longQuoted ?? effectivePrice,
          size, leverage: 1, hedgeId,
          executionMode: execution,
          waitLongExchange: longExchange,
          waitShortExchange: shortExchange,
        },
        {
          pair, exchange: shortExchange, side: "sell",
          orderType, price: isLimit ? limitPrice : shortQuoted ?? effectivePrice,
          size, leverage: 1, hedgeId,
          executionMode: execution,
          waitLongExchange: longExchange,
          waitShortExchange: shortExchange,
        },
      ]);
    } else {
      onSubmit([
        {
          pair, exchange: standardExchange, side,
          orderType, price: effectivePrice, size, leverage, reduceOnly,
          executionMode: "instant",
        },
      ]);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Tabs value={mode} onValueChange={(v) => setMode(v as FormMode)}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="standard" className="text-xs">Standard</TabsTrigger>
          <TabsTrigger value="hedge" className="text-xs">Hedge</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Side toggle */}
      <div className="grid grid-cols-2 gap-2">
        <SideButton active={side === "buy"} onClick={() => setSide("buy")} side="buy" disabled={isHedge} />
        <SideButton active={side === "sell"} onClick={() => setSide("sell")} side="sell" disabled={isHedge} />
      </div>
      {isHedge && (
        <p className="text-[11px] text-muted-foreground">
          Hedge opens long + short simultaneously across two venues.
        </p>
      )}

      {/* Market type — perpetual/futures only */}
      <div className="flex items-center gap-2">
        <span className="w-20 text-xs text-muted-foreground">Market</span>
        <div className="flex flex-1 items-center justify-between rounded-md bg-muted/40 px-2.5 py-1.5">
          <span className="text-xs font-medium">Perp / Futures</span>
          <span className="text-[10px] uppercase text-muted-foreground">only</span>
        </div>
      </div>

      {/* Execution mode */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="w-20 text-xs text-muted-foreground">Execution</span>
          <div className="flex flex-1 gap-1">
            <Button
              type="button"
              variant={execution === "instant" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 flex-1 gap-1 text-xs"
              onClick={() => setExecution("instant")}
            >
              <Zap className="size-3" />
              Instant
            </Button>
            <Button
              type="button"
              variant={execution === "delay" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 flex-1 gap-1 text-xs"
              onClick={() => setExecution("delay")}
              disabled={!isHedge}
            >
              <Timer className="size-3" />
              Delay
            </Button>
          </div>
        </div>
        {!isHedge && (
          <p className="pl-[5.5rem] text-[10px] text-muted-foreground">
            Delay needs two venues — switch to Hedge to use it.
          </p>
        )}
        {isHedge && execution === "delay" && (
          <div className="ml-[5.5rem] flex flex-col gap-0.5 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5">
            <span className="text-[10px] text-muted-foreground">
              Waits until {exchangeName(longExchange)} ask and {exchangeName(shortExchange)} bid converge.
            </span>
            <span className="font-mono text-[11px] num">
              spread now{" "}
              {liveSpread === null ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <span className={spreadConverged ? "text-positive" : "text-warning"}>
                  {formatSignedPct(liveSpread)}
                </span>
              )}{" "}
              <span className="text-muted-foreground">
                → release at ±{SPREAD_RELEASE_THRESHOLD_PCT}%
              </span>
            </span>
          </div>
        )}
      </div>

      {/* Pair */}
      <Field label={`Pair (${availablePairs.length} streaming)`}>
        <Select
          value={pair}
          onValueChange={(v) => {
            if (!v) return;
            onPairChange(String(v));
          }}
        >
          <SelectTrigger className="font-mono text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {availablePairs.map((symbol) => (
              <SelectItem key={symbol} value={symbol} className="font-mono text-xs">
                {symbol}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {/* Exchange(s) */}
      {!isHedge ? (
        <Field label="Exchange">
          <Select value={standardExchange} onValueChange={(v) => v && setStandardExchange(String(v) as ExchangeId)}>
            <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {EXCHANGES.map((ex) => (
                <SelectItem key={ex.id} value={ex.id} className="text-xs">
                  <span className={ex.accent}>{ex.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Exchange A</Label>
            <Select value={exchangeA} onValueChange={(v) => v && setExchangeA(String(v) as ExchangeId)}>
              <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {EXCHANGES.map((ex) => (
                  <SelectItem key={ex.id} value={ex.id} className="text-xs">{ex.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Exchange B</Label>
            <Select value={exchangeB} onValueChange={(v) => v && setExchangeB(String(v) as ExchangeId)}>
              <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {EXCHANGES.filter((e) => e.id !== exchangeA).map((ex) => (
                  <SelectItem key={ex.id} value={ex.id} className="text-xs">{ex.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2 flex items-center justify-between rounded-md bg-muted/40 px-2.5 py-1.5">
            <span className="text-[11px] text-muted-foreground">Direction</span>
            <div className="flex items-center gap-1.5">
              <span className={cn("font-mono text-[11px]", aIsLong ? "text-positive" : "text-negative")}>
                A {aIsLong ? "Long" : "Short"}
              </span>
              <Switch checked={aIsLong} onCheckedChange={setAIsLong} aria-label="Direction A" />
              <span className={cn("font-mono text-[11px]", !aIsLong ? "text-positive" : "text-negative")}>
                B {!aIsLong ? "Long" : "Short"}
              </span>
            </div>
          </div>
          <div className="col-span-2 grid grid-cols-1 gap-2 text-[10px] sm:grid-cols-2">
            <span className="rounded-md bg-muted/30 px-2 py-1">
              long {exchangeName(longExchange)} ask{" "}
              <span className="font-mono num text-positive">{formatPrice(longQuoted)}</span>
            </span>
            <span className="rounded-md bg-muted/30 px-2 py-1">
              short {exchangeName(shortExchange)} bid{" "}
              <span className="font-mono num text-negative">{formatPrice(shortQuoted)}</span>
            </span>
          </div>
        </div>
      )}

      {/* Order type */}
      <div className="flex items-center gap-2">
        <span className="w-20 text-xs text-muted-foreground">Order type</span>
        <div className="flex flex-1 gap-1">
          <Button
            type="button"
            variant={orderType === "limit" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 flex-1 text-xs"
            onClick={() => setOrderType("limit")}
          >
            Limit
          </Button>
          <Button
            type="button"
            variant={orderType === "market" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 flex-1 text-xs"
            onClick={() => setOrderType("market")}
          >
            Market
          </Button>
        </div>
      </div>

      {/* Price (limit only) */}
      {isLimit && (
        <Field label="Price (USDT)">
          <Input
            type="number"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="font-mono text-xs num"
            placeholder={markPrice !== null ? String(markPrice) : "no quote yet"}
          />
        </Field>
      )}

      {/* Amount — denominated in USD, converted to base size on submit */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor="order-amount-usd" className="text-xs text-muted-foreground">
            Amount (USD)
          </Label>
          <span className="font-mono text-[10px] text-muted-foreground">
            {availableUsd === null ? (
              "available —"
            ) : (
              <>
                available <span className="text-foreground">{formatUsd(availableUsd)}</span>
              </>
            )}
          </span>
        </div>
        <Input
          id="order-amount-usd"
          type="number"
          value={amountUsd}
          onChange={(e) => setAmountUsd(e.target.value)}
          className="font-mono text-xs num"
          step="10"
          min="0"
          aria-invalid={overAvailable || undefined}
          placeholder="1000"
        />
        <div className="flex flex-wrap items-center gap-1">
          {AMOUNT_PRESETS_USD.map((preset) => (
            <Button
              key={preset}
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 font-mono text-[10px]"
              onClick={() => setAmountUsd(String(preset))}
            >
              ${preset.toLocaleString()}
            </Button>
          ))}
          {availableUsd !== null && availableUsd > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 font-mono text-[10px]"
              // Max is the notional the free collateral supports, which is the
              // leveraged figure for a standard order and half of it per leg for
              // a hedge, since both legs are posted unlevered.
              onClick={() =>
                setAmountUsd(
                  String(
                    Math.floor(availableUsd * (isHedge ? 0.5 : leverage)),
                  ),
                )
              }
            >
              Max
            </Button>
          )}
        </div>
      </div>

      {/* Leverage (standard only) */}
      {!isHedge && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="order-leverage" className="text-xs text-muted-foreground">
              Leverage
            </Label>
            <span className="font-mono text-xs font-medium num">{leverage}×</span>
          </div>
          <input
            id="order-leverage"
            type="range"
            min={1}
            max={20}
            value={leverage}
            aria-valuetext={`${leverage} times`}
            onChange={(e) => setLeverage(Number(e.target.value))}
            className="accent-primary"
          />
        </div>
      )}

      {/* Reduce-only (standard only) */}
      {!isHedge && (
        <label className="flex items-center justify-between rounded-md bg-muted/30 px-2.5 py-1.5">
          <span className="text-xs text-muted-foreground">Reduce only</span>
          <Switch checked={reduceOnly} onCheckedChange={setReduceOnly} aria-label="Reduce only" />
        </label>
      )}

      {/* Cost estimate — the USD input restated as what it commits and risks */}
      <dl className="flex flex-col gap-1 rounded-md border border-border px-2.5 py-2 text-xs">
        <Estimate label={isHedge ? "Notional (both legs)" : "Order value"} value={formatUsd(notionalUsd)} />
        <Estimate
          label="Size"
          value={size > 0 ? `≈ ${formatBaseSize(size)} ${pair || ""}`.trim() : "—"}
        />
        <Estimate
          label="Margin required"
          value={marginUsd > 0 ? formatUsd(marginUsd) : "—"}
          valueClass={overAvailable ? "text-negative" : undefined}
        />
        {!isHedge && (
          <Estimate
            label={`Est. liquidation (${leverage}×)`}
            value={liquidationPrice === null ? "—" : formatPrice(liquidationPrice)}
            hint="Rough estimate: entry adjusted by 1/leverage. Excludes venue maintenance margin and fees."
          />
        )}
        {isHedge && (
          <Estimate
            label="Directional risk"
            value="delta-neutral"
            hint="Both legs carry the same size in opposite directions, so price moves offset. Funding and fees are the live exposure."
          />
        )}
      </dl>

      {errors.length > 0 && (
        <Alert variant="error" hideIcon className="flex-col gap-1 text-[10px]">
          <ul className="flex flex-col gap-1">
            {errors.map((e) => (
              <li key={e} className="flex items-start gap-1.5">
                <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
                {e}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {/* Submit */}
      <Button
        type="button"
        disabled={!valid || submitting}
        className={cn(
          "h-9 w-full gap-1.5 font-medium text-white",
          isHedge
            ? "bg-info hover:bg-info/85"
            : side === "buy"
              ? "bg-positive hover:bg-positive/85"
              : "bg-negative hover:bg-negative/85",
        )}
        onClick={submit}
      >
        {submitting && <Loader2 aria-hidden className="size-3.5 animate-spin" />}
        {isHedge
          ? execution === "delay"
            ? "Queue Hedge Order (wait spread 0)"
            : `Submit Hedge Order · ${account}`
          : `${side === "buy" ? "Buy" : "Sell"} ${pair} · ${account}`}
      </Button>
      <p className="text-center text-[10px] text-muted-foreground">
        {account === "live"
          ? "Live orders are sent to the venue after a confirmation and cannot be recalled once filled."
          : "Paper orders are simulated against live quotes and stored in the local database."}
      </p>
    </div>
  );
}

function SideButton({
  active,
  onClick,
  side,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  side: OrderSide;
  disabled?: boolean;
}) {
  const isBuy = side === "buy";
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "outline"}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "h-9 gap-1.5 text-sm",
        active && isBuy && "border-positive/40 bg-positive/10 text-positive",
        active && !isBuy && "border-negative/40 bg-negative/10 text-negative",
        !active && "text-muted-foreground",
      )}
    >
      {isBuy ? <ArrowUp aria-hidden className="size-4" /> : <ArrowDown aria-hidden className="size-4" />}
      {isBuy ? "Buy / Long" : "Sell / Short"}
    </Button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

/**
 * Trims a converted base size to 8 decimals. Venues reject sizes with more
 * precision than they quote, and float division routinely produces more.
 */
function roundBaseSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Number(value.toFixed(8));
}

/** Shows the converted base size with enough digits to stay meaningful. */
function formatBaseSize(value: number): string {
  if (value >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return value.toPrecision(4).replace(/0+$/, "").replace(/\.$/, "");
}

/** USD with a dollar sign and two decimals, or an em dash when unusable. */
function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return "—";
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/**
 * Rough liquidation price: the move that wipes out the posted margin, i.e. the
 * entry shifted by 1/leverage against the position.
 *
 * Deliberately approximate — each venue applies its own maintenance margin tier
 * and fee schedule, so an exact figure has to come from the venue. Shown as an
 * order of magnitude, which is what the slider decision actually needs.
 */
function estimateLiquidationPrice(
  entry: number,
  leverage: number,
  side: OrderSide,
): number | null {
  if (!Number.isFinite(entry) || entry <= 0 || leverage <= 1) return null;
  const move = entry / leverage;
  const price = side === "buy" ? entry - move : entry + move;
  return price > 0 ? price : null;
}

/** One line of the estimate block, with an optional explanation on hover. */
function Estimate({
  label,
  value,
  valueClass,
  hint,
}: {
  label: string;
  value: string;
  valueClass?: string;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">
        {hint ? (
          <Tooltip>
            <TooltipTrigger render={<span className="cursor-help underline decoration-dotted underline-offset-2" />}>
              {label}
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-64 text-xs">
              {hint}
            </TooltipContent>
          </Tooltip>
        ) : (
          label
        )}
      </dt>
      <dd className={cn("font-mono num", valueClass)}>{value}</dd>
    </div>
  );
}
