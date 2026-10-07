// T4 submitRuling (§5.2 steps 1–12) and T2 fastDispose (S1). Both share writeRulingChecked.
import { allowedActions, type AllowedResult } from "./allowed.ts";
import type { AnswerRecord } from "./effective.ts";
import { appendAudit } from "./audit.ts";
import { nextSeq, tx, type Db } from "./db.ts";
import { CoreError } from "./errors.ts";
import { canonical, outboxEventId, sha256 } from "./ids.ts";
import { usedToolSlots } from "./budget.ts";
import { appendRejectAudit, insertReview, readContent, readReview, readRuling, upsertContentState, visibilityFor } from "./review.ts";
import { assertTransition } from "./states.ts";
import { CONTENT_BEARING_EVIDENCE, questionsOf, rulesFor, ruleAllowed, type Action, type Actor, type EvidenceRow, type JudgeAnswerRow, type JudgeCallRow, type Pins, type PolicyBundle, type ReviewRow, type RulingRow } from "./types.ts";

export type SubmitRulingInput = {
  reviewId: string;
  actor: Actor;
  attempt?: number;
  workerId?: string;
  action: Action;
  evidenceIds: readonly string[];
  ruleIds: readonly string[];
  judgeCallIds: readonly string[];
  pins: Pick<Pins, "rulesVer" | "calibVer" | "evidenceVer">;
  modelId?: string;
  reason: string;
  usedMicro?: number;
  costStatus?: "settled" | "estimated";
  humanAuth?: { reviewerId: string; token: string };
};

export type HumanAuth = { token: string; reviewers: readonly string[] };

export function verifyHumanAuth(cfg: HumanAuth, auth: { reviewerId: string; token: string } | undefined): void {
  if (!auth || auth.token !== cfg.token || !cfg.reviewers.includes(auth.reviewerId)) throw new CoreError("E_HUMAN_AUTH");
}

export type SubmitResult = { ruling: RulingRow; duplicate: boolean; allowed?: AllowedResult };

/** Fingerprint of a judge call's input for this review: content + the evidence it saw (§5.4). */
export function inputFingerprint(contentSha: string | null, scene: string, evidenceSet: readonly string[], evidenceVer: string): string {
  return sha256(canonical({ content_sha: contentSha, scene, evidence: [...evidenceSet].sort(), evidence_ver: evidenceVer }));
}

function parseProbs(s: string | null): Record<string, number> | null {
  return s ? (JSON.parse(s) as Record<string, number>) : null;
}

/** Load trusted answers for a review (status ok, fingerprint verified, question known, calibrated). */
export function trustedAnswers(db: Db, review: ReviewRow, bundle: PolicyBundle, judgeCallIds: readonly string[], evidenceVer: string): { answers: AnswerRecord[]; calls: JudgeCallRow[] } {
  const content = readContent(db, review.content_id);
  if (!content) throw new CoreError("E_REVIEW_NOT_FOUND", `content ${review.content_id}`);
  const known = questionsOf(bundle);
  const violationOf = new Map<string, string>();
  for (const r of bundle.rules) {
    violationOf.set(r.question.sha, r.question.violationOption);
    for (const x of r.exceptions) violationOf.set(x.question.sha, x.question.violationOption);
  }
  for (const sc of Object.values(bundle.scenes)) violationOf.set(sc.imageCheck.question.sha, sc.imageCheck.question.violationOption);
  const ownEvidence = new Set((db.prepare("SELECT body_sha FROM evidence WHERE review_id=? AND kind IN ('account_history','thread_context','image_check','similar')").all(review.review_id) as { body_sha: string }[]).map((e) => e.body_sha));
  const calls: JudgeCallRow[] = [];
  const answers: AnswerRecord[] = [];
  for (const id of judgeCallIds) {
    const call = db.prepare("SELECT * FROM judge_call WHERE judge_call_id=?").get(id) as JudgeCallRow | undefined;
    if (!call) throw new CoreError("E_JUDGE_FOREIGN", `judge_call ${id} not found`);
    calls.push(call);
    if (call.status !== "ok") continue;
    const set = JSON.parse(call.evidence_set) as string[];
    if (!set.every((s) => ownEvidence.has(s))) throw new CoreError("E_JUDGE_FOREIGN", `judge_call ${id} cites evidence not of this review`);
    if (call.input_sha !== inputFingerprint(content.text_sha, content.scene, set, evidenceVer)) throw new CoreError("E_JUDGE_FOREIGN", `judge_call ${id} input fingerprint mismatch`);
    const rows = db.prepare("SELECT * FROM judge_answer WHERE judge_call_id=?").all(id) as JudgeAnswerRow[];
    for (const a of rows) {
      if (!known.has(a.question_sha)) continue;
      const cal = parseProbs(a.calibrated_probs);
      const vo = violationOf.get(a.question_sha)!;
      answers.push({ judgeCallId: id, questionSha: a.question_sha, choice: a.choice, p: cal ? (cal[vo] ?? null) : null, evidenceSet: set, inputSha: call.input_sha, model: call.model, calibVer: call.calib_ver, confirmsCallId: call.confirms_call_id, createdAt: call.created_at });
    }
  }
  return { answers, calls };
}

