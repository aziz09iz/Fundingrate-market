import { randomUUID } from "node:crypto";
import type { ExchangeId, Order, TradeSource } from "@/lib/types";
import { privateAdapter } from "@/lib/private";
import { clientOrderIdFor } from "@/lib/private/client-id";
import { getCredentials } from "@/lib/db/credentials";
import {
  insertLiveOrder,
  liveExchangeOrderId,
  liveOrderById,
  livePositions,
  markLiveOrderCancelled,
} from "@/lib/db/live";
import { completeAudit, recordAudit } from "@/lib/db/audit";
import { getLiveRuntime } from "@/lib/private/runtime";

/**
 * Live order execution.
 *
 * These functions send real orders to real venues with real money. Three things
 * are therefore non-negotiable here:
 *   1. Every attempt is written to the audit log *before* it is sent.
 *   2. A read-only credential is refused rather than attempted.
 *   3. A venue without order support is refused explicitly, not silently.
 */

const REQUEST_TIMEOUT_MS = 20_000;

export class OrderRejected extends Error {}

export interface PlaceLiveOrderInput {
  exchange: ExchangeId;
  coin: string;
  side: "buy" | "sell";
  orderType: "market" | "limit";
  size: number;
  price?: number;
  leverage?: number;
  reduceOnly?: boolean;
  hedgeId?: string;
  /** Who asked for this order. Defaults to manual, so only the strategy has to
   * say otherwise. */
  source?: TradeSource;
}

export interface PlaceLiveOrderResult {
  order: Order;
  exchangeOrderId: string;
}

function assertTradable(exchange: ExchangeId) {
  const adapter = privateAdapter(exchange);
  if (!adapter) throw new OrderRejected(`No adapter for ${exchange}`);
  if (!adapter.supportsTrading || typeof adapter.placeOrder !== "function") {
    throw new OrderRejected(
      `${exchange} order placement is not implemented in this app. It is read-only here.`,
    );
  }
  const creds = getCredentials(exchange);
  if (!creds) {
    throw new OrderRejected(`No credentials configured for ${exchange}`);
  }
  if (creds.readOnly) {
    throw new OrderRejected(
      `${exchange} credentials are marked read-only. Orders are refused.`,
    );
  }
  return { adapter, creds };
}

export async function placeLiveOrder(
  input: PlaceLiveOrderInput,
): Promise<PlaceLiveOrderResult> {
  const { adapter, creds } = assertTradable(input.exchange);
  const source: TradeSource = input.source ?? "manual";
  const clientOrderId = clientOrderIdFor(source);

  // Recorded before the request leaves, so an order that vanishes mid-flight is
  // still traceable.
  const auditId = recordAudit({
    action: "live.order.place",
    accountType: "live",
    exchange: input.exchange,
    coin: input.coin,
    payload: {
      side: input.side,
      orderType: input.orderType,
      size: input.size,
      price: input.price,
      leverage: input.leverage,
      reduceOnly: input.reduceOnly,
      clientOrderId,
    },
    outcome: "submitting",
  });

  const localId = randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const result = await adapter.placeOrder!(
      creds,
      {
        coin: input.coin,
        side: input.side,
        orderType: input.orderType,
        size: input.size,
        price: input.price,
        leverage: input.leverage,
        reduceOnly: input.reduceOnly,
        clientOrderId,
      },
      controller.signal,
    );

    insertLiveOrder({
      id: localId,
      exchange: input.exchange,
      exchangeOrderId: result.exchangeOrderId || null,
      clientOrderId,
      coin: input.coin,
      side: input.side,
      orderType: input.orderType,
      price: input.price ?? result.filledPrice ?? 0,
      size: input.size,
      status: result.status,
      leverage: input.leverage ?? 1,
      reduceOnly: input.reduceOnly,
      hedgeId: input.hedgeId ?? null,
      source,
    });

    completeAudit(auditId, "submitted");

    const order = liveOrderById(localId);
    if (!order) throw new Error("order was not persisted");
    return { order, exchangeOrderId: result.exchangeOrderId };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    completeAudit(auditId, "failed", detail);
    throw err;
  } finally {
    clearTimeout(timer);
    // Pick up the venue's own view of the order as soon as it streams in.
    getLiveRuntime().resync();
  }
}

export interface CancelLiveOrderInput {
  /** Local order id from live_orders. */
  id: string;
}

export async function cancelLiveOrder(input: CancelLiveOrderInput): Promise<void> {
  const order = liveOrderById(input.id);
  if (!order) throw new OrderRejected("Order not found");
  const adapter = privateAdapter(order.exchange);
  if (!adapter || typeof adapter.cancelOrder !== "function") {
    throw new OrderRejected(`${order.exchange} cancel is not implemented in this app`);
  }
  const creds = getCredentials(order.exchange);
  if (!creds) throw new OrderRejected(`No credentials configured for ${order.exchange}`);
  if (creds.readOnly) {
    throw new OrderRejected(`${order.exchange} credentials are read-only. Cancel is refused.`);
  }

  const auditId = recordAudit({
    action: "live.order.cancel",
    accountType: "live",
    exchange: order.exchange,
    coin: order.pair,
    payload: { id: input.id },
    outcome: "submitting",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    await adapter.cancelOrder(
      creds,
      {
        coin: order.pair,
        exchangeOrderId: liveExchangeOrderId(input.id),
        clientOrderId: null,
      },
      controller.signal,
    );
    markLiveOrderCancelled(input.id);
    completeAudit(auditId, "cancelled");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    completeAudit(auditId, "failed", detail);
    throw err;
  } finally {
    clearTimeout(timer);
    getLiveRuntime().resync();
  }
}

export interface ClosePositionInput {
  exchange: ExchangeId;
  coin: string;
  side: "long" | "short";
  /** Omit to close the whole position. */
  size?: number;
  source?: TradeSource;
}

/**
 * Closes a position with a reduce-only market order in the opposite direction.
 * Size is validated against the venue's reported position so a typo cannot
 * accidentally open a new position on the other side.
 */
export async function closeLivePosition(
  input: ClosePositionInput,
): Promise<PlaceLiveOrderResult> {
  const position = livePositions().find(
    (p) => p.exchange === input.exchange && p.coin === input.coin && p.side === input.side,
  );
  if (!position) {
    throw new OrderRejected(`No open ${input.side} position for ${input.coin} on ${input.exchange}`);
  }
  const size = input.size ?? position.size;
  if (size <= 0) throw new OrderRejected("size must be positive");
  if (size > position.size + 1e-12) {
    throw new OrderRejected(
      `Requested ${size} exceeds the open position of ${position.size}. Refusing to flip the position.`,
    );
  }

  return placeLiveOrder({
    exchange: input.exchange,
    coin: input.coin,
    // Closing a long means selling, and vice versa.
    side: input.side === "long" ? "sell" : "buy",
    orderType: "market",
    size,
    leverage: position.leverage,
    reduceOnly: true,
    hedgeId: position.hedgeId,
    source: input.source,
  });
}
