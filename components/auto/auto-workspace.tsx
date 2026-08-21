"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/page-header";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DeploymentList } from "@/components/auto/deployment-list";
import { DeployDialog, type AvailableStrategy } from "@/components/auto/deploy-dialog";
import { FundingSyncCard } from "@/components/auto/fundingsync-card";
import { FundingSyncConfig } from "@/components/auto/fundingsync-config";
import { PerpBridgeCard } from "@/components/auto/perpbridge-card";
import { PerpBridgeConfigForm } from "@/components/auto/perpbridge-config";
import { FundingBridgeCard } from "@/components/auto/fundingbridge-card";
import { FundingBridgeConfigForm } from "@/components/auto/fundingbridge-config";
import { FundingYieldCard } from "@/components/auto/fundingyield-card";
import { FundingYieldConfigForm } from "@/components/auto/fundingyield-config";
import { apiFetch } from "@/lib/api/client";
import type {
  AccountType,
  ExposureState,
  FundingBridgeConfig,
  FundingYieldConfig,
  PerpBridgeConfig,
  StrategyConfig,
  StrategyListItem,
  StrategySnapshot,
} from "@/lib/types";
import { DEFAULT_TAKER_FEES } from "@/lib/fees-shared";
import { toast } from "sonner";
import { ArrowLeft, Pencil, RefreshCw, Trash2 } from "lucide-react";

type Tab = "monitor" | "config";

interface AutoWorkspaceProps {
  accountType: AccountType;
}

interface ListResponse {
  accountType: AccountType;
  deployments: StrategyListItem[];
  exposure: ExposureState;
}

interface DeploymentsResponse extends ListResponse {
  available: AvailableStrategy[];
}

/** Whatever shape the selected deployment stores; narrowed before it reaches a form. */
type AnyConfig =
  | StrategyConfig
  | PerpBridgeConfig
  | FundingBridgeConfig
  | FundingYieldConfig;

/**
 * Shared workspace for Auto Live and Auto Paper.
 *
 * Two views in one page: the deployment list, and one deployment's detail. Kept as a
 * single route so returning to the list is instant and the poll never has to be torn
 * down and rebuilt — with several deployments to watch, a page transition per click
 * would mean a fresh load of everything each time.
 */
