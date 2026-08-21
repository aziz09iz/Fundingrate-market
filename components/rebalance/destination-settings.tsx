"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { apiFetch } from "@/lib/api/client";
import type {
  AllowlistedDestination,
  ExchangeId,
  NetworkId,
  TransferToken,
} from "@/lib/types";
import { EXCHANGES, cn, exchangeInfo, exchangeName, formatAgo } from "@/lib/utils";
import { NETWORK_LABELS, TRANSFER_TOKENS } from "@/lib/rebalance/chains";
import {
  BadgeCheck,
  Clock,
  Loader2,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";

interface DestinationsResponse {
  destinations: AllowlistedDestination[];
  encryptionAvailable: boolean;
}

interface VerifyResponse extends DestinationsResponse {
  ok: boolean;
  error?: string;
}

interface Draft {
  exchange: ExchangeId;
  token: TransferToken;
  network: NetworkId;
  address: string;
  memo: string;
  label: string;
}

const NETWORK_IDS = Object.keys(NETWORK_LABELS) as NetworkId[];

/**
 * The visible tail of a masked address, used as the arming challenge.
 *
 * `maskAddress` renders `head…tail`, so this reads the part after the ellipsis —
 * the operator can always see what they are being asked to type, and no full
 * address has to reach the browser for it.
 */
function addressTailOf(masked: string): string {
  const tail = masked.split("…").at(-1) ?? masked;
  return tail.slice(-6);
}

/** What the operator is being asked to accept, which depends on the check. */
function armingWarning(destination: AllowlistedDestination): string {
  if (destination.verifiedMatch === true && destination.verifiedStale) {
    return (
      "On-chain withdrawals cannot be reversed. This address matched when it was last checked, but that was long " +
      "enough ago that the venue could have rotated it since. Verify again before arming."
    );
  }
  if (destination.verifiedMatch === null) {
    return (
      "On-chain withdrawals cannot be reversed, and this address has never been confirmed against the venue. " +
      "Arming it means you are vouching for it yourself — compare it with what the venue shows for this exact token and chain."
    );
  }
  return "On-chain withdrawals cannot be reversed. Confirm the address matches what the destination venue shows for this exact token and chain.";
}

const EMPTY_DRAFT: Draft = {
  exchange: "binance",
  token: "USDT",
  network: "TRC20",
  address: "",
  memo: "",
  label: "",
};

interface DestinationSettingsProps {
  /** Refreshes the parent overview after a change, so counts stay in step. */
  onChanged?: () => void;
}

/**
 * Withdrawal destinations.
 *
 * The flow here is deliberately two-step. Saving an address stores it but leaves
 * it inert; a separate confirm arms it. Nothing — manual transfer or automation —
 * can send to an unconfirmed row, which is what makes a mistyped address a
 * recoverable annoyance rather than a permanent loss.
 *
 * Verify asks the destination venue what its own deposit address is and compares.
 * Doing that before confirming is the single most valuable habit on this page.
 */
export function DestinationSettings({ onChanged }: DestinationSettingsProps) {
  const [data, setData] = useState<DestinationsResponse | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [deleting, setDeleting] = useState<AllowlistedDestination | null>(null);
  const [arming, setArming] = useState<AllowlistedDestination | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const result = await apiFetch<DestinationsResponse>("/api/rebalance/destinations");
      setData(result);
      setNowMs(Date.now());
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

  const post = async <T extends DestinationsResponse>(
    body: Record<string, unknown>,
  ): Promise<T> => {
    const result = await apiFetch<T>("/api/rebalance/destinations", { method: "POST", json: body });
    setData({
      destinations: result.destinations,
      encryptionAvailable: data?.encryptionAvailable ?? true,
    });
    onChanged?.();
    return result;
  };

  const onSave = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const address = draft.address.trim();
      if (!address) throw new Error("Address is required");
      await post({
        action: "save",
        exchange: draft.exchange,
        token: draft.token,
        network: draft.network,
        address,
        memo: draft.memo.trim() || undefined,
        label: draft.label.trim() || undefined,
      });
      setDraft({ ...EMPTY_DRAFT, exchange: draft.exchange, token: draft.token });
      setNotice({
        ok: true,
        message: "Saved, but not armed. Verify it against the venue, then confirm it before sending.",
      });
      toast.success("Destination saved, not armed", {
        description: `${exchangeName(draft.exchange)} · ${draft.token} on ${NETWORK_LABELS[draft.network]}. Verify it, then confirm before sending.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error("Could not save destination", { description: message });
    } finally {
      setSaving(false);
    }
  };

  const onVerify = async (destination: AllowlistedDestination) => {
    setBusy(destination.id);
    setError(null);
    setNotice(null);
    try {
      const result = await post<VerifyResponse>({ action: "verify", id: destination.id });
      setNotice({
        ok: result.ok,
        message: result.ok
          ? `${exchangeName(destination.exchange)} confirms this is its ${destination.token} deposit address on ${destination.network}.`
          : (result.error ?? "The venue did not confirm this address."),
      });
      // A failed check is the one outcome worth interrupting for: it means either a
      // typo or a rotated address, and both block arming until resolved.
      if (!result.ok) {
        toast.error("Venue did not confirm this address", {
          description: `${exchangeName(destination.exchange)} · ${destination.token} on ${NETWORK_LABELS[destination.network]}. ${result.error ?? ""}`.trim(),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error("Could not run the venue check", { description: message });
    } finally {
      setBusy(null);
    }
  };

  const onDisarm = async (destination: AllowlistedDestination) => {
    setBusy(destination.id);
    try {
      await post({ action: "confirm", id: destination.id, confirmed: false });
      setNotice({ ok: true, message: "Disarmed. Transfers to this route are refused again." });
      toast.success("Destination disarmed", {
        description: `${exchangeName(destination.exchange)} · ${destination.token} on ${NETWORK_LABELS[destination.network]} (${destination.addressMasked}) can no longer receive transfers.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error("Could not disarm destination", { description: message });
    } finally {
      setBusy(null);
    }
  };

  const destinations = useMemo(() => data?.destinations ?? [], [data]);
  const armed = destinations.filter((d) => d.confirmed).length;

  /** Routes grouped by venue, so one venue's chains read as a set. */
  const byVenue = useMemo(() => {
    const groups = new Map<ExchangeId, AllowlistedDestination[]>();
    for (const d of destinations) {
      const list = groups.get(d.exchange) ?? [];
      list.push(d);
      groups.set(d.exchange, list);
    }
    return [...groups.entries()];
  }, [destinations]);

  const chainNeedsMemo = draft.network === "SOLANA";

  return (
    <div className="flex flex-col gap-4">
      <Alert variant="error" className="text-[11px]">
        These addresses are the only places this app can send funds. An on-chain withdrawal cannot be
        reversed and sending on the wrong chain loses the money with no recourse. A saved address is
        inert until you confirm it — verify against the venue first. A destination whose venue check
        failed cannot be armed at all, and every transfer re-checks the address with the venue before
        sending.
      </Alert>

      {error && <Alert variant="error">{error}</Alert>}

      {notice && (
        <Alert variant={notice.ok ? "success" : "error"}>{notice.message}</Alert>
      )}

      {data && !data.encryptionAvailable && (
        <Alert variant="warning">
          APP_PASSWORD is not set on the server, so an address cannot be encrypted. Set it in
          .env.local and restart before adding a destination.
        </Alert>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Add Destination</CardTitle>
          <Badge variant="secondary" className="text-[10px]">
            one address per venue, token and chain
          </Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Venue</Label>
              <Select
                value={draft.exchange}
                onValueChange={(v) => setDraft((d) => ({ ...d, exchange: v as ExchangeId }))}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXCHANGES.map((ex) => (
                    <SelectItem key={ex.id} value={ex.id} className="text-xs">
                      {ex.name}
                      <span className="ml-1.5 text-[10px] uppercase text-muted-foreground">
                        {ex.venueType}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Token</Label>
              <Select
                value={draft.token}
                onValueChange={(v) => setDraft((d) => ({ ...d, token: v as TransferToken }))}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRANSFER_TOKENS.map((token) => (
                    <SelectItem key={token} value={token} className="text-xs">
                      {token}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Network</Label>
              <Select
                value={draft.network}
                onValueChange={(v) => setDraft((d) => ({ ...d, network: v as NetworkId }))}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NETWORK_IDS.map((id) => (
                    <SelectItem key={id} value={id} className="text-xs">
                      {NETWORK_LABELS[id]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dest-address" className="text-xs text-muted-foreground">
              Deposit address — copy it from {exchangeName(draft.exchange)} for {draft.token} on{" "}
              {NETWORK_LABELS[draft.network]}
            </Label>
            <Input
              id="dest-address"
              value={draft.address}
              onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))}
              placeholder="paste the destination venue's deposit address"
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dest-memo" className="text-xs text-muted-foreground">
                Memo / tag {chainNeedsMemo ? "(often required on this chain)" : "(optional)"}
              </Label>
              <Input
                id="dest-memo"
                value={draft.memo}
                onChange={(e) => setDraft((d) => ({ ...d, memo: e.target.value }))}
                placeholder="only if the venue asks for one"
                className="font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dest-label" className="text-xs text-muted-foreground">
                Label (optional)
              </Label>
              <Input
                id="dest-label"
                value={draft.label}
                onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                placeholder="e.g. main sub-account"
                className="text-xs"
                autoComplete="off"
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] text-muted-foreground">
              Saving an existing route replaces its address and disarms it.
            </p>
            <Button
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => void onSave()}
              disabled={saving || data?.encryptionAvailable === false}
            >
              {saving ? (
                <Loader2 aria-hidden className="size-3 animate-spin" />
              ) : (
                <Plus aria-hidden className="size-3" />
              )}
              Save destination
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Configured Destinations</CardTitle>
          <Badge
            variant="secondary"
            className={cn("text-[10px]", armed > 0 ? "text-positive" : "text-muted-foreground")}
          >
            {armed}/{destinations.length} armed
          </Badge>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8">Route</TableHead>
                <TableHead className="h-8">Address</TableHead>
                <TableHead className="h-8">Venue check</TableHead>
                <TableHead className="h-8">State</TableHead>
                <TableHead className="h-8 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {destinations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-xs text-muted-foreground">
                    No destinations configured, so no transfer can be sent anywhere yet.
                  </TableCell>
                </TableRow>
              )}
              {byVenue.flatMap(([exchange, rows]) => [
                <TableRow key={exchange} className="hover:bg-transparent">
                  <TableCell colSpan={5} className="bg-muted/30 py-1.5">
                    <span
                      className={cn(
                        "text-[10px] font-medium uppercase tracking-wider",
                        exchangeInfo(exchange).accent,
                      )}
                    >
                      {exchangeName(exchange)}
                    </span>
                    <span className="ml-2 text-[10px] uppercase text-muted-foreground/70">
                      {exchangeInfo(exchange).venueType}
                    </span>
                  </TableCell>
                </TableRow>,
                ...rows.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="text-xs">
                      <span className="font-mono">{d.token}</span>
                      <span className="ml-1.5 text-muted-foreground">
                        {NETWORK_LABELS[d.network]}
                      </span>
                      {d.label && (
                        <Badge variant="secondary" className="ml-1.5 text-[9px]">
                          {d.label}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono num text-[11px] text-muted-foreground">
                      {d.addressMasked}
                      {d.requiresMemo && (
                        <span className="ml-1 text-[9px] text-info">+memo</span>
                      )}
                    </TableCell>
                    <TableCell className="text-[11px]">
                      {d.verifiedMatch === true ? (
                        d.verifiedStale ? (
                          <span className="inline-flex items-center gap-1 text-warning">
                            <Clock aria-hidden className="size-3" />
                            stale — checked {formatAgo(d.verifiedAt ?? null, nowMs)}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-positive">
                            <BadgeCheck aria-hidden className="size-3" />
                            matched {formatAgo(d.verifiedAt ?? null, nowMs)}
                          </span>
                        )
                      ) : d.verifiedMatch === false ? (
                        <span className="inline-flex items-center gap-1 text-negative">
                          <X aria-hidden className="size-3" />
                          mismatch
                        </span>
                      ) : (
                        <span className="text-muted-foreground">not checked</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {d.confirmed ? (
                        <Badge variant="secondary" className="gap-1 text-[10px] text-positive">
                          <ShieldCheck aria-hidden className="size-3" />
                          Armed
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="gap-1 text-[10px] text-warning">
                          <ShieldAlert aria-hidden className="size-3" />
                          Not armed
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 gap-1 px-2 text-[10px]"
                          onClick={() => void onVerify(d)}
                          disabled={busy !== null}
                        >
                          {busy === d.id ? (
                            <Loader2 aria-hidden className="size-3 animate-spin" />
                          ) : (
                            <ShieldCheck aria-hidden className="size-3" />
                          )}
                          Verify
                        </Button>
                        {d.confirmed ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-[10px] text-warning"
                            onClick={() => void onDisarm(d)}
                            disabled={busy !== null}
                          >
                            Disarm
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            className="h-6 px-2 text-[10px]"
                            onClick={() => setArming(d)}
                            // The server refuses this too; disabling here just
                            // saves a round trip and says why in the tooltip.
                            disabled={busy !== null || d.verifiedMatch === false}
                            title={
                              d.verifiedMatch === false
                                ? "The venue reported a different address at the last check. Re-verify before arming."
                                : undefined
                            }
                          >
                            Confirm
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[10px] text-negative hover:text-negative/80"
                          onClick={() => setDeleting(d)}
                          disabled={busy !== null}
                          aria-label={`Delete ${d.token} destination on ${NETWORK_LABELS[d.network]}`}
                        >
                          <Trash2 aria-hidden className="size-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )),
                ...rows
                  .filter((d) => d.lastError)
                  .map((d) => (
                    <TableRow key={`${d.id}-err`} className="hover:bg-transparent">
                      <TableCell colSpan={5} className="py-1.5 text-[11px] text-warning">
                        {d.token}/{d.network}: {d.lastError}
                      </TableCell>
                    </TableRow>
                  )),
              ])}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={arming !== null}
        onOpenChange={(open) => !open && setArming(null)}
        title="Arm this destination"
        description="Once armed, manual transfers and the automation can both send funds to this address."
        confirmLabel="Arm destination"
        destructive
        warning={arming ? armingWarning(arming) : undefined}
        // Typing the address tail rather than a fixed word: the only thing that can
        // be wrong here is the address, so the challenge is reading it.
        challenge={
          arming
            ? {
                value: addressTailOf(arming.addressMasked),
                label: `Type the last ${addressTailOf(arming.addressMasked).length} characters of the address to confirm you have compared it with ${exchangeName(arming.exchange)}`,
              }
            : undefined
        }
        details={
          arming
            ? [
                { label: "Venue", value: exchangeName(arming.exchange), emphasis: true },
                { label: "Token", value: arming.token },
                { label: "Network", value: NETWORK_LABELS[arming.network] },
                { label: "Address", value: arming.addressMasked, emphasis: true },
                {
                  label: "Venue check",
                  value:
                    arming.verifiedMatch === true
                      ? arming.verifiedStale
                        ? `matched, but ${formatAgo(arming.verifiedAt ?? null, nowMs)}`
                        : "matched"
                      : arming.verifiedMatch === false
                        ? "MISMATCH — arming is refused"
                        : "not checked",
                  emphasis: arming.verifiedMatch !== true,
                },
              ]
            : []
        }
        onConfirm={async () => {
          if (!arming) return;
          await post({ action: "confirm", id: arming.id, confirmed: true });
          setNotice({ ok: true, message: "Armed. Transfers to this route are now permitted." });
          toast.success("Destination armed", {
            description: `${exchangeName(arming.exchange)} · ${arming.token} on ${NETWORK_LABELS[arming.network]} (${arming.addressMasked}) can now receive transfers.`,
          });
          setArming(null);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete destination"
        description="Removes this withdrawal route. Transfers to it are refused immediately."
        confirmLabel="Delete"
        destructive
        details={
          deleting
            ? [
                { label: "Venue", value: exchangeName(deleting.exchange), emphasis: true },
                { label: "Route", value: `${deleting.token} · ${NETWORK_LABELS[deleting.network]}` },
                { label: "Address", value: deleting.addressMasked },
              ]
            : []
        }
        onConfirm={async () => {
          if (!deleting) return;
          await post({ action: "delete", id: deleting.id });
          setNotice({ ok: true, message: "Destination deleted." });
          toast.success("Destination deleted", {
            description: `${exchangeName(deleting.exchange)} · ${deleting.token} on ${NETWORK_LABELS[deleting.network]} (${deleting.addressMasked}) is no longer a valid route.`,
          });
          setDeleting(null);
        }}
      />
    </div>
  );
}
