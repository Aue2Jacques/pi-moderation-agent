// Round-9 review items through the real Worker / Gateway (faux model, recorded judge):
// R9-05 calibration on the main path, R9-06 images never auto-disposed, R9-07 cost on host-triggered release,
// R9-08 metrics definitions, R9-12 an old review continues under its own bundle.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../../packages/core/src/index.ts";
import { Gateway, DEFAULT_GATEWAY_CONFIG } from "../../packages/gateway/src/index.ts";
import { loadCalibrator, noCalibrator } from "../../packages/judges/src/index.ts";
import { recordedJudge, uniform, type JudgeRequest, type JudgeResponse } from "../../packages/worker/src/index.ts";
import { BUNDLE, PINS, freshDb, seedContent } from "../helpers.ts";
import { PASS_SCRIPT, PRICES, lowRisk, makeWorker, passThroughCalibrator, queuedReview, resolving, review, ruling, runToIdle, setScript, setScriptedUsage, type Step } from "./setup.ts";

const lowWithVariant = (req: JudgeRequest): JudgeResponse => {
  const a = uniform(req.questions, 0.02);
  return { status: "ok", model: "jev-recorded", answers: a, variant: { shuffleSeed: 17, answers: a }, usage: { input: 950, output: 568 }, latencyMs: 300 };
};
const gw = (db: core.Db, calibrator: core.Calibrator, judge = recordedJudge(lowWithVariant)) =>
  new Gateway({ db, bundle: BUNDLE, judge, prices: PRICES, calibrator, evidenceVer: "evidence@t1", judgeModel: "jev-recorded", cfg: { ...DEFAULT_GATEWAY_CONFIG }, now: () => Date.now(), gatewayId: "g1" });
const latest = (db: core.Db, cid: string) => db.prepare("SELECT * FROM review WHERE content_id=? ORDER BY seq DESC LIMIT 1").get(cid) as core.ReviewRow;

describe("R9-05 calibration is applied on the main path, or nothing is auto-disposed", () => {
  it("strict with no calib files: a clearly low-risk text is NOT auto-passed; answers stored uncalibrated; pin calib@none", async () => {
    const db = freshDb();
    seedContent(db, "c1", "comment", { text: "plain text" });
    const out = await gw(db, noCalibrator()).processIntakeOnce();
    expect(out[0]!.decision).toBe("suspicious");
    expect(latest(db, "c1").calib_ver).toBe("calib@none");
    const n = db.prepare("SELECT COUNT(*) AS total, SUM(calibrated_probs IS NULL) AS nulls FROM judge_answer").get() as { total: number; nulls: number };
    expect(n.total).toBeGreaterThan(0);
    expect(n.nulls).toBe(n.total);
    expect(core.readRuling(db, latest(db, "c1").review_id)).toBeUndefined();
  });
  it("strict with a fitted file: the probability the permission gate sees is the file's output, traceable by temperature and calib_ver", async () => {
    const dir = mkdtempSync(join(tmpdir(), "calib-"));
    mkdirSync(join(dir, "jev-recorded"));
    writeFileSync(join(dir, "jev-recorded", "comment-3.json"), JSON.stringify({ T: 0.5, n: 300, ece_before: 0.08, ece_after: 0.02, fitted_at: 0, bucket: { judge: "jev-recorded", rules_ver: BUNDLE.rulesVer, scene: "comment", n_options: 3 } }));
    const cal = loadCalibrator(dir, "jev-recorded");
    const db = freshDb();
    seedContent(db, "c1", "comment", { text: "plain text" });
    const out = await gw(db, cal).processIntakeOnce();
    expect(out[0]!.decision).toBe("pass");
    const r = latest(db, "c1");
    expect(r.calib_ver).toBe(cal.calibVer);
    const a = db.prepare("SELECT raw_probs, calibrated_probs, temperature FROM judge_answer LIMIT 1").get() as { raw_probs: string; calibrated_probs: string; temperature: number };
    expect(a.temperature).toBe(0.5);
    expect(a.calibrated_probs).not.toBe(a.raw_probs);
    const calP = JSON.parse(a.calibrated_probs) as Record<string, number>;
    expect(Math.min(...Object.values(calP))).toBeLessThan(Math.min(...Object.values(JSON.parse(a.raw_probs) as Record<string, number>)));   // T<1 sharpens
  });
  it("worker: a calibrator whose version differs from the review's pin cannot calibrate → the agent's pass is rejected, review goes to human", async () => {
    const db = freshDb();
    const now = Date.now();
    const r = queuedReview(db, "c1", { thread: "t1", at: now - 1000 });
    const steps: Step[] = [...PASS_SCRIPT.slice(0, 4), { tool: "release", args: { reason: "evidence_gap" } }, { text: "x" }];
    const fx = await makeWorker({ db, steps: [], calibrator: passThroughCalibrator("calib@other") });
    setScript(fx, resolving(db, () => r.review_id, steps));
    await fx.worker.start();
    await fx.worker.admitOnce();
    await runToIdle(fx);
    expect(ruling(db, r.review_id)).toBeUndefined();
    expect(review(db, r.review_id).state).toBe("human_queue");
    const nulls = db.prepare("SELECT COUNT(*) AS n FROM judge_answer a JOIN judge_call c ON c.judge_call_id=a.judge_call_id WHERE c.review_id=? AND a.calibrated_probs IS NOT NULL").get(r.review_id) as { n: number };
    expect(nulls.n).toBe(0);
    await fx.close();
  });
});

