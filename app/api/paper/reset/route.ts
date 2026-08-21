import { requireAuth } from "@/lib/auth/guard";
import { DEFAULT_PAPER_BALANCE } from "@/lib/types";
import { paperAccountOverview, resetPaperAccount } from "@/lib/db/paper";
import { markPriceMap } from "@/lib/market/marks";
import { recordAudit } from "@/lib/db/audit";
import {
  asObject,
  handleRouteError,
  jsonOk,
  optionalPositive,
} from "@/lib/api/validate";

// Wipes the paper account and re-seeds its balance. Destructive by design, so
// it is a POST behind auth and the UI confirms before calling it.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      // An empty body means "reset to the default balance".
    }
    const parsed = asObject(body);
    const startingBalance =
      optionalPositive(parsed.startingBalance, "startingBalance", 100_000_000) ??
      DEFAULT_PAPER_BALANCE;

    recordAudit({
      action: "paper.reset",
      accountType: "paper",
      payload: { startingBalance },
      outcome: "requested",
    });

    // Every paper table is cleared and the balance rewritten in one
    // transaction, so a half-reset account is not possible.
    const state = resetPaperAccount(startingBalance);

    recordAudit({
      action: "paper.reset",
      accountType: "paper",
      payload: { startingBalance },
      outcome: "completed",
    });

    return jsonOk({ state, overview: paperAccountOverview(markPriceMap()) });
  } catch (err) {
    return handleRouteError(err);
  }
}
