"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { apiFetch } from "@/lib/api/client";
import type { AccountType } from "@/lib/types";
import { cn, formatAgo } from "@/lib/utils";
import { Loader2, Save, Send, ShieldAlert } from "lucide-react";

/** Which events are worth a phone buzzing. Mirrors the server's shape. */
interface TelegramEvents {
  opened: boolean;
  closed: boolean;
  failures: boolean;
  transfers: boolean;
}

interface TelegramStatus {
  enabled: boolean;
  tokenStored: boolean;
  tokenTail: string | null;
  chatId: string;
  events: TelegramEvents;
  encryptionAvailable: boolean;
  lastError: string | null;
  lastSentAt: number | null;
}

interface NotificationsResponse {
  telegram: TelegramStatus;
  exposure: { live: number; paper: number };
}

interface TestResponse extends NotificationsResponse {
  ok: boolean;
  error?: string;
}

const EVENT_COPY: { key: keyof TelegramEvents; label: string; hint: string }[] = [
  {
    key: "closed",
    label: "Hedge closed",
    hint: "With its realized PnL. The outcome of every automated trade.",
  },
  {
    key: "failures",
    label: "Failures",
    hint: "A refused order, a failed transfer, or a hedge left half-unwound. Worth waking up for.",
  },
  {
    key: "transfers",
    label: "Transfers sent",
    hint: "On-chain withdrawals, which cannot be reversed — especially the automated ones.",
  },
  {
    key: "opened",
    label: "Hedge opened",
    hint: "High volume on an active account. Off by default for that reason.",
  },
];

/**
 * Telegram notifications and the account exposure ceilings.
 *
 * The bot token is write-only: it is stored encrypted and the page only ever learns
 * whether one exists and its last four characters. The test button sends with the
 * token currently in the field rather than the stored one, so a bad paste is caught
 * before it is saved.
 */
