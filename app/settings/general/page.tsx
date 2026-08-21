"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/page-header";
import { FeeSettings } from "@/components/settings/fee-settings";
import { NotificationSettings } from "@/components/settings/notification-settings";
import { apiFetch } from "@/lib/api/client";
import type { AccountType, GeneralSettings, MarketConfig } from "@/lib/types";
import { Check, Loader2, Save, ShieldCheck } from "lucide-react";

const DEFAULTS: GeneralSettings = {
  // Paper, so a fresh install cannot land on live and turn a mis-click into a real
  // order. The stored value replaces this as soon as it loads.
  defaultAccount: "paper",
  pollIntervalSec: 60,
  layer1CountPerExchange: 10,
};

type SaveState = "idle" | "saving" | "saved" | "error";

export default function GeneralSettingsPage() {
  const [settings, setSettings] = useState<GeneralSettings>(DEFAULTS);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savingDefault, setSavingDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Market settings and the default account both live on the server, so read the
  // applied values on mount rather than showing a guess.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/market/config", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const config = (await res.json()) as MarketConfig;
        if (cancelled) return;
        setSettings((prev) => ({
          ...prev,
          pollIntervalSec: config.pollIntervalSec,
          layer1CountPerExchange: config.layer1CountPerExchange,
        }));
      } catch {
        // Leaving the defaults on screen is better than blocking the page.
      }
      try {
        const stored = await apiFetch<{ defaultAccount: AccountType }>("/api/settings/defaults");
        if (cancelled) return;
        setSettings((prev) => ({ ...prev, defaultAccount: stored.defaultAccount }));
      } catch {
        // Same reasoning: the field shows its default rather than an error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = (next: Partial<GeneralSettings>) =>
    setSettings((prev) => ({ ...prev, ...next }));

  /**
   * Saves the default account immediately on click.
   *
   * Deliberately not folded into the page's Save button: that one applies market
   * cadence, and a picker that looked applied but was not saved is exactly the
   * failure these settings had before.
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

  const onSave = useCallback(async () => {
    setSaveState("saving");
    setError(null);
    try {
      const res = await fetch("/api/market/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pollIntervalSec: settings.pollIntervalSec,
          layer1CountPerExchange: settings.layer1CountPerExchange,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      // The server clamps out-of-range values, so adopt what it applied.
      const applied = (await res.json()) as MarketConfig;
      setSettings((prev) => ({
        ...prev,
        pollIntervalSec: applied.pollIntervalSec,
        layer1CountPerExchange: applied.layer1CountPerExchange,
      }));
      setSaveState("saved");
      toast.success("Market settings applied", {
        description: `Ranking every ${applied.pollIntervalSec}s · ${applied.layer1CountPerExchange} layer 1 pairs per venue`,
      });
      setTimeout(() => setSaveState("idle"), 1800);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setSaveState("error");
      toast.error("Could not save market settings", { description: message });
    }
  }, [settings.pollIntervalSec, settings.layer1CountPerExchange]);

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-6">
      <PageHeader
        title="General Settings"
        description="Market data cadence, subscription depth, and application preferences."
        actions={
          <Button
            size="sm"
            className="h-8 gap-1.5"
            disabled={saveState === "saving"}
            onClick={() => void onSave()}
          >
            {saveState === "saving" ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
            ) : saveState === "saved" ? (
              <Check aria-hidden className="size-3.5" />
            ) : (
              <Save aria-hidden className="size-3.5" />
            )}
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : "Save"}
          </Button>
        }
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Market Data</CardTitle>
          <Badge variant="secondary" className="text-[10px]">applies immediately</Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="poll" className="text-xs text-muted-foreground">
              Pair ranking interval (seconds)
            </Label>
            <Input
              id="poll"
              type="number"
              min={10}
              max={600}
              value={settings.pollIntervalSec}
              onChange={(e) => patch({ pollIntervalSec: Number(e.target.value) })}
              className="max-w-[8rem] font-mono text-xs num"
            />
            <p className="text-[10px] text-muted-foreground">
              How often each venue is polled to decide which pairs to watch. Funding rates and
              prices themselves always come from the live streams, never from this poll.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="layer1" className="text-xs text-muted-foreground">
              Layer 1 pairs per exchange
            </Label>
            <Input
              id="layer1"
              type="number"
              min={1}
              max={50}
              value={settings.layer1CountPerExchange}
              onChange={(e) => patch({ layer1CountPerExchange: Number(e.target.value) })}
              className="max-w-[8rem] font-mono text-xs num"
            />
            <p className="text-[10px] text-muted-foreground">
              Each venue streams its own top pairs by funding rate. Layer 2 then fills in the same
              coins on every other venue that lists them, so raising this widens the whole board.
            </p>
          </div>

          {error && (
            <Alert variant="error" className="text-[11px]">
              {error}
            </Alert>
          )}
        </CardContent>
      </Card>

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
