"use client";

/**
 * Client-side API helper.
 *
 * Authentication is a signed httpOnly session cookie set by /api/auth/login, so
 * there is nothing for the browser to attach: the cookie rides along with every
 * same-origin request automatically and the page's JavaScript cannot read it.
 */

export class AuthRequiredError extends Error {
  constructor(message = "Session expired. Sign in again.") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

/**
 * Fetch wrapper that turns error responses into thrown errors carrying the
 * server's message.
 *
 * A 401 means the session is gone — expired, or the password was changed — so the
 * browser is sent back to the login page rather than left showing a screen of
 * failed panels.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const headers = new Headers(init.headers);

  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }

  const res = await fetch(path, { ...init, headers, body, cache: "no-store" });

  if (res.status === 401) {
    if (typeof window !== "undefined") {
      const next = `${window.location.pathname}${window.location.search}`;
      // A full document load, not a router push: the session is gone, and every
      // panel currently holding data fetched under it has to be discarded.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = `/login?next=${encodeURIComponent(next)}`;
    }
    throw new AuthRequiredError();
  }

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }

  if (!res.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new Error(message);
  }

  return payload as T;
}

/** Clears the session cookie and returns to the login page. */
export async function signOut(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST", cache: "no-store" });
  } finally {
    // Full reload for the same reason as above: nothing fetched under the old
    // session should survive into the login screen.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    if (typeof window !== "undefined") window.location.href = "/login";
  }
}
