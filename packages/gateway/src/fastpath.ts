// Fast path (docs §9.3, S1/S2/S2'): preprocess → one judge call with every applicable question (original + confirm copy)
// → policy engine → fastDispose / createSuspiciousReview. Judge failure never passes (fail-closed).
import * as core from "@mod/core";
import type { Db, PolicyBundle, PriceTable, Scene } from "@mod/core";
import { decide, type Decision } from "@mod/policy";
import type { JudgeClient } from "@mod/worker";
import { preprocess, type Blacklist, type RateLimit, type SimhashIndex } from "./preprocess.ts";

export type FastpathDeps = {
  db: Db; bundle: PolicyBundle; judge: JudgeClient; prices: PriceTable;
  pins: core.Pins; judgeModel: string; calibrator: core.Calibrator;
  blacklist: Blacklist; index: SimhashIndex; rate: RateLimit;
  backpressure: () => { agentFull: boolean };
  budgetTools: number; budgetMicro: number;
  now: () => number;
};

export type FastpathOutcome = { contentId: string; decision: Decision["state"] | "judge_down" | "backpressure" | "preprocess_error" | "image_unsupported" | "fastpath_error" | "calib_missing" | "judge_incomplete"; reviewId: string; latencyMs: number; judgeStatus: string; blacklistHits: number; nearDup: number };

/** Route an item straight to the human queue with a reason (G direct release), recording the judge calls made so far. */
export function toHuman(deps: FastpathDeps, contentId: string, reason: core.ReleaseReason, judgeCallIds: string[] = []): core.ReviewRow {
  const sceneCfg = deps.bundle.scenes[core.readContent(deps.db, contentId)!.scene as Scene];
  return core.createSuspiciousReview(deps.db, {
    contentId, pins: deps.pins, judgeModel: deps.judgeModel, judgeCallIds, pendingVisibility: sceneCfg.pendingVisibility, deadlineMs: sceneCfg.deadlineMs,
    budgetTools: deps.budgetTools, budgetMicro: deps.budgetMicro, direct: { reason, severity: sceneCfg.defaultSeverity, humanSlaMs: sceneCfg.humanSlaMs },
  }, deps.now()).review;
}