describe("R9-06 content with images is never auto-disposed in the text MVP", () => {
  it("gateway: image content goes straight to human (image_unsupported) with zero judge calls", async () => {
    const db = freshDb();
    seedContent(db, "img1", "comment", { text: "plain text", imageRefs: ["sha256:abc"] });
    let calls = 0;
    const out = await gw(db, passThroughCalibrator("calib@t1"), recordedJudge((req) => { calls++; return lowWithVariant(req); })).processIntakeOnce();
    expect(out[0]!.decision).toBe("image_unsupported");
    expect(calls).toBe(0);
    expect(latest(db, "img1")).toMatchObject({ state: "human_queue", release_reason: "image_unsupported" });
  });
  it("worker: the judge tool never asks image_check, and a pass on image content is rejected", async () => {
    const db = freshDb();
    const now = Date.now();
    const r = queuedReview(db, "c1", { thread: "t1", at: now - 1000, imageRefs: ["sha256:abc"] });
    const asked: string[] = [];
    const steps: Step[] = [...PASS_SCRIPT.slice(0, 4), { tool: "release", args: { reason: "evidence_gap" } }, { text: "x" }];
    const fx = await makeWorker({ db, steps: [], judge: (req) => { asked.push(...req.questions.map((q) => q.kind)); return lowRisk(req); } });
    setScript(fx, resolving(db, () => r.review_id, steps));
    await fx.worker.start();
    await fx.worker.admitOnce();
    await runToIdle(fx);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked).not.toContain("image_check");
    expect(ruling(db, r.review_id)).toBeUndefined();
    expect(review(db, r.review_id).state).toBe("human_queue");
    const codes = (db.prepare("SELECT payload FROM audit WHERE kind='submit_rejected'").all() as { payload: string }[]).map((a) => JSON.parse(a.payload).code);
    expect(codes).toContain("E_ACTION_NOT_SUPPORTED");   // pass is not in allowedActions: image_check is not covered
    await fx.close();
  });
});

