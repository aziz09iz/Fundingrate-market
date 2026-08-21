import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session";

/** Clears the session cookie. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const response = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    ...sessionCookieOptions(new URL(request.url).protocol === "https:"),
    maxAge: 0,
  });
  return response;
}
