// Transactions T1–T3', T5–T9, T11–T17 and read helpers. docs/dev-doc-v1.md §4.
// T4 (submitRuling) and T2 (fastDispose) live in submit-check.ts; T10 in consumer.ts.
import { appendAudit } from "./audit.ts";
import { currentSeq, nextSeq, tx, type Db } from "./db.ts";
import { CoreError } from "./errors.ts";
import { abortCommandId, outboxEventId, reviewId as mkReviewId, sha256, type Trigger } from "./ids.ts";
import { assertTransition, isTerminal } from "./states.ts";
import { modelSpentMicro } from "./budget.ts";
import type { PriceTable } from "./prices.ts";
import type { Action, ContentRow, Pins, ReleaseReason, ReviewRow, RulingRow, Scene, Visibility } from "./types.ts";

export type Config = {
  leaseTtlMs: number;
  deadlineMs: number;
  maxAttempts: number;
  scanMs: number;
  budgetTools: number;
  budgetMicro: number;
  /** an admitted review whose conversation has had no unfinished task or submission for this long is released to a
   *  human as agent_stalled (e.g. the main model kept failing and the generation gave up); default 30 s */
  agentStallMs?: number;
};

export const DEFAULT_CONFIG: Config = { leaseTtlMs: 30_000, deadlineMs: 60_000, maxAttempts: 3, scanMs: 2_000, budgetTools: 12, budgetMicro: 50_000 };

// ---------- reads ----------

export function readReview(db: Db, reviewId: string): ReviewRow | undefined {
  return db.prepare("SELECT * FROM review WHERE review_id=?").get(reviewId) as ReviewRow | undefined;
}
export function requireReview(db: Db, reviewId: string): ReviewRow {
  const r = readReview(db, reviewId);
  if (!r) throw new CoreError("E_REVIEW_NOT_FOUND", `review ${reviewId}`);
  return r;
}
export function readRuling(db: Db, reviewId: string): RulingRow | undefined {
  return db.prepare("SELECT * FROM ruling WHERE review_id=?").get(reviewId) as RulingRow | undefined;
}
export function readContent(db: Db, contentId: string): ContentRow | undefined {
  return db.prepare("SELECT * FROM content WHERE content_id=?").get(contentId) as ContentRow | undefined;
}
/** dev plan 2026-10-08 §3.1 problem 3 (temporary): the content replies to something that is not in the store (deleted,
 *  or not arrived yet). Such a reply is never passed automatically — not by the fast path, not by the agent — because the
 *  missing parent may be what makes it a violation; a clear violation can still be acted on, and a person can pass it. */
export function parentMissing(db: Db, contentId: string): boolean {
  const c = readContent(db, contentId);
  if (!c?.reply_to) return false;
  return !db.prepare("SELECT 1 FROM content WHERE content_id=?").get(c.reply_to);
}
export function latestReview(db: Db, contentId: string): ReviewRow | undefined {
  return db.prepare("SELECT * FROM review WHERE content_id=? ORDER BY seq DESC LIMIT 1").get(contentId) as ReviewRow | undefined;
}
export function hasTerminal(db: Db, reviewId: string): boolean {
  const r = readReview(db, reviewId);
  return !!r && (isTerminal(r.state) || r.state === "human_queue");
}

export type LeaseStatus = { held: boolean; deadlinePassed: boolean; revoked: boolean; state: string | null };
export function leaseStatus(db: Db, reviewId: string, workerId: string, attempt: number, at: number): LeaseStatus {
  const r = readReview(db, reviewId);
  if (!r) return { held: false, deadlinePassed: true, revoked: true, state: null };
  const revoked = r.revoked_attempt === attempt;
  const held = r.state === "investigating" && r.lease_owner === workerId && r.attempt === attempt && (r.lease_until ?? 0) >= at && !revoked;
  return { held, deadlinePassed: (r.deadline_at ?? 0) <= at, revoked, state: r.state };
}

// ---------- content_state (§3.3) ----------

export function visibilityFor(action: Action | null, pendingVisibility: Visibility): Visibility {
  if (action === "pass") return "visible";
  if (action === "limit") return "self_only";
  if (action === "takedown") return "hidden";
  return pendingVisibility;
}

