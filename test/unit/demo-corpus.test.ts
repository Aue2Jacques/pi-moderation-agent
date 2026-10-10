// Demo corpus (packages/worker/src/demo-corpus.ts, DEMO_CORPUS): the demo judge replays the recorded answers of a real
// judge run for texts in the corpus (primary and shuffled copy), keeps the scripted scores for other texts; the demo
// traffic draws only corpus texts; against a real Gateway with that run's calibration (calib/kev4b-v1), recorded answers
// route as the policy says. The corpus here is a made-up three-line file; the real one stays on the demo server.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundle } from "../../packages/policy/src/index.ts";
import { Gateway, DEFAULT_GATEWAY_CONFIG } from "../../packages/gateway/src/index.ts";
import { DemoTraffic, SIM_REVIEWER, makeContent, rng } from "../../packages/gateway/src/demo-traffic.ts";
import { corpusAgentAnswer, demoCalibrator, demoJudge, demoJudgeModel, demoPrices, loadDemoCorpus } from "../../packages/worker/src/index.ts";
import { freshDb } from "../helpers.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const { bundle, texts } = loadBundle(join(ROOT, "rules"), join(ROOT, "config", "scenes.yaml"));
const rule = (id: string) => bundle.rules.find((r) => r.ruleId === id)!.question;
const guard = bundle.scenes.comment.injectionGuard!.question;
const questions = [rule("ABUSE-001"), rule("MARKETING-003"), guard];

const d = (v: number) => ({ violate: v, none: 1 - v - 0.001, unknown: 0.001 });
const answers = (a: number, m: number, g: number) => ({ "ABUSE-001": d(a), "MARKETING-003": d(m), injection_guard: d(g) });
const LINES = [
  { id: "t1", kind: "normal", text: "今天的外卖送得挺快，汤也没洒", primary: answers(0.001, 0.001, 0.001), copy: answers(0.002, 0.001, 0.001) },
  { id: "t2", kind: "marketing", text: "全场两折，加[联系方式]下单", primary: answers(0.002, 0.999, 0.001), copy: answers(0.002, 0.998, 0.001) },
  { id: "t3", kind: "abuse", text: "你说话真是一点脑子都不带", primary: answers(0.6, 0.001, 0.001), copy: answers(0.55, 0.001, 0.001) },
];

