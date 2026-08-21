"use client";

import { Suspense, useState } from "react";
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

/**
 * Password login.
 *
 * The password is posted once and exchanged for an httpOnly session cookie, so
 * it is never held in any browser storage the page can read.
 */
function LoginForm() {
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only same-origin paths are honoured, so a crafted ?next= cannot bounce the
  // browser to another site after a successful login.
  const nextParam = params.get("next");
  const destination = nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//")
    ? nextParam
    : "/dashboard/cross";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
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
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "Sign in failed.");
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

          <Button type="submit" size="lg" disabled={busy || password.length === 0} className="gap-1.5">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <LockKeyhole className="size-4" />}
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p className="mt-4 text-center text-[10px] text-muted-foreground">
          The password is set as APP_PASSWORD on the server. The session is a
          signed httpOnly cookie and expires after 7 days.
        </p>
      </div>
    </div>
  );
}
