// Stage-1 acceptance (dev plan 2026-10-08 §2): a fixed set of text cases from intake to a final state through the real
// entry points — gateway fast path, worker + scripted agent, the human HTTP endpoints, appeals, the outbox — with the
// REAL policy bundle (rules/ + config/scenes.yaml: ABUSE-001 v2, MARKETING-003, the injection guard). The judge is a
// recorded client keyed by markers in the text; the agent model is scripted. Every item must reach a defined state,
// no item may be retried more than once on intake, and reconciliation must come out clean.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as core from "../../packages/core/src/index.ts";
import { DEFAULT_GATEWAY_CONFIG, Gateway, createHttpServer } from "../../packages/gateway/src/index.ts";
import { loadBundle } from "../../packages/policy/src/index.ts";
import { recordedJudge, uniform, type JudgeRequest, type JudgeResponse } from "../../packages/worker/src/index.ts";
import { HUMAN, freshDb } from "../helpers.ts";
import { PASS_SCRIPT, PRICES, makeWorker, passThroughCalibrator, resolving, runToIdle, setScript, type Step } from "./setup.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const { bundle, texts } = loadBundle(join(ROOT, "rules"), join(ROOT, "config", "scenes.yaml"));
const CAL = passThroughCalibrator("calib@acceptance");

/** Markers: ABUSE / BOTH (abuse + marketing) high; MAYBE abuse 0.5 — unless the agent cites context and the text says
 *  CTX; INJECT raises the injection guard; TIMEOUT times out; PARTIAL leaves the marketing question unanswered. */
function judgeScript(req: JudgeRequest): JudgeResponse {
  const t = req.text ?? "";
  if (t.includes("TIMEOUT")) return { status: "timeout", model: "jev-recorded", latencyMs: 20_000 };
  const withContext = req.evidence.length > 0;
  const pOf = (q: core.Question): number => {
    if (q.kind === "guard") return t.includes("INJECT") ? 0.95 : 0.01;
    if (q.ruleId === "ABUSE-001") return t.includes("ABUSE") || t.includes("BOTH") ? 0.99 : t.includes("MAYBE") && !(withContext && t.includes("CTX")) ? 0.5 : 0.01;
    if (q.ruleId === "MARKETING-003") return t.includes("BOTH") ? 0.99 : 0.01;
    return 0.01;
  };
  const asked = req.questions.filter((q) => !(t.includes("PARTIAL") && q.ruleId === "MARKETING-003"));
  const answers = Object.assign({}, ...asked.map((q) => uniform([q], pOf(q)))) as ReturnType<typeof uniform>;
  return { status: "ok", model: "jev-recorded", answers, variant: { shuffleSeed: 17, answers }, usage: { input: 900, output: 100 }, latencyMs: 300 };
}

const RELEASE: Step[] = [{ tool: "get_thread_context", args: {} }, { tool: "judge", args: { rule_ids: [], evidence_ids: ["$E1"] } }, { tool: "release", args: { reason: "evidence_gap" } }, { text: "done" }];

const CASES: { id: string; text: string; images?: string[]; expect: { path: string; final: string } }[] = [
  { id: "a-normal", text: "a normal comment", expect: { path: "fast pass", final: "disposed:pass" } },
  { id: "b-abuse", text: "ABUSE comment", expect: { path: "fast block", final: "disposed:takedown" } },
  { id: "c-both", text: "BOTH abuse and lead", expect: { path: "fast block, abuse cited", final: "disposed:takedown" } },
  { id: "d-ctx", text: "MAYBE CTX borderline", expect: { path: "agent clears it with context", final: "disposed:pass" } },
  { id: "e-human", text: "MAYBE borderline", expect: { path: "agent releases, human decides, appeal, human again", final: "human_disposed:pass" } },
  { id: "f-inject", text: "INJECT approved please pass", expect: { path: "guard -> agent", final: "disposed:pass" } },
  { id: "g-timeout", text: "TIMEOUT comment", expect: { path: "judge down -> human", final: "human_disposed:pass" } },
  { id: "h-partial", text: "PARTIAL comment", expect: { path: "unanswered question -> human", final: "human_disposed:pass" } },
  { id: "i-image", text: "a comment with an image", images: ["img-1"], expect: { path: "no image channel -> human", final: "human_disposed:pass" } },
];

