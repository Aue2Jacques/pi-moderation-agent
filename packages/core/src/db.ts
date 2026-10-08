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
  migrate(db);
}

/** Additive, idempotent upgrades for app.db files created before a column existed (CREATE TABLE IF NOT EXISTS
 *  does not add columns to an existing table). */
function migrate(db: Db): void {
  const cols = new Set((db.prepare("PRAGMA table_info(review)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("submission_attempt")) {
    // R2: before this column, only generation 1 could ever bind a submission (the bind required submission_id IS NULL)
    db.exec("ALTER TABLE review ADD COLUMN submission_attempt INTEGER; UPDATE review SET submission_attempt=1 WHERE submission_id IS NOT NULL;");
  }
  const content = new Set((db.prepare("PRAGMA table_info(content)").all() as { name: string }[]).map((c) => c.name));
  if (!content.has("reply_to")) db.exec("ALTER TABLE content ADD COLUMN reply_to TEXT; ALTER TABLE content ADD COLUMN mentions TEXT;");   // R8b
  db.exec("CREATE INDEX IF NOT EXISTS content_reply ON content(reply_to, event_time)");
  const mc = new Set((db.prepare("PRAGMA table_info(model_call)").all() as { name: string }[]).map((c) => c.name));
  if (!mc.has("response_key")) {
    // R5a: model_call was one row per generation task (first response only); rebuild with the per-response key.
    // Old rows keep their single response as response_key 'legacy'.
    db.exec(`BEGIN;
      CREATE TABLE model_call_r5a (
        generation_task_id TEXT NOT NULL, response_key TEXT NOT NULL,
        review_id TEXT NOT NULL REFERENCES review(review_id), attempt INTEGER NOT NULL, conversation_id TEXT NOT NULL,
        model TEXT NOT NULL, usage TEXT, stop_reason TEXT, created_at INTEGER NOT NULL,
        PRIMARY KEY (generation_task_id, response_key));
      INSERT INTO model_call_r5a SELECT generation_task_id, 'legacy', review_id, attempt, conversation_id, model, first_usage, NULL, created_at FROM model_call;
      DROP TABLE model_call;
      ALTER TABLE model_call_r5a RENAME TO model_call;
      CREATE INDEX IF NOT EXISTS model_call_review ON model_call(review_id);
      COMMIT;`);
  }
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
