"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { apiFetch } from "@/lib/api/client";
import type {
  ExchangeBalance,
  ExchangeId,
  NetworkId,
  TransferNetworkOption,
  TransferRecord,
  TransferToken,
} from "@/lib/types";
import { cn, exchangeInfo, exchangeName, signGlyph } from "@/lib/utils";
import { TRANSFER_TOKENS } from "@/lib/rebalance/chains";
import { ArrowRight, ArrowLeftRight, Loader2, ShieldCheck } from "lucide-react";

export interface TransferPrefill {
  from: ExchangeId;
  to: ExchangeId;
  token: TransferToken;
  amount: number;
}

interface TransferFormProps {
  balances: ExchangeBalance[];
  /**
   * Seeds the form from an applied recommendation. The parent remounts this
   * component per apply, so it is read once during initial state setup.
   */
  prefill?: TransferPrefill;
  onSubmitted: (record: TransferRecord) => void;
}

interface NetworksResponse {
  networks: TransferNetworkOption[];
}

interface DryRunResponse {
  fee: number;
  minAmount: number;
  received: number;
  venueChain: string;
  addressMasked: string;
  requiresMemo: boolean;
  /** True when the destination venue vouched for the address, null when unasked. */
  addressVerified: boolean | null;
  addressVerifyNote: string | null;
}

interface TransferResponse {
  transfer: TransferRecord;
}

