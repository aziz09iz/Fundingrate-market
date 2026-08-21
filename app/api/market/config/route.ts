import { getMarketRuntime } from "@/lib/market/runtime";

// Reads and updates the poll cadence and layer 1 size.
//
// Unauthenticated, like the rest of this market API. That is acceptable on a
// machine you control, but anyone who can reach the server can change these
// values — put auth in front of it before exposing the app publicly.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const market = getMarketRuntime();
  return Response.json(market.snapshot().config, {
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  const market = getMarketRuntime();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return new Response("Expected an object", { status: 400 });
  }

  const patch = body as Record<string, unknown>;
  const next: { pollIntervalSec?: number; layer1CountPerExchange?: number } = {};

  if (patch.pollIntervalSec !== undefined) {
    const value = Number(patch.pollIntervalSec);
    if (!Number.isFinite(value)) {
      return new Response("pollIntervalSec must be a number", { status: 400 });
    }
    next.pollIntervalSec = value;
  }
  if (patch.layer1CountPerExchange !== undefined) {
    const value = Number(patch.layer1CountPerExchange);
    if (!Number.isFinite(value)) {
      return new Response("layer1CountPerExchange must be a number", { status: 400 });
    }
    next.layer1CountPerExchange = value;
  }

  // Values are clamped in the store, so out-of-range input is corrected rather
  // than rejected; the response echoes what was actually applied.
  const applied = market.setConfig(next);
  return Response.json(applied, { headers: { "cache-control": "no-store" } });
}
