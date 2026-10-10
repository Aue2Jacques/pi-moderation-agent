// U-01 engine, U-02 calib, U-07 rules YAML, U-08 prompt labels, U-10 logprob parsing, U-11 shadow
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { AnswerRecord, PolicyBundle, Rule } from "../../packages/core/src/index.ts";
import * as policy from "../../packages/policy/src/index.ts";
import * as judges from "../../packages/judges/src/index.ts";
import { allowedActions as coreAllowed } from "../../packages/core/src/index.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const loaded = policy.loadBundle(join(ROOT, "rules"), join(ROOT, "config", "scenes.yaml"));
const B = loaded.bundle;
const abuse = B.rules.find((r) => r.ruleId === "ABUSE-001")!;
const mkt = B.rules.find((r) => r.ruleId === "MARKETING-003")!;
// the exception machinery stays in the code for future rules; ABUSE-001 lost its exception (§2.2), so those tests use
// a test-only copy of the old rule loaded through the same YAML loader
const abuseX = policy.ruleFromYaml(parse(readFileSync(join(ROOT, "rules", "test-fixtures", "abuse-001-v1-with-exception.yaml"), "utf8")) as policy.RuleYaml);
const BX = { ...B, rules: [abuseX, mkt] };

const ans = (sha: string, id: string, p: number, choice: string, confirms?: string, at = 0): AnswerRecord => ({
  judgeCallId: id, questionSha: sha, choice, p, evidenceSet: [], inputSha: "in", model: "m", calibVer: "c", confirmsCallId: confirms ?? null, createdAt: at,
});
const pair = (sha: string, prefix: string, p = 0.02): AnswerRecord[] => [ans(sha, `${prefix}a`, p, "none"), ans(sha, `${prefix}b`, p, "none", `${prefix}a`, 1)];
// the comment scene asks the fast-path injection guard (§2.2); an automatic decision needs a clear guard answer
const guardQ = B.scenes.comment.injectionGuard!.question;
const G = pair(guardQ.sha, "g");

describe("U-07 rules YAML", () => {
  it("loads the bundle, derives question shas, versions rules+scenes together", () => {
    expect(B.rules.map((r) => r.ruleId)).toEqual(["ABUSE-001", "MARKETING-003"]);
    expect(abuse.exceptions).toEqual([]);                                     // EX-QUOTE removed (dev plan 2026-10-08 §2.2)
    expect(abuseX.exceptions[0]!.question.appliesChoice).toBe("applies");
    expect(abuse.question.passChoices).toEqual(["none"]);
    expect(B.rulesVer).toMatch(/^rules@[0-9a-f]{12}$/);
    expect(B.scenes.comment.requiredCategories).toEqual(["ABUSE", "MARKETING"]);
    expect(loaded.contractTests["ABUSE-001"]).toHaveLength(5);
    expect(() => policy.ruleFromYaml({ ...yamlOf(abuse), question: { id: "q", instructions: "i", options: { violate: "v", none: "n", unknown: "u" }, violation_option: "violate", pass_choices: ["unknown"] } })).toThrow(/unknown/);
    expect(() => policy.ruleFromYaml({ ...yamlOf(abuse), thresholds: { block: 0.1, pass: 0.5 } })).toThrow(/threshold/);
  });
});

function yamlOf(r: Rule): policy.RuleYaml {
  return { rule_id: r.ruleId, version: 1, category: r.category, scenes: [...r.scenes], severity: r.severity, default_action: r.defaultAction, text: "t",
    question: { id: "q", instructions: "i", options: { violate: "v", none: "n", unknown: "u" }, violation_option: "violate", pass_choices: ["none"] }, thresholds: { block: 0.9, pass: 0.1 } };
}

