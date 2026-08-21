import type {
  ExchangeBalance,
  ExchangeId,
  RebalanceConfig,
  RebalanceSuggestion,
} from "@/lib/types";
import { exchangeName } from "@/lib/utils";

/**
 * Rebalance recommendations.
 *
 * Two triggers, in priority order:
 *   1. A venue close to a margin call needs collateral now.
 *   2. Capital drifting far from an equal-weight split is inefficient but not
 *      urgent.
 *
 * Every suggestion is capped by what can actually be sent: the source venue's
 * *funding* balance, not its derivatives collateral, because only funding can be
 * withdrawn. A recommendation that cannot be executed is noise — which is also
 * why sources and destinations are filtered by different capabilities. An on-chain
 * venue reports its balance but cannot sign a withdrawal here, so it can receive
 * and never send.
 */

export function totalEquity(balances: ExchangeBalance[]): number {
  return balances.reduce((sum, b) => sum + b.available + b.inPosition, 0);
}

export function venueTotal(b: ExchangeBalance): number {
  return b.available + b.inPosition;
}

/**
 * Can funds be sent from this venue?
 *
 * `transferSource === undefined` counts as yes, so a balance produced before this
 * field existed is not silently excluded; only an explicit false disqualifies.
 */
function canSend(b: ExchangeBalance): boolean {
  return b.walletSupported !== false && b.transferSource !== false;
}

/** Can funds be sent to this venue? Requires a confirmed destination address. */
function canReceive(b: ExchangeBalance): boolean {
  return b.walletSupported !== false && b.destinationAllowlisted === true;
}

/** How much this venue could send right now, respecting the idle floor. */
function sendableAmount(balance: ExchangeBalance, config: RebalanceConfig): number {
  if (!canSend(balance)) return 0;
  // Withdrawals come from the funding wallet; the futures balance would have to
  // be transferred internally first, and that is what the executor does. The
  // combined figure is the real ceiling.
  const movable = (balance.funding ?? 0) + balance.available;
  return Math.max(0, movable - config.minIdleBalance);
}

export function rebalanceSuggestions(
  balances: ExchangeBalance[],
  config: RebalanceConfig,
): RebalanceSuggestion[] {
  // Equity is measured over every venue that reports a balance, including ones
  // that can only receive: the equal-weight target is about where capital *is*,
  // not about where it can move.
  const usable = balances.filter((b) => b.walletSupported !== false);
  if (usable.length < 2) return [];
  const senders = usable.filter(canSend);
  const receivers = usable.filter(canReceive);
  if (senders.length === 0 || receivers.length === 0) return [];

  const equity = totalEquity(usable);
  if (equity <= 0) return [];
  const target = equity / usable.length;
  const out: RebalanceSuggestion[] = [];

  // ── Trigger 1: margin pressure ──
  const needy = [...receivers].sort((a, b) => b.marginRatio - a.marginRatio)[0];
  const donor = [...senders].sort(
    (a, b) => sendableAmount(b, config) - sendableAmount(a, config),
  )[0];

  if (
    needy &&
    donor &&
    needy.exchange !== donor.exchange &&
    needy.marginRatio * 100 >= config.marginRatioTriggerPct
  ) {
    const headroom = sendableAmount(donor, config);
    const amount = Math.min(
      Math.floor(Math.min(headroom, venueTotal(needy) * 0.15)),
      config.maxAmountPerTransfer,
    );
    if (amount > 0) {
      out.push({
        id: `SUG-margin-${needy.exchange}`,
        from: donor.exchange,
        to: needy.exchange,
        token: "USDT",
        amount,
        reason: `${exchangeName(needy.exchange)} margin at ${(needy.marginRatio * 100).toFixed(0)}%, ${exchangeName(donor.exchange)} has $${headroom.toLocaleString()} movable`,
        urgency: needy.marginRatio >= 0.85 ? "high" : "medium",
      });
    }
  }

  // ── Trigger 2: drift from equal weight ──
  const receiver = [...receivers].sort((a, b) => venueTotal(a) - venueTotal(b))[0];

  if (receiver) {
    for (const b of senders) {
      if (b.exchange === receiver.exchange) continue;
      const deviationPct = ((venueTotal(b) - target) / target) * 100;
      if (deviationPct <= config.imbalanceThresholdPct) continue;
      if (out.some((s) => s.from === b.exchange && s.to === receiver.exchange)) continue;
      const headroom = sendableAmount(b, config);
      const amount = Math.min(
        Math.floor(Math.min(headroom, venueTotal(b) - target)),
        config.maxAmountPerTransfer,
      );
      if (amount <= 0) continue;
      out.push({
        id: `SUG-drift-${b.exchange}`,
        from: b.exchange,
        to: receiver.exchange,
        token: "USDT",
        amount,
        reason: `${exchangeName(b.exchange)} holds ${deviationPct.toFixed(0)}% above equal-weight target`,
        urgency: "low",
      });
    }
  }

  return out;
}

/**
 * Filters suggestions down to what the automation is actually permitted to send.
 * Unlike the UI preview this applies every guard rail, so the count it produces
 * is the count that would execute.
 */
export function actionableSuggestions(
  suggestions: RebalanceSuggestion[],
  balances: ExchangeBalance[],
  config: RebalanceConfig,
): RebalanceSuggestion[] {
  const byId = new Map(balances.map((b) => [b.exchange, b]));
  return suggestions.filter((s) => {
    if (!config.allowedSources.includes(s.from)) return false;
    if (!config.allowedDestinations.includes(s.to)) return false;
    if (s.amount > config.maxAmountPerTransfer) return false;
    const source = byId.get(s.from);
    if (!source || !canSend(source)) return false;
    if (sendableAmount(source, config) < s.amount) return false;
    const destination = byId.get(s.to);
    // Requires a confirmed destination rather than merely not-disallowed: an
    // unarmed address is refused at execution anyway, and counting it as
    // actionable would make the preview promise a transfer that cannot happen.
    if (!destination || !canReceive(destination)) return false;
    return true;
  });
}

/** Venues that could donate funds, for the UI's venue pickers. */
export function donorVenues(balances: ExchangeBalance[], config: RebalanceConfig): ExchangeId[] {
  return balances.filter((b) => sendableAmount(b, config) > 0).map((b) => b.exchange);
}

/** Venues that can receive funds, for the UI's venue pickers. */
export function receiverVenues(balances: ExchangeBalance[]): ExchangeId[] {
  return balances.filter(canReceive).map((b) => b.exchange);
}