/** Upsert; only advances when seq is higher. Inside a transaction. */
export function upsertContentState(db: Db, contentId: string, action: Action | null, seq: number, visibility: Visibility, at: number): void {
  db.prepare(
    `INSERT INTO content_state(content_id, effective_action, effective_seq, visibility, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(content_id) DO UPDATE SET effective_action=excluded.effective_action, effective_seq=excluded.effective_seq,
       visibility=excluded.visibility, updated_at=excluded.updated_at
     WHERE excluded.effective_seq > content_state.effective_seq`,
  ).run(contentId, action, seq, visibility, at);
}

function insertOutbox(db: Db, r: Pick<ReviewRow, "review_id" | "content_id" | "seq">, kind: "ruling" | "release", payload: unknown, at: number): void {
  db.prepare("INSERT OR IGNORE INTO outbox(event_id, review_id, content_id, seq, kind, payload, status, attempts, next_at, created_at) VALUES (?,?,?,?,?,?,'pending',0,?,?)")
    .run(outboxEventId(r.review_id, kind), r.review_id, r.content_id, r.seq, kind, JSON.stringify(payload), at, at);
}

function insertHumanQueue(db: Db, r: ReviewRow, reason: string, severity: number, slaMs: number, at: number): void {
  db.prepare("INSERT OR IGNORE INTO human_queue(review_id, severity, due_at, reason, created_at) VALUES (?,?,?,?,?)").run(r.review_id, severity, at + slaMs, reason, at);
}

// ---------- T1 ----------

export type NewContent = { contentId: string; scene: Scene; text?: string; imageRefs?: string[]; accountId?: string; threadId?: string;
  /** the content this one replies to, and the accounts it @-mentions (R8b: thread context follows these relations) */
  replyTo?: string; mentions?: string[];
  eventTime: number; prio?: number };

export function intakeInsert(db: Db, c: NewContent, at: number): { inserted: boolean } {
  return tx(db, () => {
    const exists = db.prepare("SELECT 1 FROM content WHERE content_id=?").get(c.contentId);
    if (exists) return { inserted: false };
    const seq = nextSeq(db);
    const text = c.text ?? null;
    db.prepare("INSERT INTO content(content_id, scene, text_sha, text, image_refs, account_id, thread_id, reply_to, mentions, event_time, ingest_seq, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(c.contentId, c.scene, text === null ? null : sha256(text), text, c.imageRefs ? JSON.stringify(c.imageRefs) : null, c.accountId ?? null, c.threadId ?? null,
        c.replyTo ?? null, c.mentions?.length ? JSON.stringify(c.mentions) : null, c.eventTime, seq, at);
    db.prepare("INSERT INTO intake(content_id, prio, status, created_at, updated_at) VALUES (?,?,'received',?,?)").run(c.contentId, c.prio ?? 5, at, at);
    return { inserted: true };
  });
}

/** Context-only content: posts that existed before the period under study (e.g. the parent a case replies to). Stored
 *  as content with an ingest seq but no intake row, so the fast path never picks it up; the thread-context tool sees it. */
export function contextInsert(db: Db, c: NewContent, at: number): { inserted: boolean } {
  return tx(db, () => {
    if (db.prepare("SELECT 1 FROM content WHERE content_id=?").get(c.contentId)) return { inserted: false };
    const text = c.text ?? null;
    db.prepare("INSERT INTO content(content_id, scene, text_sha, text, image_refs, account_id, thread_id, reply_to, mentions, event_time, ingest_seq, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(c.contentId, c.scene, text === null ? null : sha256(text), text, c.imageRefs ? JSON.stringify(c.imageRefs) : null, c.accountId ?? null, c.threadId ?? null,
        c.replyTo ?? null, c.mentions?.length ? JSON.stringify(c.mentions) : null, c.eventTime, nextSeq(db), at);
    return { inserted: true };
  });
}

export type SynthEvent = { eventId: string; accountId: string; kind: "prior_ruling" | "appeal" | "post" | "warning"; payload: unknown; eventTime: number };
/** Account-history events imported from outside the system (stage-1 known gap: no writer existed). prior_ruling payload:
 *  {"action": ..., "rule_ids": [...]}. Idempotent by event id. */
export function synthEventInsert(db: Db, e: SynthEvent): { inserted: boolean } {
  return tx(db, () => {
    if (db.prepare("SELECT 1 FROM synth_event WHERE event_id=?").get(e.eventId)) return { inserted: false };
    db.prepare("INSERT INTO synth_event(event_id, account_id, kind, payload, event_time, ingest_seq) VALUES (?,?,?,?,?,?)").run(e.eventId, e.accountId, e.kind, JSON.stringify(e.payload), e.eventTime, nextSeq(db));
    return { inserted: true };
  });
}