describe("U-01 engine", () => {
  it("judge down → suspicious, never pass", () => {
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [...pair(abuse.question.sha, "a"), ...pair(mkt.question.sha, "m")], judgeOk: false }).state).toBe("suspicious");
  });
  it("confirmed low risk on all required → pass; single unconfirmed → suspicious (uncovered)", () => {
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [...pair(abuse.question.sha, "a"), ...pair(mkt.question.sha, "m"), ...G], judgeOk: true }).state).toBe("pass");
    const d = policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [ans(abuse.question.sha, "x", 0.02, "none"), ...pair(mkt.question.sha, "m")], judgeOk: true });
    expect(d.state).toBe("suspicious");
    expect(d.reason).toBe("uncovered:ABUSE");
  });
  it("rule with exception: block only when the exception was asked and is not_applies", () => {
    const hi = ans(abuseX.question.sha, "h", 0.99, "violate");
    expect(policy.decide({ bundle: BX, scene: "comment", hasImages: false, answers: [hi], judgeOk: true }).state).toBe("suspicious");
    const d = policy.decide({ bundle: BX, scene: "comment", hasImages: false, answers: [hi, ans(abuseX.exceptions[0]!.question.sha, "h", 0.01, "not_applies"), ...G], judgeOk: true });
    expect(d).toMatchObject({ state: "block", action: "takedown", hits: ["ABUSE-001"] });
    const applies = policy.decide({ bundle: BX, scene: "comment", hasImages: false, answers: [hi, ans(abuseX.exceptions[0]!.question.sha, "h", 0.9, "applies")], judgeOk: true });
    expect(applies.state).toBe("suspicious");
  });
  it("ABUSE-001 without an exception: a high abuse answer alone blocks (§2.2)", () => {
    const d = policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [ans(abuse.question.sha, "h", 0.99, "violate"), ...G], judgeOk: true });
    expect(d).toMatchObject({ state: "block", action: "takedown", hits: ["ABUSE-001"] });
  });
  it("marketing block → limit; images without image_check → suspicious", () => {
    const d = policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [ans(mkt.question.sha, "m", 0.95, "violate"), ...G], judgeOk: true });
    expect(d).toMatchObject({ state: "block", action: "limit" });
    const img = policy.decide({ bundle: B, scene: "comment", hasImages: true, answers: [...pair(abuse.question.sha, "a"), ...pair(mkt.question.sha, "m")], judgeOk: true });
    expect(img).toMatchObject({ reason: "image_unsupported", route: "human" });   // §2.2: a capability gap is a system cause
    const imgAnswers = [...pair(abuse.question.sha, "a"), ...pair(mkt.question.sha, "m"), ...pair(B.scenes.comment.imageCheck.question.sha, "i"), ...G];
    // round-9 item 6: an image_check answer without a delivered image never passes
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: true, answers: imgAnswers, judgeOk: true }).state).toBe("suspicious");
    const ok = policy.decide({ bundle: B, scene: "comment", hasImages: true, imageDelivered: true, answers: imgAnswers, judgeOk: true });
    expect(ok.state).toBe("pass");
  });
  it("contract runner: required fixture missing = fail, optional = skip", () => {
    const rec = new Map<string, policy.Recorded>([
      ["fx/a1-1", { scene: "comment", hasImages: false, judgeOk: true, answers: [ans(abuse.question.sha, "1", 0.99, "violate"), ...pair(mkt.question.sha, "m"), ...G] }],
      ["fx/a1-3", { scene: "comment", hasImages: false, judgeOk: true, answers: [...pair(abuse.question.sha, "a"), ...pair(mkt.question.sha, "m"), ...G] }],
      ["fx/a1-5", { scene: "comment", hasImages: false, judgeOk: true, answers: [...pair(abuse.question.sha, "a"), ...pair(mkt.question.sha, "m"), ans(guardQ.sha, "ga", 0.95, "violate"), ans(guardQ.sha, "gb", 0.9, "violate", "ga", 1)] }],   // c5: injection-like, guard flags it -> agent (§2.2)
      ["fx/m3-1", { scene: "comment", hasImages: false, judgeOk: true, answers: [ans(mkt.question.sha, "1", 0.95, "violate"), ...G] }],
      ["fx/m3-3", { scene: "comment", hasImages: false, judgeOk: true, answers: [...pair(abuse.question.sha, "a"), ...pair(mkt.question.sha, "m"), ...G] }],
    ]);
    const r = policy.runContract(B, loaded.contractTests, (ref) => rec.get(ref));
    expect(r.planned).toBe(7);
    expect(r.skipped).toEqual(["ABUSE-001/c4"]);
    expect(r.failed).toEqual([{ id: "ABUSE-001/c2", expected: "block", got: "fixture_missing" }]);
    expect(r.passed).toBe(5);
    expect(policy.contractPassed(r)).toBe(false);
  });
  it("injection guard (§2.2): flagged or missing turns an automatic pass or block into suspicious; never a violation by itself", () => {
    const passShape = [...pair(abuse.question.sha, "a"), ...pair(mkt.question.sha, "m")];
    const flagged = [ans(guardQ.sha, "ga", 0.92, "violate"), ans(guardQ.sha, "gb", 0.88, "violate", "ga", 1)];
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [...passShape, ...flagged], judgeOk: true })).toMatchObject({ state: "suspicious", reason: "injection_suspected" });
    const blockShape = [ans(abuse.question.sha, "h", 0.99, "violate")];
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [...blockShape, ...flagged], judgeOk: true })).toMatchObject({ state: "suspicious", reason: "injection_suspected", hits: ["ABUSE-001"] });
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: passShape, judgeOk: true })).toMatchObject({ state: "suspicious", reason: "judge_incomplete:injection_guard", route: "human" });
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [...passShape, ...G], judgeOk: true }).state).toBe("pass");
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [...passShape, ...flagged], judgeOk: true }).route).toBe("agent");
    // a flagged guard on content that is already suspicious changes nothing
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [ans(abuse.question.sha, "x", 0.5, "violate"), ...flagged], judgeOk: true }).reason).not.toBe("injection_suspected");
  });
  it("§2.2 where a suspicious item goes: the agent for content questions, a human for system causes", () => {
    const mid = [ans(abuse.question.sha, "ma", 0.5, "violate"), ans(abuse.question.sha, "mb", 0.5, "violate", "ma", 1), ...pair(mkt.question.sha, "m"), ...G];
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: mid, judgeOk: true })).toMatchObject({ state: "suspicious", route: "agent" });
    const uncal = [{ ...ans(abuse.question.sha, "ua", 0.02, "none"), p: null }, { ...ans(abuse.question.sha, "ub", 0.02, "none", "ua", 1), p: null }, ...pair(mkt.question.sha, "m"), ...G];
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: uncal, judgeOk: true })).toMatchObject({ state: "suspicious", reason: "calib_missing:ABUSE-001", route: "human" });
    const noMkt = [...pair(abuse.question.sha, "a"), ...G];
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: noMkt, judgeOk: true })).toMatchObject({ state: "suspicious", reason: "judge_incomplete:MARKETING-003", route: "human" });
    // a confident block does not wait for the other questions
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [ans(abuse.question.sha, "h", 0.99, "violate"), ...G], judgeOk: true }).state).toBe("block");
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [], judgeOk: false })).toMatchObject({ reason: "judge_unavailable", route: "human" });
  });
});

