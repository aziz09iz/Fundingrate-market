"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

export interface ConfirmDetail {
  label: string;
  value: string;
  /** Emphasise values that determine what happens to real money. */
  emphasis?: boolean;
}

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Key/value lines shown verbatim so the user sees exactly what will be sent. */
  details?: ConfirmDetail[];
  /** Shown prominently; use for anything irreversible. */
  warning?: string;
  confirmLabel?: string;
  /** Styles the confirm button as destructive. */
  destructive?: boolean;
  /**
   * Demands the user retype this string before confirming. Reserved for the
   * largest actions: a mis-click and a deliberate decision are indistinguishable
   * when both are one button press, and past a certain notional they should not be.
   */
  challenge?: { value: string; label: string };
  /** Extra inputs, e.g. an amount field. */
  children?: React.ReactNode;
  onConfirm: () => Promise<void> | void;
}

/**
 * Confirmation step for actions that cannot be undone.
 *
 * It shows the exact parameters rather than a generic "are you sure", because a
 * wrong venue or size is the kind of mistake this dialog exists to catch.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  details,
  warning,
  confirmLabel = "Confirm",
  destructive = false,
  challenge,
  children,
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  const challengeMet = !challenge || typed.trim() === challenge.value;

  const run = async () => {
    if (!challengeMet) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setTyped("");
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't let a click-away abandon an in-flight request.
        if (busy) return;
        setError(null);
        setTyped("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {children}

        {details && details.length > 0 && (
          <div className="flex flex-col gap-1 rounded-md border border-border p-2.5 text-xs">
            {details.map((d) => (
              <div key={d.label} className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{d.label}</span>
                <span className={cn("font-mono num", d.emphasis && "font-medium text-foreground")}>
                  {d.value}
                </span>
              </div>
            ))}
          </div>
        )}

        {warning && (
          <Alert variant="warning" className="text-[11px]">
            {warning}
          </Alert>
        )}

        {challenge && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-challenge" className="text-xs text-muted-foreground">
              {challenge.label}
            </Label>
            <Input
              id="confirm-challenge"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && challengeMet) void run();
              }}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={typed.length > 0 && !challengeMet}
              placeholder={challenge.value}
              className="font-mono text-xs"
            />
          </div>
        )}

        {error && (
          <Alert variant="error" className="text-[11px]">
            {error}
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            className={cn(destructive && "bg-negative text-white hover:bg-negative/85")}
            onClick={() => void run()}
            disabled={busy || !challengeMet}
          >
            {busy && <Loader2 aria-hidden className="size-3.5 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
