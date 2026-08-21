import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, sessionValid } from "@/lib/auth/session";

/**
 * Gate every page behind the password session.
 *
 * This is the redirect layer only — it decides whether a browser sees /login or
 * the app. API routes are deliberately excluded from the matcher and check the
 * session themselves through `requireAuth`, because a proxy matcher is the wrong
 * place for the only authorization check: editing this file must not be able to
 * expose an order endpoint.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const authed = sessionValid(request.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === "/login") {
    if (authed) return NextResponse.redirect(new URL("/dashboard", request.url));
    return NextResponse.next();
  }

  if (authed) return NextResponse.next();

  const login = new URL("/login", request.url);
  // Preserve where they were headed, so a bookmarked deep link survives login.
  if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)"],
};
