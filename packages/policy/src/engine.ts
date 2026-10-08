// Policy engine: judge answers → three states. Shares thresholds and ruleAllowed with core.allowedActions (docs §9.3).
import { allowedActions, type AnswerRecord, type PolicyBundle, type Scene } from "@mod/core";

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
  if (!i.judgeOk) return { state: "suspicious", action: null, hits: [], reason: "judge_unavailable" };
  const r = allowedActions({ bundle: i.bundle, scene: i.scene, hasImages: i.hasImages, imageDelivered: i.imageDelivered ?? false, answers: i.answers });
  const blocking = r.rules.filter((v) => v.blockSupport);
  if (blocking.length > 0) {
    const action = r.allowed.has("takedown") ? "takedown" : "limit";
    return { state: "block", action, hits: blocking.map((v) => v.ruleId), reason: "block_support" };
  }
  if (r.allowed.has("pass")) return { state: "pass", action: "pass", hits: [], reason: "all_required_covered_and_confirmed" };
  const missing = r.required.filter((c) => !r.covered[c]);
  return { state: "suspicious", action: null, hits: r.rules.filter((v) => v.suspicious).map((v) => v.ruleId), reason: missing.length ? `uncovered:${missing.join(",")}` : "suspicious_band" };
}
