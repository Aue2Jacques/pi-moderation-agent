// D-01, D-02, D-03, D-05, D-07, D-08, D-09, D-13, D-15, D-17, D-18 + U-04 (submit-check steps)
import { describe, expect, it } from "vitest";
import * as core from "../../../packages/core/src/index.ts";
import { ABUSE_Q, BUNDLE, CFG, HUMAN, PINS, T0, addEvidence, expectCode, freshDb, humanAuth, judge, lowRiskConfirmed, seedContent } from "../../helpers.ts";

const sus = (db: core.Db, id: string, at = T0, calls: string[] = []) =>
  core.createSuspiciousReview(db, { contentId: id, pins: PINS, judgeModel: "jev", judgeCallIds: calls, pendingVisibility: "hidden", deadlineMs: CFG.deadlineMs, budgetTools: 12, budgetMicro: 50_000 }, at).review;

const lease = (db: core.Db, rid: string, w = "w1", at = T0) => core.acquireLease(db, rid, w, CFG, at);

function agentSubmit(db: core.Db, r: core.ReviewRow, action: core.Action, calls: string[], extra: Partial<core.SubmitRulingInput> = {}, at = T0 + 1000) {
  return core.submitRuling(db, BUNDLE, { reviewId: r.review_id, actor: "agent", attempt: r.attempt, workerId: r.lease_owner!, action, evidenceIds: [], ruleIds: action === "pass" ? [] : ["ABUSE-001"], judgeCallIds: calls, pins: PINS, reason: "r", ...extra }, at);
}

