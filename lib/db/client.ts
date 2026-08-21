import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "@/lib/db/migrations";

/**
 * SQLite access through Node's built-in `node:sqlite`. No native build step and
 * no extra dependency, which matters because better-sqlite3 needs a C++
 * toolchain that is not present on every machine.
 *
 * Every statement in this app binds parameters — never string-concatenate
 * values into SQL, even for internal callers.
 */

const DATA_DIR = join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "app.db");

// Survive dev-server hot reloads so each recompile does not open a new handle.
const globalRef = globalThis as typeof globalThis & {
  __frwDb?: DatabaseSync;
};

export function getDb(): DatabaseSync {
  if (globalRef.__frwDb) return globalRef.__frwDb;

  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);

  // WAL keeps reads from blocking the writer; foreign keys are off by default
  // in SQLite and must be enabled per connection.
  db.prepare("PRAGMA journal_mode = WAL").run();
  db.prepare("PRAGMA foreign_keys = ON").run();
  db.prepare("PRAGMA busy_timeout = 5000").run();
  // NORMAL rather than the FULL default, which fsyncs on every commit.
  //
  // This is a real cost, not a micro-optimisation: the strategy loop writes a
  // `last_run_at` per deployment every 5 seconds whether or not the deployment is
  // switched on, and `node:sqlite` is synchronous — so each fsync blocks the same
  // event loop that is parsing ten venues' order-book frames. Measured on this
  // schema with 7 deployments: 0.925 ms per tick at FULL against 0.044 ms at
  // NORMAL, and on a shared VPS disk an fsync costs far more than on local NVMe.
  //
  // In WAL mode NORMAL cannot corrupt the database. The exposure is losing the
  // last few committed transactions on a power cut, and what is at stake there is
  // a run timestamp and a log line — not an order or a position, both of which are
  // reconciled from the venue on restart anyway.
  db.prepare("PRAGMA synchronous = NORMAL").run();

  runMigrations(db);
  globalRef.__frwDb = db;
  return db;
}

/**
 * Runs `fn` inside a transaction, rolling back if it throws. Used wherever a
 * partial write would be worse than no write — a half-finished account reset,
 * for instance.
 */
export function inTransaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  db.prepare("BEGIN IMMEDIATE").run();
  try {
    const result = fn(db);
    db.prepare("COMMIT").run();
    return result;
  } catch (err) {
    try {
      db.prepare("ROLLBACK").run();
    } catch {
      // Rollback can fail if the transaction already ended; the original error
      // is the one worth surfacing.
    }
    throw err;
  }
}

/** Narrow a sqlite row value to a number, treating null/undefined as fallback. */
export function rowNum(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** Narrow a sqlite row value to a string. */
export function rowStr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** SQLite has no boolean type; integers 0/1 are used instead. */
export function rowBool(value: unknown): boolean {
  return rowNum(value, 0) !== 0;
}
