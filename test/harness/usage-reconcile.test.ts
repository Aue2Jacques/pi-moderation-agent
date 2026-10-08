// Stage-① known gap: the cost ledger (model_call, one row per physical response) reconciled with Pi's own pi.usage.
import { describe, expect, it } from "vitest";
import * as core from "../../packages/core/src/index.ts";
import { freshDb } from "../helpers.ts";
import { PASS_SCRIPT, lowRisk, makeWorker, queuedReview, resolving, runToIdle, setScript } from "./setup.ts";

describe("usage reconcile: ledger vs pi.usage", () => {
  it("matches per model after real generations; a missing ledger row shows up as a difference", async () => {
    const db = freshDb();
    const r1 = queuedReview(db, "u1", { thread: "t1", at: Date.now() - 2000 });
    const r2 = queuedReview(db, "u2", { thread: "t2", at: Date.now() - 1000 });
    const fx = await makeWorker({ db, steps: [], judge: lowRisk });
    let cur: string | undefined;
    setScript(fx, resolving(db, () => cur, PASS_SCRIPT));
    await fx.worker.start();
    cur = r1.review_id; await fx.worker.admitOnce(); await runToIdle(fx);
    cur = r2.review_id; await fx.worker.admitOnce(); await runToIdle(fx);
    const ok = await fx.worker.usageReconcile();
    expect(ok.conversations).toBe(2);
    expect(ok.diffs).toEqual([]);
    const m = Object.values(ok.ledger)[0]!;   // the faux provider estimates its own token counts; both sides must agree
    expect(m.responses).toBeGreaterThan(0);
    expect(m.input).toBeGreaterThan(0);
    // drop one ledger row: the reconcile must see it
    db.prepare("DELETE FROM model_call WHERE rowid=(SELECT MIN(rowid) FROM model_call)").run();
    const bad = await fx.worker.usageReconcile();
    expect(bad.diffs.map((d) => d.counter).sort()).toEqual(["input", "output"]);
    await fx.close();
  });
});
