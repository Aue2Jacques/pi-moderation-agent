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
 *  two readings or unreadable slang, after the v4 pilot's disagreements (docs/policy/labeling-standard-v4.md §6). */
export const ABUSE_V41: Standard = { ...ABUSE_V4, id: "abuse-v4.1", ...load("label-abuse-v4.1.txt") };

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

export const STANDARDS: Record<string, Standard> = { [ABUSE_V4.id]: ABUSE_V4, [ABUSE_V41.id]: ABUSE_V41, [MARKETING_V1.id]: MARKETING_V1, [GUARD_V1.id]: GUARD_V1 };

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
