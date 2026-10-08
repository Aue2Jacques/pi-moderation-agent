// Regression tests for the dev plan 2026-10-08 stage-① fixes that are pure core logic (the process-level ones are in
// test/harness: lock.test.ts for R1, crash.test.ts for R2's recovery path).
import { describe, expect, it } from "vitest";
import * as core from "../../packages/core/src/index.ts";
import { CFG, PINS, T0, freshDb, lowRiskConfirmed, seedContent } from "../helpers.ts";

function queued(db: core.Db, id: string): core.ReviewRow {
  seedContent(db, id, "comment", { eventTime: T0 });
  return core.createSuspiciousReview(db, { contentId: id, pins: PINS, judgeModel: "jev", judgeCallIds: [], pendingVisibility: "hidden", deadlineMs: CFG.deadlineMs, budgetTools: 12, budgetMicro: 50_000 }, T0).review;
}

describe("R2 submission belongs to a generation", () => {
  it("each generation binds its own submission; an older generation cannot overwrite a newer one", () => {
    const db = freshDb();
    const id = queued(db, "c1").review_id;
    const g1 = core.acquireLease(db, id, "w1", CFG, T0);
    expect(core.bindSubmission(db, id, g1.attempt, "sub-1")).toBe(true);
    expect(core.bindSubmission(db, id, g1.attempt, "sub-1b")).toBe(false);                 // same generation: first bind wins
    const g2 = core.acquireLease(db, id, "w2", CFG, T0 + CFG.leaseTtlMs + 1);                // generation 1's lease expired
    expect(core.bindSubmission(db, id, g2.attempt, "sub-2")).toBe(true);                    // used to fail: submission_id was set
    expect(core.bindSubmission(db, id, g1.attempt, "late-1")).toBe(false);                  // a stale generation cannot bind
    expect(core.requireReview(db, id)).toMatchObject({ attempt: 2, submission_id: "sub-2", submission_attempt: 2 });
  });

  it("an app.db from before the column gets it on ensureSchema, existing bindings marked as generation 1", () => {
    const db = freshDb();
    const id = queued(db, "c1").review_id;
    const g1 = core.acquireLease(db, id, "w1", CFG, T0);
    core.bindSubmission(db, id, g1.attempt, "sub-1");
    db.exec("ALTER TABLE review DROP COLUMN submission_attempt");                               // what an old file looks like
    core.ensureSchema(db);
    expect(core.requireReview(db, id)).toMatchObject({ submission_id: "sub-1", submission_attempt: 1 });
    core.ensureSchema(db);                                                                      // idempotent
    expect(core.requireReview(db, id).submission_attempt).toBe(1);
  });
});

describe("R5a model_call holds one row per physical response", () => {
  it("an app.db with the old one-row-per-task table is rebuilt on ensureSchema, keeping its rows", () => {
    const db = freshDb();
    const id = queued(db, "c1").review_id;
    db.exec(`DROP TABLE model_call;
      CREATE TABLE model_call (generation_task_id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES review(review_id), attempt INTEGER NOT NULL,
        conversation_id TEXT NOT NULL, model TEXT NOT NULL, first_usage TEXT, created_at INTEGER NOT NULL);`);
    db.prepare("INSERT INTO model_call VALUES ('g1', ?, 1, 'conv', 'm1', ?, ?)").run(id, JSON.stringify({ input: 100, output: 10 }), T0);
    core.ensureSchema(db);
    expect(db.prepare("SELECT generation_task_id, response_key, usage FROM model_call").all()).toEqual([{ generation_task_id: "g1", response_key: "legacy", usage: JSON.stringify({ input: 100, output: 10 }) }]);
    expect(core.recordModelCall(db, "g1", "resp-2", id, 1, "conv", "m1", { input: 1, output: 1 }, "stop", T0)).toBe(true);   // a further response of the same task
    core.ensureSchema(db);                                                                                                  // idempotent
    expect((db.prepare("SELECT COUNT(*) AS n FROM model_call").get() as { n: number }).n).toBe(2);
  });
});