describe("D-01 fastDispose", () => {
  it("creates review + ruling + content_state (upsert) in one transaction and is idempotent", () => {
    const db = freshDb();
    seedContent(db, "c1");
    const calls = lowRiskConfirmed(db, "c1", null);
    const r1 = core.fastDispose(db, BUNDLE, { contentId: "c1", action: "pass", ruleIds: [], judgeCallIds: calls, pins: PINS, judgeModel: "jev", budgetTools: 12, budgetMicro: 50_000, reason: "fast" }, T0);
    expect(r1.duplicate).toBe(false);
    expect(r1.ruling.actor).toBe("fastpath");
    const cs = db.prepare("SELECT * FROM content_state WHERE content_id='c1'").get() as { effective_action: string; effective_seq: number; visibility: string };
    expect(cs).toMatchObject({ effective_action: "pass", effective_seq: 1, visibility: "visible" });
    expect((db.prepare("SELECT review_id FROM judge_call WHERE judge_call_id=?").get(calls[0]!) as { review_id: string }).review_id).toBe(r1.ruling.review_id);
    expect((db.prepare("SELECT status, judged_review_id FROM intake WHERE content_id='c1'").get() as { status: string; judged_review_id: string })).toEqual({ status: "judged", judged_review_id: r1.ruling.review_id });
    const r2 = core.fastDispose(db, BUNDLE, { contentId: "c1", action: "takedown", ruleIds: ["ABUSE-001"], judgeCallIds: [], pins: PINS, judgeModel: "jev", budgetTools: 12, budgetMicro: 50_000, reason: "again" }, T0 + 1);
    expect(r2.duplicate).toBe(true);
    expect(r2.ruling.action).toBe("pass");
    expect((db.prepare("SELECT COUNT(*) AS n FROM ruling").get() as { n: number }).n).toBe(1);
  });
  it("H-33: fast pass without a confirming answer is rejected and audited", () => {
    const db = freshDb();
    seedContent(db, "c2");
    judge(db, { id: "j1", contentId: "c2", p: 0.02, choice: "none" });
    const e = expectCode(() => core.fastDispose(db, BUNDLE, { contentId: "c2", action: "pass", ruleIds: [], judgeCallIds: ["j1"], pins: PINS, judgeModel: "jev", budgetTools: 12, budgetMicro: 50_000, reason: "fast" }, T0), "E_ACTION_NOT_SUPPORTED");
    expect(e.detail["step"]).toBe(11);
    expect((db.prepare("SELECT COUNT(*) AS n FROM review").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='submit_rejected'").get() as { n: number }).n).toBe(1);
  });
});

describe("D-02 acquireLease", () => {
  it("only one worker wins; expired/over-attempt/past-deadline are refused with distinct codes", () => {
    const db = freshDb();
    seedContent(db, "c1");
    const r = sus(db, "c1");
    const got = lease(db, r.review_id, "w1");
    expect(got.attempt).toBe(1);
    const held = expectCode(() => lease(db, r.review_id, "w2"), "E_LEASE_HELD");
    expect(held.detail["lease_until"]).toBe(T0 + CFG.leaseTtlMs);
    // expired lease → S3' re-acquire by another worker, attempt 2
    const again = core.acquireLease(db, r.review_id, "w2", CFG, T0 + CFG.leaseTtlMs + 1);
    expect(again.attempt).toBe(2);
    // past deadline (and w2's lease expired) → E_STATE_INVALID
    expectCode(() => core.acquireLease(db, r.review_id, "w3", CFG, T0 + CFG.deadlineMs + CFG.leaseTtlMs + 2), "E_STATE_INVALID");
    // attempt limit
    const db2 = freshDb();
    seedContent(db2, "c9");
    const r2 = sus(db2, "c9");
    core.tx(db2, () => db2.prepare("UPDATE review SET deadline_at=? WHERE review_id=?").run(T0 + 10 ** 9, r2.review_id));
    let t = T0;
    for (let i = 0; i < CFG.maxAttempts; i++) { expect(core.acquireLease(db2, r2.review_id, `w${i}`, CFG, t).attempt).toBe(i + 1); t += CFG.leaseTtlMs + 1; }
    const e = expectCode(() => core.acquireLease(db2, r2.review_id, "wX", CFG, t), "E_STATE_INVALID");
    expect(e.detail["attempt"]).toBe(CFG.maxAttempts);
  });
  it("D-18: expired or revoked leases cannot be renewed", () => {
    const db = freshDb();
    seedContent(db, "c1");
    const r = lease(db, sus(db, "c1").review_id);
    core.renewLease(db, r.review_id, "w1", 1, CFG, T0 + 5000);
    expectCode(() => core.renewLease(db, r.review_id, "w1", 1, CFG, T0 + CFG.leaseTtlMs + 6000), "E_LEASE_LOST");
    const db2 = freshDb();
    seedContent(db2, "c1");
    const r2 = lease(db2, sus(db2, "c1").review_id);
    core.revokeAndRelease(db2, r2.review_id, "timeout", 1, 1000, T0 + 10);
    expectCode(() => core.renewLease(db2, r2.review_id, "w1", 1, CFG, T0 + 20), "E_LEASE_LOST");
  });
});

describe("U-04 / D-03 submitRuling steps", () => {
  it("steps 1–11 each reject with the documented code and step; audit survives rollback (D-07)", () => {
    const db = freshDb();
    seedContent(db, "c1");
    const r = lease(db, sus(db, "c1").review_id);
    const calls = lowRiskConfirmed(db, "c1", r.review_id);
    const base: core.SubmitRulingInput = { reviewId: r.review_id, actor: "agent", attempt: 1, workerId: "w1", action: "pass", evidenceIds: [], ruleIds: [], judgeCallIds: calls, pins: PINS, reason: "x" };
    const at = T0 + 1000;
    const cases: [Partial<core.SubmitRulingInput>, core.ErrorCode, number][] = [
      [{ reviewId: "nope#fast#1" }, "E_REVIEW_NOT_FOUND", 1],
      [{ workerId: "w2" }, "E_LEASE_LOST", 4],
      [{ attempt: 7 }, "E_ATTEMPT_STALE", 4],
      [{ pins: { ...PINS, calibVer: "other" } }, "E_VERSION_MISMATCH", 7],
      [{ action: "takedown", ruleIds: [] }, "E_ACTION_NOT_ALLOWED", 8],
      [{ action: "takedown", ruleIds: ["NOPE-1"] }, "E_RULE_UNKNOWN", 8],
      [{ action: "limit", ruleIds: ["ABUSE-001"] }, "E_ACTION_NOT_ALLOWED", 8],
      [{ evidenceIds: ["other#suspicious#1#e1"] }, "E_EVIDENCE_FOREIGN", 9],
      [{ judgeCallIds: ["missing"] }, "E_JUDGE_FOREIGN", 10],
      [{ action: "takedown", ruleIds: ["ABUSE-001"] }, "E_ACTION_NOT_SUPPORTED", 11],
    ];
    for (const [patch, code, step] of cases) {
      const e = expectCode(() => core.submitRuling(db, BUNDLE, { ...base, ...patch }, at), code);
      expect(e.detail["step"], code).toBe(step);
    }
    // step 5 deadline (lease still valid, deadline moved earlier), step 6 budget
    core.tx(db, () => db.prepare("UPDATE review SET deadline_at=? WHERE review_id=?").run(at - 1, r.review_id));
    const d = expectCode(() => core.submitRuling(db, BUNDLE, base, at), "E_DEADLINE_PASSED");
    expect(d.detail["step"]).toBe(5);
    core.tx(db, () => db.prepare("UPDATE review SET deadline_at=? WHERE review_id=?").run(T0 + CFG.deadlineMs, r.review_id));
    for (let i = 0; i < 12; i++) core.reserveToolSlot(db, r.review_id, 1, `call${i}`, "judge", 10, 12, at);
    expectCode(() => core.reserveToolSlot(db, r.review_id, 1, "call12", "judge", 10, 12, at), "E_BUDGET_EXCEEDED");
    // blocked rows do not count: a dispose still goes through step 6
    const ok = core.submitRuling(db, BUNDLE, base, at);
    expect(ok.ruling.action).toBe("pass");
    expect(JSON.parse(ok.ruling.allowed_actions)).toEqual(["pass"]);
    const audits = (db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='submit_rejected'").get() as { n: number }).n;
    expect(audits).toBe(cases.length + 1);
    expect(core.verifyAuditChain(db)).toBeNull();
  });
  it("step 2: same actor+attempt returns duplicate; other actor → E_STATE_INVALID (H-06 late dispose)", () => {
    const db = freshDb();
    seedContent(db, "c1");
    const r = lease(db, sus(db, "c1").review_id);
    const calls = lowRiskConfirmed(db, "c1", r.review_id);
    const first = agentSubmit(db, r, "pass", calls);
    const again = agentSubmit(db, r, "pass", calls);
    expect(again.duplicate).toBe(true);
    expect(again.ruling.review_id).toBe(first.ruling.review_id);
    expectCode(() => core.submitRuling(db, BUNDLE, { reviewId: r.review_id, actor: "human", action: "takedown", evidenceIds: [], ruleIds: ["ABUSE-001"], judgeCallIds: [], pins: PINS, reason: "h", humanAuth }, T0 + 2000, HUMAN), "E_STATE_INVALID");
  });
  it("human: zero evidence pass allowed in human_queue; takedown without rule_ids rejected; wrong token E_HUMAN_AUTH", () => {
    const db = freshDb();
    seedContent(db, "c1");
    const r = sus(db, "c1");
    core.releaseToHuman(db, r.review_id, { kind: "control" }, "timeout", 1, 1000, T0 + 1);
    const human = (patch: Partial<core.SubmitRulingInput>) => core.submitRuling(db, BUNDLE, { reviewId: r.review_id, actor: "human", action: "pass", evidenceIds: [], ruleIds: [], judgeCallIds: [], pins: PINS, reason: "h", humanAuth, ...patch }, T0 + 2, HUMAN);
    expectCode(() => human({ humanAuth: { reviewerId: "rev1", token: "bad" } }), "E_HUMAN_AUTH");
    expectCode(() => human({ action: "takedown", ruleIds: [] }), "E_ACTION_NOT_ALLOWED");
    const out = human({});
    expect(out.ruling.actor).toBe("human");
    expect((db.prepare("SELECT state FROM review WHERE review_id=?").get(r.review_id) as { state: string }).state).toBe("human_disposed");
    expect((db.prepare("SELECT closed_at FROM human_queue WHERE review_id=?").get(r.review_id) as { closed_at: number | null }).closed_at).not.toBeNull();
    // human in investigating → E_STATE_INVALID
    const db2 = freshDb();
    seedContent(db2, "c1");
    const r2 = lease(db2, sus(db2, "c1").review_id);
    expectCode(() => core.submitRuling(db2, BUNDLE, { reviewId: r2.review_id, actor: "human", action: "pass", evidenceIds: [], ruleIds: [], judgeCallIds: [], pins: PINS, reason: "h", humanAuth }, T0 + 2, HUMAN), "E_STATE_INVALID");
  });
  it("D-03: content_state advances only on higher seq; D-17 three-column FK rejects cross-review rulings", () => {
    const db = freshDb();
    seedContent(db, "A");
    seedContent(db, "B");
    const ra = sus(db, "A");
    const rb = sus(db, "B");
    core.tx(db, () => {
      expect(() => db.prepare("INSERT INTO ruling(review_id, content_id, seq, action, actor, allowed_actions, effective_answers, evidence_ids, rule_ids, judge_call_ids, rules_ver, calib_ver, evidence_ver, ingest_seq, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(ra.review_id, "B", rb.seq, "pass", "human", "[]", "{}", "[]", "[]", "[]", "r", "c", "e", 1, T0)).toThrow(/FOREIGN KEY/);
    });
    core.tx(db, () => core.upsertContentState(db, "A", "takedown", 2, "hidden", T0));
    core.tx(db, () => core.upsertContentState(db, "A", "pass", 1, "visible", T0 + 1));
    expect((db.prepare("SELECT effective_action, effective_seq FROM content_state WHERE content_id='A'").get() as { effective_action: string; effective_seq: number })).toEqual({ effective_action: "takedown", effective_seq: 2 });
  });
  it("D-15: release by a stale attempt → E_ATTEMPT_STALE; by the holder → human_queue with outbox", () => {
    const db = freshDb();
    seedContent(db, "c1");
    const r = lease(db, sus(db, "c1").review_id);
    expectCode(() => core.releaseToHuman(db, r.review_id, { kind: "agent", workerId: "w1", attempt: 5, usedMicro: 0, costStatus: "settled" }, "evidence_gap", 1, 1000, T0 + 1), "E_ATTEMPT_STALE");
    expect(core.releaseToHuman(db, r.review_id, { kind: "agent", workerId: "w1", attempt: 1, usedMicro: 123, costStatus: "settled" }, "evidence_gap", 1, 1000, T0 + 1).duplicate).toBe(false);
    expect(core.releaseToHuman(db, r.review_id, { kind: "agent", workerId: "w1", attempt: 1, usedMicro: 123, costStatus: "settled" }, "evidence_gap", 1, 1000, T0 + 2).duplicate).toBe(true);
    expect((db.prepare("SELECT kind, status FROM outbox WHERE review_id=?").get(r.review_id) as { kind: string; status: string })).toEqual({ kind: "release", status: "pending" });
  });
});

describe("D-08 createFollowupReview (T9)", () => {
  it("retry returns the same review; different payload conflicts; non-terminal latest refused; new request gets new seq", () => {
    const db = freshDb();
    seedContent(db, "c1");
    const calls = lowRiskConfirmed(db, "c1", null);
    core.fastDispose(db, BUNDLE, { contentId: "c1", action: "pass", ruleIds: [], judgeCallIds: calls, pins: PINS, judgeModel: "jev", budgetTools: 12, budgetMicro: 50_000, reason: "fast" }, T0);
    const common = { contentId: "c1", trigger: "appeal" as const, pins: PINS, judgeModel: "jev", deadlineMs: 60_000, budgetTools: 12, budgetMicro: 50_000, pendingVisibility: "hidden" as const };
    const a = core.createFollowupReview(db, { ...common, triggerRequestId: "req-1", payloadSha: "p1" }, T0 + 1);
    expect(a.review.seq).toBe(2);
    const retry = core.createFollowupReview(db, { ...common, triggerRequestId: "req-1", payloadSha: "p1" }, T0 + 2);
    expect(retry.duplicate).toBe(true);
    expect(retry.review.review_id).toBe(a.review.review_id);
    expectCode(() => core.createFollowupReview(db, { ...common, triggerRequestId: "req-1", payloadSha: "p2" }, T0 + 3), "E_REQUEST_CONFLICT");
    expectCode(() => core.createFollowupReview(db, { ...common, trigger: "recheck", triggerRequestId: "req-1", payloadSha: "p1x" }, T0 + 3), "E_REQUEST_CONFLICT");
    // latest review (appeal#2) is queued → new request refused
    expectCode(() => core.createFollowupReview(db, { ...common, triggerRequestId: "req-2", payloadSha: "p1" }, T0 + 4), "E_STATE_INVALID");
    expect((db.prepare("SELECT COUNT(*) AS n FROM review WHERE content_id='c1'").get() as { n: number }).n).toBe(2);
  });
});

describe("D-09 / D-13", () => {
  it("D-09: pending initial state is NULL/0/hidden and CHECK forbids inconsistent rows", () => {
    const db = freshDb();
    seedContent(db, "c1");
    sus(db, "c1");
    expect(db.prepare("SELECT effective_action, effective_seq, visibility FROM content_state WHERE content_id='c1'").get()).toEqual({ effective_action: null, effective_seq: 0, visibility: "hidden" });
    expect(() => core.tx(db, () => db.prepare("INSERT INTO content_state VALUES ('zz', NULL, 3, 'hidden', 0)").run())).toThrow(/CHECK/);
  });
  it("D-13: ledger_seq is strictly increasing across transactions", () => {
    const db = freshDb();
    const seen: number[] = [];
    for (let i = 0; i < 50; i++) seen.push(core.tx(db, () => core.nextSeq(db)));
    expect(new Set(seen).size).toBe(50);
    expect(seen.every((v, i) => i === 0 || v > seen[i - 1]!)).toBe(true);
  });
  it("D-05: audit is append-only and the chain verifies", () => {
    const db = freshDb();
    core.tx(db, () => core.appendAudit(db, "k", "r", "a", { x: 1 }, T0));
    core.tx(db, () => core.appendAudit(db, "k", "r", "a", { x: 2 }, T0 + 1));
    expect(() => db.exec("UPDATE audit SET payload='{}' WHERE audit_id=1")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM audit")).toThrow(/append-only/);
    expect(core.verifyAuditChain(db)).toBeNull();
  });
});

describe("evidence fingerprints (step 10)", () => {
  it("a judge call citing evidence of another review, or with a wrong fingerprint, is E_JUDGE_FOREIGN", () => {
    const db = freshDb();
    seedContent(db, "c1");
    seedContent(db, "c2");
    const r1 = lease(db, sus(db, "c1").review_id);
    const r2 = lease(db, sus(db, "c2").review_id, "w2");
    const sha = addEvidence(db, r2.review_id, 1, "thread_context", 1);
    judge(db, { id: "foreign", contentId: "c1", reviewId: r1.review_id, p: 0.02, choice: "none", evidenceShas: [sha] });
    expectCode(() => agentSubmit(db, r1, "pass", ["foreign"]), "E_JUDGE_FOREIGN");
    const own = addEvidence(db, r1.review_id, 1, "thread_context", 1, "own body");
    judge(db, { id: "ok-a", contentId: "c1", reviewId: r1.review_id, p: 0.02, choice: "none", evidenceShas: [own], extraAnswers: [{ question: ABUSE_Q, p: 0.02, choice: "none" }] });
    // tamper: call recorded for c2's fingerprint but attached to r1
    judge(db, { id: "bad-fp", contentId: "c2", reviewId: r1.review_id, p: 0.02, choice: "none" });
    expectCode(() => agentSubmit(db, r1, "pass", ["bad-fp"]), "E_JUDGE_FOREIGN");
  });
});