export function AutoWorkspace({ accountType }: AutoWorkspaceProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("monitor");
  const [list, setList] = useState<StrategyListItem[] | null>(null);
  const [exposure, setExposure] = useState<ExposureState | null>(null);
  const [available, setAvailable] = useState<AvailableStrategy[]>([]);
  const [snapshot, setSnapshot] = useState<StrategySnapshot | null>(null);
  const [draft, setDraft] = useState<AnyConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [deployOpen, setDeployOpen] = useState(false);
  const [renaming, setRenaming] = useState<StrategyListItem | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleting, setDeleting] = useState<StrategyListItem | null>(null);

  const isLive = accountType === "live";
  /**
   * Set while a toggle or run is in flight. The 5s poll can have a request already
   * on the wire when the user flips a switch; without this its stale answer lands
   * afterwards and the switch appears to snap back.
   */
  const mutating = useRef(false);
  /**
   * The selected deployment, readable inside the poll without making `load` depend
   * on it — a changing dependency would tear down and rebuild the interval on every
   * drill-in. Written in an effect rather than during render.
   */
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const load = useCallback(async () => {
    // Nothing is set before the first await, so this is safe from an effect.
    try {
      const target = selectedRef.current;
      const listResult = await apiFetch<ListResponse>(`/api/auto/state?account=${accountType}`);
      if (!mutating.current) {
        setList(listResult.deployments);
        setExposure(listResult.exposure);
      }

      if (target) {
        try {
          const detail = await apiFetch<StrategySnapshot>(
            `/api/auto/state?account=${accountType}&deployment=${encodeURIComponent(target)}`,
          );
          if (!mutating.current) {
            setSnapshot(detail);
            setDraft((prev) => prev ?? detail.config);
          }
        } catch {
          // The deployment was deleted while this view was open. Fall back to the
          // list rather than leaving a stale panel that looks like a live engine.
          selectedRef.current = null;
          setSelected(null);
          setSnapshot(null);
          setDraft(null);
        }
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [accountType]);

  /** Deployable strategies with their suggested names, fetched when the dialog opens. */
  const loadAvailable = useCallback(async () => {
    try {
      const result = await apiFetch<DeploymentsResponse>(
        `/api/auto/deployments?account=${accountType}`,
      );
      setAvailable(result.available);
      setList(result.deployments);
      setExposure(result.exposure);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [accountType]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => {
      setNowMs(Date.now());
      void load();
    }, 5_000);
    return () => clearInterval(t);
  }, [load]);

  const openDeployment = useCallback(
    (deploymentId: string) => {
      // Clear the previous deployment's detail so its config cannot be shown under
      // the new one's heading for a frame.
      setSnapshot(null);
      setDraft(null);
      setConfigError(null);
      setTab("monitor");
      setSelected(deploymentId);
      // Set here as well as in the effect: `load` reads the ref, and this call
      // happens before the effect has run.
      selectedRef.current = deploymentId;
      void load();
    },
    [load],
  );

  const backToList = useCallback(() => {
    setSelected(null);
    selectedRef.current = null;
    setSnapshot(null);
    setDraft(null);
    setConfigError(null);
  }, []);

  const onToggle = useCallback(
    async (deploymentId: string, enabled: boolean) => {
      setBusy(deploymentId);
      mutating.current = true;
      setError(null);
      const label = list?.find((i) => i.deploymentId === deploymentId)?.label ?? deploymentId;
      try {
        await apiFetch("/api/auto/control", {
          method: "POST",
          json: { deployment: deploymentId, action: "toggle", enabled },
        });
        toast.success(enabled ? "Deployment switched on" : "Deployment switched off", {
          description: `${label} on the ${accountType} account.`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        toast.error(enabled ? "Could not switch on" : "Could not switch off", {
          description: message,
        });
      } finally {
        mutating.current = false;
        setBusy(null);
        // Re-read both views so the list and the detail agree.
        await load();
      }
    },
    [accountType, list, load],
  );

  const onRunNow = useCallback(async () => {
    if (!selected) return;
    setRunning(true);
    mutating.current = true;
    setError(null);
    try {
      const result = await apiFetch<{
        actions: number;
        reason: string | null;
        state: StrategySnapshot;
      }>("/api/auto/control", {
        method: "POST",
        json: { deployment: selected, action: "run" },
      });
      setSnapshot(result.state);
      if (result.reason) setError(`Cycle did nothing: ${result.reason}`);
      else
        toast.success("Cycle run", {
          description: `${result.actions} action${result.actions === 1 ? "" : "s"} taken on ${
            result.state.label
          }.`,
        });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error("Cycle failed", { description: message });
    } finally {
      mutating.current = false;
      setRunning(false);
    }
  }, [selected]);

  const onSaveConfig = useCallback(async () => {
    if (!draft || !selected) return;
    setSaving(true);
    setConfigError(null);
    try {
      const result = await apiFetch<{
        config: AnyConfig;
        state: StrategySnapshot;
      }>("/api/auto/config", {
        method: "POST",
        json: { deployment: selected, config: draft },
      });
      setDraft(result.config);
      setSnapshot(result.state);
      toast.success("Configuration saved", {
        description: `${result.state.label} now runs on the saved settings.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setConfigError(message);
      toast.error("Could not save configuration", { description: message });
    } finally {
      setSaving(false);
    }
  }, [draft, selected]);

  const item = list?.find((i) => i.deploymentId === selected) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-6">
      <PageHeader
        title={isLive ? "Auto Live" : "Auto Paper"}
        description={
          selected
            ? `${item?.label ?? snapshot?.label ?? selected} · ${item?.strategyName ?? ""} on the ${accountType} account.`
            : isLive
              ? "Strategy deployments running against your live account with real funds."
              : "Strategy deployments running against the simulated account, valued at live prices."
        }
        badge={isLive ? "Live" : "Paper"}
        actions={
          <>
            {selected && (
              <Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={backToList}>
                <ArrowLeft aria-hidden className="size-3.5" />
                Deployments
              </Button>
            )}
            {selected && item && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5"
                  onClick={() => {
                    setRenameDraft(item.label);
                    setRenaming(item);
                  }}
                >
                  <Pencil aria-hidden className="size-3.5" />
                  Rename
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 text-negative hover:text-negative/85"
                  onClick={() => setDeleting(item)}
                >
                  <Trash2 aria-hidden className="size-3.5" />
                  Delete
                </Button>
              </>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw aria-hidden className="size-3.5" />
              Refresh
            </Button>
            {selected && (
              <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
                <TabsList>
                  <TabsTrigger value="monitor" className="text-xs">
                    Monitor
                  </TabsTrigger>
                  <TabsTrigger value="config" className="text-xs">
                    Configuration
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            )}
            {!selected && list && (
              <Badge variant="secondary" className="text-[10px]">
                {list.filter((i) => i.run.active).length} active
              </Badge>
            )}
          </>
        }
      />

      {isLive && !selected && (
        <Alert variant="error" className="text-[11px]">
          When armed and switched on, these open and close real hedged positions without asking. Run
          them on the paper account first and compare the logs against what you expect.
        </Alert>
      )}

      {error && <Alert variant="error">{error}</Alert>}

      {!list && loading && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}

      {list && !selected && (
        <DeploymentList
          items={list}
          exposure={exposure}
          busy={busy}
          onOpen={openDeployment}
          onToggle={(id, enabled) => void onToggle(id, enabled)}
          onDeploy={() => {
            void loadAvailable();
            setDeployOpen(true);
          }}
        />
      )}

      {selected && !snapshot && loading && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}

      {selected && snapshot && tab === "monitor" && (
        <MonitorFor
          snapshot={snapshot}
          nowMs={nowMs}
          busy={busy === snapshot.deploymentId}
          running={running}
          onToggle={(enabled) => void onToggle(snapshot.deploymentId, enabled)}
          onRunNow={() => void onRunNow()}
        />
      )}

      {selected && snapshot && draft && tab === "config" && (
        <ConfigFor
          snapshot={snapshot}
          draft={draft}
          onChange={setDraft}
          saving={saving}
          error={configError}
          onSave={() => void onSaveConfig()}
        />
      )}

      <DeployDialog
        open={deployOpen}
        onOpenChange={setDeployOpen}
        accountType={accountType}
        available={available}
        onDeployed={(deploymentId) => {
          setDeployOpen(false);
          toast.success("Strategy deployed", {
            description: `Switched off on default settings — set its venues and thresholds on the ${accountType} account before arming it.`,
          });
          // Straight into its configuration: a new deployment starts switched off on
          // default settings, so the venues and thresholds are the next thing needed.
          openDeployment(deploymentId);
          setTab("config");
        }}
      />

      <ConfirmDialog
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        title="Rename deployment"
        description="The name appears in logs and alerts, so it is worth making it say what this deployment does."
        confirmLabel="Rename"
        onConfirm={async () => {
          if (!renaming) return;
          const previous = renaming.label;
          await apiFetch("/api/auto/deployments", {
            method: "POST",
            json: { action: "rename", deployment: renaming.deploymentId, label: renameDraft },
          });
          setRenaming(null);
          toast.success("Deployment renamed", {
            description: `${previous} is now ${renameDraft}.`,
          });
          await load();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rename-deployment" className="text-xs text-muted-foreground">
            Name
          </Label>
          <Input
            id="rename-deployment"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            placeholder="e.g. Asia CEX pairs"
            maxLength={40}
            autoComplete="off"
          />
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete deployment"
        description="Removes this deployment and its configuration. Its settled history is kept."
        confirmLabel="Delete deployment"
        destructive
        warning="Refused while it still holds a hedge — an open position with no engine managing its exit would sit there unattended. Switch it off and close its hedges first."
        details={
          deleting
            ? [
                { label: "Deployment", value: deleting.label, emphasis: true },
                { label: "Strategy", value: deleting.strategyName },
                { label: "Open hedges", value: String(deleting.openPositions) },
              ]
            : []
        }
        onConfirm={async () => {
          if (!deleting) return;
          const removed = deleting.label;
          await apiFetch("/api/auto/deployments", {
            method: "POST",
            json: { action: "delete", deployment: deleting.deploymentId },
          });
          setDeleting(null);
          backToList();
          toast.success("Deployment deleted", {
            description: `${removed} is gone; its settled history is kept.`,
          });
          await load();
        }}
      />
    </div>
  );
}

interface MonitorProps {
  snapshot: StrategySnapshot;
  nowMs: number;
  busy: boolean;
  running: boolean;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
}

/**
 * Picks the monitor for the loaded snapshot.
 *
 * Switched on `snapshot.strategy` rather than on the selected id: the snapshot is what
 * carries the config being rendered, so keying off anything else could pair one
 * strategy's card with another's numbers during the frame after a switch.
 */
function MonitorFor({ snapshot, ...rest }: MonitorProps) {
  switch (snapshot.strategy) {
    case "perpbridge":
      return <PerpBridgeCard snapshot={snapshot} {...rest} />;
    case "fundingbridge":
      return <FundingBridgeCard snapshot={snapshot} {...rest} />;
    case "fundingyield":
      return <FundingYieldCard snapshot={snapshot} {...rest} />;
    default:
      return <FundingSyncCard snapshot={snapshot} {...rest} />;
  }
}

interface ConfigProps {
  snapshot: StrategySnapshot;
  draft: AnyConfig;
  onChange: (config: AnyConfig) => void;
  saving: boolean;
  error: string | null;
  onSave: () => void;
}

/** Picks the configuration form, narrowing the draft to that strategy's shape. */
function ConfigFor({ snapshot, draft, onChange, saving, error, onSave }: ConfigProps) {
  switch (snapshot.strategy) {
    case "perpbridge": {
      const config = draft as PerpBridgeConfig;
      return (
        <PerpBridgeConfigForm
          config={config}
          onChange={onChange}
          saving={saving}
          error={error}
          feeCostPct={roundTripFeeEstimate(config.venues)}
          onSave={onSave}
        />
      );
    }
    case "fundingbridge": {
      const config = draft as FundingBridgeConfig;
      return (
        <FundingBridgeConfigForm
          config={config}
          onChange={onChange}
          saving={saving}
          error={error}
          feeCostPct={roundTripFeeEstimate(config.venues)}
          onSave={onSave}
        />
      );
    }
    case "fundingyield": {
      const config = draft as FundingYieldConfig;
      return (
        <FundingYieldConfigForm
          config={config}
          onChange={onChange}
          saving={saving}
          error={error}
          feeCostPct={roundTripFeeEstimate(config.venues)}
          onSave={onSave}
        />
      );
    }
    default:
      return (
        <FundingSyncConfig
          config={draft as StrategyConfig}
          onChange={onChange}
          saving={saving}
          error={error}
          onSave={onSave}
        />
      );
  }
}

/**
 * Worst-case round trip fee for a venue set, matching what the server applies.
 *
 * Uses the shipped defaults rather than the saved fee table: this is a hint next to
 * an input, and fetching the table would add a request to every config render. The
 * server's own gate uses the saved values, so the number shown can be slightly
 * stale — never the one that decides a trade.
 */
function roundTripFeeEstimate(venues: readonly string[]): number {
  const pcts = venues
    .map((v) => DEFAULT_TAKER_FEES[v as keyof typeof DEFAULT_TAKER_FEES] ?? 0.06)
    .sort((a, b) => b - a);
  if (pcts.length === 0) return 0;
  return Number((((pcts[0] ?? 0) + (pcts[1] ?? pcts[0] ?? 0)) * 2).toFixed(6));
}