// ---------- review creation (shared by T2/T2'/T9) ----------

export type ReviewCreate = {
  contentId: string; trigger: Trigger; triggerRequestId: string; payloadSha: string;
  pins: Pins; judgeModel: string; snapshotSeq?: number; deadlineAt: number | null;
  budgetTools: number; budgetMicro: number; state: "queued" | "disposed" | "human_queue"; releaseReason?: ReleaseReason; suspectReason?: string;
};

/** Insert a review row with the next seq. Inside a transaction. */
export function insertReview(db: Db, c: ReviewCreate, at: number): ReviewRow {
  const last = latestReview(db, c.contentId);
  const seq = (last?.seq ?? 0) + 1;
  const id = mkReviewId(c.contentId, c.trigger, seq);
  assertTransition(null, c.state);
  const snapshot = c.snapshotSeq ?? currentSeq(db);
  db.prepare(
    `INSERT INTO review(review_id, content_id, seq, trigger, trigger_request_id, trigger_payload_sha, state, attempt, deadline_at, snapshot_seq,
       budget_tools, budget_micro, rules_ver, calib_ver, evidence_ver, prices_ver, judge_model, release_reason, suspect_reason, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, c.contentId, seq, c.trigger, c.triggerRequestId, c.payloadSha, c.state, c.deadlineAt, snapshot, c.budgetTools, c.budgetMicro,
    c.pins.rulesVer, c.pins.calibVer, c.pins.evidenceVer, c.pins.pricesVer, c.judgeModel, c.releaseReason ?? null, c.suspectReason ?? null, at, at);
  return requireReview(db, id);
}

function bindJudgeCalls(db: Db, reviewId: string, judgeCallIds: readonly string[]): void {
  const stmt = db.prepare("UPDATE judge_call SET review_id=? WHERE judge_call_id=? AND review_id IS NULL");
  for (const id of judgeCallIds) stmt.run(reviewId, id);
}

function markIntakeJudged(db: Db, contentId: string, reviewId: string, at: number): void {
  db.prepare("UPDATE intake SET status='judged', judged_review_id=?, lease_owner=NULL, lease_until=NULL, updated_at=? WHERE content_id=?").run(reviewId, at, contentId);
}

// ---------- T2' ----------

export type SuspiciousInput = {
  contentId: string; pins: Pins; judgeModel: string; judgeCallIds: readonly string[];
  pendingVisibility: Visibility; deadlineMs: number; budgetTools: number; budgetMicro: number;
  /** when set, S2' instead of S2 */
  direct?: { reason: ReleaseReason; severity: number; humanSlaMs: number };
  snapshotSeq?: number;
  /** why it goes to the agent (§2.2); stored on the review for the agent's task description */
  suspectReason?: string;
};

export function createSuspiciousReview(db: Db, i: SuspiciousInput, at: number): { review: ReviewRow; duplicate: boolean } {
  return tx(db, () => {
    const intake = db.prepare("SELECT judged_review_id FROM intake WHERE content_id=?").get(i.contentId) as { judged_review_id: string | null } | undefined;
    if (!intake) throw new CoreError("E_REVIEW_NOT_FOUND", `no intake for ${i.contentId}`);
    if (intake.judged_review_id) return { review: requireReview(db, intake.judged_review_id), duplicate: true };
    const base = { contentId: i.contentId, trigger: "suspicious" as const, triggerRequestId: i.contentId, payloadSha: sha256("suspicious"), pins: i.pins, judgeModel: i.judgeModel,
      budgetTools: i.budgetTools, budgetMicro: i.budgetMicro, ...(i.snapshotSeq !== undefined ? { snapshotSeq: i.snapshotSeq } : {}) };
    let review: ReviewRow;
    if (i.direct) {
      review = insertReview(db, { ...base, deadlineAt: null, state: "human_queue", releaseReason: i.direct.reason }, at);
      insertHumanQueue(db, review, i.direct.reason, i.direct.severity, i.direct.humanSlaMs, at);
      insertOutbox(db, review, "release", { reason: i.direct.reason }, at);
    } else {
      review = insertReview(db, { ...base, deadlineAt: at + i.deadlineMs, state: "queued", ...(i.suspectReason ? { suspectReason: i.suspectReason } : {}) }, at);
    }
    upsertContentState(db, i.contentId, null, 0, i.pendingVisibility, at);
    markIntakeJudged(db, i.contentId, review.review_id, at);
    bindJudgeCalls(db, review.review_id, i.judgeCallIds);
    return { review, duplicate: false };
  });
}

// ---------- T3 / T3' ----------

export function acquireLease(db: Db, reviewId: string, workerId: string, cfg: Config, at: number): ReviewRow {
  return tx(db, () => {
    const res = db.prepare(
      `UPDATE review SET state='investigating', attempt=attempt+1, lease_owner=?, lease_until=?, updated_at=?
       WHERE review_id=? AND (state='queued' OR (state='investigating' AND lease_until < ?)) AND deadline_at > ? AND attempt < ?`,
    ).run(workerId, at + cfg.leaseTtlMs, at, reviewId, at, at, cfg.maxAttempts);
    if (res.changes === 1) return requireReview(db, reviewId);
    const r = requireReview(db, reviewId);
    if (r.state === "investigating" && (r.lease_until ?? 0) >= at) throw new CoreError("E_LEASE_HELD", `held by ${r.lease_owner}`, { lease_until: r.lease_until });
    throw new CoreError("E_STATE_INVALID", `cannot lease review in state ${r.state}`, { state: r.state, attempt: r.attempt, deadline_at: r.deadline_at });
  });
}

export function renewLease(db: Db, reviewId: string, workerId: string, attempt: number, cfg: Config, at: number): void {
  tx(db, () => {
    const res = db.prepare(
      `UPDATE review SET lease_until=?, updated_at=? WHERE review_id=? AND state='investigating' AND lease_owner=? AND attempt=? AND lease_until >= ? AND revoked_attempt IS NOT ?`,
    ).run(at + cfg.leaseTtlMs, at, reviewId, workerId, attempt, at, attempt);
    if (res.changes !== 1) throw new CoreError("E_LEASE_LOST", `lease not held for ${reviewId}#${attempt}`);
  });
}

