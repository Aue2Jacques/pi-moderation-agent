// D-04, D-06, D-10, D-11, D-12, D-14, D-16, U-13, U-14, H-01 (core-level), H-19/H-26 (consumer)
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as core from "../../../packages/core/src/index.ts";
import { BUNDLE, CFG, HUMAN, PINS, T0, dbPath, expectCode, freshDb, humanAuth, lowRiskConfirmed, seedContent } from "../../helpers.ts";

const sus = (db: core.Db, id: string, at = T0) =>
  core.createSuspiciousReview(db, { contentId: id, pins: PINS, judgeModel: "jev", judgeCallIds: [], pendingVisibility: "hidden", deadlineMs: CFG.deadlineMs, budgetTools: 12, budgetMicro: 50_000 }, at).review;
const deliverTo = (db: core.Db, at: number) => (ev: core.consumer.OutboxEvent) => void core.consumer.apply(db, ev, at);
const fast = (db: core.Db, id: string, action: core.Action, at = T0) => {
  const calls = action === "pass" ? lowRiskConfirmed(db, id, null, `fc-${id}`, at) : [];
  return core.fastDispose(db, BUNDLE, { contentId: id, action, ruleIds: action === "pass" ? [] : ["ABUSE-001"], judgeCallIds: calls, pins: PINS, judgeModel: "jev", budgetTools: 12, budgetMicro: 50_000, reason: "f" }, at);
};

