// allowedActions: docs/dev-doc-v1.md §5.4 step 2. Pure.
import { effectiveAnswer, isConfirmed, type AnswerRecord, type Effective } from "./effective.ts";
import type { Action, PolicyBundle, Question, Rule, Scene } from "./types.ts";
import { rulesFor } from "./types.ts";

export type AllowedInput = {
  bundle: PolicyBundle;
  scene: Scene;
  hasImages: boolean;
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

function verdictFor(ruleId: string, q: Question, thresholds: { block: number; pass: number }, exceptions: Rule["exceptions"], answers: readonly AnswerRecord[], out: Record<string, string[]>): RuleVerdict {
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
      passSupport = isConfirmed(e, passOk);
    }
  }
  const suspicious = e.kind === "group" && !passSupport && !blockSupport;
  return { ruleId, effective: e, blockSupport, passSupport, suspicious, exceptions: exc };
}

export function allowedActions(input: AllowedInput): AllowedResult {
  const { bundle, scene, hasImages, answers } = input;
  const sceneCfg = bundle.scenes[scene];
  const effectiveAnswers: Record<string, string[]> = {};
  const rules = rulesFor(bundle, scene).map((r) => verdictFor(r.ruleId, r.question, r.thresholds, r.exceptions, answers, effectiveAnswers));
  const byRule = new Map(rulesFor(bundle, scene).map((r) => [r.ruleId, r] as const));

  const required = [...sceneCfg.requiredCategories];
  if (hasImages) required.push("image_check");

  const covered: Record<string, boolean> = {};
  for (const c of required) {
    if (c === "image_check") {
      const v = verdictFor("image_check", sceneCfg.imageCheck.question, sceneCfg.imageCheck.thresholds, [], answers, effectiveAnswers);
      covered[c] = v.passSupport;
    } else {
      const rs = rules.filter((v) => byRule.get(v.ruleId)?.category === c);
      covered[c] = rs.length > 0 && rs.every((v) => v.passSupport);
    }
  }

  const allowed = new Set<Action>();
  const blocking = rules.filter((v) => v.blockSupport);
  for (const v of blocking) allowed.add(byRule.get(v.ruleId)!.defaultAction);
  if (blocking.length === 0 && required.every((c) => covered[c])) allowed.add("pass");
  return { allowed, rules, covered, required, effectiveAnswers };
}