describe("U-11 shadow", () => {
  it("threshold-only vs semantic vs none; insufficient when a new question has no recorded answer", () => {
    expect(policy.classifyChange(abuseX, { ...abuseX, thresholds: { block: 0.95, pass: 0.1 } })).toBe("threshold_only");
    expect(policy.classifyChange(abuseX, { ...abuseX, question: { ...abuseX.question, sha: "other" } })).toBe("semantic");
    expect(policy.classifyChange(abuseX, { ...abuseX, exceptions: [] })).toBe("semantic");     // removing an exception is a semantic change
    expect(policy.classifyChange(abuseX, abuseX)).toBe("none");
    expect(policy.isInsufficient(abuseX, new Set([abuseX.question.sha]))).toBe(true);
    expect(policy.isInsufficient(abuseX, new Set([abuseX.question.sha, abuseX.exceptions[0]!.question.sha]))).toBe(false);
  });
});

describe("U-02 calibration", () => {
  it("temperature >1 softens, fit lowers NLL on overconfident data, ECE drops", () => {
    const soft = judges.applyTemperature({ a: 0.99, b: 0.01 }, 2);
    expect(soft["a"]).toBeLessThan(0.99);
    expect(soft["a"]! + soft["b"]!).toBeCloseTo(1);
    // overconfident judge: says 0.99 but is right only 80% of the time
    const samples: judges.Sample[] = [];
    for (let i = 0; i < 100; i++) samples.push({ probs: { a: 0.99, b: 0.01 }, label: i < 80 ? "a" : "b" });
    const fit = judges.fitTemperature(samples);
    expect(fit.T).toBeGreaterThan(1);
    expect(fit.nllAfter).toBeLessThan(fit.nllBefore);
    const before = judges.ece(samples);
    const after = judges.ece(samples.map((s) => ({ ...s, probs: judges.applyTemperature(s.probs, fit.T) })));
    expect(after).toBeLessThan(before);
  });
});