describe("R6 durable(): reviews that should have a session on W", () => {
  const S = (reviewId: string, o: Partial<core.reconcile.SessionLike> = {}): core.reconcile.SessionLike => ({ conversationId: "7", reviewId, mode: "active", liveTasks: 1, submission: null, ...o });
  it("an investigating review with a live lease but no session on W is a violation", () => {
    const db = freshDb();
    const id = queued(db, "c1").review_id;
    core.acquireLease(db, id, "w1", CFG, T0);
    core.tx(db, () => db.prepare("UPDATE review SET conversation_id='7' WHERE review_id=?").run(id));
    expect(core.reconcile.durable(db, [], T0 + 1).map((v) => v.check)).toEqual(["investigating_without_session"]);
    expect(core.reconcile.durable(db, [S(id)], T0 + 1)).toEqual([]);
  });
  it("an investigating review whose lease has expired (dead holder, or deferred by R3 on restart) is not one", () => {
    const db = freshDb();
    const id = queued(db, "c1").review_id;
    core.acquireLease(db, id, "w1", CFG, T0);
    expect(core.reconcile.durable(db, [], T0 + CFG.leaseTtlMs + 1)).toEqual([]);
  });
  it("an active grant with no live task (a lease with no work, the R2 symptom) is a violation", () => {
    const db = freshDb();
    const id = queued(db, "c1").review_id;
    core.acquireLease(db, id, "w1", CFG, T0);
    core.tx(db, () => db.prepare("UPDATE review SET conversation_id='7' WHERE review_id=?").run(id));
    expect(core.reconcile.durable(db, [S(id, { liveTasks: 0 })], T0 + 1).map((v) => v.check)).toEqual(["active_grant_without_task"]);
  });
});


describe("R9c database files are private (0600)", () => {
  it("a new app.db and its WAL and SHM files are created 0600", async () => {
    const { mkdtempSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const path = join(mkdtempSync(join(tmpdir(), "perm-")), "app.db");
    const db = core.openAppDb(path, "test");
    core.ensureSchema(db);                                                     // writes, so the WAL file exists
    for (const f of [path, `${path}-wal`, `${path}-shm`]) expect((statSync(f).mode & 0o777).toString(8)).toBe("600");
    db.close();
  });
});

describe("R9b calibration buckets include the question", () => {
  const T0x = 0;
  const file = (question: string | undefined, T: number) => JSON.stringify({ T, n: 200, ece_before: 0.1, ece_after: 0.03, fitted_at: T0x,
    bucket: { judge: "jev-x", rules_ver: "rules@a", scene: "comment", n_options: 3, ...(question ? { question } : {}) } });
  const raw = { violate: 0.08, none: 0.92 };
  const at = async () => {
    const { mkdtempSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "calib-"));
    mkdirSync(join(dir, "jev-x"));
    return { dir, sub: join(dir, "jev-x"), join };
  };
  it("two questions in the same scene with the same option count keep separate temperatures", async () => {
    const { writeFileSync } = await import("node:fs");
    const { dir, sub, join } = await at();
    writeFileSync(join(sub, "abuse.json"), file("ABUSE-001", 2));
    writeFileSync(join(sub, "mkt.json"), file("MARKETING-003", 4));
    const { loadCalibrator } = await import("../../packages/judges/src/index.ts");
    const c = loadCalibrator(dir, "jev-x");
    const b = { judge: "jev-x", rulesVer: "rules@a", scene: "comment" as const, nOptions: 3 };
    expect(c.apply({ ...b, question: "ABUSE-001" }, raw)?.temperature).toBe(2);
    expect(c.apply({ ...b, question: "MARKETING-003" }, raw)?.temperature).toBe(4);
    expect(c.apply({ ...b, question: "ABUSE-001.EX-QUOTE" }, raw)).toBeNull();   // not fitted: stays uncalibrated
  });
  it("two files for the same bucket fail to load instead of one silently replacing the other", async () => {
    const { writeFileSync } = await import("node:fs");
    const { dir, sub, join } = await at();
    writeFileSync(join(sub, "a.json"), file("ABUSE-001", 2));
    writeFileSync(join(sub, "b.json"), file("ABUSE-001", 3));
    const { loadCalibrator } = await import("../../packages/judges/src/index.ts");
    expect(() => loadCalibrator(dir, "jev-x")).toThrow(/duplicate calibration bucket/);
  });
  it("a file without bucket.question is rejected (it cannot say which question it was fitted on)", async () => {
    const { writeFileSync } = await import("node:fs");
    const { dir, sub, join } = await at();
    writeFileSync(join(sub, "old.json"), file(undefined, 2));
    const { loadCalibrator } = await import("../../packages/judges/src/index.ts");
    expect(() => loadCalibrator(dir, "jev-x")).toThrow(/question/);
  });
});

