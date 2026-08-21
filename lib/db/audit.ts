import type { AccountType, ExchangeId } from "@/lib/types";
import { getDb, rowStr } from "@/lib/db/client";

/**
 * Audit trail and idempotency.
 *
 * Anything that can move money is recorded before it is attempted, so an
 * unexpected outcome can always be traced to exactly what was sent. Payloads
 * are stored as JSON with credential-shaped fields stripped.
 */

export interface AuditEntry {
  action: string;
  accountType?: AccountType;
  exchange?: ExchangeId;
  coin?: string;
  payload?: unknown;
  outcome?: string;
  error?: string;
}

/** Field names that must never reach the audit log. */
const SECRET_KEYS = new Set([
  "apisecret",
  "apikey",
  "passphrase",
  "secret",
  "signature",
  "token",
  "authorization",
  "privatekey",
]);

/**
 * Deep-copies a payload, replacing anything that looks like a credential.
 * The audit log is meant to be readable, so it must not become a secret store.
 */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.has(key.toLowerCase()) ? "[redacted]" : redact(val, depth + 1);
  }
  return out;
}

export function recordAudit(entry: AuditEntry): number {
  const payload = entry.payload === undefined ? null : JSON.stringify(redact(entry.payload));
  const result = getDb()
    .prepare(
      "INSERT INTO audit_log (at, action, account_type, exchange, coin, payload, outcome, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      Date.now(),
      entry.action,
      entry.accountType ?? null,
      entry.exchange ?? null,
      entry.coin ?? null,
      payload,
      entry.outcome ?? null,
      entry.error ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function completeAudit(id: number, outcome: string, error?: string | null): void {
  getDb()
    .prepare("UPDATE audit_log SET outcome = ?, error = ? WHERE id = ?")
    .run(outcome, error ?? null, id);
}

export interface AuditRow {
  id: number;
  at: number;
  action: string;
  accountType: string | null;
  exchange: string | null;
  coin: string | null;
  outcome: string | null;
  error: string | null;
}

export function recentAudit(limit = 50): AuditRow[] {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = getDb()
    .prepare(
      "SELECT id, at, action, account_type, exchange, coin, outcome, error FROM audit_log ORDER BY at DESC LIMIT ?",
    )
    .all(capped) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    at: Number(r.at),
    action: rowStr(r.action),
    accountType: (r.account_type as string | null) ?? null,
    exchange: (r.exchange as string | null) ?? null,
    coin: (r.coin as string | null) ?? null,
    outcome: (r.outcome as string | null) ?? null,
    error: (r.error as string | null) ?? null,
  }));
}

// ─── Idempotency ────────────────────────────────────────────────────────────

/**
 * Claims an idempotency key. Returns the stored response when the key was
 * already used, so a retried or double-clicked request cannot place a second
 * order. Returns null when the key is fresh and the caller should proceed.
 */
export function claimIdempotencyKey(key: string, action: string): string | null {
  const db = getDb();
  const existing = db
    .prepare("SELECT response FROM idempotency WHERE key = ?")
    .get(key) as { response?: unknown } | undefined;
  if (existing) return rowStr(existing.response, "");

  db.prepare("INSERT INTO idempotency (key, action, created_at) VALUES (?, ?, ?)").run(
    key,
    action,
    Date.now(),
  );
  return null;
}

export function storeIdempotentResponse(key: string, response: unknown): void {
  getDb()
    .prepare("UPDATE idempotency SET response = ? WHERE key = ?")
    .run(JSON.stringify(response), key);
}

/** Drops a claim so a failed attempt can be retried with the same key. */
export function releaseIdempotencyKey(key: string): void {
  getDb().prepare("DELETE FROM idempotency WHERE key = ? AND response IS NULL").run(key);
}
