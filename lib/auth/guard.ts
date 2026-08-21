import { SESSION_COOKIE, sessionValid } from "@/lib/auth/session";
import { passwordConfigured } from "@/lib/auth/password";

/**
 * Access control for routes that can move money or read credential state.
 *
 * One check: a valid session cookie, which the browser only receives after
 * posting the correct password to /api/auth/login. The market data routes stay
 * public — they expose nothing private. Anything that places an order, resets an
 * account, or touches credentials goes through `requireAuth` first.
 *
 * The proxy already redirects unauthenticated page requests to /login, but every
 * route re-checks here: a matcher change or a direct API call must not be able
 * to bypass the only gate.
 */

export interface AuthFailure {
  response: Response;
}

function deny(message: string, status: number): AuthFailure {
  return {
    response: new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }),
  };
}

/** Reads one cookie out of the request's Cookie header. */
function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Returns null when the request may proceed, or an AuthFailure whose `response`
 * should be returned directly by the route.
 */
export function requireAuth(request: Request): AuthFailure | null {
  if (!passwordConfigured()) {
    // Refusing outright is safer than defaulting to open: an unset password
    // would otherwise leave order endpoints reachable by anyone.
    return deny(
      "APP_PASSWORD is not configured on the server. Set it in .env.local before using account endpoints.",
      503,
    );
  }

  if (!sessionValid(cookieValue(request, SESSION_COOKIE))) {
    return deny("Not signed in.", 401);
  }

  return null;
}

/** True when the server has enough configuration for authenticated routes. */
export function authConfigured(): boolean {
  return passwordConfigured();
}
