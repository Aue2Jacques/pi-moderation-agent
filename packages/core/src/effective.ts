// Effective judge answer per question: docs/dev-doc-v1.md §5.4 step 1.
// Pure function over answer records; no DB access.

export type AnswerRecord = {
  judgeCallId: string;
  questionSha: string;
  choice: string;
  /** calibrated probability of the question's violation option; null when uncalibrated */
  p: number | null;
  /** sorted body_sha list of content-bearing evidence the call saw (never includes rule/judge evidence) */
  evidenceSet: readonly string[];
  inputSha: string;
  model: string;
  calibVer: string;
  confirmsCallId: string | null;
  createdAt: number;
};

export type EffectiveGroup = {
  kind: "group";
  evidenceSet: readonly string[];
  inconsistent: boolean;
  /**
   * mean p of the group's answers (only meaningful when !inconsistent). Same input, same model: the judge's answers
   * still differ by up to ~0.04 (50-run probe 2026-10-09), so a verdict must not depend on which copy happens to be latest.
   */
  p: number;
  choice: string;
  answers: readonly AnswerRecord[];
};

export type Effective = { kind: "none"; reason: "no_answers" | "no_unique_maximal" } | EffectiveGroup;

const key = (set: readonly string[]): string => [...set].sort().join("|");
const isSuperset = (a: readonly string[], b: readonly string[]): boolean => b.every((x) => a.includes(x));

/** Group trusted answers of one question by evidence set and select the unique maximal group. */
export function effectiveAnswer(answers: readonly AnswerRecord[]): Effective {
  const usable = answers.filter((a) => a.p !== null);
  if (usable.length === 0) return { kind: "none", reason: "no_answers" };
  const groups = new Map<string, AnswerRecord[]>();
  for (const a of usable) {
    const k = key(a.evidenceSet);
    const g = groups.get(k);
    if (g) g.push(a);
    else groups.set(k, [a]);
  }
  const sets = [...groups.values()].map((g) => g[0]!.evidenceSet);
  const maximal = sets.filter((s) => sets.every((t) => isSuperset(s, t)));
  if (maximal.length !== 1) return { kind: "none", reason: "no_unique_maximal" };
  const g = groups.get(key(maximal[0]!))!;
  const sorted = [...g].sort((a, b) => a.createdAt - b.createdAt);
  const latest = sorted[sorted.length - 1]!;
  const inconsistent = sorted.some((a) => a.choice !== latest.choice);
  const mean = sorted.reduce((acc, a) => acc + (a.p as number), 0) / sorted.length;
  return { kind: "group", evidenceSet: latest.evidenceSet, inconsistent, p: mean, choice: latest.choice, answers: sorted };
}

export type ActionCondition = (a: AnswerRecord) => boolean;

/**
 * confirmed(action): the group contains a pair (a, b) where b confirms a, both share input/question/model/calib,
 * and each satisfies the action's condition on its own (docs §5.4, round-8 item 1.2).
 */
export function isConfirmed(group: EffectiveGroup, satisfies: ActionCondition): boolean {
  const byId = new Map(group.answers.map((a) => [a.judgeCallId, a] as const));
  for (const b of group.answers) {
    if (!b.confirmsCallId) continue;
    const a = byId.get(b.confirmsCallId);
    if (!a) continue;
    if (a.inputSha !== b.inputSha || a.questionSha !== b.questionSha || a.model !== b.model || a.calibVer !== b.calibVer) continue;
    if (satisfies(a) && satisfies(b)) return true;
  }
  return false;
}
