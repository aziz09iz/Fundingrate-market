import type { DatabaseSync } from "node:sqlite";
import type { AccountType, ExchangeId } from "@/lib/types";
import { getDb, rowStr } from "@/lib/db/client";

/**
 * Venue leg reservations.
 *
 * This table is the rule, not a cache of it: `PRIMARY KEY (account_type, exchange,
 * coin, side)` means one deployment can hold a given leg on a given venue, and the
 * database refuses the second claim.
 *
 * The constraint exists because it is the one the venue itself imposes. An exchange
 * nets positions per (coin, side) — if two deployments both go long BTC on Bybit,
 * Bybit holds a single long BTC position. Closing either hedge would then close
 * part of the other, and on paper `applyPaperFill` would merge them into one row
 * with a blended entry price. No schema can give two deployments separate legs
 * there, so the app models the limit instead of pretending it does not exist.
 *
 * What this replaced was blunter and also wrong in the other direction: a unique
 * index on `(account_type, coin)` allowed one open hedge per coin across all
 * strategies, so two deployments could not both hold BTC even on entirely separate
 * venues. Reserving legs rather than coins lifts that while closing the real hole.
 */

export interface LegClaim {
  accountType: AccountType;
  exchange: ExchangeId;
  coin: string;
  side: "long" | "short";
}

export interface ReservationConflict {
  claim: LegClaim;
  /** The position already holding this leg. */
  positionId: string;
  deploymentId: string;
}

/**
 * Claims both legs of a hedge, or nothing.
 *
 * Must be called inside a transaction: a partial claim would leave one leg reserved
 * for a hedge that was never queued, and nothing would ever release it. Returns the
 * conflicting claim when a leg is taken, so the caller can say which one and by
 * whom rather than reporting a bare failure.
 */
export function claimLegs(
  db: DatabaseSync,
  claims: LegClaim[],
  positionId: string,
  deploymentId: string,
): ReservationConflict | null {
  const now = Date.now();
  for (const claim of claims) {
    const existing = db
      .prepare(
        "SELECT position_id, deployment_id FROM leg_reservations WHERE account_type = ? AND exchange = ? AND coin = ? AND side = ?",
      )
      .get(claim.accountType, claim.exchange, claim.coin, claim.side) as
      | Record<string, unknown>
      | undefined;
    if (existing) {
      return {
        claim,
        positionId: rowStr(existing.position_id),
        deploymentId: rowStr(existing.deployment_id),
      };
    }
    db.prepare(
      "INSERT INTO leg_reservations (account_type, exchange, coin, side, position_id, deployment_id, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      claim.accountType,
      claim.exchange,
      claim.coin,
      claim.side,
      positionId,
      deploymentId,
      now,
    );
  }
  return null;
}

/** Frees every leg a position held. Safe to call more than once. */
export function releaseLegs(positionId: string): void {
  getDb().prepare("DELETE FROM leg_reservations WHERE position_id = ?").run(positionId);
}

/** Who holds this leg right now, if anyone. */
export function legHolder(claim: LegClaim): ReservationConflict | null {
  const row = getDb()
    .prepare(
      "SELECT position_id, deployment_id FROM leg_reservations WHERE account_type = ? AND exchange = ? AND coin = ? AND side = ?",
    )
    .get(claim.accountType, claim.exchange, claim.coin, claim.side) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    claim,
    positionId: rowStr(row.position_id),
    deploymentId: rowStr(row.deployment_id),
  };
}

/**
 * Legs held on this account, as a lookup key set.
 *
 * Used by the engines to skip a candidate whose legs are taken before doing the work
 * of ranking it. Keys are `exchange:coin:side`.
 */
export function heldLegKeys(accountType: AccountType): Set<string> {
  const rows = getDb()
    .prepare("SELECT exchange, coin, side FROM leg_reservations WHERE account_type = ?")
    .all(accountType) as Record<string, unknown>[];
  return new Set(
    rows.map((row) => `${rowStr(row.exchange)}:${rowStr(row.coin)}:${rowStr(row.side)}`),
  );
}

export function legKey(exchange: ExchangeId, coin: string, side: "long" | "short"): string {
  return `${exchange}:${coin}:${side}`;
}

/**
 * Drops reservations whose position is no longer active.
 *
 * A safety net, not the main path — `releaseLegs` runs when a hedge settles. This
 * catches the case where the process died between closing a position and freeing its
 * legs, which would otherwise block that venue leg permanently.
 */
export function reconcileReservations(): number {
  const result = getDb()
    .prepare(
      "DELETE FROM leg_reservations WHERE position_id NOT IN " +
        "(SELECT id FROM strategy_positions WHERE status IN ('queued','opening','open','closing'))",
    )
    .run();
  return Number(result.changes ?? 0);
}
