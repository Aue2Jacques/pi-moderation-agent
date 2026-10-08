// Phase 4: fast path + control + dispatch + backpressure + HTTP with a recorded judge (no tokens).
// H-09 (judge down → no pass), H-12 (version pin: new reviews get the new bundle, old keep theirs), H-14 (backpressure), fast-path S1/S2 with in-call confirm,
// blacklist → suspicious, near-duplicate detection, HTTP: health / reviews redacted / restricted auth+audit / human claim+submit / appeal idempotency.
import { describe, expect, it } from "vitest";
import * as core from "../../packages/core/src/index.ts";
import { Gateway, DEFAULT_GATEWAY_CONFIG, createHttpServer, normalizeText, simhash, hamming, Blacklist } from "../../packages/gateway/src/index.ts";
import { recordedJudge, uniform, type JudgeRequest, type JudgeResponse } from "../../packages/worker/src/index.ts";
import { BUNDLE, HUMAN, T0, freshDb, seedContent } from "../helpers.ts";
import { PRICES, passThroughCalibrator } from "./setup.ts";

/** in-call confirm: primary + variant with identical answers (Jev-like determinism) */
const withVariant = (answers: ReturnType<typeof uniform>): JudgeResponse => ({ status: "ok", model: "jev-recorded", answers, variant: { shuffleSeed: 17, answers }, usage: { input: 950, output: 568 }, latencyMs: 300 });
const byText = (req: JudgeRequest): JudgeResponse => {
  const t = req.text ?? "";
  if (t.includes("TIMEOUT")) return { status: "timeout", model: "jev-recorded", latencyMs: 20_000 };
  if (t.includes("INJECT")) return withVariant({ ...uniform(req.questions.filter((q) => q.kind === "guard"), 0.95), ...uniform(req.questions.filter((q) => q.kind !== "guard"), 0.01) });
  if (t.includes("BOTH")) return withVariant({ ...uniform(req.questions.filter((q) => q.kind === "rule"), 0.99), ...uniform(req.questions.filter((q) => q.kind !== "rule"), 0.01) });
  if (t.includes("ABUSE")) return withVariant({ ...uniform(req.questions.filter((q) => q.kind === "rule" && q.ruleId === "ABUSE-001"), 0.99), ...uniform(req.questions.filter((q) => q.kind !== "rule" || q.ruleId !== "ABUSE-001"), 0.01) });
  if (t.includes("MAYBE")) return withVariant({ ...uniform(req.questions.filter((q) => q.kind === "rule" && q.ruleId === "ABUSE-001"), 0.5), ...uniform(req.questions.filter((q) => q.kind !== "rule" || q.ruleId !== "ABUSE-001"), 0.01) });
  return withVariant(uniform(req.questions, 0.01));
};

function makeGateway(db: core.Db, o: Partial<typeof DEFAULT_GATEWAY_CONFIG> = {}, now: () => number = () => Date.now(), bundle = BUNDLE, calibrator: core.Calibrator = passThroughCalibrator("calib@t1")) {
  return new Gateway({ db, bundle, judge: recordedJudge(byText), prices: PRICES, calibrator, evidenceVer: "evidence@t1", judgeModel: "jev-recorded", cfg: { ...DEFAULT_GATEWAY_CONFIG, ...o }, now, gatewayId: "g1" });
}
const state = (db: core.Db, cid: string) => db.prepare("SELECT state, release_reason, rules_ver FROM review WHERE content_id=? ORDER BY seq DESC LIMIT 1").get(cid) as { state: string; release_reason: string | null; rules_ver: string } | undefined;

describe("preprocess", () => {
  it("normalizes width/space/case, blacklist matches, simhash near-duplicates are close", () => {
    expect(normalizeText("Ｈｅｌｌｏ  世界​")).toBe("hello 世界");
    const bl = new Blacklist(["加我微信", "ＱＱ群"]);
    expect(bl.hits("想要的加我微信abc，或进qq群")).toEqual(expect.arrayContaining(["加我微信", "qq群"]));
    const a = simhash("今天的比赛太精彩了，门将扑得漂亮");
    const b = simhash("今天的比赛太精彩了，门将扑得很漂亮");
    const c = simhash("私信我拿内部折扣，限时三天");
    expect(hamming(a, b)).toBeLessThanOrEqual(8);
    expect(hamming(a, c)).toBeGreaterThan(hamming(a, b));
  });
});