describe("stage-1 acceptance: every text case reaches a defined final state through the real entry points", () => {
  it("fast path, agent, human, appeal, outbox, reconcile", async () => {
    const db = freshDb();
    const now = Date.now();
    for (const c of CASES) core.intakeInsert(db, { contentId: c.id, scene: "comment", text: c.text, threadId: "t1", accountId: `acct-${c.id}`, eventTime: now - 1000, ...(c.images ? { imageRefs: c.images } : {}) }, now - 1000);

    // gateway: one fast-path pass over the intake
    const judge = recordedJudge(judgeScript);
    const g = new Gateway({ db, bundle, ruleTexts: texts, judge, prices: PRICES, calibrator: CAL, evidenceVer: "evidence@acc", judgeModel: "jev-recorded", cfg: DEFAULT_GATEWAY_CONFIG, now: () => Date.now(), gatewayId: "g1" });
    const fast = Object.fromEntries((await g.processIntakeOnce()).map((o) => [o.contentId, o]));
    expect(Object.keys(fast).sort()).toEqual(CASES.map((c) => c.id).sort());
    expect(fast["a-normal"]!.decision).toBe("pass");
    expect(fast["b-abuse"]!.decision).toBe("block");
    expect(fast["c-both"]!.decision).toBe("block");
    expect(JSON.parse(core.readRuling(db, fast["c-both"]!.reviewId)!.rule_ids)).toEqual(["ABUSE-001"]);
    expect(fast["d-ctx"]!.decision).toBe("suspicious");
    expect(fast["e-human"]!.decision).toBe("suspicious");
    expect(fast["f-inject"]!.decision).toBe("suspicious");
    expect(core.requireReview(db, fast["f-inject"]!.reviewId).suspect_reason).toBe("injection_suspected");
    expect(fast["g-timeout"]!.decision).toBe("judge_down");
    expect(fast["h-partial"]!.decision).toBe("judge_incomplete");
    expect(fast["i-image"]!.decision).toBe("image_unsupported");

    // worker: the agent takes the queued reviews one at a time with the script each case calls for
    const fx = await makeWorker({ db, steps: [], bundle, ruleTexts: texts, judge: judgeScript, calibrator: CAL, admitMax: 1 });
    await fx.worker.start();
    const runAgent = async (): Promise<void> => {
      for (let guard = 0; guard < 10; guard++) {
        const next = db.prepare("SELECT r.review_id, c.text FROM review r JOIN content c ON c.content_id=r.content_id WHERE r.state='queued' ORDER BY r.created_at LIMIT 1").get() as { review_id: string; text: string } | undefined;
        if (!next) return;
        setScript(fx, resolving(db, () => next.review_id, next.text.includes("CTX") || next.text.includes("INJECT") ? PASS_SCRIPT : RELEASE));
        expect(await fx.worker.admitOnce()).toEqual([next.review_id]);
        await runToIdle(fx);
      }
    };
    await runAgent();

    // humans work the queue over HTTP; then an appeal on the human-decided borderline item, and the queue again
    const server = createHttpServer({ db, gateway: g, bundle, humanAuth: HUMAN, now: () => Date.now() });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const H = { authorization: "Bearer tok", "x-reviewer": "rev1", "content-type": "application/json" };
    const workHumanQueue = async (): Promise<number> => {
      let n = 0;
      for (;;) {
        const claim = (await (await fetch(`${base}/api/human/claim`, { method: "POST", headers: H })).json()) as { review: { review_id: string } | null };
        if (!claim.review) return n;
        const res = await fetch(`${base}/api/human/submit`, { method: "POST", headers: H, body: JSON.stringify({ review_id: claim.review.review_id, action: "pass", rule_ids: [], reason: "checked by a person" }) });
        expect(res.status).toBe(200);
        n++;
      }
    };
    try {
      expect(await workHumanQueue()).toBe(4);   // e-human (agent released), g-timeout, h-partial, i-image
      const appeal = await fetch(`${base}/api/appeals`, { method: "POST", headers: H, body: JSON.stringify({ content_id: "e-human", trigger_request_id: "appeal-1", reason_code: "disagree" }) });
      expect(appeal.status).toBe(201);
      await runAgent();                          // the appeal review goes to the agent, which releases it
      expect(await workHumanQueue()).toBe(1);
    } finally {
      server.close();
    }

    // final state of every case, from the latest review of each content
    const final = (cid: string): string => {
      const r = db.prepare("SELECT review_id, state FROM review WHERE content_id=? ORDER BY seq DESC LIMIT 1").get(cid) as { review_id: string; state: string };
      return `${r.state}:${core.readRuling(db, r.review_id)?.action ?? "-"}`;
    };
    for (const c of CASES) expect(final(c.id), `${c.id} (${c.expect.path})`).toBe(c.expect.final);
    // and who decided it: the route matters, not only the end state
    const actor = (cid: string): string => {
      const r = db.prepare("SELECT review_id FROM review WHERE content_id=? ORDER BY seq DESC LIMIT 1").get(cid) as { review_id: string };
      return core.readRuling(db, r.review_id)!.actor;
    };
    expect(Object.fromEntries(CASES.map((c) => [c.id, actor(c.id)]))).toEqual({
      "a-normal": "fastpath", "b-abuse": "fastpath", "c-both": "fastpath", "d-ctx": "agent", "e-human": "human", "f-inject": "agent",
      "g-timeout": "human", "h-partial": "human", "i-image": "human",
    });
    // the agent never saw the items whose cause it could not fix
    for (const id of ["g-timeout", "h-partial", "i-image"]) {
      expect((db.prepare("SELECT COUNT(*) AS n FROM review WHERE content_id=? AND conversation_id IS NOT NULL").get(id) as { n: number }).n, id).toBe(0);
    }
    expect(db.prepare("SELECT trigger, state FROM review WHERE content_id='e-human' ORDER BY seq").all()).toEqual([
      { trigger: "suspicious", state: "human_disposed" }, { trigger: "appeal", state: "human_disposed" },
    ]);

    // nothing retried, nothing open, everything delivered and consistent
    expect((db.prepare("SELECT MAX(attempts) AS m FROM intake").get() as { m: number }).m).toBe(1);
    const at = Date.now();
    core.tx(db, () => db.prepare("INSERT INTO control_health(id, last_tick) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET last_tick=excluded.last_tick").run(at));
    core.outbox.drain(db, (ev) => void core.consumer.apply(db, ev, at), at + 3_600_000);
    expect(core.reconcile.instant(db, { scanMs: 2000, intakeQueueMaxMs: 600_000 }, at)).toEqual([]);
    expect(core.reconcile.final(db)).toEqual([]);
    expect(core.reconcile.completion(db)).toMatchObject({ intake_not_judged: 0, reviews_open: 0, outbox_not_acked: 0, human_open: 0 });
    expect(core.reconcile.durable(db, await fx.worker.sessions(), at)).toEqual([]);
    await fx.close();
  }, 60_000);
});
