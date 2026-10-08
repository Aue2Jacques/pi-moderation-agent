// U-01 engine, U-02 calib, U-07 rules YAML, U-08 prompt labels, U-10 logprob parsing, U-11 shadow
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import type { AnswerRecord, Rule } from "../../packages/core/src/index.ts";
import * as policy from "../../packages/policy/src/index.ts";
import * as judges from "../../packages/judges/src/index.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const loaded = policy.loadBundle(join(ROOT, "rules"), join(ROOT, "config", "scenes.yaml"));
const B = loaded.bundle;
const abuse = B.rules.find((r) => r.ruleId === "ABUSE-001")!;
const mkt = B.rules.find((r) => r.ruleId === "MARKETING-003")!;

const ans = (sha: string, id: string, p: number, choice: string, confirms?: string, at = 0): AnswerRecord => ({
  judgeCallId: id, questionSha: sha, choice, p, evidenceSet: [], inputSha: "in", model: "m", calibVer: "c", confirmsCallId: confirms ?? null, createdAt: at,
});
const pair = (sha: string, prefix: string, p = 0.02): AnswerRecord[] => [ans(sha, `${prefix}a`, p, "none"), ans(sha, `${prefix}b`, p, "none", `${prefix}a`, 1)];

describe("U-07 rules YAML", () => {
  it("loads the bundle, derives question shas, versions rules+scenes together", () => {
    expect(B.rules.map((r) => r.ruleId)).toEqual(["ABUSE-001", "MARKETING-003"]);
    expect(abuse.exceptions[0]!.question.appliesChoice).toBe("applies");
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
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [...pair(abuse.question.sha, "a"), ...pair(mkt.question.sha, "m")], judgeOk: true }).state).toBe("pass");
    const d = policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [ans(abuse.question.sha, "x", 0.02, "none"), ...pair(mkt.question.sha, "m")], judgeOk: true });
    expect(d.state).toBe("suspicious");
    expect(d.reason).toBe("uncovered:ABUSE");
  });
  it("rule with exception: block only when the exception was asked and is not_applies", () => {
    const hi = ans(abuse.question.sha, "h", 0.99, "violate");
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [hi], judgeOk: true }).state).toBe("suspicious");
    const d = policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [hi, ans(abuse.exceptions[0]!.question.sha, "h", 0.01, "not_applies")], judgeOk: true });
    expect(d).toMatchObject({ state: "block", action: "takedown", hits: ["ABUSE-001"] });
    const applies = policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [hi, ans(abuse.exceptions[0]!.question.sha, "h", 0.9, "applies")], judgeOk: true });
    expect(applies.state).toBe("suspicious");
  });
  it("marketing block → limit; images without image_check → suspicious", () => {
    const d = policy.decide({ bundle: B, scene: "comment", hasImages: false, answers: [ans(mkt.question.sha, "m", 0.95, "violate")], judgeOk: true });
    expect(d).toMatchObject({ state: "block", action: "limit" });
    const img = policy.decide({ bundle: B, scene: "comment", hasImages: true, answers: [...pair(abuse.question.sha, "a"), ...pair(mkt.question.sha, "m")], judgeOk: true });
    expect(img.reason).toBe("uncovered:image_check");
    const imgAnswers = [...pair(abuse.question.sha, "a"), ...pair(mkt.question.sha, "m"), ...pair(B.scenes.comment.imageCheck.question.sha, "i")];
    // round-9 item 6: an image_check answer without a delivered image never passes
    expect(policy.decide({ bundle: B, scene: "comment", hasImages: true, answers: imgAnswers, judgeOk: true }).state).toBe("suspicious");
    const ok = policy.decide({ bundle: B, scene: "comment", hasImages: true, imageDelivered: true, answers: imgAnswers, judgeOk: true });
    expect(ok.state).toBe("pass");
  });
  it("contract runner: required fixture missing = fail, optional = skip", () => {
    const rec = new Map<string, policy.Recorded>([
      ["fx/a1-1", { scene: "comment", hasImages: false, judgeOk: true, answers: [ans(abuse.question.sha, "1", 0.99, "violate"), ans(abuse.exceptions[0]!.question.sha, "1", 0.01, "not_applies"), ...pair(mkt.question.sha, "m")] }],
      ["fx/a1-3", { scene: "comment", hasImages: false, judgeOk: true, answers: [...pair(abuse.question.sha, "a"), ...pair(mkt.question.sha, "m")] }],
      ["fx/a1-5", { scene: "comment", hasImages: false, judgeOk: true, answers: [ans(abuse.question.sha, "1", 0.5, "violate")] }],
      ["fx/m3-1", { scene: "comment", hasImages: false, judgeOk: true, answers: [ans(mkt.question.sha, "1", 0.95, "violate")] }],
      ["fx/m3-3", { scene: "comment", hasImages: false, judgeOk: true, answers: [...pair(abuse.question.sha, "a"), ...pair(mkt.question.sha, "m")] }],
    ]);
    const r = policy.runContract(B, loaded.contractTests, (ref) => rec.get(ref));
    expect(r.planned).toBe(7);
    expect(r.skipped).toEqual(["ABUSE-001/c4"]);
    expect(r.failed).toEqual([{ id: "ABUSE-001/c2", expected: "block", got: "fixture_missing" }]);
    expect(r.passed).toBe(5);
    expect(policy.contractPassed(r)).toBe(false);
  });
});

describe("U-11 shadow", () => {
  it("threshold-only vs semantic vs none; insufficient when a new question has no recorded answer", () => {
    expect(policy.classifyChange(abuse, { ...abuse, thresholds: { block: 0.95, pass: 0.1 } })).toBe("threshold_only");
    expect(policy.classifyChange(abuse, { ...abuse, question: { ...abuse.question, sha: "other" } })).toBe("semantic");
    expect(policy.classifyChange(abuse, { ...abuse, exceptions: [] })).toBe("semantic");
    expect(policy.classifyChange(abuse, abuse)).toBe("none");
    expect(policy.isInsufficient(abuse, new Set([abuse.question.sha]))).toBe(true);
    expect(policy.isInsufficient(abuse, new Set([abuse.question.sha, abuse.exceptions[0]!.question.sha]))).toBe(false);
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
    const b = judges.buildQuestions([abuse.question, ...abuse.exceptions.map((x) => x.question), mkt.question], true, 17);
    expect(Object.keys(b.questions)).toEqual(["ABUSE-001", "ABUSE-001#confirm", "ABUSE-001.EX-QUOTE", "ABUSE-001.EX-QUOTE#confirm", "MARKETING-003", "MARKETING-003#confirm"]);
    expect(b.toSha).toEqual({ "ABUSE-001": abuse.question.sha, "ABUSE-001.EX-QUOTE": abuse.exceptions[0]!.question.sha, "MARKETING-003": mkt.question.sha });
    expect(Object.keys(b.questions["ABUSE-001#confirm"]!.type === "choice" ? (b.questions["ABUSE-001#confirm"] as { criteria: Record<string, string> }).criteria : {})).not.toEqual(Object.keys(abuse.question.criteria));
  });
  it("the judge sees the rule definition (with its exclusions), and the exception sees both texts", () => {
    expect(abuse.question.instructions).toContain("规则定义：");
    expect(abuse.question.instructions).toContain("不包括");
    expect(abuse.exceptions[0]!.question.instructions).toContain("例外定义：");
    expect(abuse.exceptions[0]!.question.instructions).toContain("规则定义：");
  });
});
