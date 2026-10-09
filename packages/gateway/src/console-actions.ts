// Write paths of the console API, shared by G's HTTP handlers and the demo traffic generator (demo-traffic.ts), so a
// simulated content, a simulated reviewer's decision and a simulated appeal take exactly the code path a person's does:
// intake (with an optional parent kept as read-only context), human claim / ruling (core.submitRuling, actor human)
// and appeals (core.createFollowupReview). Input validation of raw HTTP bodies stays in http.ts.
import * as core from "@mod/core";
import type { Db, PolicyBundle } from "@mod/core";
import type { Gateway } from "./gateway.ts";

/** A refusal decided here (not by the submit check): HTTP status + code. */
export class ActionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) { super(message ?? code); this.status = status; this.code = code; }
}

export type ActionDeps = { db: Db; gateway: Gateway; bundle: PolicyBundle; humanAuth: core.HumanAuth; now: () => number };

export type NewContentInput = {
  /** may be empty when the content carries an image */
  text: string; scene: core.Scene;
  /** refs of images already in the image store */
  imageRefs?: string[]; contentId?: string; accountId?: string; threadId?: string; replyTo?: string;
  parent?: { text: string; accountId?: string };
};
export type IntakeResult =
  | { status: 201; contentId: string; duplicate: false }
  | { status: 200; contentId: string; duplicate: true }
  | { status: 409; code: "E_REQUEST_CONFLICT"; message: string }
  | { status: 429; code: "E_BACKPRESSURE"; message: string };

/** Put one text content on the intake queue (idempotent by content id). The parent, if any, existed a minute earlier
 *  and is stored as context only: it is never judged itself; the agent's context tool reads it. */
export function intakeContent(d: ActionDeps, i: NewContentInput): IntakeResult {
  const { db } = d;
  const contentId = i.contentId ?? `c-${d.now().toString(36)}-${core.uuid().slice(0, 6)}`;
  const existing = core.readContent(db, contentId);
  const text = i.text || null;
  if (existing) {
    const sameImages = (existing.image_refs ?? null) === (i.imageRefs?.length ? JSON.stringify(i.imageRefs) : null);
    if (existing.scene === i.scene && existing.text_sha === (text === null ? null : core.sha256(text)) && sameImages) return { status: 200, contentId, duplicate: true };
    return { status: 409, code: "E_REQUEST_CONFLICT", message: `content ${contentId} exists with a different payload` };
  }
  if (d.gateway.replayPaused) return { status: 429, code: "E_BACKPRESSURE", message: "intake paused by backpressure" };
  const at = d.now();
  const threadId = i.threadId ?? (i.parent ? `t-${contentId}` : undefined);
  let replyTo = i.replyTo;
  if (i.parent) {
    replyTo = `${contentId}.parent`;
    core.contextInsert(db, { contentId: replyTo, scene: i.scene, text: i.parent.text, ...(i.parent.accountId ? { accountId: i.parent.accountId } : {}), ...(threadId ? { threadId } : {}), eventTime: at - 60_000 }, at);
  }
  core.intakeInsert(db, { contentId, scene: i.scene, ...(text !== null ? { text } : {}), ...(i.imageRefs?.length ? { imageRefs: i.imageRefs } : {}), ...(i.accountId ? { accountId: i.accountId } : {}), ...(threadId ? { threadId } : {}), ...(replyTo ? { replyTo } : {}), eventTime: at }, at);
  return { status: 201, contentId, duplicate: false };
}

/** The bundle a review is pinned to: the gateway's own, or the copy stored when that version was in use (dev plan R7). */
export function pinnedBundle(d: ActionDeps, r: core.ReviewRow): PolicyBundle | undefined {
  return r.rules_ver === d.bundle.rulesVer ? d.bundle : (core.loadStoredBundle(d.db, r.rules_ver)?.bundle as PolicyBundle | undefined);
}

export type HumanDecision = { reviewId: string; reviewerId: string; token: string; action: core.Action; ruleIds: readonly string[]; reason: string; feedback?: { ruleId: string; label: string } };

/** A person's ruling on a human task, through the same submit check as every other ruling. Throws ActionError or
 *  CoreError (the submit check's refusal, already written to the audit log). */
