// Stage ③ rule release (dev plan 2026-10-08 §5): a candidate bundle reaches new content only after a passed gate run for
// its exact config and only inside its rollout percentage; pct 0 rolls back; reviews keep the version they were made with.
import { describe, expect, it } from "vitest";
import * as core from "../../packages/core/src/index.ts";
import { DEFAULT_GATEWAY_CONFIG, Gateway } from "../../packages/gateway/src/index.ts";
import { recordedJudge, uniform, type JudgeRequest, type JudgeResponse } from "../../packages/worker/src/index.ts";
import { BUNDLE, freshDb, seedContent } from "../helpers.ts";
import { PRICES, passThroughCalibrator } from "./setup.ts";

// every text: ABUSE-001 at p = 0.5 (between the stable lines 0.10 / 0.90), everything else low, with the in-call copy
const judge = recordedJudge((req: JudgeRequest): JudgeResponse => {
  const answers = { ...uniform(req.questions.filter((q) => q.kind === "rule" && q.ruleId === "ABUSE-001"), 0.5), ...uniform(req.questions.filter((q) => !(q.kind === "rule" && q.ruleId === "ABUSE-001")), 0.01) };
  return { status: "ok", model: "jev-recorded", answers, variant: { shuffleSeed: 17, answers }, usage: { input: 900, output: 500 }, latencyMs: 200 };
});
// the candidate only lowers the ABUSE-001 block line to 0.45: a threshold-only change
const CANDIDATE: core.PolicyBundle = { ...BUNDLE, rulesVer: "rules@candidate", rules: BUNDLE.rules.map((r) => (r.ruleId === "ABUSE-001" ? { ...r, thresholds: { ...r.thresholds, block: 0.45 } } : r)) };
const calibrator = passThroughCalibrator("calib@t1");
const gate: core.GateConfig = { rulesVer: CANDIDATE.rulesVer, calibVer: calibrator.calibVer, judgeModel: "jev-recorded", agentModel: "agent-x", pricesVer: PRICES.pricesVer };
const gw = (db: core.Db) => new Gateway({ db, bundle: BUNDLE, judge, prices: PRICES, calibrator, evidenceVer: "evidence@t1", judgeModel: "jev-recorded", cfg: DEFAULT_GATEWAY_CONFIG, now: () => Date.now(), gatewayId: "g1", candidate: { bundle: CANDIDATE, agentModel: "agent-x" } });
const pinned = (db: core.Db, id: string) => db.prepare("SELECT rules_ver, state FROM review WHERE content_id=? ORDER BY seq DESC LIMIT 1").get(id) as { rules_ver: string; state: string };

describe("stage ③ candidate rollout", () => {
  it("pct 0, or pct 100 without a passed gate: stable; gate passed + pct 100: candidate decides; pct 0 again: rolled back", async () => {
    const db = freshDb();
    const g = gw(db);
    expect(core.loadStoredBundle(db, CANDIDATE.rulesVer)).toBeTruthy();   // stored up front: W and people can work on its reviews
    seedContent(db, "r0", "comment", { text: "t0" });
    await g.processIntakeOnce();
    expect(pinned(db, "r0")).toEqual({ rules_ver: BUNDLE.rulesVer, state: "queued" });   // 0.5: suspicious under the stable lines

    core.setRollout(db, "rules", CANDIDATE.rulesVer, "sha-c", 100, Date.now());
    seedContent(db, "r1", "comment", { text: "t1" });
    await g.processIntakeOnce();
    expect(pinned(db, "r1").rules_ver).toBe(BUNDLE.rulesVer);   // no passed gate for the candidate's config

    core.recordGateRun(db, "gr-fail", gate, false, { why: "test" }, Date.now());
    seedContent(db, "r2", "comment", { text: "t2" });
    await g.processIntakeOnce();
    expect(pinned(db, "r2").rules_ver).toBe(BUNDLE.rulesVer);   // a failed gate run is not enough

    core.recordGateRun(db, "gr-ok", gate, true, { why: "test" }, Date.now());
    seedContent(db, "r3", "comment", { text: "t3" });
    await g.processIntakeOnce();
    expect(pinned(db, "r3")).toEqual({ rules_ver: CANDIDATE.rulesVer, state: "disposed" });   // 0.5 >= 0.45: blocked by the candidate
    expect((db.prepare("SELECT action FROM ruling WHERE content_id='r3'").get() as { action: string }).action).toBe("takedown");

    core.setRollout(db, "rules", CANDIDATE.rulesVer, "sha-c", 0, Date.now());   // rollback
    seedContent(db, "r4", "comment", { text: "t4" });
    await g.processIntakeOnce();
    expect(pinned(db, "r4").rules_ver).toBe(BUNDLE.rulesVer);
    expect(pinned(db, "r3").rules_ver).toBe(CANDIDATE.rulesVer);   // the earlier review keeps the version it was made with
  });

  it("pct 50 splits by a stable per-content bucket", async () => {
    const db = freshDb();
    const g = gw(db);
    core.recordGateRun(db, "gr-ok", gate, true, {}, Date.now());
    core.setRollout(db, "rules", CANDIDATE.rulesVer, "sha-c", 50, Date.now());
    const ids = Array.from({ length: 40 }, (_, k) => `s${k}`);
    for (const id of ids) seedContent(db, id, "comment", { text: id });
    for (let i = 0; i < 5; i++) await g.processIntakeOnce();
    for (const id of ids) expect(pinned(db, id).rules_ver).toBe(core.rolloutBucket(id) < 50 ? CANDIDATE.rulesVer : BUNDLE.rulesVer);
    const onCandidate = ids.filter((id) => pinned(db, id).rules_ver === CANDIDATE.rulesVer).length;
    expect(onCandidate).toBeGreaterThan(0);
    expect(onCandidate).toBeLessThan(40);
  });
});