describe("R9-07 cost is settled from the ledger on every exit path", () => {
  const prices: core.PriceTable = { pricesVer: "prices@t1", perMillion: { "faux/faux-1": { input: 1_000_000, output: 1_000_000 }, "jev-recorded": { input: 1_000_000, output: 0 } } };
  it("host-triggered release (model never ends the review) records model + tool cost, not 0", async () => {
    const db = freshDb();
    const now = Date.now();
    const r = queuedReview(db, "c1", { thread: "t1", at: now - 1000 });
    setScriptedUsage({ input: 1000, output: 100 });
    try {
      const steps: Step[] = [PASS_SCRIPT[0]!, PASS_SCRIPT[1]!, { text: "thinking" }];   // yields twice → onYield → host release (model_release)
      const fx = await makeWorker({ db, steps: [], prices });
      setScript(fx, resolving(db, () => r.review_id, steps));
      await fx.worker.start();
      await fx.worker.admitOnce();
      await runToIdle(fx);
      const rv = review(db, r.review_id);
      expect(rv).toMatchObject({ state: "human_queue", release_reason: "model_release", cost_status: "settled" });
      const ledger = core.spentFromLedger(db, prices, r.review_id);
      expect(ledger.models).toBeGreaterThan(0);
      expect(ledger.tools).toBe(480);                    // one judge call, 480 input tokens at 1 micro/token
      expect(rv.used_micro).toBe(ledger.spent);
      await fx.close();
    } finally {
      setScriptedUsage({ input: 0, output: 0 });
    }
  });
  it("normal dispose: final used_micro equals the ledger", async () => {
    const db = freshDb();
    const now = Date.now();
    const r = queuedReview(db, "c1", { thread: "t1", at: now - 1000 });
    setScriptedUsage({ input: 500, output: 50 });
    try {
      const fx = await makeWorker({ db, steps: [], prices });
      setScript(fx, resolving(db, () => r.review_id, PASS_SCRIPT));
      await fx.worker.start();
      await fx.worker.admitOnce();
      await runToIdle(fx);
      expect(review(db, r.review_id).state).toBe("disposed");
      expect(review(db, r.review_id).used_micro).toBe(core.spentFromLedger(db, prices, r.review_id).spent);
      await fx.close();
    } finally {
      setScriptedUsage({ input: 0, output: 0 });
    }
  });
  it("control-loop revocation includes model cost already spent (estimated until settled)", () => {
    const db = freshDb();
    const r = queuedReview(db, "c1", { at: 1000 });
    core.acquireLease(db, r.review_id, "w1", { ...core.DEFAULT_CONFIG, leaseTtlMs: 10 }, 1000);
    core.recordModelCall(db, "g1", "r1", r.review_id, 1, "7", "faux-1", { input: 1000, output: 100 }, "stop", 1001);
    core.control.tick(db, { ...core.DEFAULT_CONFIG, maxAttempts: 1 }, () => 1, 1000, 5000, prices);
    expect(review(db, r.review_id)).toMatchObject({ state: "human_queue", used_micro: 1100, cost_status: "estimated" });
  });
});

describe("R9-08 metrics count releases from both processes over the same denominator", () => {
  it("an agent release (evidence_gap) shows up in release_pct and release_by_reason; cost denominator is content judged", async () => {
    const db = freshDb();
    const g = gw(db, passThroughCalibrator("calib@t1"), recordedJudge((req) => (req.text?.includes("MAYBE") ? { ...lowWithVariant(req), answers: uniform(req.questions, 0.5), variant: { shuffleSeed: 17, answers: uniform(req.questions, 0.5) } } : lowWithVariant(req))));
    seedContent(db, "ok1", "comment", { text: "plain" });
    seedContent(db, "ok2", "comment", { text: "plain" });
    seedContent(db, "m1", "comment", { text: "MAYBE" });
    seedContent(db, "img", "comment", { text: "plain", imageRefs: ["x"] });
    await g.processIntakeOnce();
    const sus = latest(db, "m1");
    expect(sus.state).toBe("queued");
    const leased = core.acquireLease(db, sus.review_id, "w1", core.DEFAULT_CONFIG, Date.now());
    core.releaseToHuman(db, sus.review_id, { kind: "agent", workerId: "w1", attempt: leased.attempt, usedMicro: 700, costStatus: "settled" }, "evidence_gap", 1, 1000, Date.now());
    const m = g.metrics();
    expect(m.cost_denominator).toBe(4);
    expect(m.release_by_reason).toEqual({ evidence_gap: 1, image_unsupported: 1 });
    expect(m.release_agent_pct).toBe(25);
    expect(m.release_fast_pct).toBe(25);
    expect(m.release_pct).toBe(50);
    // expected fast-path cost built independently (dev plan R5b: this used to repeat the dashboard's own query, so
    // it expected 0 together with the bug): requests made x usage { input: 950 } x 1 micro per input token
    const requests = (db.prepare("SELECT COUNT(*) AS n FROM judge_call WHERE confirms_call_id IS NULL").get() as { n: number }).n;
    expect(requests).toBe(3);                                                 // ok1, ok2, m1 (the image item never reaches the judge)
    const fastCost = requests * 950;
    expect(m.cost_micro_window).toBe(fastCost + 700);
    expect(m.cost_micro_per_1k).toBe(Math.round(((fastCost + 700) / 4) * 1000));
    expect(m.calib_ver).toBe("calib@t1");
  });
});

