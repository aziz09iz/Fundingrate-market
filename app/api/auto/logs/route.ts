import { requireAuth } from "@/lib/auth/guard";
import type { AccountType, LogChannel } from "@/lib/types";
import { STRATEGY_IDS } from "@/lib/types";
import { strategyLogs } from "@/lib/db/strategy";
import { getStrategyRuntime } from "@/lib/strategy/runtime";
import { handleRouteError, jsonOk } from "@/lib/api/validate";

/**
 * Strategy log lines, real decisions rather than a synthetic feed.
 *
 * Behind auth and polled rather than streamed: these lines carry position sizes
 * and PnL, and EventSource cannot send an Authorization header, so cloning the
 * public market SSE route would expose account data on an open endpoint.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const params = new URL(request.url).searchParams;
    const account = params.get("account");
    const accountType: AccountType | undefined =
      account === "live" || account === "paper" ? account : undefined;
    const raw = params.get("strategy");
    // An unknown value is ignored rather than rejected: the logs page is a
    // read-only view, and dropping the filter shows more than asked rather than
    // failing outright.
    const strategy: LogChannel | undefined =
      raw === "system" || (raw !== null && (STRATEGY_IDS as string[]).includes(raw))
        ? (raw as LogChannel)
        : undefined;
    const limit = Number(params.get("limit") ?? 300);

    // Keeps the engines alive even if only the log page is open.
    getStrategyRuntime();

    return jsonOk({
      logs: strategyLogs({
        accountType,
        strategy,
        limit: Number.isFinite(limit) ? limit : 300,
      }),
    });
  } catch (err) {
    return handleRouteError(err);
  }
}
