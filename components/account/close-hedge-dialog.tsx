"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/confirm-dialog";
import type { AccountType, Position } from "@/lib/types";
import type { HedgeRow } from "@/lib/hedge-view";
import { exchangeName, formatSignedUsd } from "@/lib/utils";

/** What a close action needs: which legs to unwind, and how much of each. */
export interface CloseHedgeInput {
  legs: Position[];
  /** Fraction of each leg to close, 0 < fraction <= 1. */
  fraction: number;
}

interface CloseHedgeDialogProps {
  /** The hedge being closed, or null when the dialog is shut. */
  hedge: HedgeRow | null;
  onOpenChange: (open: boolean) => void;
  accountType: AccountType;
  onConfirm: (input: CloseHedgeInput) => Promise<void>;
}

/**
 * Percentage-based close for a whole hedge, shared by the paper and live views.
 *
 * Both legs go together rather than one at a time: closing half a hedge leaves
 * naked directional exposure, which is the opposite of what the position was
 * opened for. Per-leg control still exists on the live page for the cases where
 * unwinding one side really is the intent.
 *
 * Deliberately no retype challenge, unlike opening an order or arming a
 * destination. Closing reduces exposure, so the asymmetric risk runs the other
 * way: friction that delays an exit is more dangerous than one that delays an
 * entry.
 */
export function CloseHedgeDialog({
  hedge,
  onOpenChange,
  accountType,
  onConfirm,
}: CloseHedgeDialogProps) {
  const [pct, setPct] = useState("100");

  const legs = hedge
    ? [hedge.longLeg, hedge.shortLeg, ...hedge.extraLegs].filter(
        (l): l is Position => l !== null,
      )
    : [];
  const fraction = Math.min(1, Math.max(0, Number(pct || 0) / 100));
  const isPaper = accountType === "paper";

  return (
    <ConfirmDialog
      open={hedge !== null}
      onOpenChange={(open) => {
        if (!open) setPct("100");
        onOpenChange(open);
      }}
      title={legs.length > 1 ? "Close hedge" : "Close position"}
      description={
        legs.length > 1
          ? "Unwinds both legs with market orders, in one step."
          : "Unwinds this position with a market order."
      }
      confirmLabel="Close now"
      destructive
      warning={
        isPaper
          ? "Simulated against live quotes. Realized PnL is booked immediately and cannot be undone."
          : "This sends real reduce-only market orders to real venues. Once they fill it cannot be undone."
      }
      details={
        hedge
          ? [
              { label: "Pair", value: hedge.coin, emphasis: true },
              {
                label: "Legs",
                value: legs.map((l) => `${l.side} ${exchangeName(l.exchange)}`).join(" · "),
                emphasis: true,
              },
              { label: "Closing", value: `${pct || 0}% of each leg`, emphasis: true },
              {
                label: "Size per leg",
                value: legs.map((l) => trimSize(l.size * fraction)).join(" · "),
              },
              {
                label: "Unrealized now",
                value: hedge.markStale
                  ? "no quote on one leg"
                  : formatSignedUsd(hedge.unrealizedPnl * fraction, 2),
              },
            ]
          : []
      }
      onConfirm={async () => {
        if (!hedge) return;
        if (!(fraction > 0)) throw new Error("Choose a percentage above zero");
        await onConfirm({ legs, fraction });
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="close-hedge-pct" className="text-xs text-muted-foreground">
          Percentage of the hedge to close
        </Label>
        <Input
          id="close-hedge-pct"
          type="number"
          min={1}
          max={100}
          step={1}
          value={pct}
          onChange={(e) => setPct(e.target.value)}
          className="font-mono text-xs num"
        />
        <div className="flex gap-1">
          {[25, 50, 75, 100].map((preset) => (
            <Button
              key={preset}
              variant="ghost"
              size="sm"
              className="h-6 flex-1 text-[10px]"
              onClick={() => setPct(String(preset))}
            >
              {preset === 100 ? "All" : `${preset}%`}
            </Button>
          ))}
        </div>
        {hedge?.markStale && (
          <p className="text-[10px] text-warning">
            One leg has no live quote, so it cannot be filled right now. Closing will be refused for
            that leg rather than filled at a guessed price.
          </p>
        )}
      </div>
    </ConfirmDialog>
  );
}

/** Trims a computed leg size to something a venue would accept. */
function trimSize(size: number): string {
  return String(Number(size.toFixed(8)));
}
