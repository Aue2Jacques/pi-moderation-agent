// allowedActions: docs/dev-doc-v1.md §5.4 step 2. Pure.
import { effectiveAnswer, isConfirmed, type AnswerRecord, type Effective, type EffectiveGroup } from "./effective.ts";
import type { Action, PolicyBundle, Question, Rule, Scene } from "./types.ts";
import { rulesFor } from "./types.ts";

export type AllowedInput = {
  bundle: PolicyBundle;
  scene: Scene;
  hasImages: boolean;
  /** true only when an image was actually delivered to the judge for this review (round-9 item 6). No image channel exists in the text MVP, so callers pass false and image content can never be auto-passed. */
  imageDelivered?: boolean;
  /** trusted answers (status ok, input_sha verified, question known); grouping by question happens here */
  answers: readonly AnswerRecord[];
};

export type RuleVerdict = {
  ruleId: string;
  effective: Effective;
  blockSupport: boolean;
  passSupport: boolean;
  suspicious: boolean;
  exceptions: Record<string, "applies" | "not_applies" | "unknown">;
};

export type AllowedResult = {
  allowed: Set<Action>;
  rules: RuleVerdict[];
  covered: Record<string, boolean>;
  required: string[];
  /** per question_sha: judge_call ids of the effective group (for ruling.effective_answers) */
  effectiveAnswers: Record<string, string[]>;
};

function byQuestion(answers: readonly AnswerRecord[], sha: string): AnswerRecord[] {
  return answers.filter((a) => a.questionSha === sha);
}

function exceptionVerdict(q: Question, answers: readonly AnswerRecord[]): "applies" | "not_applies" | "unknown" {
  const e = effectiveAnswer(byQuestion(answers, q.sha));
  if (e.kind !== "group" || e.inconsistent) return "unknown";
  if (q.appliesChoice && e.choice === q.appliesChoice) return "applies";
  if (q.notAppliesChoice && e.choice === q.notAppliesChoice) return "not_applies";
  return "unknown";
}

function verdictFor(ruleId: string, q: Question, thresholds: { block: number; pass: number }, exceptions: Rule["exceptions"], answers: readonly AnswerRecord[], out: Record<string, string[]>, confirmPass = true): RuleVerdict {
  const e = effectiveAnswer(byQuestion(answers, q.sha));
  const exc: RuleVerdict["exceptions"] = {};
  for (const x of exceptions) exc[x.id] = exceptionVerdict(x.question, answers);
  let blockSupport = false;
  let passSupport = false;
  if (e.kind === "group") {
    out[q.sha] = e.answers.map((a) => a.judgeCallId);
    const passOk = (a: AnswerRecord): boolean => a.p !== null && a.p < thresholds.pass && q.passChoices.includes(a.choice);
    if (!e.inconsistent) {
      blockSupport = e.p >= thresholds.block && Object.values(exc).every((v) => v === "not_applies");
      // round-9 item 15: a confirmed low-risk pair is revoked by any later answer on the same evidence that does not
      // itself satisfy pass (e.g. same choice, p=0.40). Only the pairs after the last such doubt count.
      const lastDoubt = Math.max(-Infinity, ...e.answers.filter((a) => !passOk(a)).map((a) => a.createdAt));
      const afterDoubt: EffectiveGroup = { ...e, answers: e.answers.filter((a) => a.createdAt > lastDoubt) };
      // §2.2 (owner 2026-10-07: measure with and without): confirmation is a per-scene policy switch, on by default
      passSupport = passOk(e.answers[e.answers.length - 1]!) && (!confirmPass || isConfirmed(afterDoubt, passOk));
    }
  }
  const suspicious = e.kind === "group" && !passSupport && !blockSupport;
  return { ruleId, effective: e, blockSupport, passSupport, suspicious, exceptions: exc };
}

export function allowedActions(input: AllowedInput): AllowedResult {
  const { bundle, scene, hasImages, answers } = input;
  const imageDelivered = input.imageDelivered ?? false;
  const sceneCfg = bundle.scenes[scene];
  const effectiveAnswers: Record<string, string[]> = {};
  const confirmPass = sceneCfg.confirmPass ?? true;
  const rules = rulesFor(bundle, scene).map((r) => verdictFor(r.ruleId, r.question, r.thresholds, r.exceptions, answers, effectiveAnswers, confirmPass));
  const byRule = new Map(rulesFor(bundle, scene).map((r) => [r.ruleId, r] as const));

  const required = [...sceneCfg.requiredCategories];
  if (hasImages) required.push("image_check");

  const covered: Record<string, boolean> = {};
  for (const c of required) {
    if (c === "image_check") {
      const v = verdictFor("image_check", sceneCfg.imageCheck.question, sceneCfg.imageCheck.thresholds, [], answers, effectiveAnswers, confirmPass);
      covered[c] = imageDelivered && v.passSupport;   // an image_check answer without a delivered image is not coverage
    } else {
      const rs = rules.filter((v) => byRule.get(v.ruleId)?.category === c);
      covered[c] = rs.length > 0 && rs.every((v) => v.passSupport);
    }
  }

  const allowed = new Set<Action>();
  const blocking = rules.filter((v) => v.blockSupport);
  // stage-1 review fix 2: several blocking rules -> only the heaviest action is allowed (takedown > limit), for the
  // agent's submit check exactly as for the fast path; a lighter action citing a lighter rule is no longer accepted
  const RANK: Record<Action, number> = { pass: 0, limit: 1, takedown: 2 };
  const heaviest = blocking.map((v) => byRule.get(v.ruleId)!.defaultAction).sort((a, b) => RANK[b] - RANK[a])[0];
  if (heaviest) allowed.add(heaviest);
  if (blocking.length === 0 && required.every((c) => covered[c])) allowed.add("pass");
  return { allowed, rules, covered, required, effectiveAnswers };
}
