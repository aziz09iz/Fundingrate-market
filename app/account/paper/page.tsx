"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/page-skeleton";
import { AccountDetail, type CloseHedgeInput } from "@/components/account-detail";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { apiFetch } from "@/lib/api/client";
import { DEFAULT_PAPER_BALANCE } from "@/lib/types";
import type { AccountOverview, PaperAccountState } from "@/lib/types";
import { formatAgo } from "@/lib/utils";
import { Loader2, RefreshCw, RotateCcw } from "lucide-react";

interface PaperResponse {
  overview: AccountOverview;
  state: PaperAccountState;
}

export default function PaperAccountPage() {
  const [data, setData] = useState<PaperResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetAmount, setResetAmount] = useState(String(DEFAULT_PAPER_BALANCE));
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async (options: { notify?: boolean } = {}) => {
    // No state is touched before the first await: setting state synchronously
    // inside an effect body triggers cascading renders.
    try {
      const result = await apiFetch<PaperResponse>("/api/paper/account");
      setData(result);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      if (options.notify) toast.error("Could not load paper account", { description: message });
    } finally {
      setLoading(false);
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load({ notify: true });
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  useEffect(() => {
    // Wrapped in an async callback: a synchronous call in an effect body would
    // schedule the first setState as a cascading render.
    void (async () => {
      await load();
    })();
  }, [load]);

  // Positions are valued against live marks, so refresh on a slow cadence to
  // keep unrealized PnL current without hammering the endpoint.
  useEffect(() => {
    const t = setInterval(() => {
      setNowMs(Date.now());
      void load();
    }, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const onReset = async () => {
    const amount = Number(resetAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Starting balance must be a positive number");
    }
    const result = await apiFetch<PaperResponse>("/api/paper/reset", {
      method: "POST",
      json: { startingBalance: amount },
    });
    setData(result);
    toast.success("Paper account reset", {
      description: `Balance set to $${amount.toLocaleString()}. History cleared.`,
    });
  };

  /**
   * Closes every leg of a hedge, sequentially.
   *
   * Sequential rather than parallel: the two legs write to the same paper state
   * row, and a failure on the second leg should leave the first one closed and
   * visible rather than racing to a total that reflects neither.
   */
  const onCloseHedge = useCallback(
    async ({ legs, fraction }: CloseHedgeInput) => {
      const failures: string[] = [];
      let closed = 0;
      let overview: PaperResponse["overview"] | null = null;

      for (const leg of legs) {
        const size = Number((leg.size * fraction).toFixed(8));
        if (!(size > 0)) continue;
        try {
          const result = await apiFetch<{ overview: PaperResponse["overview"] }>(
            "/api/paper/position/close",
            {
              method: "POST",
              json: { exchange: leg.exchange, coin: leg.coin, side: leg.side, size },
            },
          );
          overview = result.overview;
          closed += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push(`${leg.side} ${leg.exchange}: ${message}`);
        }
      }

      if (overview) setData((prev) => (prev ? { ...prev, overview } : prev));
      await load();

      // A hedge half-closed is directional exposure, so a partial failure is
      // reported as a failure rather than folded into a success message.
      if (failures.length > 0) {
        const detail = failures.join(" · ");
        setError(detail);
        toast.error(
          closed > 0
            ? `Closed ${closed} of ${legs.length} legs — the rest failed`
            : "Could not close this position",
          { description: detail },
        );
        throw new Error(detail);
      }

      toast.success(
        legs.length > 1 ? "Hedge closed" : "Position closed",
        {
          description: `${legs[0]?.coin ?? ""} · ${Math.round(fraction * 100)}% of ${legs.length} leg${legs.length === 1 ? "" : "s"}`.trim(),
        },
      );
    },
    [load],
  );

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-6">
      <PageHeader
        title="Paper Account"
        description="Simulated trading valued against live market prices — no real funds at risk."
        badge="Paper"
        actions={
          <>
            {data && (
              <Badge variant="secondary" className="text-[10px]">
                reset {formatAgo(data.state.resetAt, nowMs)}
              </Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => void onRefresh()}
              disabled={loading || refreshing}
            >
              {refreshing ? (
                <Loader2 aria-hidden className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw aria-hidden className="size-3.5" />
              )}
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-negative hover:text-negative"
              onClick={() => {
                setResetAmount(String(data?.state.startingBalance ?? DEFAULT_PAPER_BALANCE));
                setResetOpen(true);
              }}
              disabled={!data}
            >
              <RotateCcw aria-hidden className="size-3.5" />
              Reset Account
            </Button>
          </>
        }
      />

      {error && <Alert variant="error">{error}</Alert>}

      {!data && loading && <PageSkeleton cards={4} rows={6} filters={false} />}

      {data && <AccountDetail data={data.overview} onCloseHedge={onCloseHedge} />}

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset paper account"
        description="Clears all simulated positions, orders, trades and PnL history, then sets the balance to the amount below."
        confirmLabel="Reset account"
        destructive
        warning="This deletes the entire paper history and cannot be undone. Live account data is untouched."
        // The word, not just a click: this wipes every recorded trade.
        challenge={{ value: "RESET", label: "Type RESET to confirm" }}
        details={[
          { label: "Current balance", value: `$${(data?.overview.balance ?? 0).toLocaleString()}` },
          { label: "Open positions", value: String(data?.overview.positions.length ?? 0) },
          { label: "Trades on record", value: String(data?.overview.recentTrades.length ?? 0) },
          { label: "New balance", value: `$${Number(resetAmount || 0).toLocaleString()}`, emphasis: true },
        ]}
        onConfirm={onReset}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reset-amount" className="text-xs text-muted-foreground">
            Starting balance (USDT)
          </Label>
          <Input
            id="reset-amount"
            type="number"
            min={1}
            step={100}
            value={resetAmount}
            onChange={(e) => setResetAmount(e.target.value)}
            className="font-mono text-xs num"
          />
          <p className="text-[10px] text-muted-foreground">
            Default is {DEFAULT_PAPER_BALANCE.toLocaleString()}.
          </p>
        </div>
      </ConfirmDialog>
    </div>
  );
}