describe("U-08 / U-10 logprob judge", () => {
  const q = { instructions: "classify", criteria: { violate: "bad", none: "fine", unknown: "unsure" } };
  it("labels follow A–Z order; shuffle is deterministic per seed", () => {
    const p = judges.buildPrompt({ text: "x" }, q);
    expect(p.labels).toEqual({ violate: "A", none: "B", unknown: "C" });
    expect(p.messages[1]!.content).toContain("A. bad");
    const s1 = judges.buildPrompt({ text: "x" }, q, 17);
    const s2 = judges.buildPrompt({ text: "x" }, q, 17);
    expect(s1.order).toEqual(s2.order);
    expect(s1.order).not.toEqual(Object.keys(q.criteria));   // the confirmation copy must actually be reordered
    expect(judges.buildPrompt({}, { instructions: "", criteria: Object.fromEntries(Array.from({ length: 62 }, (_, i) => [`o${i}`, "x"])) }).labels["o61"]).toBe("9");
    expect(() => judges.buildPrompt({}, { instructions: "", criteria: Object.fromEntries(Array.from({ length: 63 }, (_, i) => [`o${i}`, "x"])) })).toThrow(/too many/);
  });
  it("parsing: all options must match (leading space stripped), low mass → abstain, non-label first token → abstain", () => {
    const labels = { violate: "A", none: "B", unknown: "C" };
    const ok = judges.parseTopLogprobs([{ token: " B", logprob: Math.log(0.7) }, { token: "A", logprob: Math.log(0.2) }, { token: "C", logprob: Math.log(0.05) }, { token: "B", logprob: Math.log(0.01) }], labels);
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") {
      expect(ok.probs["none"]).toBeCloseTo(0.7 / 0.95, 5);
      expect(ok.massCovered).toBeCloseTo(0.95, 5);
    }
    expect(judges.parseTopLogprobs([{ token: "B", logprob: Math.log(0.9) }, { token: "A", logprob: Math.log(0.05) }], labels)).toEqual({ status: "abstain", reason: "missing_option" });
    expect(judges.parseTopLogprobs([{ token: "A", logprob: Math.log(0.1) }, { token: "B", logprob: Math.log(0.1) }, { token: "C", logprob: Math.log(0.1) }], labels)).toEqual({ status: "abstain", reason: "low_mass" });
    expect(judges.parseTopLogprobs([{ token: "好的", logprob: Math.log(0.9) }], labels)).toEqual({ status: "abstain", reason: "no_label" });
  });
});

