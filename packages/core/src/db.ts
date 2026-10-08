// app.db connection and transaction helpers. Rules: docs/dev-doc-v1.md §13.5.
// - every write transaction is BEGIN IMMEDIATE
// - no await inside a transaction (DatabaseSync is synchronous anyway)
// - busy_timeout is per connection and short (W 1500ms, G 2000ms)
import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Role = "worker" | "gateway" | "test" | "tool";

const BUSY_MS: Record<Role, number> = { worker: 1500, gateway: 2000, test: 1500, tool: 3000 };

export type Db = DatabaseSync;

/** Create (or tighten) a database file as owner-only 0600 before SQLite opens it (dev plan R9c). SQLite gives the
 *  -wal and -shm files it creates the same permissions as the database file; existing ones are tightened too. */
export function ensurePrivateDbFile(path: string): void {
  if (path === ":memory:") return;
  if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
  for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
}

export function openAppDb(path: string, role: Role): Db {
  ensurePrivateDbFile(path);
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  // the busy timeout must be set BEFORE journal_mode: switching (or re-asserting) WAL needs the lock, and while another
  // process writes — e.g. G and W starting together, one of them migrating — it failed at once with "database is
  // locked" (found by test/harness/migrate-concurrent.test.ts). Opening waits as long as a migration may take, then the
  // role's short timeout applies.
  db.exec("PRAGMA busy_timeout=60000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec(`PRAGMA busy_timeout=${BUSY_MS[role]}`);
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

/**
 * Create the schema and bring an older app.db up to date, as ONE transaction taken with the write lock first
 * (stage-1 review fix 1): a second process (G and W both call this at startup) waits for the lock and then sees the
 * finished structure; a kill or an error part-way rolls everything back, so the next start repairs from a consistent
 * file. Every step checks its own complete target (each column, each backfill), never "the first column exists".
 */
export function ensureSchema(db: Db): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  beginImmediateWithRetry(db, 60_000);
  try {
    db.exec(sql);
    migrate(db);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** BEGIN IMMEDIATE, retried while another process holds the write lock (a long migration can outlast busy_timeout). */
function beginImmediateWithRetry(db: Db, maxWaitMs: number): void {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      db.exec("BEGIN IMMEDIATE");
      return;
    } catch (e) {
      if (!/locked|busy/i.test(String((e as Error).message)) || Date.now() > deadline) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);   // synchronous 100 ms back-off
    }
  }
}

const columnsOf = (db: Db, table: string): Set<string> => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
const addColumn = (db: Db, table: string, column: string, type: string): void => {
  if (!columnsOf(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
};

/** Additive, idempotent upgrades for app.db files created before a column existed (CREATE TABLE IF NOT EXISTS does
 *  not add columns to an existing table). Runs inside ensureSchema's transaction; no BEGIN/COMMIT of its own. */
function migrate(db: Db): void {
  addColumn(db, "review", "suspect_reason", "TEXT");                     // §2.2
  addColumn(db, "review", "submission_attempt", "INTEGER");              // R2
  // R2 backfill: before the column, only generation 1 could bind a submission. Safe to repeat: only rows still lacking it.
  db.exec("UPDATE review SET submission_attempt=1 WHERE submission_id IS NOT NULL AND submission_attempt IS NULL");
  addColumn(db, "judge_call", "request_sha", "TEXT");                    // R9a; old rows stay NULL
  addColumn(db, "content", "reply_to", "TEXT");                          // R8b
  addColumn(db, "content", "mentions", "TEXT");                          // R8b
  db.exec("CREATE INDEX IF NOT EXISTS content_reply ON content(reply_to, event_time)");
  const ja = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='judge_answer'").get() as { sql: string } | undefined)?.sql ?? "";
  if (ja && !ja.includes("'guard'")) {
    // §2.2 injection guard: question_kind gains 'guard'; SQLite cannot alter a CHECK, so rebuild the table
    db.exec(`CREATE TABLE judge_answer_g (
        judge_call_id TEXT NOT NULL REFERENCES judge_call(judge_call_id), question_sha TEXT NOT NULL, rule_id TEXT,
        question_kind TEXT NOT NULL CHECK(question_kind IN ('rule','exception','image_check','guard')),
        choice TEXT NOT NULL, raw_probs TEXT NOT NULL, calibrated_probs TEXT, temperature REAL,
        PRIMARY KEY(judge_call_id, question_sha));
      INSERT INTO judge_answer_g SELECT judge_call_id, question_sha, rule_id, question_kind, choice, raw_probs, calibrated_probs, temperature FROM judge_answer;
      DROP TABLE judge_answer;
      ALTER TABLE judge_answer_g RENAME TO judge_answer;
      CREATE INDEX IF NOT EXISTS judge_answer_q ON judge_answer(question_sha);`);
  }
  if (!columnsOf(db, "model_call").has("response_key")) {
    // R5a: model_call was one row per generation task (first response only); rebuild with the per-response key.
    // Old rows keep their single response as response_key 'legacy'.
    db.exec(`CREATE TABLE model_call_r5a (
        generation_task_id TEXT NOT NULL, response_key TEXT NOT NULL,
        review_id TEXT NOT NULL REFERENCES review(review_id), attempt INTEGER NOT NULL, conversation_id TEXT NOT NULL,
        model TEXT NOT NULL, usage TEXT, stop_reason TEXT, created_at INTEGER NOT NULL,
        PRIMARY KEY (generation_task_id, response_key));
      INSERT INTO model_call_r5a SELECT generation_task_id, 'legacy', review_id, attempt, conversation_id, model, first_usage, NULL, created_at FROM model_call;
      DROP TABLE model_call;
      ALTER TABLE model_call_r5a RENAME TO model_call;
      CREATE INDEX IF NOT EXISTS model_call_review ON model_call(review_id);`);
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
