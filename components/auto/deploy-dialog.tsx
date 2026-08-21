"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { apiFetch } from "@/lib/api/client";
import type { AccountType, StrategyId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Coins, PiggyBank, Timer, TrendingUp } from "lucide-react";

/** A strategy that can be deployed, with a name the server knows is free. */
export interface AvailableStrategy {
  strategy: StrategyId;
  name: string;
  tagline: string;
  suggestedLabel: string;
}

interface DeployDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountType: AccountType;
  available: AvailableStrategy[];
  onDeployed: (deploymentId: string) => void;
}

const ICON = {
  fundingsync: Coins,
  perpbridge: TrendingUp,
  fundingbridge: Timer,
  fundingyield: PiggyBank,
} as const;

/**
 * Deploys a strategy: pick which one, name it, and it appears switched off.
 *
 * The name is the point of this dialog. Several deployments of one strategy are
 * indistinguishable in a log line without it, so the field is prefilled with a free
 * suggestion from the server — client-side numbering would collide as soon as two
 * tabs are open.
 */
export function DeployDialog({
  open,
  onOpenChange,
  accountType,
  available,
  onDeployed,
}: DeployDialogProps) {
  const [strategy, setStrategy] = useState<StrategyId | null>(null);
  const [label, setLabel] = useState("");
  const [wasOpen, setWasOpen] = useState(open);

  // Reset when the dialog opens, so a previously abandoned choice does not reappear
  // as if it were still intended. Adjusted during render rather than in an effect:
  // an effect would paint one frame with the stale selection.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setStrategy(null);
      setLabel("");
    }
  }

  const chosen = available.find((a) => a.strategy === strategy) ?? null;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Deploy a strategy"
      description="Runs another instance of a strategy with its own venues and thresholds. Several deployments of the same strategy can run side by side."
      confirmLabel="Deploy"
      warning="It starts switched off on default settings. Set its venues and thresholds before starting it."
      onConfirm={async () => {
        if (!strategy) throw new Error("Pick a strategy to deploy");
        const result = await apiFetch<{ deploymentId: string }>("/api/auto/deployments", {
          method: "POST",
          json: {
            action: "create",
            account: accountType,
            strategy,
            label: label.trim() || undefined,
          },
        });
        onDeployed(result.deploymentId);
      }}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Strategy</Label>
          <div className="flex flex-col gap-1.5">
            {available.map((entry) => {
              const Icon = ICON[entry.strategy] ?? Coins;
              const selected = strategy === entry.strategy;
              return (
                <button
                  key={entry.strategy}
                  type="button"
                  onClick={() => {
                    setStrategy(entry.strategy);
                    // Only overwrite an untouched field, so a name already typed
                    // survives a change of mind about the strategy.
                    setLabel((prev) => (prev.trim() ? prev : entry.suggestedLabel));
                  }}
                  className={cn(
                    "flex items-start gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors",
                    selected
                      ? "border-primary/50 bg-secondary/60"
                      : "border-border hover:bg-secondary/40",
                  )}
                >
                  <Icon
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      selected ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{entry.name}</span>
                    <span className="text-[11px] text-muted-foreground">{entry.tagline}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="deploy-label" className="text-xs text-muted-foreground">
            Name — appears in logs and alerts
          </Label>
          <Input
            id="deploy-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={chosen?.suggestedLabel ?? "e.g. Asia CEX pairs"}
            maxLength={40}
            autoComplete="off"
          />
          <p className="text-[10px] text-muted-foreground">
            Name it after what makes it different — its venues, its risk, its market. “
            {chosen?.suggestedLabel ?? "FundingBridge 2"}” works, but says less.
          </p>
        </div>
      </div>
    </ConfirmDialog>
  );
}