describe("fast path S1/S2/S2'", () => {
  it("pass and block dispose directly with the in-call confirm; suspicious queues; judge timeout → human_queue judge_down (H-09)", async () => {
    const db = freshDb();
    seedContent(db, "ok1", "comment", { text: "normal text" });
    seedContent(db, "bad1", "comment", { text: "ABUSE text" });
    seedContent(db, "mid1", "comment", { text: "MAYBE text" });
    seedContent(db, "to1", "comment", { text: "TIMEOUT text" });
    const g = makeGateway(db);
    const out = await g.processIntakeOnce();
    expect(out.map((o) => [o.contentId, o.decision]).sort()).toEqual([["bad1", "block"], ["mid1", "suspicious"], ["ok1", "pass"], ["to1", "judge_down"]]);
    expect(core.readRuling(db, state(db, "ok1") ? `ok1#fast#1` : "")?.action).toBe("pass");
    expect(core.readRuling(db, "bad1#fast#1")?.action).toBe("takedown");
    expect(state(db, "mid1")?.state).toBe("queued");
    expect(state(db, "to1")).toMatchObject({ state: "human_queue", release_reason: "judge_down" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM ruling WHERE action='pass'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM judge_call WHERE confirms_call_id IS NOT NULL").get() as { n: number }).n).toBe(3);
    expect((db.prepare("SELECT COUNT(*) AS n FROM intake WHERE status='judged'").get() as { n: number }).n).toBe(4);
    expect(core.reconcile.instant(db, { scanMs: 2000, intakeQueueMaxMs: 60_000 }, Date.now())).toEqual([]);
  });
  it("blacklist hit forces suspicious even when the judge says pass; rate limit too", async () => {
    const db = freshDb();
    seedContent(db, "bl1", "comment", { text: "normal 加我微信 text" });
    for (let i = 0; i < 4; i++) seedContent(db, `rl${i}`, "comment", { text: `normal text ${i}`, accountId: "spammer" });
    const g = makeGateway(db, { blacklist: ["加我微信"], rateMaxPerMinute: 2 });
    const out = await g.processIntakeOnce();
    expect(out.find((o) => o.contentId === "bl1")?.decision).toBe("suspicious");
    const rl = out.filter((o) => o.contentId.startsWith("rl")).map((o) => o.decision);
    expect(rl.filter((d) => d === "suspicious").length).toBe(2);   // 3rd and 4th hit the limit
  });
  it("H-14 backpressure: agent queue full → S2' backpressure; outstanding over max → replay paused, resumes below 80%", async () => {
    const db = freshDb();
    for (let i = 0; i < 4; i++) seedContent(db, `m${i}`, "comment", { text: `MAYBE ${i}` });
    const g = makeGateway(db, { queueAgentMax: 2, outstandingMax: 2 });
    const out = await g.processIntakeOnce();
    const decisions = out.map((o) => o.decision).sort();
    expect(decisions.filter((d) => d === "suspicious").length).toBeLessThanOrEqual(2);
    expect(decisions.filter((d) => d === "backpressure").length).toBeGreaterThanOrEqual(2);
    g.tickControl();
    expect(g.replayPaused).toBe(true);
    // drain: release the queued ones to human and close them → outstanding drops → resume
    for (const r of db.prepare("SELECT review_id FROM review WHERE state='queued'").all() as { review_id: string }[]) core.releaseToHuman(db, r.review_id, { kind: "control" }, "timeout", 1, 1000, Date.now());
    g.tickControl();
    expect(g.replayPaused).toBe(false);
  });
  it("H-12 version pin: reviews created after a bundle change carry the new rules_ver; existing reviews keep the old one", async () => {
    const db = freshDb();
    seedContent(db, "v1", "comment", { text: "MAYBE 1" });
    const g1 = makeGateway(db);
    await g1.processIntakeOnce();
    expect(state(db, "v1")?.rules_ver).toBe(BUNDLE.rulesVer);
    seedContent(db, "v2", "comment", { text: "MAYBE 2" });
    const g2 = makeGateway(db, {}, () => Date.now(), { ...BUNDLE, rulesVer: "rules@v2" });
    await g2.processIntakeOnce();
    expect(state(db, "v2")?.rules_ver).toBe("rules@v2");
    expect(state(db, "v1")?.rules_ver).toBe(BUNDLE.rulesVer);
  });
  it("control + dispatch loops: timed-out queued review goes to human, outbox drained to downstream", async () => {
    const db = freshDb();
    let t = T0;
    seedContent(db, "q1", "comment", { text: "MAYBE 1" });
    const g = makeGateway(db, {}, () => t);
    await g.processIntakeOnce();
    t = T0 + 61_000;
    const res = g.tickControl();
    expect(res.timedOut).toEqual(["q1#suspicious#1"]);
    expect(g.dispatchOutbox()).toBe(1);
    expect((db.prepare("SELECT result FROM consumer_log").get() as { result: string }).result).toBe("notified");
    const m = g.metrics();
    expect(m.queue_human).toBe(1);
    expect(m.outbox_pending).toBe(0);
  });
});

describe("HTTP", () => {
  it("health, redacted reviews, restricted needs auth+confirm and audits, human claim/submit, appeal idempotent", async () => {
    const db = freshDb();
    seedContent(db, "h1", "comment", { text: "MAYBE secret text" });
    seedContent(db, "h2", "comment", { text: "ABUSE text" });
    const g = makeGateway(db);
    await g.processIntakeOnce();
    core.releaseToHuman(db, "h1#suspicious#1", { kind: "control" }, "timeout", 2, 1000, Date.now());
    const server = createHttpServer({ db, gateway: g, bundle: BUNDLE, humanAuth: HUMAN, now: () => Date.now() });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const H = { authorization: "Bearer tok", "x-reviewer": "rev1", "content-type": "application/json" };
    try {
      expect(((await (await fetch(`${base}/api/health`)).json()) as { ok: boolean }).ok).toBe(true);
      const list = (await (await fetch(`${base}/api/reviews`)).json()) as Record<string, unknown>[];
      expect(list.length).toBe(2);
      expect(JSON.stringify(list)).not.toContain("secret");
      const detail = (await (await fetch(`${base}/api/reviews/${encodeURIComponent("h1#suspicious#1")}`)).json()) as { evidence: unknown[]; judge_answers: unknown[] };
      expect(JSON.stringify(detail)).not.toContain("secret");
      expect(detail.judge_answers.length).toBeGreaterThan(0);
      expect((await fetch(`${base}/api/reviews/${encodeURIComponent("h1#suspicious#1")}/restricted`, { headers: { "x-confirm": "yes" } })).status).toBe(401);
      expect((await fetch(`${base}/api/reviews/${encodeURIComponent("h1#suspicious#1")}/restricted`, { headers: H })).status).toBe(400);
      const restricted = await fetch(`${base}/api/reviews/${encodeURIComponent("h1#suspicious#1")}/restricted`, { headers: { ...H, "x-confirm": "yes" } });
      expect(restricted.status).toBe(200);
      expect(JSON.stringify(await restricted.json())).toContain("secret");
      expect((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='restricted_view'").get() as { n: number }).n).toBe(1);
      expect((await fetch(`${base}/api/human/claim`, { method: "POST" })).status).toBe(401);
      const claim = (await (await fetch(`${base}/api/human/claim`, { method: "POST", headers: H })).json()) as { review: { review_id: string } };
      expect(claim.review.review_id).toBe("h1#suspicious#1");
      const bad = await fetch(`${base}/api/human/submit`, { method: "POST", headers: H, body: JSON.stringify({ review_id: "h1#suspicious#1", action: "takedown", rule_ids: [], reason: "x" }) });
      expect(bad.status).toBe(422);
      const ok = await fetch(`${base}/api/human/submit`, { method: "POST", headers: H, body: JSON.stringify({ review_id: "h1#suspicious#1", action: "pass", rule_ids: [], reason: "fine" }) });
      expect(ok.status).toBe(200);
      expect(core.readRuling(db, "h1#suspicious#1")?.actor).toBe("human");
      const a1 = await fetch(`${base}/api/appeals`, { method: "POST", headers: H, body: JSON.stringify({ content_id: "h2", trigger_request_id: "req-1", reason_code: "disagree" }) });
      expect(a1.status).toBe(201);
      const a2 = await fetch(`${base}/api/appeals`, { method: "POST", headers: H, body: JSON.stringify({ content_id: "h2", trigger_request_id: "req-1", reason_code: "disagree" }) });
      expect(a2.status).toBe(200);
      expect(((await a2.json()) as { duplicate: boolean }).duplicate).toBe(true);
      const a3 = await fetch(`${base}/api/appeals`, { method: "POST", headers: H, body: JSON.stringify({ content_id: "h2", trigger_request_id: "req-1", reason_code: "other" }) });
      expect(a3.status).toBe(409);
      expect((await (await fetch(`${base}/`)).text()).includes("仪表盘")).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe("R4 multi-rule block and bounded fast-path retries (dev plan 2026-10-08)", () => {
  // one judge request records the primary answer and its in-call confirm copy; count requests by their primary rows
  const judgeCalls = (db: core.Db, cid: string): number => (db.prepare("SELECT COUNT(*) AS n FROM judge_call WHERE content_id=? AND confirms_call_id IS NULL").get(cid) as { n: number }).n;

  it("abuse and marketing both block: one ruling on the first pass — heaviest action, citing only the rules that allow it", async () => {
    const db = freshDb();
    seedContent(db, "both1", "comment", { text: "BOTH text" });
    const g = makeGateway(db);
    const [o] = await g.processIntakeOnce();
    expect(o).toMatchObject({ contentId: "both1", decision: "block" });
    const rul = core.readRuling(db, o!.reviewId)!;
    expect(rul.action).toBe("takedown");
    expect(JSON.parse(rul.rule_ids)).toEqual(["ABUSE-001"]);                    // MARKETING-003 allows only limit
    expect(rul.reason).toContain("MARKETING-003");                             // the other hit is kept in the reason
    expect(judgeCalls(db, "both1")).toBe(1);
  });

  it("a failure that repeats on every pass goes to a human after intakeMaxAttempts; judge calls stay bounded", async () => {
    const db = freshDb();
    seedContent(db, "stuck1", "comment", { text: "ABUSE text" });
    // the scene forbids takedown, so every ruling the fast path builds fails the submit check
    const bundle = { ...BUNDLE, scenes: { ...BUNDLE.scenes, comment: { ...BUNDLE.scenes.comment, allowedActions: ["pass", "limit"] as const } } } as core.PolicyBundle;
    const g = makeGateway(db, { intakeMaxAttempts: 3 }, () => Date.now(), bundle);
    const status = () => (db.prepare("SELECT status FROM intake WHERE content_id='stuck1'").get() as { status: string }).status;
    for (let pass = 0; pass < 10 && status() !== "judged"; pass++) await g.processIntakeOnce();
    expect(state(db, "stuck1")).toMatchObject({ state: "human_queue", release_reason: "fastpath_error" });
    expect(judgeCalls(db, "stuck1")).toBeLessThanOrEqual(3);
  });
});

describe("R5b fast-path judge cost on the dashboard (dev plan 2026-10-08)", () => {
  it("one fast-path item: cost_micro_window = its judge requests priced by hand (usage x unit price)", async () => {
    const db = freshDb();
    seedContent(db, "ok1", "comment", { text: "normal text" });
    const g = makeGateway(db);
    const [o] = await g.processIntakeOnce();
    expect(o).toMatchObject({ decision: "pass" });
    // byText answers every request with usage { input: 950, output: 568 }; PRICES: jev-recorded = 1 micro per input token, 0 per output
    const requests = (db.prepare("SELECT COUNT(*) AS n FROM judge_call WHERE content_id='ok1' AND confirms_call_id IS NULL").get() as { n: number }).n;
    expect(requests).toBe(1);
    const m = g.metrics();
    expect(m.cost_micro_window).toBe(requests * 950);
    expect(m.cost_micro_per_1k).toBe(requests * 950 * 1000);   // one item judged in the window
  });

  it("a suspicious item's fast-path call (bound to the new agent review) is counted once", async () => {
    const db = freshDb();
    seedContent(db, "ok1", "comment", { text: "normal text" });
    seedContent(db, "mid1", "comment", { text: "MAYBE text" });
    const g = makeGateway(db);
    const outs = await g.processIntakeOnce();
    expect(outs.map((o) => o.decision).sort()).toEqual(["pass", "suspicious"]);
    expect((db.prepare("SELECT review_id FROM judge_call WHERE content_id='mid1' AND confirms_call_id IS NULL").get() as { review_id: string | null }).review_id).not.toBeNull();
    const m = g.metrics();
    expect(m.cost_micro_window).toBe(2 * 950);   // two fast-path requests; the agent review has no cost yet
  });
});

describe("R7 human work on a review pinned to an older rules version (dev plan 2026-10-08)", () => {
  it("after the gateway moves to a new bundle, claim lists the review's own rules and the human ruling is accepted under its version", async () => {
    const db = freshDb();
    seedContent(db, "v1", "comment", { text: "MAYBE text" });
    await makeGateway(db).processIntakeOnce();                                                 // review created under rules@test1 (stored)
    const rid = (db.prepare("SELECT review_id FROM review WHERE content_id='v1'").get() as { review_id: string }).review_id;
    core.releaseToHuman(db, rid, { kind: "control" }, "timeout", 2, 1000, Date.now());
    const NEW: core.PolicyBundle = { ...BUNDLE, rulesVer: "rules@test2", rules: BUNDLE.rules.filter((r) => r.ruleId === "ABUSE-001") };   // marketing rule removed
    const g2 = makeGateway(db, {}, () => Date.now(), NEW);
    const server = createHttpServer({ db, gateway: g2, bundle: NEW, humanAuth: HUMAN, now: () => Date.now() });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const H = { authorization: "Bearer tok", "x-reviewer": "rev1", "content-type": "application/json" };
    try {
      const claim = (await (await fetch(`${base}/api/human/claim`, { method: "POST", headers: H })).json()) as { review: { review_id: string }; rules: { rule_id: string }[] };
      expect(claim.review.review_id).toBe(rid);
      expect(claim.rules.map((x) => x.rule_id).sort()).toEqual(["ABUSE-001", "MARKETING-003"]);   // the review's version, not the gateway's
      const sub = await fetch(`${base}/api/human/submit`, { method: "POST", headers: H, body: JSON.stringify({ review_id: rid, action: "limit", rule_ids: ["MARKETING-003"], reason: "lead" }) });
      expect(sub.status).toBe(200);
      expect(core.readRuling(db, rid)).toMatchObject({ actor: "human", action: "limit", rules_ver: "rules@test1" });
    } finally {
      server.close();
    }
  });
});

describe("§2.2 fast-path injection guard (dev plan 2026-10-08)", () => {
  it("the guard is asked and recorded; flagged -> agent review (injection_suspected); clear -> pass as before", async () => {
    const db = freshDb();
    seedContent(db, "inj1", "comment", { text: "INJECT plain text" });
    seedContent(db, "ok1", "comment", { text: "normal text" });
    const guardQ = { ...BUNDLE.scenes.comment.imageCheck.question, sha: core.questionSha({ kind: "guard", instructions: "guard?", criteria: { violate: "y", none: "n", unknown: "u" } }), key: "injection_guard", kind: "guard" as const, instructions: "guard?" };
    const bundle: core.PolicyBundle = { ...BUNDLE, rulesVer: "rules@guard", scenes: { ...BUNDLE.scenes, comment: { ...BUNDLE.scenes.comment, injectionGuard: { threshold: 0.5, question: guardQ } } } };
    const out = await makeGateway(db, {}, () => Date.now(), bundle).processIntakeOnce();
    const byId = Object.fromEntries(out.map((o) => [o.contentId, o]));
    expect(byId["inj1"]).toMatchObject({ decision: "suspicious" });
    expect((db.prepare("SELECT state, suspect_reason FROM review WHERE content_id='inj1'").get())).toEqual({ state: "queued", suspect_reason: "injection_suspected" });   // §2.2: the agent sees why
    expect(byId["ok1"]).toMatchObject({ decision: "pass" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM judge_answer a JOIN judge_call c ON c.judge_call_id=a.judge_call_id WHERE c.content_id='inj1' AND a.question_kind='guard'").get() as { n: number }).n).toBe(2);   // primary + confirm copy
  });
});


describe("§2.2 confirm switch vs judge client (dev plan 2026-10-08)", () => {
  it("a judge client without the in-call copy is refused while any scene requires confirmation", () => {
    const db = freshDb();
    const noCopy = { ...recordedJudge(byText), inCallConfirm: false };
    expect(() => new Gateway({ db, bundle: BUNDLE, judge: noCopy, prices: PRICES, calibrator: passThroughCalibrator("calib@t1"), evidenceVer: "e", judgeModel: "jev-recorded", cfg: DEFAULT_GATEWAY_CONFIG, now: () => Date.now(), gatewayId: "g1" })).toThrow(/confirm_pass/);
    const off = { ...BUNDLE, scenes: Object.fromEntries(Object.entries(BUNDLE.scenes).map(([k, v]) => [k, { ...v, confirmPass: false }])) } as core.PolicyBundle;
    expect(() => new Gateway({ db, bundle: off, judge: noCopy, prices: PRICES, calibrator: passThroughCalibrator("calib@t1"), evidenceVer: "e", judgeModel: "jev-recorded", cfg: DEFAULT_GATEWAY_CONFIG, now: () => Date.now(), gatewayId: "g1" })).not.toThrow();
  });
});
