// Policy engine: judge answers → three states. Shares thresholds and ruleAllowed with core.allowedActions (docs §9.3).
import { allowedActions, effectiveAnswer, ruleAllowed, type AnswerRecord, type PolicyBundle, type Scene } from "@mod/core";

export type Decision = { state: "pass" | "block" | "suspicious"; action: "pass" | "limit" | "takedown" | null; hits: string[]; reason: string };

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
  const d = decideRules(i);
  // dev plan §2.2 (owner choice 2026-10-08): the fast-path injection guard. When the scene asks it, an automatic
  // decision (pass or block) needs a consistent answer below the threshold; a flagged or missing guard answer sends the
  // item to the agent instead. It never makes anything a violation by itself.
  const guard = i.bundle.scenes[i.scene].injectionGuard;
  if (guard && (d.state === "pass" || d.state === "block")) {
    const e = effectiveAnswer(i.answers.filter((a) => a.questionSha === guard.question.sha));
    const clear = e.kind === "group" && !e.inconsistent && e.answers.every((a) => a.p !== null) && e.p < guard.threshold;
    if (!clear) {
      const flagged = e.kind === "group" && e.answers.some((a) => a.p !== null) && e.p >= guard.threshold;
      return { state: "suspicious", action: null, hits: d.hits, reason: flagged ? "injection_suspected" : "uncovered:injection_guard" };
    }
  }
  return d;
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