export function bindConversation(db: Db, reviewId: string, conversationId: string): boolean {
  return tx(db, () => db.prepare("UPDATE review SET conversation_id=? WHERE review_id=? AND conversation_id IS NULL").run(conversationId, reviewId).changes === 1);
}
/** Record the submission of generation `attempt`. Only the current generation can bind, and a generation's binding
 *  is never overwritten by an older one (R2: generation 2+ used to be unable to bind, so recovery saw generation 1's
 *  finished submission and skipped re-submitting). */
export function bindSubmission(db: Db, reviewId: string, attempt: number, submissionId: string): boolean {
  return tx(db, () => db.prepare(
    "UPDATE review SET submission_id=?, submission_attempt=? WHERE review_id=? AND attempt=? AND (submission_attempt IS NULL OR submission_attempt < ?)",
  ).run(submissionId, attempt, reviewId, attempt, attempt).changes === 1);
}

// ---------- T5 / T6 / T7 ----------

export type ReleaseActor = { kind: "agent"; workerId: string; attempt: number; usedMicro: number; costStatus: "settled" | "estimated" } | { kind: "control" };

export function releaseToHuman(db: Db, reviewId: string, actor: ReleaseActor, reason: ReleaseReason, severity: number, humanSlaMs: number, at: number): { duplicate: boolean } {
  return tx(db, () => {
    const r = requireReview(db, reviewId);
    if (r.state === "human_queue") return { duplicate: true };
    if (isTerminal(r.state)) throw new CoreError("E_STATE_INVALID", `review ${reviewId} is ${r.state}`);
    if (actor.kind === "agent") {
      assertTransition(r.state, "human_queue");
      const res = db.prepare(
        `UPDATE review SET state='human_queue', release_reason=?, lease_owner=NULL, lease_until=NULL, used_micro=?, cost_status=?, updated_at=?
         WHERE review_id=? AND state='investigating' AND lease_owner=? AND attempt=? AND lease_until >= ? AND revoked_attempt IS NOT ?`,
      ).run(reason, actor.usedMicro, actor.costStatus, at, reviewId, actor.workerId, actor.attempt, at, actor.attempt);
      if (res.changes !== 1) throw new CoreError("E_ATTEMPT_STALE", `attempt ${actor.attempt} cannot release ${reviewId}`);
    } else {
      assertTransition(r.state, "human_queue");   // S11 (queued) ; S7 goes through revokeAndRelease
      if (r.state !== "queued") throw new CoreError("E_STATE_INVALID", `control release only from queued; use revokeAndRelease`, { state: r.state });
      db.prepare("UPDATE review SET state='human_queue', release_reason=?, updated_at=? WHERE review_id=?").run(reason, at, reviewId);
    }
    insertHumanQueue(db, r, reason, severity, humanSlaMs, at);
    insertOutbox(db, r, "release", { reason }, at);
    return { duplicate: false };
  });
}