describe("confirmation copy is really reordered (seed 17 used to return the identity for every 3-option question)", () => {
  it("shuffleCriteria and the logprob prompt change the order for every seed 0..299 and 2..6 options", () => {
    for (let n = 2; n <= 6; n++) {
      const crit = Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, `t${i}`]));
      for (let seed = 0; seed < 300; seed++) {
        expect(Object.keys(judges.shuffleCriteria(crit, seed)), `n=${n} seed=${seed}`).not.toEqual(Object.keys(crit));
        expect(judges.buildPrompt({}, { instructions: "", criteria: crit }, seed).order, `prompt n=${n} seed=${seed}`).not.toEqual(Object.keys(crit));
      }
    }
    expect(judges.shuffleCriteria({ only: "x" }, 17)).toEqual({ only: "x" });
  });
  it("buildQuestions: readable wire keys, confirm copy reordered, every key maps back to its sha", () => {
    const b = judges.buildQuestions([abuseX.question, ...abuseX.exceptions.map((x) => x.question), mkt.question], true, 17);
    expect(Object.keys(b.questions)).toEqual(["ABUSE-001", "ABUSE-001#confirm", "ABUSE-001.EX-QUOTE", "ABUSE-001.EX-QUOTE#confirm", "MARKETING-003", "MARKETING-003#confirm"]);
    expect(b.toSha).toEqual({ "ABUSE-001": abuseX.question.sha, "ABUSE-001.EX-QUOTE": abuseX.exceptions[0]!.question.sha, "MARKETING-003": mkt.question.sha });
    expect(Object.keys(b.questions["ABUSE-001#confirm"]!.type === "choice" ? (b.questions["ABUSE-001#confirm"] as { criteria: Record<string, string> }).criteria : {})).not.toEqual(Object.keys(abuseX.question.criteria));
  });
  it("the judge sees the rule definition (with its exclusions), and the exception sees both texts", () => {
    expect(abuse.question.instructions).toContain("规则定义：");
    expect(abuse.question.instructions).toContain("不包括");
    expect(abuse.question.instructions).toContain("反偏见");                  // §2.2: anti-bias stays in the definition
    expect(abuseX.exceptions[0]!.question.instructions).toContain("例外定义：");
    expect(abuseX.exceptions[0]!.question.instructions).toContain("规则定义：");
  });
});

describe("§2.2 confirmation is a per-scene switch (dev plan 2026-10-08)", () => {
  it("on (default): one low answer is not enough to pass; off: it is; blocks are unaffected", () => {
    const one = [ans(abuse.question.sha, "x", 0.02, "none"), ans(mkt.question.sha, "y", 0.02, "none"), ans(guardQ.sha, "z", 0.02, "none")];
    expect(B.scenes.comment.confirmPass).toBeUndefined();                                  // the shipped config keeps the default (on)
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: one, judgeOk: true }).state).toBe("suspicious");
    const off = { ...B, scenes: { ...B.scenes, comment: { ...B.scenes.comment, confirmPass: false } } };
    expect(policy.decide({ bundle: off, scene: "comment", hasImages: false, answers: one, judgeOk: true }).state).toBe("pass");
    expect(policy.decide({ bundle: off, scene: "comment", hasImages: false, answers: [ans(abuse.question.sha, "h", 0.99, "violate"), ans(guardQ.sha, "z", 0.02, "none")], judgeOk: true }).state).toBe("block");
    expect(policy.sceneFromYaml({ required_categories: [], allowed_actions: ["pass"], pending_visibility: "hidden", deadline_ms: 1, human_sla_ms: 1, default_severity: 1,
      image_check: { thresholds: { block: 0.9, pass: 0.1 }, question: { id: "i", instructions: "i", options: { violate: "v", none: "n", unknown: "u" }, violation_option: "violate", pass_choices: ["none"] } }, confirm_pass: false } as never).confirmPass).toBe(false);
  });
});

