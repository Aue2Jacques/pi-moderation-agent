// Platform labeling standards (dev plan 2026-10-08 §0.1 decision 2): one standard per runtime question — ABUSE-001,
// MARKETING-003, the injection guard. A model answers the standard's fact questions with 是 / 否 / 不确定; the label is
// computed here by a fixed table into violate / allow / uncertain — "uncertain" is kept, never folded into allow.
// These are model-assisted labels: two models' agreement is a consensus label, not an independent human gold standard.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../../packages/core/src/index.ts";

export type Answer = "是" | "否" | "不确定";
export type Label = "violate" | "allow" | "uncertain";
export type Standard = { id: string; prompt: string; promptSha: string; questions: readonly string[]; label: (a: Record<string, Answer>) => Label };

const load = (file: string): { prompt: string; promptSha: string } => {
  const prompt = readFileSync(join(import.meta.dirname, "..", "..", "rules", "prompts", file), "utf8");
  return { prompt, promptSha: sha256(prompt).slice(0, 12) };
};
const yes = (a: Record<string, Answer>, q: string) => a[q] === "是";
const unsure = (a: Record<string, Answer>, q: string) => a[q] === "不确定";

/** ABUSE-001 (label-abuse-v4): any of q1–q6 "是" is a hit; q7 "是" clears only when EVERY hit is quoted to refute or
 *  negated (a mixed text with one own attack stays a violation); no hit but some "不确定" -> uncertain. */
export const ABUSE_V4: Standard = {
  id: "abuse-v4", ...load("label-abuse-v4.txt"), questions: ["q1", "q2", "q3", "q4", "q5", "q6", "q7"],
  label: (a) => {
    const hits = ["q1", "q2", "q3", "q4", "q5", "q6"].filter((q) => yes(a, q));
    if (hits.length) return yes(a, "q7") ? "allow" : unsure(a, "q7") ? "uncertain" : "violate";
    return ["q1", "q2", "q3", "q4", "q5", "q6"].some((q) => unsure(a, q)) ? "uncertain" : "allow";
  },
};

/** ABUSE-001 v4.1: same questions and label table as v4; q4 / q5 / q6 reworded to surface tests and "不确定" limited to
 *  two readings or unreadable slang, after the v4 pilot's disagreements (docs/policy/labeling-standard-v4.md §5). */
export const ABUSE_V41: Standard = { ...ABUSE_V4, id: "abuse-v4.1", ...load("label-abuse-v4.1.txt") };

/** ABUSE-001 v4.2: v4 plus "decode homophones / abbreviations first" and a short glossary of slurs (examples from the
 *  ToxiCN lexicon), after reading the v4 disagreements: qwen missed homophone profanity, deepseek missed group slurs
 *  (docs/policy/labeling-standard-v4.md §6). v4.1's rewording is not carried over. */
export const ABUSE_V42: Standard = { ...ABUSE_V4, id: "abuse-v4.2", ...load("label-abuse-v4.2.txt") };

/** MARKETING-003 (label-marketing-v1): contact / off-platform lead (m1) or black-market / fraud (m3) -> violate;
 *  selling or soliciting (m2) -> violate unless it is also called a natural recommendation (m4), which contradicts it
 *  -> uncertain; otherwise any "不确定" on m1–m3 -> uncertain; else allow. */
export const MARKETING_V1: Standard = {
  id: "marketing-v1", ...load("label-marketing-v1.txt"), questions: ["m1", "m2", "m3", "m4"],
  label: (a) => {
    if (yes(a, "m1") || yes(a, "m3")) return "violate";
    if (yes(a, "m2")) return yes(a, "m4") ? "uncertain" : "violate";
    return ["m1", "m2", "m3"].some((q) => unsure(a, q)) ? "uncertain" : "allow";
  },
};

/** Injection guard (label-guard-v1): "violate" here means the guard SHOULD fire (text addressed to the moderation
 *  system), not that the content breaks a rule. */
export const GUARD_V1: Standard = {
  id: "guard-v1", ...load("label-guard-v1.txt"), questions: ["g1"],
  label: (a) => (yes(a, "g1") ? "violate" : unsure(a, "g1") ? "uncertain" : "allow"),
};

export const STANDARDS: Record<string, Standard> = { [ABUSE_V4.id]: ABUSE_V4, [ABUSE_V41.id]: ABUSE_V41, [ABUSE_V42.id]: ABUSE_V42, [MARKETING_V1.id]: MARKETING_V1, [GUARD_V1.id]: GUARD_V1 };

/** Read a model's JSON answer for a standard: the questions it answered and the ones it left out; undefined when there
 *  is no JSON object or any answer is not one of 是 / 否 / 不确定. */
export function readAnswers(std: Standard, raw: string): { got: Record<string, Answer>; missing: string[] } | undefined {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return undefined;
  let o: Record<string, unknown>;
  try { o = JSON.parse(m[0]) as Record<string, unknown>; } catch { return undefined; }
  const got: Record<string, Answer> = {}, missing: string[] = [];
  for (const q of std.questions) {
    const v = o[q];
    if (v === undefined) { missing.push(q); continue; }
    if (v !== "是" && v !== "否" && v !== "不确定") return undefined;
    got[q] = v;
  }
  return { got, missing };
}

/** Parse a complete answer; undefined when any question is missing or invalid. */
export function parseAnswers(std: Standard, raw: string): Record<string, Answer> | undefined {
  const r = readAnswers(std, raw);
  return r && r.missing.length === 0 ? r.got : undefined;
}

/** The follow-up turn asking only for the questions a model left out (seen with qwen3.8-flash omitting q7). */
export const followUpFor = (missing: string[]): string =>
  `你漏答了 ${missing.join("、")}。请按上面的题目补答，只输出一个 JSON，只含这几个键：{${missing.map((q) => `"${q}":"是|否|不确定"`).join(",")}}`;

/** One labeler's label over repeated answers: the label more than half of them give; otherwise uncertain. */
export function majority(labels: readonly Label[]): Label {
  const c = new Map<Label, number>();
  for (const l of labels) c.set(l, (c.get(l) ?? 0) + 1);
  const top = [...c].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] * 2 > labels.length ? top[0] : "uncertain";
}

/** Frozen labeling setup (owner, 2026-10-08): ABUSE-001 is labeled with abuse-v4.2; each of the two labeling models
 *  answers 3 times and keeps its majority; where the two disagree, gemini-3.8-flash (also 3 answers, majority) casts a
 *  third vote; what is still split goes to the owner. Changing the prompt makes a new version, never this one. */
export const FROZEN_ABUSE = {
  standard: "abuse-v4.2", promptSha: "64910d875ddd", votesPerModel: 3,
  models: ["deepseek-v4.1-flash", "qwen3.8-flash"], tiebreak: "gemini-3.8-flash",
} as const;

export type Final = { label?: Label; source: "consensus" | "tiebreak" | "owner" | "needs_tiebreak" };

/** Final label from the two models' voted labels and, when they differ, the tie-break model's voted label:
 *  same label -> consensus; tie-break equal to one side -> that label; otherwise the owner decides (uncertain until then). */
export function finalLabel(a: Label, b: Label, tie?: Label): Final {
  if (a === b) return { label: a, source: "consensus" };
  if (tie === undefined) return { source: "needs_tiebreak" };
  if (tie === a || tie === b) return { label: tie, source: "tiebreak" };
  return { label: "uncertain", source: "owner" };
}