/** S7: revoke the current attempt and release. Cost uses the fallback formula (estimated). */
export function revokeAndRelease(db: Db, reviewId: string, reason: ReleaseReason, severity: number, humanSlaMs: number, at: number, prices?: PriceTable): { duplicate: boolean } {
  return tx(db, () => {
    const r = requireReview(db, reviewId);
    if (r.state === "human_queue") return { duplicate: true };
    if (isTerminal(r.state)) throw new CoreError("E_STATE_INVALID", `review ${reviewId} is ${r.state}`);
    assertTransition(r.state, "human_queue");
    // round-9 item 7: model requests already made count too (priced from model_call); still 'estimated' until W settles
    const fallback = fallbackCost(db, reviewId) + (prices ? modelSpentMicro(db, prices, reviewId) : 0);
    db.prepare("UPDATE review SET state='human_queue', release_reason=?, lease_owner=NULL, lease_until=NULL, revoked_attempt=?, used_micro=?, cost_status='estimated', updated_at=? WHERE review_id=?")
      .run(reason, r.attempt, fallback, at, reviewId);
    insertHumanQueue(db, r, reason, severity, humanSlaMs, at);
    insertOutbox(db, r, "release", { reason }, at);
    if (r.state === "investigating") {
      db.prepare("INSERT OR IGNORE INTO worker_command(command_id, review_id, kind, attempt, status, created_at) VALUES (?,?,'abort',?,'pending',?)")
        .run(abortCommandId(reviewId, r.attempt), reviewId, r.attempt, at);
    }
    return { duplicate: false };
  });
}

export function requeue(db: Db, reviewId: string, cfg: Config, at: number): boolean {
  return tx(db, () => db.prepare(
    `UPDATE review SET state='queued', lease_owner=NULL, lease_until=NULL, updated_at=?
     WHERE review_id=? AND state='investigating' AND lease_until < ? AND attempt < ? AND deadline_at > ?`,
  ).run(at, reviewId, at, cfg.maxAttempts, at).changes === 1);
}

// ---------- T9 ----------

export function createFollowupReview(db: Db, i: { contentId: string; trigger: "appeal" | "recheck" | "rule_change"; triggerRequestId: string; payloadSha: string; pins: Pins; judgeModel: string; deadlineMs: number; budgetTools: number; budgetMicro: number; pendingVisibility: Visibility }, at: number): { review: ReviewRow; duplicate: boolean } {
  return tx(db, () => {
    const existing = db.prepare("SELECT * FROM review WHERE content_id=? AND trigger_request_id=?").get(i.contentId, i.triggerRequestId) as ReviewRow | undefined;
    if (existing) {
      if (existing.trigger_payload_sha === i.payloadSha) return { review: existing, duplicate: true };
      throw new CoreError("E_REQUEST_CONFLICT", `trigger_request_id ${i.triggerRequestId} reused with different payload`);
    }
    const last = latestReview(db, i.contentId);
    if (!last) throw new CoreError("E_REVIEW_NOT_FOUND", `no review for ${i.contentId}`);
    if (!isTerminal(last.state)) throw new CoreError("E_STATE_INVALID", `latest review ${last.review_id} is ${last.state}`, { state: last.state });
    const review = insertReview(db, { contentId: i.contentId, trigger: i.trigger, triggerRequestId: i.triggerRequestId, payloadSha: i.payloadSha, pins: i.pins, judgeModel: i.judgeModel,
      deadlineAt: at + i.deadlineMs, budgetTools: i.budgetTools, budgetMicro: i.budgetMicro, state: "queued" }, at);
    // content_state row already exists; visibility unchanged while a new review is pending (prior ruling stays effective)
    return { review, duplicate: false };
  });
}

// ---------- T14, T15, T17 ----------

export function bumpYield(db: Db, reviewId: string, max: number, at: number): boolean {
  return tx(db, () => db.prepare("UPDATE review SET yield_continues=yield_continues+1, updated_at=? WHERE review_id=? AND yield_continues < ?").run(at, reviewId, max).changes === 1);
}

export function appendRejectAudit(db: Db, payload: { code: string; step: number; reviewId: string; actor: string; attempt?: number; action?: string }, at: number): void {
  tx(db, () => appendAudit(db, "submit_rejected", payload.reviewId, payload.actor, payload, at));
}

