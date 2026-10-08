// Stage-1 review fix 1: G and W both run ensureSchema at startup. Two processes migrating the same old app.db at the
// same moment must both start, and the file must end up complete (no "duplicate column", no half structure).
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as core from "../../packages/core/src/index.ts";

const CORE = join(import.meta.dirname, "..", "..", "packages", "core", "src", "index.ts");
const child = (path: string) => new Promise<{ code: number | null; err: string }>((done) => {
  const p = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e",
    `const core = await import(${JSON.stringify(CORE)}); const db = core.openAppDb(${JSON.stringify(path)}, "tool"); core.ensureSchema(db); db.close();`]);
  let err = "";
  p.stderr.on("data", (b) => { err += String(b); });
  p.on("close", (code) => done({ code, err }));
});

function oldShapeDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), "mig-")), "app.db");
  const db = core.openAppDb(path, "test");
  core.ensureSchema(db);
  // roll the file back to an older shape: columns missing, judge_answer without 'guard', one-row-per-task model_call
  db.exec(`DROP INDEX IF EXISTS content_reply; ALTER TABLE content DROP COLUMN mentions; ALTER TABLE content DROP COLUMN reply_to;
    ALTER TABLE review DROP COLUMN suspect_reason; ALTER TABLE review DROP COLUMN submission_attempt; ALTER TABLE judge_call DROP COLUMN request_sha;
    DROP TABLE judge_answer; CREATE TABLE judge_answer (judge_call_id TEXT NOT NULL, question_sha TEXT NOT NULL, rule_id TEXT, question_kind TEXT NOT NULL CHECK(question_kind IN ('rule','exception','image_check')), choice TEXT NOT NULL, raw_probs TEXT NOT NULL, calibrated_probs TEXT, temperature REAL, PRIMARY KEY(judge_call_id, question_sha));
    DROP TABLE model_call; CREATE TABLE model_call (generation_task_id TEXT PRIMARY KEY, review_id TEXT NOT NULL, attempt INTEGER NOT NULL, conversation_id TEXT NOT NULL, model TEXT NOT NULL, first_usage TEXT, created_at INTEGER NOT NULL);`);
  db.close();
  return path;
}

describe("closeout fix 1: concurrent migration", () => {
  it("two processes migrating one old file at once: both succeed, the structure is complete (5 rounds)", async () => {
    for (let round = 0; round < 5; round++) {
      const path = oldShapeDb();
      const [a, b] = await Promise.all([child(path), child(path)]);
      expect([a.code, b.code], `${a.err}\n${b.err}`).toEqual([0, 0]);
      const db = core.openAppDb(path, "test");
      const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols("content")).toEqual(expect.arrayContaining(["reply_to", "mentions"]));
      expect(cols("review")).toEqual(expect.arrayContaining(["suspect_reason", "submission_attempt"]));
      expect(cols("model_call")).toContain("response_key");
      expect((db.prepare("SELECT sql FROM sqlite_master WHERE name='judge_answer'").get() as { sql: string }).sql).toContain("'guard'");
      db.close();
    }
  }, 120_000);
});
