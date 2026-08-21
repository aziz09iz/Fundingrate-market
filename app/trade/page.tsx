"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { PageSkeleton } from "@/components/page-skeleton";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { OrderForm, type OrderFormPrefill } from "@/components/trade/order-form";
import { VenueQuotes } from "@/components/trade/venue-quotes";
import { OpenOrders } from "@/components/trade/open-orders";
import { useMarketStream, type StreamStatus } from "@/lib/hooks/use-market-stream";
import { apiFetch } from "@/lib/api/client";
import {
  findRow,
  hedgeEntrySpreadPct,
  intentOf,
  intentReleasable,
  nextOrderId,
  queuedToOrder,
  type OrderIntent,
  type QueuedIntent,
} from "@/lib/trade-orders";
import type {
  AccountOverview,
  AccountType,
  CredentialStatus,
  ExchangeId,
  LiveAccountSnapshot,
  MarketSnapshot,
  Order,
} from "@/lib/types";
import { EXCHANGE_IDS, cn, exchangeName, formatPrice, formatSignedPct } from "@/lib/utils";
import { Loader2, Radio, RefreshCw, WifiOff } from "lucide-react";

function isExchangeId(value: string | null): value is ExchangeId {
  return value !== null && (EXCHANGE_IDS as string[]).includes(value);
}

const STATUS_LABEL: Record<StreamStatus, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

const STATUS_CLASS: Record<StreamStatus, string> = {
  connecting: "text-warning",
  live: "text-positive",
  reconnecting: "text-warning",
  offline: "text-negative",
};

/** An icon per state, so the badge does not depend on colour alone. */
const STATUS_ICON: Record<StreamStatus, typeof Radio> = {
  connecting: Loader2,
  live: Radio,
  reconnecting: Loader2,
  offline: WifiOff,
};

/**
 * Notional past which a live order asks the user to retype the amount.
 *
 * A mis-click and a deliberate $50k order are the same gesture otherwise. Small
 * orders stay one click, which is the point of picking a threshold rather than
 * challenging everything.
 */
const CHALLENGE_NOTIONAL_USD = 10_000;

interface OrdersResponse {
  paper: { open: Order[]; history: Order[] };
  live: { open: Order[]; history: Order[] };
}

interface LiveAccountResponse {
  snapshot: LiveAccountSnapshot;
  credentials: CredentialStatus[];
}

interface PaperAccountResponse {
  overview: AccountOverview;
}