describe("§2.2 judge_answer accepts the guard question kind", () => {
  it("an app.db whose judge_answer CHECK predates 'guard' is rebuilt on ensureSchema, keeping its rows", () => {
    const db = freshDb();
    db.exec(`DROP TABLE judge_answer;
      CREATE TABLE judge_answer (judge_call_id TEXT NOT NULL REFERENCES judge_call(judge_call_id), question_sha TEXT NOT NULL, rule_id TEXT,
        question_kind TEXT NOT NULL CHECK(question_kind IN ('rule','exception','image_check')), choice TEXT NOT NULL, raw_probs TEXT NOT NULL,
        calibrated_probs TEXT, temperature REAL, PRIMARY KEY(judge_call_id, question_sha));`);
    seedContent(db, "c1");
    const calls = lowRiskConfirmed(db, "c1", null);
    const before = (db.prepare("SELECT COUNT(*) AS n FROM judge_answer").get() as { n: number }).n;
    core.ensureSchema(db);
    expect((db.prepare("SELECT COUNT(*) AS n FROM judge_answer").get() as { n: number }).n).toBe(before);
    db.prepare("INSERT INTO judge_answer(judge_call_id, question_sha, rule_id, question_kind, choice, raw_probs) VALUES (?, 'g', NULL, 'guard', 'none', '{}')").run(calls[0]!);
    core.ensureSchema(db);                                                     // idempotent
    expect((db.prepare("SELECT COUNT(*) AS n FROM judge_answer WHERE question_kind='guard'").get() as { n: number }).n).toBe(1);
  });
});

describe("closeout fix 1: migrations survive interruption (stage-1 review)", () => {
  it("a half-upgraded content table (reply_to added, mentions not) is completed; new content can be ingested", () => {
    const db = freshDb();
    db.exec("ALTER TABLE content DROP COLUMN mentions");                       // the state a kill between the two ALTERs left
    core.ensureSchema(db);
    expect((db.prepare("PRAGMA table_info(content)").all() as { name: string }[]).map((c) => c.name)).toContain("mentions");
    expect(() => core.intakeInsert(db, { contentId: "n1", scene: "comment", text: "x", eventTime: T0, mentions: ["a"] }, T0)).not.toThrow();
  });
  it("a column added but not backfilled is backfilled on the next start", () => {
    const db = freshDb();
    const id = queued(db, "c1").review_id;
    core.acquireLease(db, id, "w1", CFG, T0);
    db.prepare("UPDATE review SET submission_id='legacy-sub', submission_attempt=NULL WHERE review_id=?").run(id);   // added, never backfilled
    core.ensureSchema(db);
    expect(core.requireReview(db, id).submission_attempt).toBe(1);
  });
  it("a migration that fails part-way leaves the file exactly as it was (one transaction)", () => {
    const db = freshDb();
    db.exec("ALTER TABLE content DROP COLUMN mentions");
    db.exec("DROP TABLE judge_answer; CREATE TABLE judge_answer (judge_call_id TEXT NOT NULL, question_sha TEXT NOT NULL, rule_id TEXT, question_kind TEXT NOT NULL CHECK(question_kind IN ('rule','exception','image_check')), choice TEXT NOT NULL, raw_probs TEXT NOT NULL, calibrated_probs TEXT, temperature REAL, PRIMARY KEY(judge_call_id, question_sha))");
    db.exec("CREATE TABLE judge_answer_g (x INTEGER)");                         // makes the judge_answer rebuild fail
    expect(() => core.ensureSchema(db)).toThrow();
    expect((db.prepare("PRAGMA table_info(content)").all() as { name: string }[]).map((c) => c.name)).not.toContain("mentions");   // rolled back
    db.exec("DROP TABLE judge_answer_g");
    core.ensureSchema(db);                                                      // and a later start completes it
    expect((db.prepare("PRAGMA table_info(content)").all() as { name: string }[]).map((c) => c.name)).toContain("mentions");
  });
});