export function NotificationSettings() {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [exposure, setExposure] = useState<{ live: number; paper: number }>({ live: 0, paper: 0 });
  const [tokenDraft, setTokenDraft] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [events, setEvents] = useState<TelegramEvents | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const result = await apiFetch<NotificationsResponse>("/api/settings/notifications");
      setStatus(result.telegram);
      setExposure(result.exposure);
      setEvents((prev) => prev ?? result.telegram.events);
      setChatDraft((prev) => (prev.length > 0 ? prev : result.telegram.chatId));
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

  /**
   * `announce` is a function of the saved status because the only safe thing to
   * name in a toast — the token's last four characters — is decided by the server.
   */
  const onSave = async (
    patch: Record<string, unknown>,
    announce: (next: TelegramStatus) => { headline: string; description: string },
    failureHeadline: string,
  ) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetch<NotificationsResponse>("/api/settings/notifications", {
        method: "POST",
        json: { action: "save", ...patch },
      });
      setStatus(result.telegram);
      setEvents(result.telegram.events);
      // Clear the token field the moment it is stored: keeping a secret in React
      // state longer than necessary serves no purpose.
      if (patch.botToken !== undefined) setTokenDraft("");
      setNotice({ ok: true, message: "Saved." });
      const { headline, description } = announce(result.telegram);
      toast.success(headline, { description });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(failureHeadline, { description: message });
    } finally {
      setSaving(false);
    }
  };

  const onTest = async () => {
    setTesting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetch<TestResponse>("/api/settings/notifications", {
        method: "POST",
        json: {
          action: "test",
          botToken: tokenDraft.trim() || undefined,
          chatId: chatDraft.trim() || undefined,
        },
      });
      setStatus(result.telegram);
      setNotice(
        result.ok
          ? { ok: true, message: "Test message sent. Check the chat." }
          : { ok: false, message: result.error ?? "Telegram refused the message." },
      );
      if (result.ok) {
        toast.success("Test message sent", {
          description: `Delivered to chat ${chatDraft.trim() || result.telegram.chatId}. Check that it arrived.`,
        });
      } else {
        toast.error("Telegram refused the test message", {
          description: result.error ?? "Telegram refused the message.",
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error("Could not send the test message", { description: message });
    } finally {
      setTesting(false);
    }
  };

  const onSaveExposure = async (account: AccountType, value: number) => {
    try {
      const result = await apiFetch<NotificationsResponse>("/api/settings/notifications", {
        method: "POST",
        json: { action: "exposure", account, maxNotional: value },
      });
      setExposure(result.exposure);
      setNotice({ ok: true, message: "Exposure ceiling saved." });
      toast.success(`${account === "live" ? "Live" : "Paper"} exposure ceiling saved`, {
        description:
          result.exposure[account] > 0
            ? `Deployments stop opening once $${result.exposure[account].toLocaleString()} is committed.`
            : "No ceiling — deployments are limited only by their own max positions.",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast.error(`Could not save the ${account} exposure ceiling`, { description: message });
    }
  };

  const canEnable = (status?.tokenStored || tokenDraft.trim().length > 0) && chatDraft.trim().length > 0;

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Telegram Notifications</CardTitle>
          <Badge
            variant="secondary"
            className={cn("text-[10px]", status?.enabled ? "text-positive" : "text-muted-foreground")}
          >
            {status?.enabled ? "On" : "Off"}
          </Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-[11px] text-muted-foreground">
            Alerts for the live account only. A simulated account produces the same volume of
            activity and none of the consequence, so notifying on it would train you to ignore the
            channel that matters.
          </p>

          {status && !status.encryptionAvailable && (
            <Alert variant="warning" className="text-[11px]">
              APP_PASSWORD is not set on the server, so the bot token cannot be encrypted. Set it in
              .env.local and restart first.
            </Alert>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tg-token" className="text-xs text-muted-foreground">
                Bot token{" "}
                {status?.tokenStored && (
                  <span className="font-mono text-[10px]">(stored ••••{status.tokenTail})</span>
                )}
              </Label>
              <Input
                id="tg-token"
                type="password"
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                placeholder={status?.tokenStored ? "replace stored token" : "from @BotFather"}
                className="font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tg-chat" className="text-xs text-muted-foreground">
                Chat / user id
              </Label>
              <Input
                id="tg-chat"
                value={chatDraft}
                onChange={(e) => setChatDraft(e.target.value)}
                placeholder="e.g. 123456789"
                className="font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          <p className="text-[10px] text-muted-foreground">
            Create a bot with @BotFather for the token, then message it once and read your numeric id
            from @userinfobot. The token is stored encrypted and no endpoint ever returns it.
          </p>

          <Separator />

          <div className="flex flex-col gap-2">
            <Label className="text-xs text-muted-foreground">Send an alert when</Label>
            {events &&
              EVENT_COPY.map((entry) => (
                <label
                  key={entry.key}
                  className="flex items-center justify-between rounded-md bg-muted/30 px-2.5 py-2"
                >
                  <span className="flex flex-col gap-0.5 pr-3">
                    <span className="text-xs">{entry.label}</span>
                    <span className="text-[10px] text-muted-foreground">{entry.hint}</span>
                  </span>
                  <Switch
                    checked={events[entry.key]}
                    onCheckedChange={(v) => {
                      const next = { ...events, [entry.key]: v };
                      setEvents(next);
                      void onSave(
                        { events: next },
                        () => ({
                          headline: v
                            ? `Alerting on "${entry.label}"`
                            : `No longer alerting on "${entry.label}"`,
                          description: v
                            ? "Saved. The live account will notify on this event."
                            : "Saved. This event no longer sends a message.",
                        }),
                        `Could not change the "${entry.label}" alert`,
                      );
                    }}
                    aria-label={entry.label}
                  />
                </label>
              ))}
          </div>

          {notice && (
            <Alert variant={notice.ok ? "success" : "error"} className="text-[11px]">
              {notice.message}
            </Alert>
          )}

          {status?.lastError && !notice && (
            <Alert variant="warning" className="text-[11px]">
              Last delivery failed: {status.lastError}
            </Alert>
          )}

          {error && (
            <Alert variant="error" className="text-[11px]">
              {error}
            </Alert>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground">
              {status?.lastSentAt
                ? `Last sent ${formatAgo(status.lastSentAt, nowMs)}`
                : "Nothing sent yet"}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => void onTest()}
                disabled={testing || !canEnable}
              >
                {testing ? (
                  <Loader2 aria-hidden className="size-3 animate-spin" />
                ) : (
                  <Send aria-hidden className="size-3" />
                )}
                Send test
              </Button>
              <Button
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() =>
                  void onSave(
                    {
                      botToken: tokenDraft.trim() || undefined,
                      chatId: chatDraft.trim(),
                    },
                    (next) => ({
                      headline: tokenDraft.trim()
                        ? "Bot token stored (encrypted)"
                        : "Telegram chat id saved",
                      description: tokenDraft.trim()
                        ? `Token ••••${next.tokenTail ?? "????"} for chat ${next.chatId}. Send a test to confirm it works.`
                        : `Alerts go to chat ${next.chatId}.`,
                    }),
                    "Could not save the Telegram credentials",
                  )
                }
                disabled={saving || status?.encryptionAvailable === false}
              >
                {saving ? (
                  <Loader2 aria-hidden className="size-3 animate-spin" />
                ) : (
                  <Save aria-hidden className="size-3" />
                )}
                Save credentials
              </Button>
              <div className="flex items-center gap-1.5 pl-1">
                <Switch
                  checked={status?.enabled ?? false}
                  onCheckedChange={(v) =>
                    void onSave(
                      { enabled: v },
                      (next) => ({
                        headline: v ? "Telegram notifications on" : "Telegram notifications off",
                        description: v
                          ? `Live-account alerts will be sent to chat ${next.chatId}.`
                          : "No alerts will be sent until this is turned back on.",
                      }),
                      v
                        ? "Could not enable Telegram notifications"
                        : "Could not disable Telegram notifications",
                    )
                  }
                  disabled={saving || (!status?.enabled && !canEnable)}
                  aria-label="Enable Telegram notifications"
                />
                <span className="w-8 text-[11px] text-muted-foreground">
                  {status?.enabled ? "On" : "Off"}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-sm">Account Exposure Ceiling</CardTitle>
          <Badge variant="secondary" className="text-[10px]">
            enforced before every entry
          </Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            Total notional an account may have committed at once, both legs of every open hedge
            counted. This matters because deployments multiply: five deployments at three positions
            each is fifteen hedges, and nothing counted that before they existed. Zero means no
            limit.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(["live", "paper"] as AccountType[]).map((account) => (
              <ExposureField
                key={account}
                account={account}
                value={exposure[account]}
                onSave={(v) => void onSaveExposure(account, v)}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function ExposureField({
  account,
  value,
  onSave,
}: {
  account: AccountType;
  value: number;
  onSave: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [dirty, setDirty] = useState(false);
  const [lastServerValue, setLastServerValue] = useState(value);

  // Adopt a new server value only while the field is untouched, so a poll cannot
  // overwrite something half-typed. Adjusted during render rather than in an effect:
  // an effect would show the stale value for a frame.
  if (value !== lastServerValue) {
    setLastServerValue(value);
    if (!dirty) setDraft(String(value));
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`exposure-${account}`} className="text-xs capitalize text-muted-foreground">
        {account} account (USD)
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id={`exposure-${account}`}
          type="number"
          min={0}
          step={500}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setDirty(true);
          }}
          className="max-w-[10rem] font-mono text-xs"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            onSave(Number(draft) || 0);
            setDirty(false);
          }}
          disabled={!dirty}
        >
          Apply
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">
        {Number(draft) > 0
          ? `Deployments stop opening once $${Number(draft).toLocaleString()} is committed.`
          : "No ceiling — deployments are limited only by their own max positions."}
      </p>
    </div>
  );
}