describe("R9-12 a review continues under the bundle it is pinned to, not the worker's current one", () => {
  it("bundle v1 stored by G; worker runs v2; the v1 review loads v1 rule text and its ruling carries rules_ver v1", async () => {
    const db = freshDb();
    const now = Date.now();
    core.storeBundle(db, BUNDLE, { "ABUSE-001": "v1 rule text", "MARKETING-003": "v1 m" }, now);
    const r = queuedReview(db, "c1", { thread: "t1", at: now - 1000 });                  // pinned to BUNDLE.rulesVer
    const v2: core.PolicyBundle = { ...BUNDLE, rulesVer: "rules@test2" };
    const steps: Step[] = [{ tool: "load_rule", args: { rule_id: "ABUSE-001" } }, ...PASS_SCRIPT.map((s) => JSON.parse(JSON.stringify(s).replace(/\$E1/g, "$E2")) as Step)];
    const fx = await makeWorker({ db, steps: [], bundle: v2, ruleTexts: { "ABUSE-001": "v2 rule text", "MARKETING-003": "v2 m" } });
    setScript(fx, resolving(db, () => r.review_id, steps));
    await fx.worker.start();
    await fx.worker.admitOnce();
    await runToIdle(fx);
    const ev = db.prepare("SELECT body FROM evidence WHERE review_id=? AND kind='rule'").get(r.review_id) as { body: string };
    expect(ev.body).toContain("v1 rule text");
    const rul = ruling(db, r.review_id)!;
    expect(rul.action).toBe("pass");
    expect(rul.rules_ver).toBe(BUNDLE.rulesVer);
    expect(core.loadStoredBundle(db, "rules@test2")).toBeDefined();                      // the worker stored its own version too
    await fx.close();
  });
  it("a review pinned to a version nobody stored is released (bundle_missing), never run under another bundle", async () => {
    const db = freshDb();
    const now = Date.now();
    const r = queuedReview(db, "c1", { thread: "t1", at: now - 1000, pins: { ...PINS, rulesVer: "rules@gone" } });
    const fx = await makeWorker({ db, steps: [] });
    setScript(fx, resolving(db, () => r.review_id, PASS_SCRIPT));
    await fx.worker.start();
    expect(await fx.worker.admitOnce()).toEqual([]);
    expect(review(db, r.review_id)).toMatchObject({ state: "human_queue", release_reason: "bundle_missing", conversation_id: null });
    expect(fx.calls).toEqual([]);
    await fx.close();
  });
});

describe("R9-14 the reconcile CLI is a gate: non-zero exit while anything accepted is unfinished", () => {
  it("queued review → exit 1 with reviews_open; after it reaches human and the outbox drains → exit 0", async () => {
    const { spawnSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    const path = join(dir, "app.db");
    const db = core.openAppDb(path, "test");
    core.ensureSchema(db);
    const r = queuedReview(db, "c1", { at: Date.now() });
    core.tx(db, () => db.prepare("UPDATE intake SET status='judged', judged_review_id=? WHERE content_id='c1'").run(r.review_id));
    core.tx(db, () => db.prepare("INSERT INTO control_health(id, last_tick) VALUES (1,?)").run(Date.now()));
    const cli = () => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(import.meta.dirname, "..", "..", "scripts", "reconcile.ts"), path], { encoding: "utf8" });
    const open = cli();
    expect(open.status).toBe(1);
    expect(JSON.parse(open.stdout)).toMatchObject({ ok: false, incomplete: ["reviews_open=1"] });
    core.releaseToHuman(db, r.review_id, { kind: "control" }, "timeout", 1, 1000, Date.now());
    core.outbox.drain(db, (ev) => void core.consumer.apply(db, ev, Date.now()), Date.now() + 3_600_000);
    const done = cli();
    expect(JSON.parse(done.stdout)).toMatchObject({ ok: true, incomplete: [] });
    expect(done.status).toBe(0);
  }, 30_000);
});
