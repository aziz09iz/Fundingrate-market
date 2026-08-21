import type { AccountType, ExchangeId, TransferToken } from "@/lib/types";
import type { StoredDeployment } from "@/lib/db/deployments";
import { telegramConfig } from "@/lib/db/settings";
import { formatMessage, sendTelegram } from "@/lib/notify/telegram";
import { STRATEGY_META } from "@/lib/types";
import { exchangeName } from "@/lib/utils";

/**
 * Notification dispatch.
 *
 * Sits between the trading code and the transport so callers never need to know
 * whether Telegram is configured, which events are subscribed, or what the message
 * looks like. Every entry point is fire-and-forget and swallows its own errors: an
 * alert that fails to send must not fail the hedge that triggered it.
 *
 * Paper events are deliberately not sent. A simulated account generates the same
 * volume of activity as a live one and none of the consequence, so notifying on it
 * would train the operator to ignore the channel that matters.
 */

export type StrategyEventKind = "opened" | "closed" | "failed";

export interface StrategyEvent {
  kind: StrategyEventKind;
  deployment: StoredDeployment;
  coin: string;
  detail: string;
  realizedPnl?: number | null;
}

/** True when this event class is subscribed and the account is live. */
function wants(kind: StrategyEventKind, accountType: AccountType): boolean {
  if (accountType !== "live") return false;
  const config = telegramConfig();
  if (!config || !config.enabled) return false;
  if (kind === "opened") return config.events.opened;
  if (kind === "closed") return config.events.closed;
  return config.events.failures;
}

const TITLE: Record<StrategyEventKind, string> = {
  opened: "Hedge opened",
  closed: "Hedge closed",
  failed: "Automation failure",
};

export async function notifyStrategyEvent(event: StrategyEvent): Promise<void> {
  try {
    if (!wants(event.kind, event.deployment.accountType)) return;
    const strategyName = STRATEGY_META[event.deployment.strategy].name;
    const lines = [
      `${event.deployment.label} · ${strategyName} · live`,
      event.detail,
    ];
    if (event.kind === "closed" && event.realizedPnl !== null && event.realizedPnl !== undefined) {
      lines.push(`Realized PnL: ${event.realizedPnl >= 0 ? "+" : ""}$${event.realizedPnl.toFixed(2)}`);
    }
    await sendTelegram(formatMessage(`${TITLE[event.kind]} — ${event.coin}`, lines));
  } catch {
    // Notification is never allowed to break the caller.
  }
}

export interface TransferEvent {
  from: ExchangeId;
  to: ExchangeId;
  token: TransferToken;
  amount: number;
  network: string;
  /** True when the automation sent it rather than a person. */
  auto: boolean;
  /** Present when the transfer failed. */
  error?: string | null;
}

/**
 * An outbound withdrawal, which is the one event worth notifying on regardless of
 * settings granularity: it is irreversible and, when automated, unattended.
 */
export async function notifyTransfer(event: TransferEvent): Promise<void> {
  try {
    const config = telegramConfig();
    if (!config || !config.enabled) return;
    const failed = Boolean(event.error);
    if (failed ? !config.events.failures : !config.events.transfers) return;

    const title = failed ? "Transfer failed" : event.auto ? "Automated transfer sent" : "Transfer sent";
    const lines = [
      `${event.amount} ${event.token} · ${exchangeName(event.from)} → ${exchangeName(event.to)}`,
      `Network: ${event.network}`,
    ];
    if (event.error) lines.push(event.error);
    await sendTelegram(formatMessage(title, lines));
  } catch {
    // Same rule: a failed alert must not fail the transfer record.
  }
}
