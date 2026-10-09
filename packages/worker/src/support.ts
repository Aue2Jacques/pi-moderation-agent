// What a set of judge answers currently supports (dev plan 2026-10-08 §3: "the judge tool returns which dispositions it
// can support now and what is still missing", so the agent stops probing by submitting and being refused). Computed
// with the same functions the submit check uses (trustedAnswers + allowedActions), so it cannot drift from what a
// dispose will accept.
import * as core from "@mod/core";
import type { Action, Db, PolicyBundle, ReviewRow } from "@mod/core";

export type RuleSupport = {
  rule_id: string;
  /** calibrated probability of a violation from the latest answer; null when uncalibrated or not answered */
  p: number | null;
  state: "supports_action" | "supports_pass" | "middle_band" | "not_answered" | "inconsistent";
  missing: string | null;
};
export type Support = { allowed_now: Action[]; rules: RuleSupport[]; missing: string[] };

export function supportOf(db: Db, review: ReviewRow, bundle: PolicyBundle, judgeCallIds: readonly string[]): Support {
  const content = core.readContent(db, review.content_id)!;
  const scene = content.scene as core.Scene;
  const { answers, calls } = core.trustedAnswers(db, review, bundle, judgeCallIds, review.evidence_ver);
  // same rule as the submit check: delivered only when a cited call came from the image channel
  const r = core.allowedActions({ bundle, scene, hasImages: !!content.image_refs, imageDelivered: !!content.image_refs && calls.some((c) => c.api === "image" && c.status === "ok"), answers, stage: "agent" });
  const confirmPass = bundle.scenes[scene].confirmPass ?? true;
  const byRule = new Map(core.rulesFor(bundle, scene).map((x) => [x.ruleId, x] as const));
  const rules: RuleSupport[] = r.rules.map((v) => {
    const rule = byRule.get(v.ruleId)!;
    const e = v.effective;
    if (e.kind !== "group") return { rule_id: v.ruleId, p: null, state: "not_answered", missing: "没有可用的判官答案（判官失败或该题没有校准），需要补判；补不到就转人工" };
    const last = e.answers[e.answers.length - 1]!;
    if (e.inconsistent) return { rule_id: v.ruleId, p: last.p, state: "inconsistent", missing: "同一证据上的主问和复问不一致，需要能改变判断的新证据" };
    if (v.blockSupport) return { rule_id: v.ruleId, p: e.p, state: "supports_action", missing: null };
    if (v.passSupport) return { rule_id: v.ruleId, p: e.p, state: "supports_pass", missing: null };
    const t = rule.agentThresholds ?? rule.thresholds;   // the agent's dispose is checked against its own lines
    const lowEnough = last.p !== null && last.p < t.pass;
    const highEnough = e.p >= t.block;
    const missing = lowEnough && confirmPass
      ? "概率已低于放行线，放行还缺：用 confirm 对同一证据复问一次"
      : highEnough
        ? `概率已达处置线，但例外未确认不成立（${Object.entries(v.exceptions).filter(([, s]) => s !== "not_applies").map(([k]) => k).join("、") || "—"}）`
        : `违规概率 ${e.p.toFixed(2)} 在中间带（放行线 <${t.pass}，处置线 ≥${t.block}），需要能改变判断的新证据`;
    return { rule_id: v.ruleId, p: e.p, state: "middle_band", missing };
  });
  const missing = [
    ...rules.filter((x) => x.missing).map((x) => `${x.rule_id}：${x.missing}`),
    ...r.required.filter((c) => !r.covered[c] && c === "image_check").map(() => "内容带图片，没有图片通道，不能自动放行"),
  ];
  return { allowed_now: [...r.allowed], rules, missing };
}