describe("context_route scene switch (stage ② finding: the fast path cannot see context)", () => {
  const withRoute = (v: "pass" | "all" | undefined): PolicyBundle => ({ ...B, scenes: { ...B.scenes, comment: { ...B.scenes.comment, ...(v ? { contextRoute: v } : {}) } } });
  const low = [...pair(abuse.question.sha, "a"), ...pair(mkt.question.sha, "m"), ...G];
  const high = [ans(abuse.question.sha, "h", 0.99, "violate"), ...G];
  it("off (default): a reply is decided like any content", () => {
    expect(policy.decide({ bundle: withRoute(undefined), scene: "comment", hasImages: false, answers: low, judgeOk: true, hasContext: true }).state).toBe("pass");
  });
  it("pass: a reply is not auto-passed (needs_context, agent) but a clear block still blocks; no context -> unchanged", () => {
    expect(policy.decide({ bundle: withRoute("pass"), scene: "comment", hasImages: false, answers: low, judgeOk: true, hasContext: true })).toMatchObject({ state: "suspicious", reason: "needs_context", route: "agent" });
    expect(policy.decide({ bundle: withRoute("pass"), scene: "comment", hasImages: false, answers: high, judgeOk: true, hasContext: true })).toMatchObject({ state: "block", action: "takedown" });
    expect(policy.decide({ bundle: withRoute("pass"), scene: "comment", hasImages: false, answers: low, judgeOk: true, hasContext: false }).state).toBe("pass");
  });
  it("all: neither auto-passed nor auto-blocked; system causes still win (judge down -> human)", () => {
    expect(policy.decide({ bundle: withRoute("all"), scene: "comment", hasImages: false, answers: high, judgeOk: true, hasContext: true })).toMatchObject({ state: "suspicious", reason: "needs_context", route: "agent" });
    expect(policy.decide({ bundle: withRoute("all"), scene: "comment", hasImages: false, answers: low, judgeOk: false, hasContext: true })).toMatchObject({ reason: "judge_unavailable", route: "human" });
  });
});

describe("agent-stage thresholds (dev plan 2026-10-08 §3.1 problem 1, temporary)", () => {
  // ABUSE-001 has agent lines since rules@a056acc526cc; the tests set or strip them explicitly
  const withAgent = (a: { block: number; pass: number } | undefined): PolicyBundle => ({ ...B, rules: B.rules.map((r) => { if (r.ruleId !== "ABUSE-001") return r; const { agentThresholds: _drop, ...rest } = r; return a ? { ...rest, agentThresholds: a } : rest; }) });
  const mid = [ans(abuse.question.sha, "h1", 0.82, "violate"), ans(abuse.question.sha, "h2", 0.82, "violate", "h1", 1), ...pair(mkt.question.sha, "m"), ...G];
  const midLow = [ans(abuse.question.sha, "l1", 0.15, "none"), ans(abuse.question.sha, "l2", 0.15, "none", "l1", 1), ...pair(mkt.question.sha, "m"), ...G];
  it("YAML: optional, parsed, and pass must be below block", () => {
    const { agent_thresholds: _none, ...without } = yamlOf(abuse) as Record<string, unknown>;
    expect(policy.ruleFromYaml(without as Parameters<typeof policy.ruleFromYaml>[0]).agentThresholds).toBeUndefined();
    expect(abuse.agentThresholds).toEqual({ block: 0.7, pass: 0.15 });
    expect(policy.ruleFromYaml({ ...yamlOf(abuse), agent_thresholds: { block: 0.8, pass: 0.2 } }).agentThresholds).toEqual({ block: 0.8, pass: 0.2 });
    expect(() => policy.ruleFromYaml({ ...yamlOf(abuse), agent_thresholds: { block: 0.2, pass: 0.8 } })).toThrow(/agent pass threshold/);
  });
  it("only the agent stage uses them; the fast path and the default stage keep the rule's thresholds", () => {
    const b = withAgent({ block: 0.8, pass: 0.2 });
    const core = (s: "fast" | "agent" | undefined, answers: AnswerRecord[]) => [...coreAllowed({ bundle: b, scene: "comment", hasImages: false, answers, ...(s ? { stage: s } : {}) }).allowed];
    expect(core("agent", mid)).toEqual(["takedown"]);
    expect(core("fast", mid)).toEqual([]);
    expect(core(undefined, mid)).toEqual([]);
    expect(policy.decide({ bundle: b, scene: "comment", hasImages: false, answers: mid, judgeOk: true }).state).toBe("suspicious");
    expect(core("agent", midLow)).toEqual(["pass"]);
    expect(core("fast", midLow)).toEqual([]);
  });
  it("a rule without them: the agent stage behaves exactly like before", () => {
    const b = withAgent(undefined);
    expect([...coreAllowed({ bundle: b, scene: "comment", hasImages: false, answers: mid, stage: "agent" }).allowed]).toEqual([]);
  });
  it("shadow: changing only the agent lines is a threshold-only change", () => {
    expect(policy.classifyChange(abuse, { ...abuse, agentThresholds: { block: 0.8, pass: 0.2 } })).toBe("threshold_only");
  });
});

