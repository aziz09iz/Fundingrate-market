"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { apiFetch } from "@/lib/api/client";
import type { CredentialKind, CredentialStatus, ExchangeId } from "@/lib/types";
import { EXCHANGES, credentialShapeOf, exchangeInfo, exchangeName, cn, formatAgo } from "@/lib/utils";
import { Check, Loader2, Radio, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";

interface CredentialsResponse {
  credentials: CredentialStatus[];
  encryptionAvailable: boolean;
}

interface VerifyResponse extends CredentialsResponse {
  ok: boolean;
  error?: string;
}

type Busy = "save" | "verify" | "toggle" | "delete" | null;

/** Draft input for one venue. Never populated from the server — write-only. */
interface Draft {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  label: string;
  readOnly: boolean;
}

const EMPTY_DRAFT: Draft = {
  apiKey: "",
  apiSecret: "",
  passphrase: "",
  label: "",
  readOnly: false,
};

interface CredentialManagerProps {
  kind: CredentialKind;
}

/**
 * Credential management for one venue class.
 *
 * CEX and DEX share this component but not their vocabulary: an exchange issues
 * an API key that can be revoked and scoped, while a chain is addressed by a
 * wallet whose private key authorises everything the wallet holds and cannot be
 * revoked at all. The copy, the required fields and the warnings differ because
 * the risks differ — presenting them as one form with optional extras would hide
 * exactly the distinction that matters.
 */
export function CredentialManager({ kind }: CredentialManagerProps) {
  const [data, setData] = useState<CredentialsResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<Record<string, Busy>>({});
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<CredentialStatus | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const isDex = kind === "dex";

  const load = useCallback(async () => {
    // Nothing is set before the first await, so calling this from an effect
    // cannot trigger a cascading render.
    try {
      const result = await apiFetch<CredentialsResponse>("/api/credentials");
      setData(result);
      setNowMs(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  /**
   * Venues of this class, rendered before the first response so the page has
   * shape rather than collapsing to a spinner.
   */
  const statuses = useMemo(() => {
    const byId = new Map((data?.credentials ?? []).map((c) => [c.exchange, c]));
    // Grouped by how the venue authenticates, not by whether it is a DEX. A venue
    // that settles on-chain but issues a revocable API key belongs on this page
    // beside the exchanges rather than on the wallet page.
    return EXCHANGES.filter((ex) => (credentialShapeOf(ex.id) === "wallet") === isDex).map<CredentialStatus>(
      (ex) =>
        byId.get(ex.id) ?? {
          exchange: ex.id,
          kind,
          configured: false,
          // Assumed supported until the server says otherwise, so the row does
          // not flicker from "add a key" to "unsupported" on first load.
          accountSupported: true,
          keyTail: null,
          enabled: false,
          readOnly: false,
          requiresPassphrase: false,
          lastVerifiedAt: null,
          lastError: null,
        },
    );
  }, [data, isDex, kind]);

  const draftFor = (exchange: ExchangeId): Draft => drafts[exchange] ?? EMPTY_DRAFT;

  const patchDraft = (exchange: ExchangeId, patch: Partial<Draft>) => {
    setDrafts((prev) => ({ ...prev, [exchange]: { ...(prev[exchange] ?? EMPTY_DRAFT), ...patch } }));
  };

  const setResult = (exchange: ExchangeId, ok: boolean, message: string) => {
    setResults((prev) => ({ ...prev, [exchange]: { ok, message } }));
  };

  const post = async <T extends CredentialsResponse>(body: Record<string, unknown>): Promise<T> => {
    const result = await apiFetch<T>("/api/credentials", { method: "POST", json: body });
    setData({
      credentials: result.credentials,
      encryptionAvailable: data?.encryptionAvailable ?? true,
    });
    return result;
  };

  /**
   * `failureHeadline` is null for actions whose outcome is already reported in the
   * row itself, so a toast does not duplicate what is on screen.
   */
  const run = async (
    exchange: ExchangeId,
    state: Exclude<Busy, null>,
    failureHeadline: string | null,
    fn: () => Promise<void>,
  ) => {
    setBusy((prev) => ({ ...prev, [exchange]: state }));
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setResult(exchange, false, message);
      if (failureHeadline) toast.error(failureHeadline, { description: message });
    } finally {
      setBusy((prev) => ({ ...prev, [exchange]: null }));
    }
  };

  const onSave = (status: CredentialStatus) =>
    run(
      status.exchange,
      "save",
      isDex ? "Could not store wallet" : "Could not store API key",
      async () => {
        const draft = draftFor(status.exchange);
        const identifier = draft.apiKey.trim();

        if (isDex) {
          if (!/^0x[0-9a-fA-F]{40}$/.test(identifier)) {
            throw new Error("Wallet address must be 0x followed by 40 hex characters");
          }
          // Aster cannot read anything without signing, so an address on its own
          // would store a credential that fails on every call.
          if (status.exchange === "aster" && !draft.apiSecret.trim()) {
            throw new Error(
              "Aster needs the API wallet private key as well — it has no public account endpoint, so even reading positions requires a signature.",
            );
          }
        } else {
          if (!identifier || !draft.apiSecret.trim()) {
            throw new Error("API key and secret are both required");
          }
          if (status.requiresPassphrase && !draft.passphrase.trim()) {
            throw new Error(`${exchangeName(status.exchange)} also requires a passphrase`);
          }
        }

        const result = await post({
          action: "save",
          exchange: status.exchange,
          apiKey: identifier,
          apiSecret: draft.apiSecret.trim() || undefined,
          passphrase: draft.passphrase.trim() || undefined,
          label: draft.label.trim() || undefined,
          readOnly: draft.readOnly,
          enabled: true,
        });
        // Clear the draft the moment it is stored: keeping a secret in React state
        // longer than necessary serves no purpose.
        setDrafts((prev) => ({ ...prev, [status.exchange]: { ...EMPTY_DRAFT } }));
        setResult(status.exchange, true, "Saved. Run Test Connection to confirm it works.");
        const saved = result.credentials.find((c) => c.exchange === status.exchange);
        const masked =
          (isDex ? saved?.walletAddressMasked : null) ??
          (saved?.keyTail ? `••••${saved.keyTail}` : null);
        toast.success(isDex ? "Wallet stored (encrypted)" : "API key stored (encrypted)", {
          description: `${exchangeName(status.exchange)}${masked ? ` · ${masked}` : ""}. Run Test Connection to confirm it works.`,
        });
      },
    );

  const onVerify = (status: CredentialStatus) =>
    run(status.exchange, "verify", null, async () => {
      const result = await post<VerifyResponse>({ action: "verify", exchange: status.exchange });
      setResult(
        status.exchange,
        result.ok,
        result.ok ? "Authenticated request succeeded." : (result.error ?? "Verification failed."),
      );
    });

  const onToggle = (status: CredentialStatus, enabled: boolean) =>
    run(
      status.exchange,
      "toggle",
      enabled ? "Could not enable venue" : "Could not disable venue",
      async () => {
        await post({ action: "toggle", exchange: status.exchange, enabled });
        setResult(status.exchange, true, enabled ? "Enabled." : "Disabled — streams stopped.");
        toast.success(
          enabled
            ? `${exchangeName(status.exchange)} enabled`
            : `${exchangeName(status.exchange)} disabled`,
          {
            description: enabled
              ? "Its private stream and order placement now use the stored credential."
              : "Its private stream stopped and orders are refused.",
          },
        );
      },
    );

  const configuredCount = statuses.filter((c) => c.configured).length;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-6">
      <PageHeader
        title={isDex ? "Wallet-Signed Venues" : "API Key Venues"}
        description={
          isDex
            ? "Venues whose orders are signed with a wallet key rather than an API secret. Write-only — nothing stored here can be read back."
            : "Venues that issue a revocable API key. Write-only — nothing stored here can be read back."
        }
        actions={
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
        }
      />

      {isDex ? (
        <Alert variant="warning" className="text-[11px]">
          A wallet private key cannot be revoked and authorises everything that wallet holds. Add the
          address alone to watch an account — that is enough for positions and balances, and it
          exposes nothing. Only add a signing key if you intend this app to move those funds, and use
          a wallet dedicated to it.
        </Alert>
      ) : (
        <p className="flex items-start gap-1.5 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <ShieldCheck aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          Secrets are never returned by any endpoint, encrypted or otherwise — only the last four
          characters of the public key are shown. Grant the narrowest permissions the venue offers,
          and never enable withdrawals on a key used here.
        </p>
      )}

      {error && <Alert variant="error">{error}</Alert>}

      {data && !data.encryptionAvailable && (
        <Alert variant="warning">
          APP_PASSWORD is not set on the server, so credentials cannot be encrypted. Set it in
          .env.local and restart before adding anything here.
        </Alert>
      )}

      {!data && loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between py-3">
            <CardTitle className="text-sm">{isDex ? "Wallets" : "Credentials"}</CardTitle>
            <Badge variant="secondary" className="text-[10px]">
              {configuredCount}/{statuses.length} configured
            </Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {statuses.map((status) => (
              <VenueRow
                key={status.exchange}
                status={status}
                draft={draftFor(status.exchange)}
                busy={busy[status.exchange] ?? null}
                result={results[status.exchange]}
                isDex={isDex}
                nowMs={nowMs}
                canSave={data?.encryptionAvailable !== false}
                onPatch={(patch) => patchDraft(status.exchange, patch)}
                onSave={() => void onSave(status)}
                onVerify={() => void onVerify(status)}
                onToggle={(v) => void onToggle(status, v)}
                onDelete={() => setDeleting(status)}
              />
            ))}
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={isDex ? "Delete stored wallet" : "Delete stored credentials"}
        description={`Removes the encrypted ${isDex ? "wallet key and address" : "key"} for this venue from the database.`}
        confirmLabel="Delete"
        destructive
        warning="Its private stream stops and orders will be refused until a credential is configured again. Cached positions and balances for this venue are cleared."
        details={
          deleting
            ? [
                { label: "Venue", value: exchangeName(deleting.exchange), emphasis: true },
                {
                  label: isDex ? "Address" : "Key",
                  value:
                    (isDex ? deleting.walletAddressMasked : null) ??
                    (deleting.keyTail ? `••••${deleting.keyTail}` : "—"),
                },
              ]
            : []
        }
        onConfirm={async () => {
          if (!deleting) return;
          const exchange = deleting.exchange;
          const masked =
            (isDex ? deleting.walletAddressMasked : null) ??
            (deleting.keyTail ? `••••${deleting.keyTail}` : null);
          await post({ action: "delete", exchange });
          setResult(exchange, true, "Deleted.");
          toast.success(isDex ? "Wallet deleted" : "Credentials deleted", {
            description: `${exchangeName(exchange)}${masked ? ` · ${masked}` : ""} removed. Its private stream stopped and orders are refused.`,
          });
          setDeleting(null);
        }}
      />
    </div>
  );
}

/**
 * What each wallet-signed venue actually wants in the two fields.
 *
 * The two are not the same shape, and the difference is not cosmetic. Hyperliquid
 * reads from a public address and signs with that same wallet's key, so the two
 * fields describe one wallet and the server refuses them if they disagree. Aster
 * signs with a separate approved API wallet, so there the two fields are *expected*
 * to be different wallets — and nothing can be read at all without the key, because
 * Aster has no public account endpoint.
 *
 * Saying this in the row is worth the space: the failure mode otherwise is an
 * operator pasting a matched pair into Aster and getting a signature the venue
 * rejects with no explanation.
 */
const WALLET_GUIDANCE: Partial<
  Record<ExchangeId, { address: string; key: string; keyPlaceholder: string; note: string }>
> = {
  hyperliquid: {
    address: "Wallet Address",
    key: "Private Key (optional)",
    keyPlaceholder: "leave blank to watch only",
    note: "The address alone is enough to watch positions and balances. Add its private key only to place orders — it must be the key for that same address, or orders are refused.",
  },
  aster: {
    address: "Master Account Address",
    key: "API Wallet Private Key",
    keyPlaceholder: "required — the API wallet's key",
    note: "Both are required: Aster has no public account endpoint, so even reading positions needs a signature. Create an API wallet at asterdex.com/en/api-wallet with perp trading enabled — its key is a different wallet from the account address, which is expected here.",
  },
};

interface VenueRowProps {
  status: CredentialStatus;
  draft: Draft;
  busy: Busy;
  result?: { ok: boolean; message: string };
  isDex: boolean;
  nowMs: number;
  canSave: boolean;
  onPatch: (patch: Partial<Draft>) => void;
  onSave: () => void;
  onVerify: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}

function VenueRow({
  status,
  draft,
  busy,
  result,
  isDex,
  nowMs,
  canSave,
  onPatch,
  onSave,
  onVerify,
  onToggle,
  onDelete,
}: VenueRowProps) {
  const info = exchangeInfo(status.exchange);
  const configured = status.configured;
  const guidance = isDex ? WALLET_GUIDANCE[status.exchange] : undefined;

  /**
   * A venue with no authenticated integration gets a statement instead of a form.
   *
   * Rendering disabled inputs would still invite an operator to paste a wallet key
   * into a field that leads nowhere, and for a DEX that key cannot be revoked
   * afterwards. Saying plainly what does and does not work is the safer shape.
   */
  if (!status.accountSupported) {
    return (
      <div className="rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("text-sm font-medium", info.accent)}>{info.name}</span>
          <Badge variant="secondary" className="gap-1 text-[10px] text-info">
            <Radio aria-hidden className="size-3" />
            Market data only
          </Badge>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Funding rates and prices for {info.name} stream on the dashboard without any credential.
          Account access is not implemented — {info.name} signs orders with a curve that has no
          JavaScript implementation, so there is nothing here to configure. Do not paste a wallet key:
          nothing would use it.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("text-sm font-medium", info.accent)}>{info.name}</span>
          <Badge
            variant="secondary"
            className={cn("text-[10px]", configured ? "text-positive" : "text-muted-foreground")}
          >
            {configured ? "Stored (encrypted)" : "Not set"}
          </Badge>
          {isDex && status.walletAddressMasked && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {status.walletAddressMasked}
            </span>
          )}
          {!isDex && status.keyTail && (
            <span className="font-mono text-[11px] text-muted-foreground">••••{status.keyTail}</span>
          )}
          {status.label && (
            <Badge variant="secondary" className="text-[10px]">
              {status.label}
            </Badge>
          )}
          {status.readOnly && (
            <Badge variant="secondary" className="text-[10px] text-warning">
              watch only
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {status.lastVerifiedAt && (
            <span className="text-[10px] text-muted-foreground">
              verified {formatAgo(status.lastVerifiedAt, nowMs)}
            </span>
          )}
          <Switch
            checked={status.enabled}
            onCheckedChange={onToggle}
            disabled={!configured || busy !== null}
            aria-label={`Enable ${info.name}`}
          />
          <span className="w-14 text-[11px] text-muted-foreground">
            {status.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
      </div>

      <Separator className="my-3" />

      {guidance && (
        <p className="mb-3 text-[11px] text-muted-foreground">{guidance.note}</p>
      )}

      <div
        className={cn(
          "grid grid-cols-1 gap-3",
          status.requiresPassphrase ? "sm:grid-cols-3" : "sm:grid-cols-2",
        )}
      >
        <Field
          id={`key-${status.exchange}`}
          label={guidance?.address ?? (isDex ? "Wallet Address" : "API Key")}
          value={draft.apiKey}
          onChange={(v) => onPatch({ apiKey: v })}
          placeholder={isDex ? "0x…" : configured ? "replace stored key" : "paste API key"}
          disabled={busy !== null}
        />
        <Field
          id={`sec-${status.exchange}`}
          label={guidance?.key ?? (isDex ? "Private Key (optional)" : "API Secret")}
          value={draft.apiSecret}
          onChange={(v) => onPatch({ apiSecret: v })}
          placeholder={
            guidance?.keyPlaceholder ?? (isDex ? "leave blank to watch only" : "••••••••")
          }
          password
          disabled={busy !== null}
        />
        {status.requiresPassphrase && (
          <Field
            id={`pass-${status.exchange}`}
            label="Passphrase"
            value={draft.passphrase}
            onChange={(v) => onPatch({ passphrase: v })}
            placeholder="••••••••"
            password
            disabled={busy !== null}
          />
        )}
        <Field
          id={`label-${status.exchange}`}
          label="Label (optional)"
          value={draft.label}
          onChange={(v) => onPatch({ label: v })}
          placeholder="e.g. main, hedge-2"
          disabled={busy !== null}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={draft.readOnly}
            onCheckedChange={(v) => onPatch({ readOnly: v })}
            disabled={busy !== null}
            aria-label="Watch only"
          />
          Save as watch-only (orders and transfers refused)
        </label>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={onSave}
            disabled={busy !== null || !canSave}
          >
            {busy === "save" ? (
              <Loader2 aria-hidden className="size-3 animate-spin" />
            ) : (
              <Check aria-hidden className="size-3" />
            )}
            Save
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={onVerify}
            disabled={!configured || busy !== null}
          >
            {busy === "verify" ? (
              <Loader2 aria-hidden className="size-3 animate-spin" />
            ) : (
              <ShieldCheck aria-hidden className="size-3" />
            )}
            Test Connection
          </Button>
          {configured && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs text-negative hover:text-negative/80"
              onClick={onDelete}
              disabled={busy !== null}
            >
              <Trash2 aria-hidden className="size-3" />
              Delete
            </Button>
          )}
        </div>
      </div>

      {result ? (
        <Alert variant={result.ok ? "success" : "error"} className="mt-2 text-[11px]">
          {result.message}
        </Alert>
      ) : (
        status.lastError && (
          <Alert variant="warning" className="mt-2 text-[11px]">
            Last error: {status.lastError}
          </Alert>
        )
      )}
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  password,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  password?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        // Secrets stay masked; there is no reveal toggle because the value is
        // never loaded from the server — only what you just typed is in here.
        type={password ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        className="font-mono text-xs"
      />
    </div>
  );
}
