// Regression tests for the dev plan 2026-10-08 stage-① fixes that are pure core logic (the process-level ones are in
// test/harness: lock.test.ts for R1, crash.test.ts for R2's recovery path).
import { describe, expect, it } from "vitest";
import * as core from "../../packages/core/src/index.ts";
import { CFG, PINS, T0, freshDb, seedContent } from "../helpers.ts";

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