/** Fresh key per submitted intent, so a retry cannot become a second position. */
function newIdempotencyKey(): string {
  return `frw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface TradeWorkspaceProps {
  initialPair: string;
  /** Account chosen in the URL, so a reload or a shared link keeps it. */
  initialAccount: AccountType;
  prefill?: OrderFormPrefill;
}

function TradeWorkspace({ initialPair, initialAccount, prefill }: TradeWorkspaceProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [requestedPair, setRequestedPair] = useState(initialPair);
  const [account, setAccount] = useState<AccountType>(initialAccount);
  const [orders, setOrders] = useState<OrdersResponse | null>(null);
  const [credentials, setCredentials] = useState<CredentialStatus[]>([]);
  const [liveBalances, setLiveBalances] = useState<LiveAccountSnapshot["balances"]>([]);
  const [paperAvailable, setPaperAvailable] = useState<number | null>(null);
  const [queued, setQueued] = useState<QueuedIntent[]>([]);
  const [pending, setPending] = useState<OrderIntent[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Mirrors the account tab into the URL so back/forward and a reload land where
  // the user was, and a link can point at one account specifically.
  const onAccountChange = useCallback(
    (next: AccountType) => {
      setAccount(next);
      const params = new URLSearchParams(searchParams.toString());
      if (next === "paper") params.delete("account");
      else params.set("account", next);
      const query = params.toString();
      router.replace(query ? `/trade?${query}` : "/trade", { scroll: false });
    },
    [router, searchParams],
  );

  const loadOrders = useCallback(async () => {
    try {
      const result = await apiFetch<OrdersResponse>("/api/orders");
      setOrders(result);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error("Could not load orders", { description: message });
    }
  }, []);

  const loadCredentials = useCallback(async () => {
    try {
      const result = await apiFetch<LiveAccountResponse>("/api/live/account");
      setCredentials(result.credentials);
      setLiveBalances(result.snapshot?.balances ?? []);
    } catch {
      // The form falls back to allowing any venue and letting the server refuse.
      setCredentials([]);
      setLiveBalances([]);
    }
  }, []);

  const loadPaperAccount = useCallback(async () => {
    try {
      const result = await apiFetch<PaperAccountResponse>("/api/paper/account");
      setPaperAvailable(result.overview?.available ?? null);
    } catch {
      // Free collateral is advisory here; the form simply shows no figure.
      setPaperAvailable(null);
    }
  }, []);

  /**
   * Adopts the installation's default account, unless the URL already names one.
   *
   * An explicit ?account= is the user's choice for this visit and outranks the
   * stored default, which is why this only fires when the parameter is absent.
   */
  useEffect(() => {
    if (searchParams.get("account") !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const stored = await apiFetch<{ defaultAccount: AccountType }>("/api/settings/defaults");
        if (!cancelled) setAccount(stored.defaultAccount);
      } catch {
        // Paper stays selected, which is the safe side to fail to.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  /**
   * Submits one intent. Delayed hedges are parked client-side instead: nothing
   * reaches a venue until the two prices converge.
   */
  const submitIntent = useCallback(
    async (intent: OrderIntent, target: AccountType) => {
      const body = {
        exchange: intent.exchange,
        coin: intent.pair,
        side: intent.side,
        orderType: intent.orderType,
        size: intent.size,
        leverage: intent.leverage,
        reduceOnly: intent.reduceOnly ?? false,
        hedgeId: intent.hedgeId,
        ...(intent.orderType === "limit" ? { price: intent.price } : {}),
      };
      if (target === "paper") {
        await apiFetch("/api/paper/order", { method: "POST", json: body });
        return;
      }
      await apiFetch("/api/live/order", {
        method: "POST",
        headers: { "idempotency-key": newIdempotencyKey() },
        json: body,
      });
    },
    [],
  );

  const runSubmission = useCallback(
    async (intents: OrderIntent[], target: AccountType) => {
      setSubmitting(true);
      try {
        // Sequential on purpose: a hedge's second leg should not fire if the
        // first was rejected, and the venue rate limits are per-key anyway.
        for (const intent of intents) {
          await submitIntent(intent, target);
        }
        // Submitting used to be silent: the only evidence was the table
        // refreshing, which on a limit order that rests looks like nothing
        // happened at all.
        toast.success(describeSubmission(intents, target), {
          description:
            intents.length > 1
              ? `${intents.length} legs sent · ${intents[0].pair}`
              : `${intents[0].side} ${intents[0].size} ${intents[0].pair} on ${exchangeName(intents[0].exchange)}`,
        });
        await Promise.all([
          loadOrders(),
          target === "live" ? loadCredentials() : loadPaperAccount(),
        ]);
      } finally {
        setSubmitting(false);
      }
    },
    [submitIntent, loadOrders, loadCredentials, loadPaperAccount],
  );

  /**
   * Releases queued hedges as each snapshot arrives — an external event, rather
   * than an effect watching state.
   */
  const releaseQueued = useCallback(
    (snap: MarketSnapshot) => {
      setQueued((prev) => {
        const ready = prev.filter((q) => intentReleasable(snap, q));
        if (ready.length === 0) return prev;
        const readyIds = new Set(ready.map((q) => q.id));
        // Fire outside the updater so React state stays synchronous here.
        void (async () => {
          for (const target of ["paper", "live"] as const) {
            const batch = ready.filter((q) => q.accountType === target);
            if (batch.length === 0) continue;
            try {
              await runSubmission(batch.map(intentOf), target);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              setError(message);
              toast.error("Queued hedge failed to release", { description: message });
            }
          }
        })();
        return prev.filter((q) => !readyIds.has(q.id));
      });
    },
    [runSubmission],
  );

  const { snapshot, status } = useMarketStream({ onSnapshot: releaseQueued });

  useEffect(() => {
    void (async () => {
      await Promise.all([loadOrders(), loadCredentials(), loadPaperAccount()]);
    })();
  }, [loadOrders, loadCredentials, loadPaperAccount]);

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => void loadOrders(), 15_000);
    return () => clearInterval(t);
  }, [loadOrders]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadOrders(), loadCredentials(), loadPaperAccount()]);
    } finally {
      setRefreshing(false);
    }
  }, [loadOrders, loadCredentials, loadPaperAccount]);

  const availablePairs = useMemo(() => snapshot?.coins ?? [], [snapshot]);
  // Only streamed coins are tradable, so fall back to the first available one.
  const pair = availablePairs.includes(requestedPair) ? requestedPair : (availablePairs[0] ?? "");
  const row = findRow(snapshot, pair);

  const tradableVenues = useMemo(
    () =>
      credentials.length === 0
        ? undefined
        : credentials
            .filter((c) => c.configured && c.enabled && !c.readOnly)
            .map((c) => c.exchange),
    [credentials],
  );

  /**
   * Free collateral for the selected account. Live sums every venue's reported
   * free balance: a hedge draws on two venues, so the total is the honest figure
   * to size against, even though no single venue holds it all.
   */
  const availableUsd = useMemo(() => {
    if (account === "paper") return paperAvailable;
    if (liveBalances.length === 0) return null;
    return liveBalances.reduce((sum, b) => sum + b.available, 0);
  }, [account, paperAvailable, liveBalances]);

  const onSubmit = useCallback(
    (intents: OrderIntent[]) => {
      setError(null);
      const delayed = intents.some((i) => i.executionMode === "delay");
      if (delayed) {
        // Queue rather than send; nothing is confirmed because nothing is sent.
        setQueued((prev) => [
          ...intents.map((intent) => ({
            ...intent,
            id: `Q-${nextOrderId()}`,
            time: Date.now(),
            accountType: account,
          })),
          ...prev,
        ]);
        return;
      }
      if (account === "live") {
        setPending(intents);
        return;
      }
      void (async () => {
        try {
          await runSubmission(intents, "paper");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          toast.error("Paper order rejected", { description: message });
        }
      })();
    },
    [account, runSubmission],
  );

  const onCancel = useCallback(
    async (id: string) => {
      // Queued intents were never sent, so cancelling one is purely local.
      if (id.startsWith("Q-")) {
        setQueued((prev) => prev.filter((q) => q.id !== id));
        toast.success("Queued order removed", {
          description: "It was never sent to a venue.",
        });
        return;
      }
      try {
        if (account === "paper") {
          await apiFetch("/api/paper/order", { method: "DELETE", json: { id } });
        } else {
          await apiFetch("/api/live/order/cancel", { method: "POST", json: { id } });
        }
        toast.success(`Order ${id} cancelled`);
        await loadOrders();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        toast.error(`Could not cancel ${id}`, { description: message });
      }
    },
    [account, loadOrders],
  );

  const bucket = account === "paper" ? orders?.paper : orders?.live;
  const openOrders = useMemo(
    () => [...queued.map(queuedToOrder), ...(bucket?.open ?? [])],
    [queued, bucket],
  );

  // Notional of the pending live order, summed across hedge legs.
  const pendingNotional = useMemo(
    () => (pending ?? []).reduce((sum, i) => sum + i.size * i.price, 0),
    [pending],
  );
  const StatusIcon = STATUS_ICON[status];

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-6">
      <PageHeader
        title="Trade"
        description="Manual perpetual & futures trading with optional cross-venue hedge."
        actions={
          <>
            <Tabs value={account} onValueChange={(v) => onAccountChange(v as AccountType)}>
              <TabsList>
                <TabsTrigger value="paper" className="text-xs">
                  Paper
                </TabsTrigger>
                <TabsTrigger value="live" className="text-xs">
                  Live
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Badge variant="secondary" className={cn("gap-1.5 text-[10px]", STATUS_CLASS[status])}>
              <StatusIcon
                aria-hidden
                className={cn("size-2.5", status === "live" && "animate-pulse")}
              />
              {STATUS_LABEL[status]}
              <span className="text-muted-foreground">{availablePairs.length} pairs</span>
            </Badge>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5"
              disabled={refreshing}
              onClick={() => void onRefresh()}
            >
              {refreshing ? (
                <Loader2 aria-hidden className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw aria-hidden className="size-3.5" />
              )}
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          </>
        }
      />

      {account === "live" && (
        <Alert variant="error" className="text-[11px]">
          Live mode sends real orders with real funds after you confirm. Switch to Paper to simulate
          against the same live quotes without risking anything.
        </Alert>
      )}

      {error && <Alert variant="error">{error}</Alert>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Place Order</CardTitle>
          </CardHeader>
          <CardContent>
            <OrderForm
              pair={pair}
              onPairChange={setRequestedPair}
              availablePairs={availablePairs}
              snapshot={snapshot}
              defaultExchange={prefill?.longExchange ?? "binance"}
              account={account}
              availableUsd={availableUsd}
              tradableVenues={account === "live" ? tradableVenues : undefined}
              submitting={submitting}
              prefill={prefill}
              onSubmit={onSubmit}
            />
          </CardContent>
        </Card>

        <Card className="flex min-h-[28rem] flex-col">
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Venue Quotes</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 p-0">
            <VenueQuotes
              coin={pair}
              row={row}
              longExchange={prefill?.longExchange}
              shortExchange={prefill?.shortExchange}
              nowMs={nowMs}
            />
          </CardContent>
        </Card>
      </div>

      <PairSwitcher
        pairs={availablePairs}
        active={pair}
        snapshot={snapshot}
        onSelect={setRequestedPair}
      />

      <OpenOrders
        orders={openOrders}
        history={bucket?.history ?? []}
        onCancel={(id) => void onCancel(id)}
      />

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending && pending.length > 1 ? "Submit hedge order" : "Submit live order"}
        description="Sends this order to the venue immediately using your API key."
        confirmLabel="Send order"
        destructive
        warning="This is a real order with real funds. Once it fills it cannot be undone."
        details={pending ? intentDetails(pending, snapshot) : []}
        // Above the threshold the amount has to be retyped, so a large order is a
        // decision rather than the same single click as a small one.
        challenge={
          pendingNotional >= CHALLENGE_NOTIONAL_USD
            ? {
                value: String(Math.round(pendingNotional)),
                label: `Type the notional (${Math.round(pendingNotional)}) to confirm this ${formatUsdRounded(pendingNotional)} order`,
              }
            : undefined
        }
        onConfirm={async () => {
          if (!pending) return;
          try {
            await runSubmission(pending, "live");
            setPending(null);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            toast.error("Live order rejected", { description: message });
            // Rethrown so the dialog stays open and shows the reason inline.
            throw err;
          }
        }}
      />
    </div>
  );
}

/** Headline for the submission toast, which differs by leg count and account. */
function describeSubmission(intents: OrderIntent[], target: AccountType): string {
  const scope = target === "live" ? "Live" : "Paper";
  if (intents.length > 1) return `${scope} hedge order submitted`;
  return `${scope} ${intents[0].orderType} order submitted`;
}

/** Whole-dollar USD for prose, where cents are noise. */
function formatUsdRounded(value: number): string {
  return `$${Math.round(value).toLocaleString()}`;
}

/** Flattens the intents into the exact numbers being sent, leg by leg. */
function intentDetails(
  intents: OrderIntent[],
  snapshot: MarketSnapshot | null,
): { label: string; value: string; emphasis?: boolean }[] {
  const details: { label: string; value: string; emphasis?: boolean }[] = [];
  intents.forEach((intent, i) => {
    const prefix = intents.length > 1 ? `Leg ${i + 1} ` : "";
    details.push(
      { label: `${prefix}Venue`, value: exchangeName(intent.exchange), emphasis: true },
      { label: `${prefix}Order`, value: `${intent.side} ${intent.orderType}`, emphasis: true },
      { label: `${prefix}Size`, value: `${intent.size} ${intent.pair}`, emphasis: true },
      {
        label: `${prefix}Price`,
        value:
          intent.orderType === "limit"
            ? formatPrice(intent.price)
            : `market (≈ ${formatPrice(intent.price)})`,
      },
      { label: `${prefix}Notional`, value: `≈ $${(intent.size * intent.price).toFixed(2)}` },
    );
    if (intent.leverage > 1) {
      details.push({ label: `${prefix}Leverage`, value: `${intent.leverage}×` });
    }
    if (intent.reduceOnly) details.push({ label: `${prefix}Reduce only`, value: "yes" });
  });

  if (intents.length === 2 && intents[0].waitLongExchange && intents[0].waitShortExchange) {
    const spread = hedgeEntrySpreadPct(
      snapshot,
      intents[0].pair,
      intents[0].waitLongExchange,
      intents[0].waitShortExchange,
    );
    details.push({
      label: "Entry spread now",
      value: formatSignedPct(spread),
      emphasis: true,
    });
  }
  return details;
}

/** Quick access to the streamed coins, ordered by the biggest funding gap. */
function PairSwitcher({
  pairs,
  active,
  snapshot,
  onSelect,
}: {
  pairs: string[];
  active: string;
  snapshot: MarketSnapshot | null;
  onSelect: (pair: string) => void;
}) {
  const ordered = useMemo(() => {
    const byDiff = new Map((snapshot?.rows ?? []).map((r) => [r.coin, Math.abs(r.diffFr ?? 0)]));
    return [...pairs].sort((a, b) => (byDiff.get(b) ?? 0) - (byDiff.get(a) ?? 0)).slice(0, 24);
  }, [pairs, snapshot]);

  if (ordered.length === 0) {
    return (
      <p className="text-center text-xs text-muted-foreground">
        Waiting for the market stream to report watched pairs…
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs text-muted-foreground">Pair:</span>
      {ordered.map((p) => (
        <button
          key={p}
          type="button"
          // A pressed state, so the selected chip is not conveyed by background
          // colour alone.
          aria-pressed={active === p}
          onClick={() => onSelect(p)}
          className={cn(
            "rounded-md px-2 py-1 font-mono text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            active === p
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
          )}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

function TradeDeepLink() {
  const params = useSearchParams();
  const coin = params.get("coin");
  const long = params.get("long");
  const short = params.get("short");
  const mode = params.get("mode");
  const account = params.get("account") === "live" ? "live" : "paper";

  const prefill: OrderFormPrefill | undefined =
    isExchangeId(long) && isExchangeId(short)
      ? { longExchange: long, shortExchange: short, mode: mode === "delay" ? "delay" : "instant" }
      : undefined;

  // Remounting on a new deep link lets the workspace and form seed themselves
  // from props instead of syncing props into state inside effects. The account is
  // deliberately outside the key: switching tabs rewrites the URL, and remounting
  // on that would discard the form the user is filling in.
  const key = `${coin ?? ""}|${long ?? ""}|${short ?? ""}|${mode ?? ""}`;

  return (
    <TradeWorkspace
      key={key}
      initialPair={(coin ?? "BTC").toUpperCase()}
      initialAccount={account}
      prefill={prefill}
    />
  );
}

export default function TradePage() {
  return (
    <Suspense fallback={<PageSkeleton cards={0} rows={6} filters={false} />}>
      <TradeDeepLink />
    </Suspense>
  );
}