describe("parent missing (dev plan §3.1 problem 3, temporary)", () => {
  const low = [...pair(abuse.question.sha, "a"), ...pair(mkt.question.sha, "m"), ...G];
  const high = [ans(abuse.question.sha, "h", 0.99, "violate"), ...G];
  it("a would-be pass goes to the agent as parent_missing; a clear block still blocks; no flag -> unchanged", () => {
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: low, judgeOk: true, parentMissing: true })).toMatchObject({ state: "suspicious", reason: "parent_missing", route: "agent" });
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: high, judgeOk: true, parentMissing: true })).toMatchObject({ state: "block", action: "takedown" });
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: low, judgeOk: true, parentMissing: false }).state).toBe("pass");
  });
  it("allowedActions never offers pass while the parent is missing, at either stage", () => {
    for (const stage of ["fast", "agent"] as const) {
      expect([...coreAllowed({ bundle: B, scene: "comment", hasImages: false, answers: low, stage, parentMissing: true }).allowed]).toEqual([]);
      expect([...coreAllowed({ bundle: B, scene: "comment", hasImages: false, answers: low, stage }).allowed]).toEqual(["pass"]);
    }
  });
});

describe("rules-first judge layout", () => {
  const q = (key: string, criteria: Record<string, string>) => ({ key, sha: `sha-${key}`, instructions: `规则 ${key} 的全文`, criteria } as unknown as Parameters<typeof judges.buildQuestions>[0][number]);
  const asked = [q("ABUSE-001", { violate: "包含辱骂", none: "不包含", unknown: "无法判断" }), q("injection_guard", { violate: "是", none: "否", unknown: "无法判断" })];
  it("moves rule text and option descriptions to one rules block and keeps short questions with the copy's option order", () => {
    const built = judges.buildQuestions(asked, true).questions;
    const rf = judges.rulesFirst(built);
    expect(Object.keys(rf.rules)).toEqual(["ABUSE-001", "injection_guard"]);
    expect(rf.rules["ABUSE-001"]).toEqual({ instructions: "规则 ABUSE-001 的全文", options: { violate: "包含辱骂", none: "不包含", unknown: "无法判断" } });
    expect(Object.keys(rf.questions)).toEqual(Object.keys(built));
    const copy = rf.questions["ABUSE-001#confirm"] as { instructions: string; criteria: Record<string, string> };
    expect(Object.keys(copy.criteria)).toEqual(Object.keys((built["ABUSE-001#confirm"] as { criteria: Record<string, string> }).criteria));   // shuffled order kept
    expect(Object.values(copy.criteria).sort()).toEqual(["不违规", "无法判断", "违规"]);
    expect(copy.instructions).not.toContain("全文");
  });
  it("gives the same rules block for every item (the cacheable part) and rejects non-choice questions", () => {
    expect(JSON.stringify(judges.rulesFirst(judges.buildQuestions(asked, true).questions).rules)).toBe(JSON.stringify(judges.rulesFirst(judges.buildQuestions(asked, true, 99).questions).rules));
    expect(() => judges.rulesFirst({ x: { type: "score", criteria: ["a"] } as never })).toThrow(/choice/);
  });
});
