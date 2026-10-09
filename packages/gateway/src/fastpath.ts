// Fast path (docs §9.3, S1/S2/S2'): preprocess → one judge call with every applicable question (original + confirm copy)
// → policy engine → fastDispose / createSuspiciousReview. Judge failure never passes (fail-closed).
import * as core from "@mod/core";
import type { Db, PolicyBundle, PriceTable, Scene } from "@mod/core";
import { decide, type Decision } from "@mod/policy";
import type { JudgeClient } from "@mod/worker";
import { preprocess, type Blacklist, type RateLimit, type SimhashIndex } from "./preprocess.ts";
import type { ImageChecker, ImageStore, LoadedImage } from "./image.ts";

export type FastpathDeps = {
  db: Db; bundle: PolicyBundle; judge: JudgeClient; prices: PriceTable;
  pins: core.Pins; judgeModel: string; calibrator: core.Calibrator;
  blacklist: Blacklist; index: SimhashIndex; rate: RateLimit;
  backpressure: () => { agentFull: boolean };
  budgetTools: number; budgetMicro: number;
  now: () => number;
  /** stage ③ minimal image channel: both set -> images are delivered to the checker; otherwise image content goes to a human */
  imageStore?: ImageStore; imageChecker?: ImageChecker;
};

export type FastpathOutcome = { contentId: string; decision: Decision["state"] | "judge_down" | "backpressure" | "preprocess_error" | "image_unsupported" | "image_review" | "fastpath_error" | "calib_missing" | "judge_incomplete"; reviewId: string; latencyMs: number; judgeStatus: string; blacklistHits: number; nearDup: number };

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
  // stage ③: with an image channel configured the images are loaded and later sent to the checker; a missing file or an
  // unsupported type still degrades explicitly to a human (image_unsupported), never to a guess
  let images: LoadedImage[] = [];
  if (hasImages) {
    const loaded = deps.imageChecker && deps.imageStore ? (JSON.parse(content.image_refs!) as string[]).map((ref) => deps.imageStore!.load(String(ref))) : undefined;
    if (!loaded || loaded.some((x) => "error" in x)) {
      const r = direct("image_unsupported");
      return { contentId, decision: "image_unsupported", reviewId: r.review_id, latencyMs: deps.now() - t0, judgeStatus: "skipped", blacklistHits: pre.blacklistHits.length, nearDup: pre.nearDuplicates.length };
    }
    images = loaded as LoadedImage[];
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

  // stage ③: the image check — the scene's image_check question, asked twice (primary + confirming copy), recorded on the
  // content's judge calls with the same input fingerprint, calibrated like any other answer
  if (images.length) {
    const ic = deps.imageChecker!;
    const q = sceneCfg.imageCheck.question;
    const reqSha = core.sha256(core.canonical({ model: ic.model, question: q.sha, images: images.map((im) => core.sha256(im.bytes.toString("base64"))) }));
    let firstId: string | undefined;
    for (let k = 0; k < 2; k++) {
      const out = await ic.check({ contentId, images, question: q });
      const id = core.uuid();
      const cal = out.status === "ok" ? deps.calibrator.apply({ judge: ic.model, rulesVer: deps.bundle.rulesVer, scene, nOptions: Object.keys(q.criteria).length, question: core.questionKey(q) }, out.probs) : null;
      core.recordJudgeCall(deps.db, {
        judgeCallId: id, reviewId: null, contentId, attempt: null, provider: ic.provider, model: out.model, api: "image", inputSha, requestSha: reqSha, evidenceSet: [], pins: deps.pins,
        status: out.status, ...(firstId ? { confirmsCallId: firstId } : {}), latencyMs: out.latencyMs,
        ...(out.status === "ok" ? { inputTokens: out.usage.input, outputTokens: out.usage.output, costMicro: (() => { try { return core.microOfUsage(deps.prices, `${ic.provider}/${out.model}`, out.usage); } catch { return 0; } })() } : { inputTokens: 0, outputTokens: 0, costMicro: 0 }),
        costStatus: out.status === "ok" ? "settled" : "unknown",
        answers: out.status === "ok" ? [{ questionSha: q.sha, ruleId: null, kind: "image_check", choice: out.choice, rawProbs: out.probs, calibratedProbs: cal ? cal.probs : null, ...(cal ? { temperature: cal.temperature } : {}) }] : [],
      }, deps.now());
      judgeCallIds.push(id);
      firstId ??= id;
      if (out.status !== "ok") {
        const r = direct("judge_down", judgeCallIds);
        return { contentId, decision: "judge_down", reviewId: r.review_id, latencyMs: deps.now() - t0, judgeStatus: `image_${out.status}`, blacklistHits: pre.blacklistHits.length, nearDup: pre.nearDuplicates.length };
      }
    }
  }

  // policy: answers → three states (blacklist hits and rate limiting force suspicious; they are deterministic signals for the agent, not rulings)
  const answers = core.trustedAnswersFromCalls(deps.db, contentId, judgeCallIds, deps.bundle, inputSha);
  let d = decide({ bundle: deps.bundle, scene, hasImages, imageDelivered: images.length > 0, answers, judgeOk: true, hasContext: !!(content.reply_to || content.mentions) });
  // the agent has no image channel: image content that is neither auto-passed nor blocked goes to a person
  if (images.length && d.state === "suspicious" && d.route === "agent") d = { ...d, route: "human", reason: "image_review" };
  if ((pre.blacklistHits.length > 0 || pre.rateLimited) && d.state === "pass") d = { state: "suspicious", action: null, hits: [], reason: pre.blacklistHits.length ? "blacklist_hit" : "rate_limited", route: "agent" };

  // §2.2: a system cause (missing calibration, an unanswered required question) goes straight to a human — the agent
  // cannot fix it by investigating and would only spend its budget
  if (d.state === "suspicious" && d.route === "human") {
    const reason: core.ReleaseReason = d.reason.startsWith("calib_missing") ? "calib_missing" : d.reason.startsWith("judge_incomplete") ? "judge_incomplete" : d.reason === "image_unsupported" ? "image_unsupported" : d.reason === "image_review" ? "image_review" : "judge_down";
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