export function humanRule(d: ActionDeps, x: HumanDecision): { action: core.Action; duplicate: boolean } {
  const { db } = d;
  const r = core.readReview(db, x.reviewId);
  if (!r) throw new ActionError(404, "E_REVIEW_NOT_FOUND");
  // a task claimed by someone else is theirs to decide (an unclaimed one can still be decided directly)
  const holder = (db.prepare("SELECT claimed_by FROM human_queue WHERE review_id=? AND closed_at IS NULL").get(r.review_id) as { claimed_by: string | null } | undefined)?.claimed_by;
  if (holder && holder !== x.reviewerId) throw new ActionError(409, "E_LEASE_HELD", `claimed by ${holder}`);
  const pinned = pinnedBundle(d, r);
  if (!pinned) throw new ActionError(409, "E_BUNDLE_MISSING", `rules ${r.rules_ver} not stored`);
  const out = core.submitRuling(db, pinned, { reviewId: r.review_id, actor: "human", action: x.action, evidenceIds: [], ruleIds: x.ruleIds, judgeCallIds: [],
    pins: { rulesVer: r.rules_ver, calibVer: r.calib_ver, evidenceVer: r.evidence_ver }, reason: x.reason, humanAuth: { reviewerId: x.reviewerId, token: x.token } }, d.now(), d.humanAuth);
  if (x.feedback) core.tx(db, () => db.prepare("INSERT INTO feedback(feedback_id, review_id, rule_id, human_label, machine_prob, created_at) VALUES (?,?,?,?,?,?)").run(core.uuid(), r.review_id, x.feedback!.ruleId, x.feedback!.label, null, d.now()));
  return { action: out.ruling.action, duplicate: out.duplicate };
}

/** Open an appeal review on a content (idempotent by request id). Throws CoreError; undefined: no such content. */
export function openAppeal(d: ActionDeps, x: { contentId: string; triggerRequestId: string; reasonCode: string | null }): { reviewId: string; duplicate: boolean } | undefined {
  const { db, gateway } = d;
  const content = core.readContent(db, x.contentId);
  if (!content) return undefined;
  const sc = d.bundle.scenes[content.scene];
  const out = core.createFollowupReview(db, { contentId: x.contentId, trigger: "appeal", triggerRequestId: x.triggerRequestId, payloadSha: core.sha256(core.canonical({ reason_code: x.reasonCode })), pins: gateway.pins, judgeModel: gateway.d.judgeModel, deadlineMs: sc.deadlineMs, budgetTools: gateway.d.cfg.budgetTools, budgetMicro: gateway.d.cfg.budgetMicro, pendingVisibility: sc.pendingVisibility }, d.now());
  // stage ③: the appeal is also an account-history event (the agent's history tool counts appeals) and keeps the
  // reason code, which the review row only holds as a hash; one event per appeal review (idempotent). Content without
  // an account still keeps its appeal reason ("(none)" never matches an account-history query).
  if (!out.duplicate) core.synthEventInsert(db, { eventId: `appeal:${out.review.review_id}`, accountId: content.account_id ?? "(none)", kind: "appeal", payload: { content_id: x.contentId, review_id: out.review.review_id, reason_code: x.reasonCode }, eventTime: d.now() });
  return { reviewId: out.review.review_id, duplicate: out.duplicate };
}

/** Claim a human task: `reviewId` names one (404 unknown, 409 closed or held by someone else), otherwise the next one
 *  by severity and due time that is free or already this reviewer's. undefined: nothing to claim. Throws ActionError. */
export function claimTask(d: ActionDeps, reviewerId: string, reviewId?: string): { reviewId: string } | undefined {
  const { db } = d;
  return core.tx(db, () => {
    if (reviewId !== undefined) {
      const q = db.prepare("SELECT review_id, claimed_by, closed_at FROM human_queue WHERE review_id=?").get(reviewId) as { review_id: string; claimed_by: string | null; closed_at: number | null } | undefined;
      if (!q) throw new ActionError(404, "E_REVIEW_NOT_FOUND", `no human task for ${reviewId}`);
      if (q.closed_at !== null) throw new ActionError(409, "E_STATE_INVALID", "task already closed");
      if (q.claimed_by && q.claimed_by !== reviewerId) throw new ActionError(409, "E_LEASE_HELD", `claimed by ${q.claimed_by}`);
      db.prepare("UPDATE human_queue SET claimed_by=?, claimed_at=? WHERE review_id=?").run(reviewerId, d.now(), q.review_id);
      return { reviewId: q.review_id };
    }
    const r = db.prepare("SELECT review_id FROM human_queue WHERE closed_at IS NULL AND (claimed_by IS NULL OR claimed_by=?) ORDER BY severity DESC, due_at LIMIT 1").get(reviewerId) as { review_id: string } | undefined;
    if (r) db.prepare("UPDATE human_queue SET claimed_by=?, claimed_at=? WHERE review_id=?").run(reviewerId, d.now(), r.review_id);
    return r ? { reviewId: r.review_id } : undefined;
  });
}

/** Give a claimed task back; false when it is not claimed by this reviewer or already closed. */
export function unclaimTask(d: ActionDeps, reviewerId: string, reviewId: string): boolean {
  return core.tx(d.db, () => d.db.prepare("UPDATE human_queue SET claimed_by=NULL, claimed_at=NULL WHERE review_id=? AND claimed_by=? AND closed_at IS NULL").run(reviewId, reviewerId).changes) === 1;
}
