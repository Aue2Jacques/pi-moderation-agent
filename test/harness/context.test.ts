// Dev plan 2026-10-08 R8: what the agent's context tools report. R8a: account history counts every ruling in the
// window (not just the 5 listed) plus imported prior_ruling events.
import { describe, expect, it } from "vitest";
import * as core from "../../packages/core/src/index.ts";
import { BUNDLE, PINS, freshDb, lowRiskConfirmed } from "../helpers.ts";
import { makeWorker, queuedReview, runToIdle, scripted, setScript } from "./setup.ts";

const HISTORY_THEN_RELEASE = scripted([{ tool: "get_account_history", args: {} }, { tool: "release", args: { reason: "evidence_gap" } }, { text: "done" }]);

describe("R8a account history counts", () => {
  it("6 earlier rulings on the account + 2 imported prior rulings → counts total 8 (the list still shows the latest 5)", async () => {
    const db = freshDb();
    const now = Date.now();
    for (let k = 0; k < 6; k++) {
      const id = `old${k}`;
      core.intakeInsert(db, { contentId: id, scene: "comment", text: `earlier ${k}`, accountId: "a1", eventTime: now - 60_000 + k }, now - 60_000 + k);
      const calls = lowRiskConfirmed(db, id, null, `jc${k}`, now - 50_000 + k);
      core.fastDispose(db, BUNDLE, { contentId: id, action: "pass", ruleIds: [], judgeCallIds: calls, pins: PINS, judgeModel: "jev", budgetTools: 12, budgetMicro: 50_000, reason: "fast" }, now - 40_000 + k);
    }
    core.tx(db, () => {
      for (let k = 0; k < 2; k++) {
        db.prepare("INSERT INTO synth_event(event_id, account_id, kind, payload, event_time, ingest_seq) VALUES (?, 'a1', 'prior_ruling', ?, ?, ?)")
          .run(`p${k}`, JSON.stringify({ action: "takedown", rule_ids: ["ABUSE-001"] }), now - 30_000 + k, core.nextSeq(db));
      }
    });
    const r = queuedReview(db, "c1", { thread: "t1", account: "a1", at: now - 1000 });
    const fx = await makeWorker({ db, steps: [] });
    setScript(fx, HISTORY_THEN_RELEASE);
    await fx.worker.start();
    await fx.worker.admitOnce();
    await runToIdle(fx);
    const ev = db.prepare("SELECT model_view FROM evidence WHERE review_id=? AND kind='account_history'").get(r.review_id) as { model_view: string };
    const view = JSON.parse(ev.model_view) as { counts: Record<string, number>; recent_rulings: unknown[] };
    expect(view.counts).toEqual({ pass: 6, takedown: 2 });
    expect(Object.values(view.counts).reduce((a, b) => a + b, 0)).toBe(8);
    expect(view.recent_rulings).toHaveLength(5);
    await fx.close();
  });
});
