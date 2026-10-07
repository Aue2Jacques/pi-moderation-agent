// app.db connection and transaction helpers. Rules: docs/dev-doc-v1.md §13.5.
// - every write transaction is BEGIN IMMEDIATE
// - no await inside a transaction (DatabaseSync is synchronous anyway)
// - busy_timeout is per connection and short (W 1500ms, G 2000ms)
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Role = "worker" | "gateway" | "test" | "tool";

const BUSY_MS: Record<Role, number> = { worker: 1500, gateway: 2000, test: 1500, tool: 3000 };

export type Db = DatabaseSync;

export function openAppDb(path: string, role: Role): Db {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec(`PRAGMA busy_timeout=${BUSY_MS[role]}`);
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

export function ensureSchema(db: Db): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  db.exec(sql);
}

/** Run `fn` inside BEGIN IMMEDIATE … COMMIT. Any throw rolls back and rethrows. Nested use is a bug (SQLite rejects it). */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  let out: T;
  try {
    out = fn();
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  db.exec("COMMIT");
  return out;
}

/** Global ingest sequence. Must be called inside a transaction. */
export function nextSeq(db: Db): number {
  const row = db.prepare("UPDATE ledger_seq SET value=value+1 WHERE id=1 RETURNING value").get() as { value: number };
  return row.value;
}

/** Current ledger value without taking a number (snapshot boundary). Inside a transaction. */
export function currentSeq(db: Db): number {
  const row = db.prepare("SELECT value FROM ledger_seq WHERE id=1").get() as { value: number };
  return row.value;
}

export const now = (): number => Date.now();
