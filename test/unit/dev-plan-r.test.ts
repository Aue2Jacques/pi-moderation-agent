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