describe("H-01 (core level) + D-06 outbox/consumer", () => {
  it("initial takedown → appeal pass → replaying the old ruling event leaves pass effective; receipts count duplicates", () => {
    const db = freshDb();
    seedContent(db, "c1");
    // takedown via fastpath needs block support: seed a high-risk call with exception not_applies
    const hi = "hi";
    core.recordJudgeCall(db, { judgeCallId: hi, reviewId: null, contentId: "c1", attempt: null, provider: "t", model: "jev-test", api: "x", inputSha: core.inputFingerprint(core.readContent(db, "c1")!.text_sha, "comment", [], PINS.evidenceVer), evidenceSet: [], pins: PINS, status: "ok", costStatus: "settled", answers: [
      { questionSha: BUNDLE.rules[0]!.question.sha, ruleId: "ABUSE-001", kind: "rule", choice: "violate", rawProbs: { violate: 0.99, none: 0.01 }, calibratedProbs: { violate: 0.99, none: 0.01 } },
      { questionSha: BUNDLE.rules[0]!.exceptions[0]!.question.sha, ruleId: "ABUSE-001", kind: "exception", choice: "not_applies", rawProbs: { applies: 0.01, not_applies: 0.99 }, calibratedProbs: { applies: 0.01, not_applies: 0.99 } },
    ] }, T0);
    const first = core.fastDispose(db, BUNDLE, { contentId: "c1", action: "takedown", ruleIds: ["ABUSE-001"], judgeCallIds: [hi], pins: PINS, judgeModel: "jev", budgetTools: 12, budgetMicro: 50_000, reason: "f" }, T0);
    expect(first.ruling.action).toBe("takedown");
    core.outbox.drain(db, deliverTo(db, T0 + 1), T0 + 1);
    expect(db.prepare("SELECT applied_action, applied_seq FROM downstream_state WHERE content_id='c1'").get()).toEqual({ applied_action: "takedown", applied_seq: 1 });
    // appeal → new review → lease → agent pass
    const appeal = core.createFollowupReview(db, { contentId: "c1", trigger: "appeal", triggerRequestId: "req-1", payloadSha: "p", pins: PINS, judgeModel: "jev", deadlineMs: 60_000, budgetTools: 12, budgetMicro: 50_000, pendingVisibility: "hidden" }, T0 + 10).review;
    const r = core.acquireLease(db, appeal.review_id, "w1", CFG, T0 + 11);
    const calls = lowRiskConfirmed(db, "c1", r.review_id, "ap", T0 + 12);
    core.submitRuling(db, BUNDLE, { reviewId: r.review_id, actor: "agent", attempt: 1, workerId: "w1", action: "pass", evidenceIds: [], ruleIds: [], judgeCallIds: calls, pins: PINS, reason: "ok" }, T0 + 20);
    expect(db.prepare("SELECT effective_action, effective_seq FROM content_state WHERE content_id='c1'").get()).toEqual({ effective_action: "pass", effective_seq: 2 });
    core.outbox.drain(db, deliverTo(db, T0 + 21), T0 + 21);
    expect(db.prepare("SELECT applied_action, applied_seq FROM downstream_state WHERE content_id='c1'").get()).toEqual({ applied_action: "pass", applied_seq: 2 });
    // replay the OLD ruling event: duplicate delivery → receipt 2, result unchanged, no regression
    const old = db.prepare("SELECT event_id, review_id, content_id, seq, kind, payload FROM outbox WHERE review_id=?").get(first.ruling.review_id) as core.consumer.OutboxEvent;
    const replay = core.consumer.apply(db, old, T0 + 30);
    expect(replay).toEqual({ result: "applied", duplicate: true });
    expect((db.prepare("SELECT COUNT(*) AS n FROM delivery_receipt WHERE event_id=?").get(old.event_id) as { n: number }).n).toBe(2);
    expect(db.prepare("SELECT applied_action FROM downstream_state WHERE content_id='c1'").get()).toEqual({ applied_action: "pass" });
    // a first-time delivery of a lower-seq ruling → stale
    const stale = core.consumer.apply(db, { ...old, event_id: "synthetic#ruling", seq: 1 }, T0 + 31);
    expect(stale.result).toBe("stale");
    expect(core.reconcile.instant(db, { scanMs: 2000, intakeQueueMaxMs: 60_000 }, T0 + 40).filter((v) => v.check !== "receipt_without_consumer_log")).toEqual([]);
    expect(core.reconcile.final(db)).toEqual([]);
  });
  it("D-06 / H-05: crash between deliver and ack → redelivery → receipts 2, applied once, final consistent", () => {
    const db = freshDb();
    seedContent(db, "c1");
    fast(db, "c1", "pass");
    let crashed = false;
    expect(() => core.outbox.dispatchOnce(db, deliverTo(db, T0), T0 + 1, { crashBeforeAck: () => { if (!crashed) { crashed = true; throw new Error("CRASH_AT=D"); } } })).toThrow("CRASH_AT=D");
    expect((db.prepare("SELECT status FROM outbox").get() as { status: string }).status).toBe("sent");
    core.outbox.drain(db, deliverTo(db, T0), T0 + 10_000);
    expect((db.prepare("SELECT COUNT(*) AS n FROM delivery_receipt").get() as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM consumer_log WHERE result='applied'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT status FROM outbox").get() as { status: string }).status).toBe("acked");
    expect(core.reconcile.final(db)).toEqual([]);
  });
});

describe("D-10 / H-19 / H-26 consumer human lifecycle (U-13)", () => {
  it("release then human ruling; duplicate vs late-first-delivery; per-review pending", () => {
    const db = freshDb();
    seedContent(db, "c1");
    const r = sus(db, "c1");
    core.releaseToHuman(db, r.review_id, { kind: "control" }, "timeout", 1, 1000, T0 + 1);
    const rel = db.prepare("SELECT event_id, review_id, content_id, seq, kind, payload FROM outbox WHERE review_id=? AND kind='release'").get(r.review_id) as core.consumer.OutboxEvent;
    expect(core.consumer.apply(db, rel, T0 + 2).result).toBe("notified");
    expect(core.consumer.humanPending(db, "c1")).toBe(true);
    core.submitRuling(db, BUNDLE, { reviewId: r.review_id, actor: "human", action: "pass", evidenceIds: [], ruleIds: [], judgeCallIds: [], pins: PINS, reason: "h", humanAuth }, T0 + 3, HUMAN);
    const rul = db.prepare("SELECT event_id, review_id, content_id, seq, kind, payload FROM outbox WHERE review_id=? AND kind='ruling'").get(r.review_id) as core.consumer.OutboxEvent;
    expect(core.consumer.apply(db, rul, T0 + 4).result).toBe("applied");           // same seq as release → still applied
    expect(core.consumer.humanPending(db, "c1")).toBe(false);
    expect(core.consumer.apply(db, rel, T0 + 5)).toEqual({ result: "notified", duplicate: true });   // duplicate: original result, no reopen
    expect(core.consumer.humanPending(db, "c1")).toBe(false);
    // H-26: a different review's release arriving first time after that review's ruling → stale_notification
    const db2 = freshDb();
    seedContent(db2, "c1");
    const r2 = sus(db2, "c1");
    core.releaseToHuman(db2, r2.review_id, { kind: "control" }, "timeout", 1, 1000, T0 + 1);
    core.submitRuling(db2, BUNDLE, { reviewId: r2.review_id, actor: "human", action: "pass", evidenceIds: [], ruleIds: [], judgeCallIds: [], pins: PINS, reason: "h", humanAuth }, T0 + 3, HUMAN);
    const evs = db2.prepare("SELECT event_id, review_id, content_id, seq, kind, payload FROM outbox WHERE review_id=? ORDER BY kind").all(r2.review_id) as core.consumer.OutboxEvent[];
    const [release, ruling] = [evs.find((e) => e.kind === "release")!, evs.find((e) => e.kind === "ruling")!];
    expect(core.consumer.apply(db2, ruling, T0 + 4).result).toBe("applied");
    expect(core.consumer.apply(db2, release, T0 + 5).result).toBe("stale_notification");
    expect(core.consumer.humanPending(db2, "c1")).toBe(false);
    // two reviews' pending flags are independent
    core.consumer.apply(db2, { event_id: "x#release", review_id: "other#appeal#2", content_id: "c1", seq: 2, kind: "release", payload: "{}" }, T0 + 6);
    expect(core.consumer.humanPending(db2, "c1")).toBe(true);
    expect((db2.prepare("SELECT pending FROM downstream_human WHERE review_id=?").get(r2.review_id) as { pending: number }).pending).toBe(0);
  });
});

describe("D-11 budget (T11/T11'/T12)", () => {
  it("replay does not re-reserve; release never counts; blocked rows excluded; physical requests settle idempotently", () => {
    const db = freshDb();
    seedContent(db, "c1");
    const r = core.acquireLease(db, sus(db, "c1").review_id, "w1", CFG, T0);
    for (let i = 0; i < 11; i++) core.reserveToolSlot(db, r.review_id, 1, `c${i}`, "judge", 100, 12, T0);
    expect(core.reserveToolSlot(db, r.review_id, 1, "c11", "judge", 100, 12, T0).created).toBe(true);    // 12th ok
    expectCode(() => core.reserveToolSlot(db, r.review_id, 1, "c12", "judge", 100, 12, T0), "E_BUDGET_EXCEEDED");
    expectCode(() => core.reserveToolSlot(db, r.review_id, 1, "c13", "judge", 100, 12, T0), "E_BUDGET_EXCEEDED");
    expect(core.usedToolSlots(db, r.review_id)).toBe(12);
    expect(core.reserveToolSlot(db, r.review_id, 1, "rel", "release", 0, 12, T0).created).toBe(true);
    expect(core.reserveToolSlot(db, r.review_id, 1, "c3", "judge", 100, 12, T0)).toEqual({ status: "reserved", created: false });   // replay
    expectCode(() => core.reserveToolSlot(db, r.review_id, 1, "c12", "judge", 100, 12, T0), "E_BUDGET_EXCEEDED");                  // replay of blocked stays blocked
    expect((db.prepare("SELECT COUNT(*) AS n FROM tool_slot WHERE review_id=?").get(r.review_id) as { n: number }).n).toBe(15);
    expect(core.roundHadBlocked(db, r.review_id, "budget_tools", T0)).toBe(true);
    // physical requests
    const n1 = core.openToolRequest(db, r.review_id, "c3", T0);
    const n2 = core.openToolRequest(db, r.review_id, "c3", T0 + 1);   // replay → new row
    expect([n1, n2]).toEqual([1, 2]);
    expect(core.settleToolRequest(db, r.review_id, "c3", n1, 70, "jc1", T0 + 2)).toBe(true);
    expect(core.settleToolRequest(db, r.review_id, "c3", n1, 70, "jc1", T0 + 3)).toBe(false);   // idempotent
    expect(core.settleToolRequest(db, r.review_id, "c3", n2, null, null, T0 + 4)).toBe(true);   // unknown
    const t = core.toolSpentMicro(db, r.review_id);
    expect(t).toEqual({ settled: 70, estimated: 100, hasUnknown: true });
    expect(core.spentMicro(db, r.review_id, 500)).toEqual({ spent: 670, settled: false });
    expect(core.recordModelCall(db, "gen1", r.review_id, 1, "conv", "m", { input: 1, output: 2 }, T0)).toBe(true);
    expect(core.recordModelCall(db, "gen1", r.review_id, 1, "conv", "m", { input: 9, output: 9 }, T0)).toBe(false);
  });
});

describe("D-14 / D-16 / U-14 control loop and reconcile", () => {
  it("U-14: tick times out queued (S11) and investigating (S7 with abort command), requeues expired leases (S8), revokes at attempt limit", () => {
    const db = freshDb();
    for (const id of ["q", "inv", "exp", "max"]) seedContent(db, id);
    const q = sus(db, "q");
    const inv = core.acquireLease(db, sus(db, "inv").review_id, "w1", CFG, T0);
    const exp = core.acquireLease(db, sus(db, "exp").review_id, "w1", CFG, T0);
    const mx = sus(db, "max");
    let t = T0;
    for (let i = 0; i < CFG.maxAttempts; i++) { core.acquireLease(db, mx.review_id, "w1", CFG, t); t += 100; core.tx(db, () => db.prepare("UPDATE review SET lease_until=? WHERE review_id=?").run(t - 1, mx.review_id)); }
    // make exp's lease expired but deadline not reached; q and inv past deadline
    core.tx(db, () => db.prepare("UPDATE review SET lease_until=? WHERE review_id=?").run(T0 + 1, exp.review_id));
    const out1 = core.control.tick(db, CFG, () => 1, 1000, T0 + 5000);
    expect(out1.requeued).toEqual([exp.review_id]);
    expect(out1.revoked).toEqual([mx.review_id]);
    const out2 = core.control.tick(db, CFG, () => 1, 1000, T0 + CFG.deadlineMs + 1);
    expect(new Set(out2.timedOut)).toEqual(new Set([q.review_id, inv.review_id, exp.review_id]));
    expect((db.prepare("SELECT state, revoked_attempt FROM review WHERE review_id=?").get(inv.review_id) as { state: string; revoked_attempt: number })).toEqual({ state: "human_queue", revoked_attempt: 1 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM worker_command WHERE review_id=? AND status='pending'").get(inv.review_id) as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT state FROM review WHERE review_id=?").get(q.review_id) as { state: string }).state).toBe("human_queue");
    expect(core.control.backpressure(db)).toEqual({ queueAgent: 0, queueHuman: 4, outstanding: 0 });
  });
  it("D-16: reconcile flags stuck intake and queued-past-deadline as timeouts, not as conservation failures; stalled control loop", () => {
    const db = freshDb();
    seedContent(db, "stuck");
    seedContent(db, "q");
    sus(db, "q");
    const cfg = { scanMs: 2000, intakeQueueMaxMs: 60_000 };
    expect(core.reconcile.instant(db, cfg, T0 + 5000).map((v) => v.check)).toEqual([]);         // 5s wait is not a failure
    const late = core.reconcile.instant(db, cfg, T0 + 70_000).map((v) => v.check);
    expect(late).toContain("intake_queue_timeout");
    expect(late).toContain("queued_past_deadline");
    core.control.tick(db, CFG, () => 1, 1000, T0 + 70_000);
    expect(core.reconcile.instant(db, cfg, T0 + 80_000).map((v) => v.check)).toContain("control_loop_stalled");
    core.tx(db, () => db.prepare("DELETE FROM intake WHERE content_id='stuck'").run());
    expect(core.reconcile.instant(db, cfg, T0 + 70_001).map((v) => v.check)).toContain("content_without_intake");
  });
  it("D-04: revokeAndRelease is atomic (a failing insert rolls everything back)", () => {
    const db = freshDb();
    seedContent(db, "c1");
    const r = core.acquireLease(db, sus(db, "c1").review_id, "w1", CFG, T0);
    core.tx(db, () => db.prepare("INSERT INTO human_queue(review_id, severity, due_at, reason, created_at) VALUES (?,?,?,?,?)").run(r.review_id, 1, 0, "pre", T0));
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON worker_command BEGIN SELECT RAISE(ABORT,'boom'); END");
    expect(() => core.revokeAndRelease(db, r.review_id, "timeout", 1, 1000, T0 + 1)).toThrow(/boom/);
    expect((db.prepare("SELECT state, lease_owner FROM review WHERE review_id=?").get(r.review_id) as { state: string; lease_owner: string })).toEqual({ state: "investigating", lease_owner: "w1" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n).toBe(0);
  });
});

describe("D-12 node:sqlite contention", () => {
  it("BEGIN IMMEDIATE waits within busy_timeout; a longer hold yields SQLITE_BUSY; deferred BEGIN gets BUSY_SNAPSHOT", () => {
    const path = dbPath();
    const a = core.openAppDb(path, "test");
    core.ensureSchema(a);
    const b = core.openAppDb(path, "worker");   // busy_timeout 1500
    a.exec("BEGIN IMMEDIATE");
    a.exec("UPDATE ledger_seq SET value=value+1");
    const t0 = Date.now();
    expect(() => b.exec("BEGIN IMMEDIATE")).toThrow(/locked|SQLITE_BUSY/);
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(1400);
    expect(waited).toBeLessThan(3000);
    a.exec("COMMIT");
    // now it succeeds immediately
    b.exec("BEGIN IMMEDIATE");
    b.exec("UPDATE ledger_seq SET value=value+1");
    b.exec("COMMIT");
    // deferred BEGIN: read, then another connection commits, then write → BUSY_SNAPSHOT (no busy handler)
    const c = new DatabaseSync(path);
    c.exec("PRAGMA busy_timeout=1500");
    c.exec("BEGIN");
    c.prepare("SELECT value FROM ledger_seq").get();
    a.exec("UPDATE ledger_seq SET value=value+1");
    expect(() => c.exec("UPDATE ledger_seq SET value=value+1")).toThrow(/locked|SQLITE_BUSY|snapshot/i);
    c.exec("ROLLBACK");
  }, 20_000);
});

describe("D-14 release gate binding", () => {
  it("rollout refused unless a passed gate_run exists for the exact config sha", () => {
    const db = freshDb();
    const cfg = { rulesVer: "rules@a", calibVer: "calib@a", judgeModel: "jev", agentModel: "m", pricesVer: "p" };
    expect(core.gateAllows(db, cfg)).toBe(false);
    core.recordGateRun(db, "g1", cfg, false, { reason: "contract failed" }, T0);
    expect(core.gateAllows(db, cfg)).toBe(false);
    core.recordGateRun(db, "g2", cfg, true, {}, T0 + 1);
    expect(core.gateAllows(db, cfg)).toBe(true);
    expect(core.gateAllows(db, { ...cfg, calibVer: "calib@b" })).toBe(false);   // A passed, B is not released on A's gate
    core.setRollout(db, "rules", "rules@a", "sha", 10, T0 + 2);
    expect((db.prepare("SELECT rollout_pct FROM version_pin WHERE version='rules@a'").get() as { rollout_pct: number }).rollout_pct).toBe(10);
  });
});