type Ctx = { db: Db; bundle: PolicyBundle; humanAuth?: HumanAuth; at: number };

/** Steps 1–12 inside the caller's transaction. Throws CoreError with detail.step. */
export function writeRulingChecked(ctx: Ctx, input: SubmitRulingInput, preloaded?: ReviewRow): SubmitResult {
  const { db, bundle, at } = ctx;
  const fail = (code: ConstructorParameters<typeof CoreError>[0], step: number, msg?: string, detail: Record<string, unknown> = {}): never => {
    throw new CoreError(code, msg, { ...detail, step });
  };
  // 1
  const found = preloaded ?? readReview(db, input.reviewId);
  if (!found) fail("E_REVIEW_NOT_FOUND", 1, `review ${input.reviewId}`);
  const review = found!;
  // 2
  const existing = readRuling(db, review.review_id);
  if (existing) {
    if (existing.actor === input.actor && (input.actor !== "agent" || existing.attempt === input.attempt)) return { ruling: existing, duplicate: true };
    return fail("E_STATE_INVALID", 2, "ruling already exists");
  }
  // 3
  const need: Record<Actor, ReviewRow["state"]> = { agent: "investigating", human: "human_queue", fastpath: "disposed" };
  if (input.actor === "fastpath") {
    if (review.state !== "disposed" || review.trigger !== "fast") fail("E_STATE_INVALID", 3, "fastpath needs a fresh fast review");
  } else if (review.state !== need[input.actor]) fail("E_STATE_INVALID", 3, `state ${review.state}`, { state: review.state });
  // 4
  if (input.actor === "agent") {
    if (review.lease_owner !== input.workerId || (review.lease_until ?? 0) < at) fail("E_LEASE_LOST", 4);
    if (review.attempt !== input.attempt || review.revoked_attempt === input.attempt) fail("E_ATTEMPT_STALE", 4);
  } else if (input.actor === "human") {
    if (!ctx.humanAuth) fail("E_HUMAN_AUTH", 4);
    try { verifyHumanAuth(ctx.humanAuth!, input.humanAuth); } catch { fail("E_HUMAN_AUTH", 4); }
  }
  // 5
  if (input.actor === "agent" && (review.deadline_at ?? 0) <= at) fail("E_DEADLINE_PASSED", 5);
  // 6
  if (input.actor === "agent" && usedToolSlots(db, review.review_id) > review.budget_tools) fail("E_BUDGET_EXCEEDED", 6);
  // 7
  if (input.pins.rulesVer !== review.rules_ver || input.pins.calibVer !== review.calib_ver || input.pins.evidenceVer !== review.evidence_ver) fail("E_VERSION_MISMATCH", 7);
  if (bundle.rulesVer !== review.rules_ver) fail("E_VERSION_MISMATCH", 7, "bundle does not match review");
  // 8
  const content = readContent(db, review.content_id);
  if (!content) fail("E_REVIEW_NOT_FOUND", 8, "content missing");
  const sceneCfg = bundle.scenes[content!.scene];
  if (!sceneCfg.allowedActions.includes(input.action)) fail("E_ACTION_NOT_ALLOWED", 8, `scene ${content!.scene} forbids ${input.action}`);
  if (input.action !== "pass" && input.ruleIds.length === 0) fail("E_ACTION_NOT_ALLOWED", 8, "limit/takedown needs rule_ids");
  const sceneRules = new Map(rulesFor(bundle, content!.scene).map((r) => [r.ruleId, r] as const));
  for (const rid of input.ruleIds) {
    const r = sceneRules.get(rid);
    if (!r) fail("E_RULE_UNKNOWN", 8, `rule ${rid}`);
    if (!ruleAllowed(r!).includes(input.action)) fail("E_ACTION_NOT_ALLOWED", 8, `rule ${rid} does not allow ${input.action}`);
  }
  // 9
  for (const eid of input.evidenceIds) {
    const e = db.prepare("SELECT review_id, attempt FROM evidence WHERE evidence_id=?").get(eid) as Pick<EvidenceRow, "review_id" | "attempt"> | undefined;
    if (!e || e.review_id !== review.review_id || e.attempt > review.attempt) fail("E_EVIDENCE_FOREIGN", 9, `evidence ${eid}`);
  }
  // 10 + 11 (skipped for human)
  let allowed: AllowedResult | undefined;
  if (input.actor !== "human") {
    let trusted: ReturnType<typeof trustedAnswers>;
    try {
      trusted = trustedAnswers(db, review, bundle, input.judgeCallIds, review.evidence_ver);
    } catch (e) {
      if (e instanceof CoreError) fail(e.code, 10, e.message);
      throw e;
    }
    for (const c of trusted!.calls) {
      if (c.review_id !== review.review_id || c.rules_ver !== review.rules_ver || c.calib_ver !== review.calib_ver || c.evidence_ver !== review.evidence_ver) fail("E_JUDGE_FOREIGN", 10, `judge_call ${c.judge_call_id} belongs elsewhere`);
    }
    const hasImages = !!content!.image_refs && (JSON.parse(content!.image_refs) as unknown[]).length > 0;
    allowed = allowedActions({ bundle, scene: content!.scene, hasImages, answers: trusted!.answers });
    if (!allowed.allowed.has(input.action)) {
      fail("E_ACTION_NOT_SUPPORTED", 11, `${input.action} not in allowed set`, {
        allowed: [...allowed.allowed], required: allowed.required, covered: allowed.covered,
        rules: allowed.rules.map((v) => ({ ruleId: v.ruleId, effective: v.effective.kind, passSupport: v.passSupport, blockSupport: v.blockSupport, suspicious: v.suspicious, exceptions: v.exceptions })),
      });
    }
  }
  // 12
  const toState = input.actor === "human" ? "human_disposed" : "disposed";
  if (input.actor !== "fastpath") assertTransition(review.state, toState);
  const seq = nextSeq(db);
  db.prepare(
    `INSERT INTO ruling(review_id, content_id, seq, action, actor, attempt, allowed_actions, effective_answers, evidence_ids, rule_ids, judge_call_ids,
       rules_ver, calib_ver, evidence_ver, model_id, reason, ingest_seq, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(review.review_id, review.content_id, review.seq, input.action, input.actor, input.actor === "agent" ? input.attempt! : null,
    JSON.stringify(allowed ? [...allowed.allowed] : ["human"]), JSON.stringify(allowed?.effectiveAnswers ?? {}),
    JSON.stringify(input.evidenceIds), JSON.stringify(input.ruleIds), JSON.stringify(input.judgeCallIds),
    review.rules_ver, review.calib_ver, review.evidence_ver, input.modelId ?? null, input.reason, seq, at);
  upsertContentState(db, review.content_id, input.action, review.seq, visibilityFor(input.action, sceneCfg.pendingVisibility), at);
  db.prepare("INSERT OR IGNORE INTO outbox(event_id, review_id, content_id, seq, kind, payload, status, attempts, next_at, created_at) VALUES (?,?,?,?,?,?,'pending',0,?,?)")
    .run(outboxEventId(review.review_id, "ruling"), review.review_id, review.content_id, review.seq, "ruling", JSON.stringify({ action: input.action, actor: input.actor }), at, at);
  if (input.actor === "agent") {
    db.prepare("UPDATE review SET state='disposed', used_micro=?, cost_status=?, updated_at=? WHERE review_id=?").run(input.usedMicro ?? null, input.costStatus ?? null, at, review.review_id);
  } else if (input.actor === "human") {
    db.prepare("UPDATE review SET state='human_disposed', updated_at=? WHERE review_id=?").run(at, review.review_id);
    db.prepare("UPDATE human_queue SET closed_at=?, closed_by=? WHERE review_id=? AND closed_at IS NULL").run(at, input.humanAuth?.reviewerId ?? "human", review.review_id);
  }
  appendAudit(db, "ruling", review.review_id, input.actor, { action: input.action, attempt: input.attempt ?? null, rule_ids: input.ruleIds }, at);
  const ruling = readRuling(db, review.review_id)!;
  return allowed ? { ruling, duplicate: false, allowed } : { ruling, duplicate: false };
}

/** T4. On rejection: rollback, then audit in a separate transaction (T15), then rethrow. */
export function submitRuling(db: Db, bundle: PolicyBundle, input: SubmitRulingInput, at: number, humanAuth?: HumanAuth): SubmitResult {
  try {
    return tx(db, () => writeRulingChecked({ db, bundle, at, ...(humanAuth ? { humanAuth } : {}) }, input));
  } catch (e) {
    if (e instanceof CoreError) {
      appendRejectAudit(db, { code: e.code, step: Number(e.detail["step"] ?? 0), reviewId: input.reviewId, actor: input.actor, ...(input.attempt !== undefined ? { attempt: input.attempt } : {}), action: input.action }, at);
    }
    throw e;
  }
}

export type FastDisposeInput = {
  contentId: string; action: Action; ruleIds: readonly string[]; judgeCallIds: readonly string[];
  pins: Pins; judgeModel: string; budgetTools: number; budgetMicro: number; reason: string;
};

/** T2 / S1: create the fast review and write its ruling in one transaction. */
export function fastDispose(db: Db, bundle: PolicyBundle, i: FastDisposeInput, at: number): SubmitResult {
  try {
    return tx(db, () => {
      const intake = db.prepare("SELECT judged_review_id FROM intake WHERE content_id=?").get(i.contentId) as { judged_review_id: string | null } | undefined;
      if (!intake) throw new CoreError("E_REVIEW_NOT_FOUND", `no intake for ${i.contentId}`);
      if (intake.judged_review_id) {
        const r = readRuling(db, intake.judged_review_id);
        if (r) return { ruling: r, duplicate: true };
        throw new CoreError("E_STATE_INVALID", `content ${i.contentId} already routed to ${intake.judged_review_id}`);
      }
      const review = insertReview(db, { contentId: i.contentId, trigger: "fast", triggerRequestId: i.contentId, payloadSha: sha256("fast"), pins: i.pins, judgeModel: i.judgeModel,
        deadlineAt: null, budgetTools: i.budgetTools, budgetMicro: i.budgetMicro, state: "disposed" }, at);
      const bind = db.prepare("UPDATE judge_call SET review_id=? WHERE judge_call_id=? AND review_id IS NULL");
      for (const id of i.judgeCallIds) bind.run(review.review_id, id);
      const out = writeRulingChecked({ db, bundle, at }, { reviewId: review.review_id, actor: "fastpath", action: i.action, evidenceIds: [], ruleIds: i.ruleIds, judgeCallIds: i.judgeCallIds, pins: i.pins, reason: i.reason }, review);
      db.prepare("UPDATE intake SET status='judged', judged_review_id=?, lease_owner=NULL, lease_until=NULL, updated_at=? WHERE content_id=?").run(review.review_id, at, i.contentId);
      return out;
    });
  } catch (e) {
    if (e instanceof CoreError) appendRejectAudit(db, { code: e.code, step: Number(e.detail["step"] ?? 0), reviewId: `${i.contentId}#fast#?`, actor: "fastpath", action: i.action }, at);
    throw e;
  }
}
