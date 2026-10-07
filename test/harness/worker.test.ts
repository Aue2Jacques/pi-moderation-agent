// In-process phase-2 cases: H-17 (end-to-end pass), H-33-like (unconfirmed pass rejected), H-10, H-08, H-06, H-30, H-32, H-22(partial)
import { describe, expect, it } from "vitest";
import * as core from "../../packages/core/src/index.ts";
import { BUNDLE, CFG, HUMAN, PINS, T0, freshDb, humanAuth } from "../helpers.ts";
import { PASS_SCRIPT, highRisk, lowRisk, makeWorker, queuedReview, resolving, review, ruling, runToIdle, setScript, type Step } from "./setup.ts";

async function runOne(steps: Step[], o: { judge?: typeof lowRisk; budgetTools?: number; thread?: boolean } = {}) {
  const db = freshDb();
  const now = () => Date.now();
  const r = queuedReview(db, "c1", { ...(o.thread === false ? {} : { thread: "t1", account: "acct1" }), ...(o.budgetTools ? { budgetTools: o.budgetTools } : {}), at: now() - 1000 });
  core.intakeInsert(db, { contentId: "n1", scene: "comment", text: "neighbor placeholder", threadId: "t1", eventTime: now() - 2000 }, now() - 2000);
  const fx = await makeWorker({ db, steps: [], ...(o.judge ? { judge: o.judge } : {}), now });
  setScript(fx, resolving(db, () => r.review_id, steps));
  await fx.worker.start();
  const admitted = await fx.worker.admitOnce();
  expect(admitted).toEqual([r.review_id]);
  await runToIdle(fx);
  return { db, fx, r };
}

