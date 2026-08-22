"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/page-header";
import { FeeSettings } from "@/components/settings/fee-settings";
import { NotificationSettings } from "@/components/settings/notification-settings";
import { apiFetch } from "@/lib/api/client";
import type { AccountType, GeneralSettings } from "@/lib/types";
import { Loader2, ShieldCheck } from "lucide-react";

const DEFAULTS: GeneralSettings = {
  // Paper, so a fresh install cannot land on live and turn a mis-click into a real
  // order. The stored value replaces this as soon as it loads.
  defaultAccount: "paper",
};

export default function GeneralSettingsPage() {
  const [settings, setSettings] = useState<GeneralSettings>(DEFAULTS);
  const [savingDefault, setSavingDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The default account lives on the server, so read the applied value on mount
  // rather than showing a guess.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await apiFetch<{ defaultAccount: AccountType }>("/api/settings/defaults");
        if (cancelled) return;
        setSettings((prev) => ({ ...prev, defaultAccount: stored.defaultAccount }));
      } catch {
        // Leaving the default on screen is better than blocking the page.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Saves the default account immediately on click.
   *
   * Every card on this page now saves itself. The page used to carry one Save button
   * that applied only the market cadence, which is exactly the arrangement that let a
   * picker look applied without being stored.
   */
  const onDefaultAccount = useCallback(async (next: AccountType) => {
    setSavingDefault(true);
    setError(null);
    try {
      const result = await apiFetch<{ defaultAccount: AccountType }>("/api/settings/defaults", {
        method: "POST",
        json: { defaultAccount: next },
      });
      setSettings((prev) => ({ ...prev, defaultAccount: result.defaultAccount }));
      toast.success(`Default account set to ${result.defaultAccount}`, {
        description: "The trade page opens on this account.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error("Could not save the default account", { description: message });
    } finally {
      setSavingDefault(false);
    }
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-6">
      <PageHeader
        title="General Settings"
        description="Paper fees, notifications, application defaults and the always-on safety rules."
      />

      <FeeSettings />

      <NotificationSettings />

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Defaults</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Default account</Label>
            <div className="flex items-center gap-1.5">
              {(["live", "paper"] as AccountType[]).map((t) => (
                <Button
                  key={t}
                  variant={settings.defaultAccount === t ? "secondary" : "outline"}
                  size="sm"
                  aria-pressed={settings.defaultAccount === t}
                  disabled={savingDefault}
                  className="h-8 text-xs capitalize"
                  onClick={() => void onDefaultAccount(t)}
                >
                  {t}
                </Button>
              ))}
              {savingDefault && (
                <Loader2 aria-hidden className="size-3.5 animate-spin text-muted-foreground" />
              )}
            </div>
            <p className="text-[10px] text-muted-foreground">
              Which account the trade page opens on. Saved as soon as you pick it, and applied to the
              whole installation rather than this browser.
            </p>
          </div>

          {error && (
            <Alert variant="error" className="text-[11px]">
              {error}
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Safety</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2.5">
          {/* Stated rather than offered as a toggle: these are unconditional in the
              code, and a switch implying they could be turned off would be a lie. */}
          <SafetyFact
            title="Withdrawals always confirm"
            detail="Every transfer shows its route, amount, fee and destination, and asks you to retype the amount before sending. Not optional."
          />
          <SafetyFact
            title="A mismatched destination cannot be armed"
            detail="If the venue reports a different deposit address, arming is refused server-side and every transfer re-checks the address before sending."
          />
          <SafetyFact
            title="Live orders always confirm"
            detail="Real orders show the exact venue, side, size and price first; above $10,000 notional the amount has to be retyped."
          />
          <SafetyFact
            title="Automation needs a server-side arm"
            detail="Unattended transfers also require REBALANCE_AUTOMATION=true in the environment, so a dashboard toggle alone cannot start moving money."
          />
          <SafetyFact
            title="Wallet signing is self-checked before use"
            detail="Hyperliquid and Aster orders are signed locally with a wallet key. The signing code reproduces the venues' own published test vectors before it will sign anything, and Hyperliquid refuses a key that controls a different wallet than the stored address."
          />
          <SafetyFact
            title="Paper views are always labelled"
            detail="Simulated accounts and tables carry a Paper badge wherever they appear."
          />
        </CardContent>
      </Card>

      <p className="text-center text-[10px] text-muted-foreground">
        Market settings are held by the server process and reset on restart. The default account,
        paper fees, notification credentials and exposure ceilings are stored in the database.
      </p>
    </div>
  );
}

/** One always-on guarantee, with the reason it is not a switch. */
function SafetyFact({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted/30 px-2.5 py-2">
      <ShieldCheck aria-hidden className="mt-0.5 size-3.5 shrink-0 text-positive" />
      <span className="flex flex-col gap-0.5">
        <span className="text-xs">{title}</span>
        <span className="text-[10px] text-muted-foreground">{detail}</span>
      </span>
    </div>
  );
}