function corpusFile(): string {
  const p = join(mkdtempSync(join(tmpdir(), "corpus-")), "corpus.jsonl");
  writeFileSync(p, LINES.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return p;
}

describe("demo corpus", () => {
  const corpus = loadDemoCorpus(corpusFile(), "kev4b-v1");

  it("loads by kind and finds a text by its model view", () => {
    expect(corpus.items).toHaveLength(3);
    expect(corpus.byKind.marketing.map((x) => x.id)).toEqual(["t2"]);
    expect(corpus.lookup("  今天的外卖送得挺快，汤也没洒 ")?.id).toBe("t1");
    expect(corpus.lookup("没见过的句子")).toBeUndefined();
  });

  it("refuses a malformed or empty file", () => {
    const p = join(mkdtempSync(join(tmpdir(), "corpus-")), "bad.jsonl");
    writeFileSync(p, JSON.stringify({ id: "x", kind: "weird", text: "a", primary: {} }) + "\n");
    expect(() => loadDemoCorpus(p, "k")).toThrow(/malformed/);
    writeFileSync(p, "\n");
    expect(() => loadDemoCorpus(p, "k")).toThrow(/empty/);
  });

  it("the judge replays recorded answers (primary and copy) and keeps scripted scores for unknown texts", async () => {
    const j = demoJudge({ delayMs: 0, corpus });
    const res = await j.classify({ contentId: "c1", text: LINES[2]!.text, scene: "comment", evidence: [], questions });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.model).toBe("kev4b-v1-replay");
    expect(res.answers[rule("ABUSE-001").sha]!.probs["violate"]).toBe(0.6);
    expect(res.answers[rule("ABUSE-001").sha]!.choice).toBe("violate");
    expect(res.variant!.answers[rule("ABUSE-001").sha]!.probs["violate"]).toBe(0.55);
    // in the human share, the agent's evidence call gets the same recorded answers
    const withEv = await demoJudge({ delayMs: 0, corpus, corpusHumanPct: 100 }).classify({ contentId: "c1", text: LINES[2]!.text, scene: "comment", evidence: [{ evidenceId: "e1", kind: "account_history", modelView: { counts: { takedown: 2 } } }], questions });
    if (withEv.status === "ok") expect(withEv.answers[rule("ABUSE-001").sha]!.probs["violate"]).toBe(0.6);
    // a text the corpus does not hold: the scripted score
    const other = await j.classify({ contentId: "c2", text: "加V领优惠券，私聊", scene: "comment", evidence: [], questions });
    if (other.status === "ok") expect(other.answers[rule("MARKETING-003").sha]!.probs["violate"]).toBeGreaterThan(0.9);
    expect(demoJudgeModel()).toBe("jev-scripted");
  });

  it("the agent's evidence call is settled by the dataset label, except the human share", async () => {
    const abuse = corpus.items.find((x) => x.id === "t3")!;
    expect(corpusAgentAnswer(rule("ABUSE-001"), abuse, 0)).toEqual({ choice: "violate", probs: { violate: 0.999, none: 0.0009, unknown: 0.0001 } });
    expect(corpusAgentAnswer(rule("MARKETING-003"), abuse, 0)?.choice).toBe("none");
    expect(corpusAgentAnswer(guard, abuse, 0)).toBeUndefined();   // the guard keeps the recorded answer
    expect(corpusAgentAnswer(rule("ABUSE-001"), abuse, 100)).toBeUndefined();   // in the human share: recorded answer
    const j = demoJudge({ delayMs: 0, corpus, corpusHumanPct: 0 });
    const ev = [{ evidenceId: "e1", kind: "account_history", modelView: { counts: {} } }];
    const res = await j.classify({ contentId: "c1", text: abuse.text, scene: "comment", evidence: ev, questions });
    if (res.status === "ok") expect(res.answers[rule("ABUSE-001").sha]!.probs["violate"]).toBe(0.999);
    const fast = await j.classify({ contentId: "c1", text: abuse.text, scene: "comment", evidence: [], questions });
    if (fast.status === "ok") expect(fast.answers[rule("ABUSE-001").sha]!.probs["violate"]).toBe(0.6);   // the fast path still replays
  });

  it("generated contents are corpus texts, all kinds drawn", () => {
    const next = rng(7);
    const kinds = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const c = makeContent(next, 1_800_000_000_000, i, corpus);
      expect(corpus.lookup(c.text)?.kind).toBe(c.kind);
      kinds.add(c.kind);
    }
    expect([...kinds].sort()).toEqual(["abuse", "marketing", "normal"]);
  });

  it("through a real gateway with the replayed run's calibration: pass, auto limit, agent", async () => {
    let clock = 1_800_000_000_000;
    const db = freshDb("gateway");
    const judgeModel = demoJudgeModel(corpus);
    const gateway = new Gateway({ db, bundle, ruleTexts: texts, judge: demoJudge({ delayMs: 0, corpus }), prices: demoPrices({ pricesVer: "prices@t", perMillion: {} }, corpus),
      calibrator: demoCalibrator(join(ROOT, "calib"), "kev4b-v1", bundle.rulesVer), evidenceVer: "evidence@t", judgeModel,
      cfg: { ...DEFAULT_GATEWAY_CONFIG, rateMaxPerMinute: 10_000 }, now: () => clock, gatewayId: "g-test" });
    const deps = { db, gateway, bundle, humanAuth: { token: "t", reviewers: ["rev1", SIM_REVIEWER] }, now: () => clock };
    const tr = new DemoTraffic({ ...deps, mode: "demo", corpus }, { perSec: 0, seed: 5, appealPct: 0 });
    const kinds = new Map<string, string>();
    for (let i = 0; i < 60; i++) { clock += 250; const c = tr.contentTick(); if (c) kinds.set(c.contentId, c.kind); }
    for (let i = 0; i < 40 && (db.prepare("SELECT COUNT(*) AS n FROM intake WHERE status<>'judged'").get() as { n: number }).n > 0; i++) await gateway.processIntakeOnce();
    const rows = db.prepare("SELECT r.content_id, r.state, ru.action FROM review r LEFT JOIN ruling ru ON ru.review_id=r.review_id").all() as { content_id: string; state: string; action: string | null }[];
    expect(rows).toHaveLength(kinds.size);
    for (const r of rows) {
      const k = kinds.get(r.content_id)!;
      if (k === "normal") expect(r.action, k).toBe("pass");
      if (k === "marketing") expect(r.action, k).toBe("limit");
      if (k === "abuse") expect(r.action, k).toBeNull();   // middle band: a suspicious review for the agent
    }
  });
});
