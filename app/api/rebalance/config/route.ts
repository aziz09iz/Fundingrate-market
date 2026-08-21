import { requireAuth } from "@/lib/auth/guard";
import type { ExchangeId, NetworkId, RebalanceConfig } from "@/lib/types";
import { getRebalanceConfig, saveRebalanceConfig } from "@/lib/db/rebalance";
import { getRebalanceRuntime } from "@/lib/rebalance/runtime";
import { recordAudit } from "@/lib/db/audit";
import { isNetworkId } from "@/lib/rebalance/chains";
import { EXCHANGE_IDS } from "@/lib/utils";
import {
  asObject,
  handleRouteError,
  jsonOk,
  requireBoolean,
  requirePositive,
  ValidationError,
} from "@/lib/api/validate";

/**
 * Automation guard rails. Stored server-side because the automation enforces
 * them without a browser attached; a value kept only in React state would be
 * forgotten the moment the tab closed.
 *
 * Saving `enabled: true` does not by itself let anything send — the server also
 * needs REBALANCE_AUTOMATION=true. The response reports both so the UI can say
 * which lock is missing.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function venueList(value: unknown, field: string): ExchangeId[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be an array`);
  const out: ExchangeId[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !(EXCHANGE_IDS as string[]).includes(entry)) {
      throw new ValidationError(`${field} contains an unknown exchange: ${String(entry)}`);
    }
    if (!out.includes(entry as ExchangeId)) out.push(entry as ExchangeId);
  }
  return out;
}

function boundedPct(value: unknown, field: string, min: number, max: number): number {
  const n = requirePositive(value, field, max);
  if (n < min) throw new ValidationError(`${field} must be at least ${min}`);
  return n;
}

function network(value: unknown, field: string, fallback: NetworkId): NetworkId {
  if (value === undefined || value === null) return fallback;
  if (!isNetworkId(value)) throw new ValidationError(`${field} is not a supported chain`);
  return value;
}

export async function GET(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    return jsonOk({
      config: getRebalanceConfig(),
      automation: getRebalanceRuntime().status(),
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  const denied = requireAuth(request);
  if (denied) return denied.response;

  try {
    const parsed = asObject(await request.json());
    const current = getRebalanceConfig();

    const preferred = asObject(parsed.preferredNetwork ?? {});
    const next: RebalanceConfig = {
      enabled: requireBoolean(parsed.enabled, current.enabled),
      imbalanceThresholdPct: boundedPct(
        parsed.imbalanceThresholdPct ?? current.imbalanceThresholdPct,
        "imbalanceThresholdPct",
        1,
        200,
      ),
      marginRatioTriggerPct: boundedPct(
        parsed.marginRatioTriggerPct ?? current.marginRatioTriggerPct,
        "marginRatioTriggerPct",
        10,
        99,
      ),
      minIdleBalance: requirePositive(
        parsed.minIdleBalance ?? current.minIdleBalance,
        "minIdleBalance",
        1e7,
      ),
      preferredNetwork: {
        USDT: network(preferred.USDT, "preferredNetwork.USDT", current.preferredNetwork.USDT),
        USDC: network(preferred.USDC, "preferredNetwork.USDC", current.preferredNetwork.USDC),
      },
      maxTransfersPerDay: Math.trunc(
        boundedPct(parsed.maxTransfersPerDay ?? current.maxTransfersPerDay, "maxTransfersPerDay", 1, 50),
      ),
      maxAmountPerTransfer: requirePositive(
        parsed.maxAmountPerTransfer ?? current.maxAmountPerTransfer,
        "maxAmountPerTransfer",
        1e7,
      ),
      cooldownMinutes: Math.trunc(
        boundedPct(parsed.cooldownMinutes ?? current.cooldownMinutes, "cooldownMinutes", 1, 10_080),
      ),
      allowedSources: parsed.allowedSources === undefined
        ? current.allowedSources
        : venueList(parsed.allowedSources, "allowedSources"),
      allowedDestinations: parsed.allowedDestinations === undefined
        ? current.allowedDestinations
        : venueList(parsed.allowedDestinations, "allowedDestinations"),
    };

    const saved = saveRebalanceConfig(next);
    recordAudit({
      action: "rebalance.config",
      payload: {
        enabled: saved.enabled,
        maxAmountPerTransfer: saved.maxAmountPerTransfer,
        maxTransfersPerDay: saved.maxTransfersPerDay,
        cooldownMinutes: saved.cooldownMinutes,
        allowedSources: saved.allowedSources,
        allowedDestinations: saved.allowedDestinations,
      },
      outcome: "saved",
    });

    return jsonOk({ config: saved, automation: getRebalanceRuntime().status() });
  } catch (err) {
    return handleRouteError(err);
  }
}
