// Shadow replay classification (docs §10): threshold-only changes reuse old answers; semantic changes must re-judge.
import type { Rule } from "@mod/core";

export type ChangeKind = "threshold_only" | "semantic" | "none";

export function classifyChange(oldRule: Rule, newRule: Rule): ChangeKind {
  const semantic =
    oldRule.question.sha !== newRule.question.sha ||
    oldRule.exceptions.length !== newRule.exceptions.length ||
    oldRule.exceptions.some((x, i) => x.id !== newRule.exceptions[i]?.id || x.question.sha !== newRule.exceptions[i]?.question.sha);
  if (semantic) return "semantic";
  const thresholdOnly =
    oldRule.thresholds.block !== newRule.thresholds.block || oldRule.thresholds.pass !== newRule.thresholds.pass ||
    oldRule.defaultAction !== newRule.defaultAction || oldRule.scenes.join() !== newRule.scenes.join() || oldRule.severity !== newRule.severity;
  return thresholdOnly ? "threshold_only" : "none";
}

/** A shadow sample is `insufficient` when the new rule asks a question the recorded answers never contained. */
export function isInsufficient(newRule: Rule, recordedQuestionShas: ReadonlySet<string>): boolean {
  if (!recordedQuestionShas.has(newRule.question.sha)) return true;
  return newRule.exceptions.some((x) => !recordedQuestionShas.has(x.question.sha));
}
