// Policy engine: judge answers → three states. Shares thresholds and ruleAllowed with core.allowedActions (docs §9.3).
import { allowedActions, effectiveAnswer, questionKey, ruleAllowed, rulesFor, type AnswerRecord, type PolicyBundle, type Scene } from "@mod/core";

/** route (§2.2): where a suspicious item goes. "human" = a system cause the agent cannot fix by investigating
 *  (missing calibration, an unanswered required question, judge down); "agent" = the content needs a closer look. */
export type Decision = { state: "pass" | "block" | "suspicious"; action: "pass" | "limit" | "takedown" | null; hits: string[]; reason: string; route?: "agent" | "human" };

export type EngineInput = {
  bundle: PolicyBundle; scene: Scene; hasImages: boolean;
  /** an image was actually delivered to the judge (round-9 item 6); false in the text MVP */
  imageDelivered?: boolean;
  /** trusted answers from the fast-path call(s), already fingerprint-checked by core when recorded */
  answers: readonly AnswerRecord[];
  /** false when the judge timed out / errored / abstained → never pass */
  judgeOk: boolean;
};

export function decide(i: EngineInput): Decision {
  if (!i.judgeOk) return { state: "suspicious", action: null, hits: [], reason: "judge_unavailable", route: "human" };
  if (i.hasImages && !(i.imageDelivered ?? false)) return { state: "suspicious", action: null, hits: [], reason: "image_unsupported", route: "human" };
  const d = decideRules(i);
  // dev plan §2.2 (owner choice 2026-10-08): the fast-path injection guard. When the scene asks it, an automatic
  // decision (pass or block) needs a consistent, calibrated answer below the threshold; flagged -> the agent
  // (injection_suspected); missing or uncalibrated -> a system cause, to a human. Never a violation by itself.
  const guard = i.bundle.scenes[i.scene].injectionGuard;
  if (guard && (d.state === "pass" || d.state === "block")) {
    const got = i.answers.filter((a) => a.questionSha === guard.question.sha);
    if (got.length === 0) return { state: "suspicious", action: null, hits: d.hits, reason: `judge_incomplete:${questionKey(guard.question)}`, route: "human" };
    if (got.every((a) => a.p === null)) return { state: "suspicious", action: null, hits: d.hits, reason: `calib_missing:${questionKey(guard.question)}`, route: "human" };
    const e = effectiveAnswer(got);
    const clear = e.kind === "group" && !e.inconsistent && e.answers.every((a) => a.p !== null) && e.p < guard.threshold;
    if (!clear) return { state: "suspicious", action: null, hits: d.hits, reason: "injection_suspected", route: "agent" };
  }
  if (d.state !== "suspicious") return d;
  // §2.2: why is it suspicious? A required question with no answer, or no calibrated answer, is a system cause the
  // agent cannot fix (its own judge calls would be just as uncalibrated); anything else needs a closer look.
  const sys = systemCause(i);
  return sys ? { ...d, reason: sys, route: "human" } : { ...d, route: "agent" };
}

/** Every question the scene requires for an automatic pass (rule questions of the required categories and their
 *  exceptions) must have an answer, and at least one calibrated answer. */
function systemCause(i: EngineInput): string | undefined {
  const sc = i.bundle.scenes[i.scene];
  const required = rulesFor(i.bundle, i.scene).filter((r) => sc.requiredCategories.includes(r.category))
    .flatMap((r) => [r.question, ...r.exceptions.map((x) => x.question)]);
  for (const q of required) {
    const got = i.answers.filter((a) => a.questionSha === q.sha);
    if (got.length === 0) return `judge_incomplete:${questionKey(q)}`;
    if (got.every((a) => a.p === null)) return `calib_missing:${questionKey(q)}`;
  }
  return undefined;
}

function decideRules(i: EngineInput): Decision {
  if (!i.judgeOk) return { state: "suspicious", action: null, hits: [], reason: "judge_unavailable" };
  const r = allowedActions({ bundle: i.bundle, scene: i.scene, hasImages: i.hasImages, imageDelivered: i.imageDelivered ?? false, answers: i.answers });
  const blocking = r.rules.filter((v) => v.blockSupport);
  if (blocking.length > 0) {
    // several rules can block at once (dev plan R4): the heaviest action wins, and the ruling cites only the rules
    // that allow that action — a cited rule that does not allow it would fail the submit check on every retry.
    // The other hits are kept in the reason.
    const action = r.allowed.has("takedown") ? "takedown" : "limit";
    const rule = (id: string) => i.bundle.rules.find((x) => x.ruleId === id)!;
    const cited = blocking.filter((v) => ruleAllowed(rule(v.ruleId)).includes(action)).map((v) => v.ruleId);
    const also = blocking.map((v) => v.ruleId).filter((id) => !cited.includes(id));
    return { state: "block", action, hits: cited, reason: also.length ? `block_support; also_hit:${also.join(",")}` : "block_support" };
  }
  if (r.allowed.has("pass")) return { state: "pass", action: "pass", hits: [], reason: "all_required_covered_and_confirmed" };
  const missing = r.required.filter((c) => !r.covered[c]);
  return { state: "suspicious", action: null, hits: r.rules.filter((v) => v.suspicious).map((v) => v.ruleId), reason: missing.length ? `uncovered:${missing.join(",")}` : "suspicious_band" };
}