describe("H-17 end-to-end with faux model and recorded judge", () => {
  it("thread → judge → confirm → dispose(pass): ruling pass, content_state visible, host loop finished, costs settled", async () => {
    const { db, fx, r } = await runOne(PASS_SCRIPT);
    const rul = ruling(db, r.review_id)!;
    expect(rul.action).toBe("pass");
    expect(rul.actor).toBe("agent");
    expect(JSON.parse(rul.allowed_actions)).toEqual(["pass"]);
    expect(review(db, r.review_id).state).toBe("disposed");
    expect(db.prepare("SELECT effective_action, visibility FROM content_state WHERE content_id='c1'").get()).toEqual({ effective_action: "pass", visibility: "visible" });
    const kinds = fx.calls.map((c) => c.kind);
    expect(kinds.filter((k) => k === "judge")).toHaveLength(1);
    expect(kinds.filter((k) => k === "confirm")).toHaveLength(1);
    expect(fx.worker.grants.count()).toBe(0);                      // host loop finished + cleaned
    expect((db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE review_id=?").get(r.review_id) as { n: number }).n).toBe(3);   // thread + judge + confirm
    expect((db.prepare("SELECT COUNT(*) AS n FROM tool_request WHERE review_id=? AND cost_status='settled'").get(r.review_id) as { n: number }).n).toBe(2);
    expect(review(db, r.review_id).used_micro).toBeGreaterThan(0);
    expect(core.reconcile.final(db).filter((v) => v.check !== "outbox_not_drained")).toEqual([]);
    await fx.close();
  });
  it("dispose(pass) without confirm is rejected (E_ACTION_NOT_SUPPORTED); the model then confirms and succeeds", async () => {
    const steps: Step[] = [
      { tool: "get_thread_context", args: {} },
      { tool: "judge", args: { rule_ids: [], evidence_ids: ["$E1"] } },
      { tool: "dispose", args: { action: "pass", evidence_ids: ["$E1"], rule_ids: [], reason: "x" } },
      { tool: "confirm", args: { judge_call_id: "$J1", rule_ids: [], evidence_ids: ["$E1"] } },
      { tool: "dispose", args: { action: "pass", evidence_ids: ["$E1"], rule_ids: [], reason: "y" } },
      { text: "done" },
    ];
    const { db, fx, r } = await runOne(steps);
    expect(ruling(db, r.review_id)?.action).toBe("pass");
    const rejected = (db.prepare("SELECT payload FROM audit WHERE kind='submit_rejected'").all() as { payload: string }[]).map((a) => JSON.parse(a.payload).code);
    expect(rejected).toEqual(["E_ACTION_NOT_SUPPORTED"]);
    await fx.close();
  });
  it("high-risk judge + dispose(takedown): exceptions were asked in the same call → takedown allowed", async () => {
    const steps: Step[] = [
      { tool: "judge", args: { rule_ids: ["ABUSE-001"], evidence_ids: [] } },
      { tool: "dispose", args: { action: "takedown", evidence_ids: [], rule_ids: ["ABUSE-001"], reason: "abuse" } },
      { text: "done" },
    ];
    const { db, fx, r } = await runOne(steps, { judge: highRisk });
    expect(ruling(db, r.review_id)?.action).toBe("takedown");
    expect(db.prepare("SELECT effective_action, visibility FROM content_state WHERE content_id='c1'").get()).toEqual({ effective_action: "takedown", visibility: "hidden" });
    await fx.close();
  });
});

describe("H-10 model never terminates", () => {
  it("one continue, then host loop releases with model_release", async () => {
    const { db, fx, r } = await runOne([{ text: "I think it is fine." }, { text: "Still fine." }, { text: "..." }]);
    const rv = review(db, r.review_id);
    expect(rv.state).toBe("human_queue");
    expect(rv.release_reason).toBe("model_release");
    expect(rv.yield_continues).toBe(1);
    expect(fx.calls.filter((c) => c.kind === "model")).toHaveLength(2);
    await fx.close();
  });
});

describe("H-08 tool budget", () => {
  it("13th counting call is blocked, afterTools releases with budget_tools, release is still allowed afterwards", async () => {
    const steps: Step[] = Array.from({ length: 13 }, () => ({ tool: "get_thread_context", args: {} } as Step)).concat([{ text: "done" }]);
    const { db, fx, r } = await runOne(steps, { budgetTools: 12 });
    const rv = review(db, r.review_id);
    expect(rv.state).toBe("human_queue");
    expect(rv.release_reason).toBe("budget_tools");
    expect(core.usedToolSlots(db, r.review_id)).toBe(12);
    expect((db.prepare("SELECT COUNT(*) AS n FROM tool_slot WHERE review_id=? AND status='blocked'").get(r.review_id) as { n: number }).n).toBe(1);
    await fx.close();
  });
});

describe("H-06 / H-29 timeout, human takeover, late machine result", () => {
  it("control loop revokes mid-run; worker aborts via command; human disposes; late dispose attempt is rejected and ruling stays human", async () => {
    const db = freshDb();
    let t = T0;
    const now = () => t;
    const r = queuedReview(db, "c1", { thread: "t1", at: T0 });
    // model: a slow path — 3 thread reads, then dispose
    const steps: Step[] = [{ tool: "get_thread_context", args: {} }, { tool: "get_thread_context", args: {} }, { tool: "get_thread_context", args: {} }, { tool: "dispose", args: { action: "pass", evidence_ids: [], rule_ids: [], reason: "late" } }, { text: "done" }];
    const fx = await makeWorker({ db, steps: [], now, cfg: { ...CFG, deadlineMs: 60_000 } });
    setScript(fx, resolving(db, () => r.review_id, steps));
    await fx.worker.start();
    await fx.worker.admitOnce();
    // deadline passes while the run is going: control loop revokes (S7) and queues an abort command
    t = T0 + CFG.deadlineMs + 1;
    const tick = core.control.tick(db, CFG, () => 1, 1000, now());
    expect(tick.timedOut).toEqual([r.review_id]);
    expect(review(db, r.review_id).state).toBe("human_queue");
    await fx.worker.pollCommands();
    await runToIdle(fx);
    expect(fx.worker.grants.count()).toBe(0);
    expect(ruling(db, r.review_id)).toBeUndefined();                       // machine never got to write
    // human disposes on the same review
    core.submitRuling(db, BUNDLE, { reviewId: r.review_id, actor: "human", action: "pass", evidenceIds: [], ruleIds: [], judgeCallIds: [], pins: PINS, reason: "human ok", humanAuth }, now(), HUMAN);
    expect(ruling(db, r.review_id)?.actor).toBe("human");
    // a late machine submission with the revoked attempt → E_STATE_INVALID (step 2: ruling exists by another actor)
    expect(() => core.submitRuling(db, BUNDLE, { reviewId: r.review_id, actor: "agent", attempt: 1, workerId: "w1", action: "takedown", evidenceIds: [], ruleIds: ["ABUSE-001"], judgeCallIds: [], pins: PINS, reason: "late" }, now())).toThrow(/E_STATE_INVALID|ruling already exists/);
    expect(ruling(db, r.review_id)?.actor).toBe("human");
    await fx.close();
  });
});

describe("H-30 / H-32", () => {
  it("admission never exceeds admitMax", async () => {
    const db = freshDb();
    const ids = ["a", "b", "c", "d"].map((id) => queuedReview(db, id, { at: Date.now() - 1000 }).review_id);
    const fx = await makeWorker({ db, steps: [{ text: "x" }, { text: "y" }, { text: "z" }], admitMax: 2 });
    await fx.worker.start();
    const first = await fx.worker.admitOnce();
    expect(first).toHaveLength(2);
    expect(fx.worker.grants.count("active")).toBe(2);
    expect(await fx.worker.admitOnce()).toEqual([]);
    await runToIdle(fx);
    const second = await fx.worker.admitOnce();
    expect(second).toHaveLength(2);
    expect(new Set([...first, ...second])).toEqual(new Set(ids));
    await fx.close();
  });
  it("H-32: a tool issued in the same round as dispose is refused and the host loop ends the session", async () => {
    const steps: Step[] = [
      { tool: "get_thread_context", args: {} },
      { tool: "judge", args: { rule_ids: [], evidence_ids: ["$E1"] } },
      { tool: "confirm", args: { judge_call_id: "$J1", rule_ids: [], evidence_ids: ["$E1"] } },
      { tools: [{ tool: "dispose", args: { action: "pass", evidence_ids: ["$E1"], rule_ids: [], reason: "ok" } }, { tool: "get_thread_context", args: {} }] },
      { text: "after" },
      { text: "after2" },
    ];
    const { db, fx, r } = await runOne(steps);
    expect(ruling(db, r.review_id)?.action).toBe("pass");
    expect((db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE review_id=? AND kind='thread_context'").get(r.review_id) as { n: number }).n).toBe(1);   // second read blocked
    expect(fx.worker.grants.count()).toBe(0);
    expect(fx.calls.filter((c) => c.kind === "model").length).toBeLessThanOrEqual(5);
    await fx.close();
  });
});