export function updateReviewCost(db: Db, reviewId: string, usedMicro: number, costStatus: "settled" | "estimated", overMicro: number | null, at: number): void {
  tx(db, () => {
    db.prepare("UPDATE review SET used_micro=?, cost_status=?, over_budget_micro=?, updated_at=? WHERE review_id=?").run(usedMicro, costStatus, overMicro, at, reviewId);
  });
}

/** Fallback cost (§7.5): model_call usage is not priced here (G has no price table in core); tool_request settled + reserved for inflight/unknown. */
export function fallbackCost(db: Db, reviewId: string): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN r.cost_status='settled' THEN r.cost_micro ELSE s.reserved_micro END),0) AS total
     FROM tool_request r JOIN tool_slot s ON s.review_id=r.review_id AND s.call_id=r.call_id WHERE r.review_id=?`,
  ).get(reviewId) as { total: number };
  return row.total;
}

// ---------- T16 ----------

export type JudgeCallInput = {
  judgeCallId: string; reviewId: string | null; contentId: string; attempt: number | null;
  provider: string; model: string; api: string; inputSha: string; evidenceSet: readonly string[];
  /** digest of the request actually sent (requestDigest); optional for callers that do not send a request */
  requestSha?: string;
  pins: Pins; status: "ok" | "timeout" | "error" | "abstain"; shuffleSeed?: number; confirmsCallId?: string; massCovered?: number;
  latencyMs?: number; inputTokens?: number; outputTokens?: number; costMicro?: number; costStatus: "settled" | "estimated" | "unknown";
  answers: readonly { questionSha: string; ruleId: string | null; kind: "rule" | "exception" | "image_check" | "guard"; choice: string; rawProbs: Record<string, number>; calibratedProbs: Record<string, number> | null; temperature?: number }[];
};

export function recordJudgeCall(db: Db, c: JudgeCallInput, at: number): void {
  tx(db, () => {
    db.prepare(
      `INSERT OR IGNORE INTO judge_call(judge_call_id, review_id, content_id, attempt, provider, model, api, input_sha, request_sha, evidence_set, rules_ver, calib_ver, evidence_ver, status,
         shuffle_seed, confirms_call_id, mass_covered, latency_ms, input_tokens, output_tokens, cost_micro, cost_status, prices_ver, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(c.judgeCallId, c.reviewId, c.contentId, c.attempt, c.provider, c.model, c.api, c.inputSha, c.requestSha ?? null, JSON.stringify([...c.evidenceSet].sort()), c.pins.rulesVer, c.pins.calibVer, c.pins.evidenceVer,
      c.status, c.shuffleSeed ?? null, c.confirmsCallId ?? null, c.massCovered ?? null, c.latencyMs ?? null, c.inputTokens ?? null, c.outputTokens ?? null, c.costMicro ?? null, c.costStatus, c.pins.pricesVer, at);
    const ins = db.prepare("INSERT OR IGNORE INTO judge_answer(judge_call_id, question_sha, rule_id, question_kind, choice, raw_probs, calibrated_probs, temperature) VALUES (?,?,?,?,?,?,?,?)");
    for (const a of c.answers) ins.run(c.judgeCallId, a.questionSha, a.ruleId, a.kind, a.choice, JSON.stringify(a.rawProbs), a.calibratedProbs ? JSON.stringify(a.calibratedProbs) : null, a.temperature ?? null);
  });
}

// ---------- round-9 item 12: policy bundle versions a review can be continued under ----------
export type StoredBundle = { bundle: PolicyBundleShape; texts: Record<string, string> };
type PolicyBundleShape = import("./types.ts").PolicyBundle;

/** G stores every bundle it runs with; a worker continues an old review under the bundle its review is pinned to. Idempotent per rules_ver. */
export function storeBundle(db: Db, bundle: PolicyBundleShape, texts: Record<string, string>, at: number): boolean {
  return tx(db, () => db.prepare("INSERT OR IGNORE INTO policy_bundle(rules_ver, bundle, texts, created_at) VALUES (?,?,?,?)").run(bundle.rulesVer, JSON.stringify(bundle), JSON.stringify(texts), at).changes === 1);
}

export function loadStoredBundle(db: Db, rulesVer: string): StoredBundle | undefined {
  const row = db.prepare("SELECT bundle, texts FROM policy_bundle WHERE rules_ver=?").get(rulesVer) as { bundle: string; texts: string } | undefined;
  return row ? { bundle: JSON.parse(row.bundle) as PolicyBundleShape, texts: JSON.parse(row.texts) as Record<string, string> } : undefined;
}