export async function runFastpath(deps: FastpathDeps, contentId: string): Promise<FastpathOutcome> {
  const t0 = deps.now();
  const content = core.readContent(deps.db, contentId);
  if (!content) throw new core.CoreError("E_REVIEW_NOT_FOUND", contentId);
  const scene = content.scene as Scene;
  const sceneCfg = deps.bundle.scenes[scene];
  const direct = (reason: core.ReleaseReason, judgeCallIds: string[] = []) => toHuman(deps, contentId, reason, judgeCallIds);

  // preprocessing
  let pre: ReturnType<typeof preprocess>;
  try {
    pre = preprocess(content.text ?? "", content.account_id, deps.now(), deps, contentId);
    core.tx(deps.db, () => deps.db.prepare("UPDATE intake SET status='preprocessed', updated_at=? WHERE content_id=? AND status='received'").run(deps.now(), contentId));
  } catch {
    const r = direct("preprocess_error");
    return { contentId, decision: "preprocess_error", reviewId: r.review_id, latencyMs: deps.now() - t0, judgeStatus: "skipped", blacklistHits: 0, nearDup: 0 };
  }

  // round-9 item 6: the text MVP has no image channel to the judge. Content with images is never auto-disposed and never
  // gets an image_check question it cannot answer: straight to human with its own reason, zero judge calls.
  const hasImages = !!content.image_refs && (JSON.parse(content.image_refs) as unknown[]).length > 0;
  if (hasImages) {
    const r = direct("image_unsupported");
    return { contentId, decision: "image_unsupported", reviewId: r.review_id, latencyMs: deps.now() - t0, judgeStatus: "skipped", blacklistHits: pre.blacklistHits.length, nearDup: pre.nearDuplicates.length };
  }
  // one judge call: every applicable rule question + its exceptions
  const rules = core.rulesFor(deps.bundle, scene);
  const guard = deps.bundle.scenes[scene].injectionGuard;
  const questions = [...rules.flatMap((r) => [r.question, ...r.exceptions.map((x) => x.question)]), ...(guard ? [guard.question] : [])];
  // E5: the judge sees the model view (placeholders for links, emails, mentions, contact numbers); content.text stays the source
  const request = { contentId, text: content.text === null ? null : core.modelView(content.text), scene, evidence: [], questions };
  const requestSha = core.requestDigest(deps.judge, request);
  const res = await deps.judge.classify(request);
  const inputSha = core.inputFingerprint(content.text_sha, scene, [], deps.pins.evidenceVer);
  const judgeCallIds: string[] = [];
  const record = (id: string, answers: Record<string, { choice: string; probs: Record<string, number> }>, confirms?: { id: string; seed: number }) => {
    core.recordJudgeCall(deps.db, {
      judgeCallId: id, reviewId: null, contentId, attempt: null, provider: deps.judge.provider, model: res.model, api: deps.judge.api, inputSha, requestSha, evidenceSet: [], pins: deps.pins,
      status: res.status, ...(confirms ? { confirmsCallId: confirms.id, shuffleSeed: confirms.seed } : {}), latencyMs: res.latencyMs,
      ...(res.status === "ok" && !confirms ? { inputTokens: res.usage.input, outputTokens: res.usage.output, costMicro: core.microOfUsage(deps.prices, `${deps.judge.provider}/${res.model}`, res.usage) } : { inputTokens: 0, outputTokens: 0, costMicro: 0 }),
      costStatus: res.status === "ok" ? "settled" : "unknown",
      answers: questions.flatMap((q) => {
        const a = answers[q.sha];
        if (!a) return [];
        // calibration is a server-side step: no fitted bucket → calibrated_probs NULL → never an effective answer
        const cal = deps.calibrator.apply({ judge: deps.judgeModel, rulesVer: deps.bundle.rulesVer, scene, nOptions: Object.keys(q.criteria).length, question: core.questionKey(q) }, a.probs);
        return [{ questionSha: q.sha, ruleId: q.ruleId ?? null, kind: q.kind, choice: a.choice, rawProbs: a.probs, calibratedProbs: cal ? cal.probs : null, ...(cal ? { temperature: cal.temperature } : {}) }];
      }),
    }, deps.now());
    judgeCallIds.push(id);
  };
  const primaryId = core.uuid();
  record(primaryId, res.status === "ok" ? res.answers : {});
  if (res.status === "ok" && res.variant) record(core.uuid(), res.variant.answers, { id: primaryId, seed: res.variant.shuffleSeed });

  if (res.status !== "ok") {
    const r = direct("judge_down", judgeCallIds);
    return { contentId, decision: "judge_down", reviewId: r.review_id, latencyMs: deps.now() - t0, judgeStatus: res.status, blacklistHits: pre.blacklistHits.length, nearDup: pre.nearDuplicates.length };
  }

  // policy: answers → three states (blacklist hits and rate limiting force suspicious; they are deterministic signals for the agent, not rulings)
  const answers = core.trustedAnswersFromCalls(deps.db, contentId, judgeCallIds, deps.bundle, inputSha);
  let d = decide({ bundle: deps.bundle, scene, hasImages, answers, judgeOk: true, hasContext: !!(content.reply_to || content.mentions) });   // hasImages is false here (gated above)
  if ((pre.blacklistHits.length > 0 || pre.rateLimited) && d.state === "pass") d = { state: "suspicious", action: null, hits: [], reason: pre.blacklistHits.length ? "blacklist_hit" : "rate_limited", route: "agent" };

  // §2.2: a system cause (missing calibration, an unanswered required question) goes straight to a human — the agent
  // cannot fix it by investigating and would only spend its budget
  if (d.state === "suspicious" && d.route === "human") {
    const reason: core.ReleaseReason = d.reason.startsWith("calib_missing") ? "calib_missing" : d.reason.startsWith("judge_incomplete") ? "judge_incomplete" : d.reason === "image_unsupported" ? "image_unsupported" : "judge_down";
    const r = direct(reason, judgeCallIds);
    return { contentId, decision: reason, reviewId: r.review_id, latencyMs: deps.now() - t0, judgeStatus: "ok", blacklistHits: pre.blacklistHits.length, nearDup: pre.nearDuplicates.length };
  }
  if (d.state === "pass" || d.state === "block") {
    const out = core.fastDispose(deps.db, deps.bundle, { contentId, action: d.state === "pass" ? "pass" : d.action!, ruleIds: d.hits, judgeCallIds, pins: deps.pins, judgeModel: deps.judgeModel, budgetTools: deps.budgetTools, budgetMicro: deps.budgetMicro, reason: d.reason }, deps.now());
    return { contentId, decision: d.state, reviewId: out.ruling.review_id, latencyMs: deps.now() - t0, judgeStatus: "ok", blacklistHits: pre.blacklistHits.length, nearDup: pre.nearDuplicates.length };
  }
  if (deps.backpressure().agentFull) {
    const r = direct("backpressure", judgeCallIds);
    return { contentId, decision: "backpressure", reviewId: r.review_id, latencyMs: deps.now() - t0, judgeStatus: "ok", blacklistHits: pre.blacklistHits.length, nearDup: pre.nearDuplicates.length };
  }
  const r = core.createSuspiciousReview(deps.db, { contentId, pins: deps.pins, judgeModel: deps.judgeModel, judgeCallIds, pendingVisibility: sceneCfg.pendingVisibility, deadlineMs: sceneCfg.deadlineMs, budgetTools: deps.budgetTools, budgetMicro: deps.budgetMicro, suspectReason: d.reason }, deps.now()).review;
  return { contentId, decision: "suspicious", reviewId: r.review_id, latencyMs: deps.now() - t0, judgeStatus: "ok", blacklistHits: pre.blacklistHits.length, nearDup: pre.nearDuplicates.length };
}