/** Fresh key per submitted transfer, so a retry cannot send funds twice. */
function newIdempotencyKey(): string {
  return `frw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function TransferForm({ balances, prefill, onSubmitted }: TransferFormProps) {
  // Sources need withdrawal signing; destinations need an armed address. They are
  // different sets, and an on-chain venue is usually only ever a destination.
  const venues = useMemo(
    () =>
      balances
        .filter((b) => b.walletSupported !== false && b.transferSource !== false)
        .map((b) => b.exchange),
    [balances],
  );
  const destinations = useMemo(
    () => balances.filter((b) => b.destinationAllowlisted === true).map((b) => b.exchange),
    [balances],
  );

  const [from, setFrom] = useState<ExchangeId | "">(prefill?.from ?? venues[0] ?? "");
  const [to, setTo] = useState<ExchangeId | "">(prefill?.to ?? destinations[0] ?? "");
  const [token, setToken] = useState<TransferToken>(prefill?.token ?? "USDT");
  const [networkChoice, setNetworkChoice] = useState<NetworkId | "">("");
  const [amount, setAmount] = useState<string>(prefill ? String(prefill.amount) : "");
  const [networks, setNetworks] = useState<TransferNetworkOption[] | null>(null);
  const [loadingNetworks, setLoadingNetworks] = useState(false);
  const [dryRun, setDryRun] = useState<DryRunResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<TransferRecord | null>(null);

  const loadNetworks = useCallback(async () => {
    if (!from || !to || from === to) {
      setNetworks(null);
      return;
    }
    setLoadingNetworks(true);
    try {
      const result = await apiFetch<NetworksResponse>(
        `/api/rebalance/networks?from=${from}&to=${to}&token=${token}`,
      );
      setNetworks(result.networks);
      setError(null);
    } catch (err) {
      setNetworks([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingNetworks(false);
    }
  }, [from, to, token]);

  useEffect(() => {
    void (async () => {
      await loadNetworks();
    })();
  }, [loadNetworks]);

  // Only chains the source venue supports *and* that have an armed destination
  // address are usable, so the rest are shown disabled with a reason rather than
  // hidden — otherwise a missing chain looks like a venue outage.
  const usable = useMemo(
    () => (networks ?? []).filter((n) => n.enabled && n.destinationAllowlisted),
    [networks],
  );
  const network: NetworkId | "" = usable.some((n) => n.network === networkChoice)
    ? networkChoice
    : (usable[0]?.network ?? "");
  const selected = usable.find((n) => n.network === network) ?? null;

  const sourceBalance = balances.find((b) => b.exchange === from);
  // Both wallets can fund a transfer: the executor moves derivatives collateral
  // to the funding wallet first.
  const movable = (sourceBalance?.funding ?? 0) + (sourceBalance?.available ?? 0);

  const amountNum = Number(amount) || 0;
  const fee = dryRun?.fee ?? selected?.fee ?? 0;
  const received = Math.max(0, amountNum - fee);

  const errors: string[] = [];
  if (!from) errors.push("Pick a source venue.");
  if (!to) errors.push("Pick a destination venue with an armed address.");
  if (from && to && from === to) errors.push("Source and destination must differ.");
  if (amountNum <= 0) errors.push("Enter an amount greater than zero.");
  if (amountNum > movable) {
    errors.push(`Exceeds the movable balance ($${movable.toLocaleString()}).`);
  }
  if (!network) errors.push("No chain is available for this route.");
  if (selected && selected.minAmount > 0 && amountNum > 0 && amountNum < selected.minAmount) {
    errors.push(`Below the ${selected.label} minimum of ${selected.minAmount} ${token}.`);
  }
  if (selected && amountNum > 0 && selected.fee >= amountNum) {
    errors.push(`The ${selected.fee} ${token} fee is not covered by this amount.`);
  }
  const valid = errors.length === 0;

  const runDryRun = async () => {
    if (!valid || !network || !from || !to) return;
    setChecking(true);
    setError(null);
    try {
      const result = await apiFetch<DryRunResponse>("/api/rebalance/transfer", {
        method: "POST",
        json: { from, to, token, network, amount: amountNum, dryRun: true },
      });
      setDryRun(result);
      setConfirmOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  const swap = () => {
    if (!from || !to) return;
    const nextFrom = to;
    const nextTo = from;
    setFrom(nextFrom);
    setTo(nextTo);
    setDryRun(null);
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_20rem]">
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Withdraw &amp; Transfer</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert variant="error" className="text-[11px]">
            This sends a real on-chain withdrawal. It cannot be reversed or recalled once broadcast.
            Funds move in two steps: derivatives collateral → funding wallet, then funding wallet →
            destination.
          </Alert>

          {/* Route */}
          <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_auto_1fr]">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">From</Label>
              <Select
                value={from}
                onValueChange={(v) => {
                  if (!v) return;
                  setFrom(String(v) as ExchangeId);
                  setDryRun(null);
                }}
              >
                <SelectTrigger className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {venues.map((id) => (
                    <SelectItem key={id} value={id} className="text-xs">
                      {exchangeName(id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="mb-0.5 size-8 shrink-0"
              onClick={swap}
              aria-label="Swap direction"
            >
              <ArrowLeftRight aria-hidden className="size-4" />
            </Button>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">To</Label>
              <Select
                value={to}
                onValueChange={(v) => {
                  if (!v) return;
                  setTo(String(v) as ExchangeId);
                  setDryRun(null);
                }}
              >
                <SelectTrigger className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {destinations
                    .filter((id) => id !== from)
                    .map((id) => (
                      <SelectItem key={id} value={id} className="text-xs">
                        {exchangeName(id)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {destinations.length === 0 && (
                <Alert variant="warning" className="text-[10px]">
                  No venue has an armed deposit address yet. Add one under the Destinations tab.
                </Alert>
              )}
            </div>
          </div>

          <Separator />

          {/* Token */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Token (stablecoins only)</Label>
            <div className="flex gap-1">
              {TRANSFER_TOKENS.map((t) => (
                <Button
                  key={t}
                  variant={token === t ? "secondary" : "outline"}
                  size="sm"
                  className="h-8 flex-1 font-mono text-xs"
                  onClick={() => {
                    setToken(t);
                    setDryRun(null);
                  }}
                  aria-pressed={token === t}
                >
                  {t}
                </Button>
              ))}
            </div>
          </div>

          {/* Network */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">Network</Label>
            {loadingNetworks && <Skeleton className="h-8 w-full" />}
            {!loadingNetworks && (
              <Select
                value={network}
                onValueChange={(v) => {
                  if (!v) return;
                  setNetworkChoice(String(v) as NetworkId);
                  setDryRun(null);
                }}
              >
                <SelectTrigger className="text-xs">
                  <SelectValue placeholder="no chain available" />
                </SelectTrigger>
                <SelectContent>
                  {usable.map((n) => (
                    <SelectItem key={n.network} value={n.network} className="text-xs">
                      {n.label}
                      <span className="ml-2 text-muted-foreground">
                        fee {n.fee} {token}
                        {n.minAmount > 0 ? ` · min ${n.minAmount}` : ""}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {selected && (
              <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
                <span>
                  Fee{" "}
                  <span className="font-mono num text-foreground">
                    {selected.fee} {token}
                  </span>
                </span>
                <span>
                  Min{" "}
                  <span className="font-mono num text-foreground">
                    {selected.minAmount > 0 ? `${selected.minAmount} ${token}` : "venue enforced"}
                  </span>
                </span>
                {selected.confirmations !== null && selected.confirmations !== undefined && (
                  <span>
                    Confirmations{" "}
                    <span className="font-mono num text-foreground">{selected.confirmations}</span>
                  </span>
                )}
              </div>
            )}
            {networks !== null && networks.length > usable.length && (
              <ul className="flex flex-col gap-0.5">
                {networks
                  .filter((n) => !n.enabled || !n.destinationAllowlisted)
                  .map((n) => (
                    <li key={n.network} className="text-[10px] text-muted-foreground">
                      {n.label} unavailable —{" "}
                      {!n.enabled
                        ? `${exchangeName(from as ExchangeId)} has withdrawals paused`
                        : "no armed destination address for this chain"}
                    </li>
                  ))}
              </ul>
            )}
            {networks !== null && networks.length === 0 && !loadingNetworks && (
              <Alert variant="warning" className="text-[10px]">
                The source venue reported no recognised chain for {token}. Chains this app cannot map
                with certainty are deliberately omitted rather than guessed.
              </Alert>
            )}
          </div>

          {/* Amount */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="transfer-amount" className="text-xs text-muted-foreground">
                Amount
              </Label>
              <span className="font-mono num text-[10px] text-muted-foreground">
                movable ${movable.toLocaleString()} (funding $
                {(sourceBalance?.funding ?? 0).toLocaleString()})
              </span>
            </div>
            <Input
              id="transfer-amount"
              type="number"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setDryRun(null);
              }}
              className="font-mono num text-xs"
              min="0"
              step="1"
            />
            <div className="flex gap-1">
              {[25, 50, 75, 100].map((p) => (
                <Button
                  key={p}
                  variant="ghost"
                  size="sm"
                  className="h-6 flex-1 text-[10px]"
                  onClick={() => {
                    setAmount(String(Math.floor((movable * p) / 100)));
                    setDryRun(null);
                  }}
                >
                  {p === 100 ? "Max" : `${p}%`}
                </Button>
              ))}
            </div>
          </div>

          {/* Destination */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-muted-foreground">
              Destination address ({to ? exchangeName(to) : "—"})
            </Label>
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-2">
              <ShieldCheck aria-hidden className="size-3.5 shrink-0 text-positive" />
              <span className="flex-1 truncate font-mono num text-xs">
                {selected?.addressMasked ?? dryRun?.addressMasked ?? "no armed address"}
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Resolved from the armed destinations under the Destinations tab. It cannot be edited
              here, and a transfer is refused if the destination venue reports a different deposit
              address.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Review side panel */}
      <Card className="flex flex-col">
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Review</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-3">
          <div className="flex items-center justify-center gap-2 rounded-md bg-muted/30 py-2 text-xs">
            <span className={from ? exchangeInfo(from).accent : ""}>
              {from ? exchangeName(from) : "—"}
            </span>
            <ArrowRight aria-hidden className="size-3 text-muted-foreground" />
            <span className={to ? exchangeInfo(to).accent : ""}>{to ? exchangeName(to) : "—"}</span>
          </div>

          <div className="flex flex-col gap-1.5 text-xs">
            <Row label="Token" value={token} />
            <Row label="Network" value={selected?.label ?? "—"} />
            <Row label="Amount" value={`${amountNum.toLocaleString()} ${token}`} />
            <Row
              label="Fee"
              value={`${signGlyph(-fee)}${fee} ${token}`}
              valueClass="text-negative"
            />
            <Separator className="my-1" />
            <Row
              label="Received"
              value={`${received.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${token}`}
              valueClass="text-positive font-medium"
            />
          </div>

          {errors.length > 0 && (
            <Alert variant="error" className="text-[10px]">
              <ul className="flex flex-col gap-1">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Alert>
          )}

          {error && (
            <Alert variant="error" className="text-[10px]">
              {error}
            </Alert>
          )}

          {submitted && (
            <Badge variant="secondary" className="justify-center text-[10px] text-positive">
              Sent {submitted.id} — tracking in History
            </Badge>
          )}

          <div className="mt-auto flex flex-col gap-2">
            <Button
              className="h-9 w-full gap-1.5 bg-negative text-white hover:bg-negative/85"
              onClick={() => void runDryRun()}
              disabled={!valid || checking}
            >
              {checking && <Loader2 aria-hidden className="size-3.5 animate-spin" />}
              Review &amp; Send Transfer
            </Button>
            <p className="text-[10px] leading-snug text-muted-foreground">
              The venue&apos;s live fee and minimum are re-checked on the server before the
              confirmation, so the numbers you approve are the numbers that will be sent.
            </p>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => !open && setConfirmOpen(false)}
        title="Send on-chain transfer"
        description="Moves collateral to the funding wallet, then withdraws to the armed destination address."
        confirmLabel="Send transfer"
        destructive
        warning={
          dryRun?.addressVerified === true
            ? "Irreversible. An on-chain withdrawal cannot be recalled, and funds sent on a chain the destination does not credit are unrecoverable."
            : "Irreversible, and the destination venue could not confirm this address just now — see the note below. An on-chain withdrawal cannot be recalled, and funds sent on a chain the destination does not credit are unrecoverable."
        }
        // Every amount is challenged, not just large ones: unlike a perp order,
        // which can be closed for the cost of a spread, a withdrawal to the wrong
        // place is gone in full regardless of size.
        challenge={{
          value: String(amountNum),
          label: `Type the amount (${amountNum}) to confirm this transfer`,
        }}
        details={
          from && to && dryRun
            ? [
                { label: "From", value: exchangeName(from), emphasis: true },
                { label: "To", value: exchangeName(to), emphasis: true },
                { label: "Token", value: token, emphasis: true },
                { label: "Network", value: selected?.label ?? String(network) },
                { label: "Venue chain id", value: dryRun.venueChain },
                { label: "Address", value: dryRun.addressMasked, emphasis: true },
                {
                  label: "Venue check",
                  value:
                    dryRun.addressVerified === true
                      ? `${exchangeName(to)} confirms this address`
                      : "not confirmed — see note",
                  emphasis: dryRun.addressVerified !== true,
                },
                { label: "Amount", value: `${amountNum.toLocaleString()} ${token}`, emphasis: true },
                { label: "Network fee", value: `${dryRun.fee} ${token}` },
                { label: "Arrives", value: `${dryRun.received} ${token}`, emphasis: true },
              ]
            : []
        }
        onConfirm={async () => {
          if (!from || !to || !network) return;
          try {
            const result = await apiFetch<TransferResponse>("/api/rebalance/transfer", {
              method: "POST",
              headers: { "idempotency-key": newIdempotencyKey() },
              json: { from, to, token, network, amount: amountNum },
            });
            setSubmitted(result.transfer);
            onSubmitted(result.transfer);
            toast.success("Transfer sent", {
              description: `${amountNum.toLocaleString()} ${token} from ${exchangeName(from)} to ${exchangeName(to)} on ${selected?.label ?? String(network)}.`,
            });
            setConfirmOpen(false);
            setAmount("");
            setDryRun(null);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            toast.error("Transfer failed", { description: message });
            // Rethrown so the dialog keeps it inline and stays open on the numbers
            // the user approved.
            throw err;
          }
        }}
      >
        {dryRun && dryRun.addressVerified !== true && (
          <Alert variant="warning" className="text-[11px]">
            {dryRun.addressVerifyNote ??
              "The destination venue could not confirm this deposit address, so it has not been cross-checked. A mismatch would have refused the transfer outright — this is the weaker case where the venue could not be asked."}
          </Alert>
        )}
      </ConfirmDialog>
    </div>
  );
}

function Row({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-mono num", valueClass)}>{value}</span>
    </div>
  );
}
