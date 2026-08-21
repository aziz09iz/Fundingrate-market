"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/page-skeleton";
import { BalanceOverview } from "@/components/rebalance/balance-overview";
import { TransferForm, type TransferPrefill } from "@/components/rebalance/transfer-form";
import {
  TransferHistory,
  type TransferEventView,
} from "@/components/rebalance/transfer-history";
import { RebalanceAutomation } from "@/components/rebalance/rebalance-automation";
import { DestinationSettings } from "@/components/rebalance/destination-settings";
import { apiFetch } from "@/lib/api/client";
import { useTabParam } from "@/lib/hooks/use-tab-param";
import type {
  RebalanceConfig,
  RebalanceOverview,
  RebalanceSuggestion,
  TransferRecord,
} from "@/lib/types";
import { Loader2, RefreshCw } from "lucide-react";

type Tab = "overview" | "transfer" | "destinations" | "history" | "automation";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "transfer", label: "Transfer" },
  { id: "destinations", label: "Destinations" },
  { id: "history", label: "History" },
  { id: "automation", label: "Automation" },
];

const TAB_IDS = TABS.map((t) => t.id) as readonly Tab[];

interface HistoryResponse {
  transfers: TransferRecord[];
  events: TransferEventView[];
  syncErrors: string[];
}

function RebalanceWorkspace() {
  const [tab, setTab] = useTabParam<Tab>("tab", TAB_IDS, "overview");
  const [overview, setOverview] = useState<RebalanceOverview | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [draft, setDraft] = useState<RebalanceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ value: TransferPrefill; key: string } | undefined>();

  const load = useCallback(async (options: { notify?: boolean } = {}) => {
    // Nothing is set before the first await, so this is safe to call from an
    // effect without triggering a cascading render.
    try {
      const result = await apiFetch<RebalanceOverview>("/api/rebalance/overview");
      setOverview(result);
      // The draft is seeded once and then owned by the form until it is saved,
      // so a background refresh cannot discard edits in progress.
      setDraft((prev) => prev ?? result.config);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      if (options.notify) toast.error("Could not load balances", { description: message });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async (sync = false) => {
    try {
      const result = await apiFetch<HistoryResponse>(
        `/api/rebalance/history${sync ? "?sync=1" : ""}`,
      );
      setHistory(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([load({ notify: true }), loadHistory(true)]);
    } finally {
      setRefreshing(false);
    }
  }, [load, loadHistory]);

  useEffect(() => {
    void (async () => {
      await Promise.all([load(), loadHistory()]);
    })();
  }, [load, loadHistory]);

  useEffect(() => {
    const t = setInterval(() => {
      void load();
      void loadHistory();
    }, 30_000);
    return () => clearInterval(t);
  }, [load, loadHistory]);

  const onApply = useCallback(
    (s: RebalanceSuggestion) => {
      setPrefill({
        value: { from: s.from, to: s.to, token: s.token, amount: s.amount },
        key: `${s.id}-${Date.now()}`,
      });
      setTab("transfer");
    },
    [setTab],
  );

  const onSaveConfig = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const result = await apiFetch<{ config: RebalanceConfig }>("/api/rebalance/config", {
        method: "POST",
        json: draft,
      });
      setDraft(result.config);
      toast.success("Rebalancing settings saved");
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error("Could not save settings", { description: message });
    } finally {
      setSaving(false);
    }
  }, [draft, load]);

  const onEvaluate = useCallback(async () => {
    setEvaluating(true);
    setError(null);
    try {
      const result = await apiFetch<{ evaluated: number; executed: number; reason: string | null }>(
        "/api/rebalance/automation",
        { method: "POST", json: { action: "evaluate" } },
      );
      if (result.reason) {
        setError(`Evaluation: ${result.reason}`);
        toast.warning("Evaluation made no transfers", { description: result.reason });
      } else {
        toast.success(
          `Evaluated ${result.evaluated} suggestion${result.evaluated === 1 ? "" : "s"}`,
          {
            description:
              result.executed > 0
                ? `${result.executed} transfer${result.executed === 1 ? "" : "s"} executed.`
                : "Nothing met the thresholds.",
          },
        );
      }
      await Promise.all([load(), loadHistory()]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error("Evaluation failed", { description: message });
    } finally {
      setEvaluating(false);
    }
  }, [load, loadHistory]);

  /**
   * Venues the automation may be pointed at.
   *
   * Sources and destinations are different sets on purpose: an on-chain venue can
   * receive a deposit but cannot sign a withdrawal here, so listing it as a
   * possible source would offer a transfer that always fails.
   */
  const sourceVenues = useMemo(
    () =>
      (overview?.balances ?? [])
        .filter((b) => b.walletSupported !== false && b.transferSource !== false)
        .map((b) => b.exchange),
    [overview],
  );

  const destinationVenues = useMemo(
    () =>
      (overview?.balances ?? [])
        .filter((b) => b.walletSupported !== false && b.destinationAllowlisted === true)
        .map((b) => b.exchange),
    [overview],
  );

  const automationBadge = overview?.automation.active
    ? { label: "Automation live", className: "text-negative" }
    : overview?.automation.enabled
      ? { label: "On, not armed", className: "text-warning" }
      : null;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-6">
      <PageHeader
        title="Treasury Rebalancing"
        description="Move USDT/USDC between venues to keep margin healthy and capital evenly spread across centralized and on-chain accounts."
        actions={
          <>
            {automationBadge && (
              <Badge variant="secondary" className={`text-[10px] ${automationBadge.className}`}>
                {automationBadge.label}
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
            <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
              <TabsList>
                {TABS.map((t) => (
                  <TabsTrigger key={t.id} value={t.id} className="text-xs">
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </>
        }
      />

      <Alert variant="error" className="text-[11px]">
        Transfers here are real on-chain withdrawals and cannot be reversed. Funds can only go to an
        address configured under Destinations, and only after that address has been explicitly armed.
      </Alert>

      {error && <Alert variant="error">{error}</Alert>}

      {!overview && loading && <PageSkeleton cards={3} rows={6} filters={false} />}

      {overview && tab === "overview" && (
        <BalanceOverview
          balances={overview.balances}
          suggestions={overview.suggestions}
          unsupportedVenues={overview.unsupportedVenues}
          onApply={onApply}
        />
      )}

      {overview && tab === "transfer" && (
        <TransferForm
          key={prefill?.key ?? "blank"}
          balances={overview.balances}
          prefill={prefill?.value}
          onSubmitted={() => {
            void load();
            void loadHistory();
            setTab("history");
          }}
        />
      )}

      {tab === "destinations" && <DestinationSettings onChanged={() => void load()} />}

      {tab === "history" && (
        <TransferHistory
          transfers={history?.transfers ?? []}
          events={history?.events ?? []}
          syncErrors={history?.syncErrors ?? []}
        />
      )}

      {overview && draft && tab === "automation" && (
        <RebalanceAutomation
          config={draft}
          onChange={setDraft}
          suggestions={overview.suggestions}
          balances={overview.balances}
          automation={overview.automation}
          sourceVenues={sourceVenues}
          destinationVenues={destinationVenues}
          saving={saving}
          evaluating={evaluating}
          onSave={() => void onSaveConfig()}
          onEvaluate={() => void onEvaluate()}
        />
      )}
    </div>
  );
}

export default function ExchangeRebalancingPage() {
  // The tab hook reads useSearchParams, which requires a Suspense boundary.
  return (
    <Suspense fallback={<PageSkeleton cards={3} rows={6} filters={false} />}>
      <RebalanceWorkspace />
    </Suspense>
  );
}
