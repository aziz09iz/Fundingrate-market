"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { apiFetch } from "@/lib/api/client";
import type { ExchangeId } from "@/lib/types";
import { EXCHANGES, exchangeInfo, formatSignedPct } from "@/lib/utils";
import { Check, Loader2, RotateCcw, Save } from "lucide-react";

type Rates = Record<ExchangeId, number>;

interface FeeResponse {
  rates: Rates;
  defaults: Rates;
}

type SaveState = "idle" | "saving" | "saved";

/**
 * Taker fees charged to the paper account, per venue.
 *
 * Editable because this app cannot see your VIP tier or fee-token discount, and
 * a hedge round trip pays these four times — two legs in, two legs out — so the
 * number materially changes whether a paper result is believable.
 */
export function FeeSettings() {
  const [rates, setRates] = useState<Rates | null>(null);
  const [defaults, setDefaults] = useState<Rates | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await apiFetch<FeeResponse>("/api/settings/fees");
      setRates(result.rates);
      setDefaults(result.defaults);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const onSave = useCallback(async () => {
    if (!rates) return;
    setSaveState("saving");
    setError(null);
    try {
      const result = await apiFetch<FeeResponse>("/api/settings/fees", {
        method: "POST",
        json: { rates },
      });
      setRates(result.rates);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1800);
      toast.success("Paper trading fees saved", {
        description: `Taker fees for ${Object.keys(result.rates).length} venues stored. Applied to every simulated fill from now on.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setSaveState("idle");
      toast.error("Could not save paper trading fees", { description: message });
    }
  }, [rates]);

  const roundTrip = rates
    ? Object.values(rates).reduce((sum, r) => sum + r, 0) / Object.values(rates).length * 4
    : 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between py-3">
        <CardTitle className="text-sm">Paper Trading Fees</CardTitle>
        <div className="flex items-center gap-1.5">
          <Badge variant="secondary" className="text-[10px]">taker %, per venue</Badge>
          {defaults && rates && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => setRates({ ...defaults })}
            >
              <RotateCcw aria-hidden className="size-3" />
              Defaults
            </Button>
          )}
          <Button
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => void onSave()}
            disabled={!rates || saveState === "saving"}
          >
            {saveState === "saving" ? (
              <Loader2 aria-hidden className="size-3 animate-spin" />
            ) : saveState === "saved" ? (
              <Check aria-hidden className="size-3" />
            ) : (
              <Save aria-hidden className="size-3" />
            )}
            {saveState === "saved" ? "Saved" : "Save"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-[10px] text-muted-foreground">
          Charged on every simulated fill and deducted from realized PnL, so a paper hedge pays
          these four times per round trip — currently about {formatSignedPct(roundTrip, 3)} of
          notional. Live trades use whatever the venue actually charges; this table does not affect
          them.
        </p>

        {rates && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {EXCHANGES.map((ex) => (
              <div key={ex.id} className="flex flex-col gap-1">
                <Label
                  htmlFor={`fee-${ex.id}`}
                  className={`text-xs ${exchangeInfo(ex.id).accent}`}
                >
                  {ex.name}
                </Label>
                <Input
                  id={`fee-${ex.id}`}
                  type="number"
                  step="0.001"
                  min={0}
                  max={1}
                  value={rates[ex.id]}
                  onChange={(e) =>
                    setRates((prev) =>
                      prev ? { ...prev, [ex.id]: Number(e.target.value) } : prev,
                    )
                  }
                  className="font-mono text-xs"
                />
              </div>
            ))}
          </div>
        )}

        {error && <Alert variant="error" className="text-[11px]">{error}</Alert>}
      </CardContent>
    </Card>
  );
}
