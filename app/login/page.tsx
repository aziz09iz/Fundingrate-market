"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CircleDollarSign, Loader2, LockKeyhole } from "lucide-react";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

/** "6h 0m", "9m 41s", "8s" — compact enough to sit in a button label. */
function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1_000);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/**
 * Password login.
 *
 * The password is posted once and exchanged for an httpOnly session cookie, so
 * it is never held in any browser storage the page can read.
 *
 * The server throttles wrong guesses — a 10 second gap after each, and a 6 hour
 * lockout after three in a row — and returns how long to wait. That wait is shown
 * as a live countdown rather than left as an error string, because a form that
 * silently refuses for six hours is indistinguishable from a broken one.
 */
function LoginForm() {
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Epoch ms the server said to wait until, or null when not throttled. */
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Ticks only while a wait is outstanding, so an idle page runs no timer.
  useEffect(() => {
    if (blockedUntil === null) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [blockedUntil]);

  const remainingMs = blockedUntil === null ? 0 : Math.max(0, blockedUntil - nowMs);
  const throttled = remainingMs > 0;

  // Only same-origin paths are honoured, so a crafted ?next= cannot bounce the
  // browser to another site after a successful login.
  const nextParam = params.get("next");
  const destination = nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//")
    ? nextParam
    : "/dashboard/cross";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || throttled) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
        cache: "no-store",
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string; retryAfterMs?: number }
          | null;
        setError(payload?.error ?? "Sign in failed.");
        // The server is the only authority on the wait; the page just displays it.
        if (typeof payload?.retryAfterMs === "number" && payload.retryAfterMs > 0) {
          setNowMs(Date.now());
          setBlockedUntil(Date.now() + payload.retryAfterMs);
        }
        setPassword("");
        setBusy(false);
        return;
      }
      setPassword("");
      // A full document load, not router.replace: every route this client
      // prefetched before signing in was resolved by the proxy as a redirect
      // back to /login, and a soft navigation would replay that cached redirect
      // and land here again. replace() also keeps /login out of the back stack.
      window.location.replace(destination);
    } catch {
      setError("Could not reach the server.");
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <CircleDollarSign className="size-5" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight">Funding Rate Market</h1>
          <p className="text-sm text-muted-foreground">
            Enter the app password to continue.
          </p>
        </div>

        <form
          onSubmit={submit}
          className="flex flex-col gap-4 rounded-xl border border-border bg-card/60 p-5"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password" className="text-xs text-muted-foreground">
              Password
            </Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              autoFocus
              disabled={throttled}
              className="h-9"
              aria-invalid={error !== null}
              aria-describedby={error ? "login-error" : undefined}
            />
          </div>

          {error && (
            <p id="login-error" role="alert" className="text-xs text-red-400">
              {error}
            </p>
          )}

          <Button
            type="submit"
            size="lg"
            disabled={busy || throttled || password.length === 0}
            className="gap-1.5"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <LockKeyhole className="size-4" />}
            {throttled
              ? `Locked — ${formatCountdown(remainingMs)}`
              : busy
                ? "Signing in…"
                : "Sign in"}
          </Button>
        </form>

        <p className="mt-4 text-center text-[10px] text-muted-foreground">
          The password is set as APP_PASSWORD on the server. The session is a
          signed httpOnly cookie and expires after 7 days.
        </p>
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
          A wrong password waits 10 seconds; three in a row lock sign-in for 6 hours.
          Restarting the server clears the lock.
        </p>
      </div>
    </div>
  );
}
