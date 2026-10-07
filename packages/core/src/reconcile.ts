// Reconciliation, app.db side (§11.5). Durable-side checks (4, 6) are done by the worker via /sessions or offline.
import type { Db } from "./db.ts";

export type Violation = { check: string; ref: string; detail?: unknown };

export type ReconcileConfig = { scanMs: number; intakeQueueMaxMs: number };

export function instant(db: Db, cfg: ReconcileConfig, at: number): Violation[] {
  const v: Violation[] = [];
  const rows = <T>(sql: string, ...p: unknown[]): T[] => db.prepare(sql).all(...(p as never[])) as T[];

  // 1. no duplicates at the side-effect level
  for (const r of rows<{ event_id: string; n: number }>("SELECT event_id, COUNT(*) AS n FROM consumer_log GROUP BY event_id HAVING n > 1")) v.push({ check: "dup_consumer_log", ref: r.event_id });
  for (const r of rows<{ event_id: string }>("SELECT d.event_id FROM delivery_receipt d LEFT JOIN consumer_log c ON c.event_id=d.event_id GROUP BY d.event_id HAVING COUNT(c.event_id)=0"))
    v.push({ check: "receipt_without_consumer_log", ref: r.event_id });
  for (const r of rows<{ content_id: string; n: number }>("SELECT content_id, SUM(CASE WHEN result='applied' THEN 1 ELSE 0 END) AS n FROM consumer_log WHERE kind='ruling' GROUP BY content_id, seq HAVING n > 1"))
    v.push({ check: "ruling_applied_twice", ref: r.content_id });

  // 2. no regression downstream
  for (const r of rows<{ content_id: string; applied_seq: number; max_sent: number | null; max_acked: number | null }>(
    `SELECT s.content_id, s.applied_seq,
       (SELECT MAX(seq) FROM outbox o WHERE o.content_id=s.content_id AND o.kind='ruling' AND o.status IN ('sent','acked')) AS max_sent,
       (SELECT MAX(seq) FROM outbox o WHERE o.content_id=s.content_id AND o.kind='ruling' AND o.status='acked') AS max_acked
     FROM downstream_state s`)) {
    if (r.applied_seq > (r.max_sent ?? 0) || r.applied_seq < (r.max_acked ?? 0)) v.push({ check: "downstream_regression", ref: r.content_id, detail: r });
  }

  // 3a. conservation (no time limit)
  for (const r of rows<{ content_id: string }>("SELECT c.content_id FROM content c LEFT JOIN intake i ON i.content_id=c.content_id WHERE i.content_id IS NULL")) v.push({ check: "content_without_intake", ref: r.content_id });
  for (const r of rows<{ content_id: string }>("SELECT content_id FROM intake WHERE status='judged' AND judged_review_id IS NULL")) v.push({ check: "judged_without_review", ref: r.content_id });
  for (const r of rows<{ review_id: string }>("SELECT r.review_id FROM review r WHERE r.state='human_queue' AND NOT EXISTS(SELECT 1 FROM human_queue h WHERE h.review_id=r.review_id AND h.closed_at IS NULL)"))
    v.push({ check: "human_queue_without_row", ref: r.review_id });
  for (const r of rows<{ review_id: string }>("SELECT review_id FROM review WHERE state IN ('disposed','human_disposed') AND NOT EXISTS(SELECT 1 FROM ruling WHERE ruling.review_id=review.review_id)"))
    v.push({ check: "terminal_without_ruling", ref: r.review_id });

  // 3b. queue timeouts (explicit limits)
  for (const r of rows<{ content_id: string }>("SELECT content_id FROM intake WHERE status IN ('received','preprocessed') AND created_at < ?", at - cfg.intakeQueueMaxMs)) v.push({ check: "intake_queue_timeout", ref: r.content_id });
  for (const r of rows<{ review_id: string }>("SELECT review_id FROM review WHERE state='queued' AND deadline_at < ?", at - 2 * cfg.scanMs)) v.push({ check: "queued_past_deadline", ref: r.review_id });
  for (const r of rows<{ review_id: string }>("SELECT review_id FROM review WHERE state='investigating' AND lease_until < ?", at - 2 * cfg.scanMs)) v.push({ check: "lease_expired_unhandled", ref: r.review_id });

  // 3c. control loop health
  const h = db.prepare("SELECT last_tick FROM control_health WHERE id=1").get() as { last_tick: number } | undefined;
  if (h && at - h.last_tick > 2 * cfg.scanMs) v.push({ check: "control_loop_stalled", ref: String(h.last_tick) });
  return v;
}

export function final(db: Db): Violation[] {
  const v: Violation[] = [];
  const rows = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
  for (const r of rows<{ content_id: string; effective_seq: number; max_seq: number }>(
    "SELECT c.content_id, c.effective_seq, (SELECT COALESCE(MAX(seq),0) FROM ruling r WHERE r.content_id=c.content_id) AS max_seq FROM content_state c"))
    if (r.effective_seq !== r.max_seq) v.push({ check: "content_state_mismatch", ref: r.content_id, detail: r });
  for (const r of rows<{ content_id: string }>("SELECT content_id FROM ruling WHERE content_id NOT IN (SELECT content_id FROM content_state)")) v.push({ check: "ruling_without_content_state", ref: r.content_id });
  for (const r of rows<{ content_id: string; applied_seq: number; max_acked: number }>(
    "SELECT s.content_id, s.applied_seq, (SELECT COALESCE(MAX(seq),0) FROM outbox o WHERE o.content_id=s.content_id AND o.kind='ruling' AND o.status='acked') AS max_acked FROM downstream_state s"))
    if (r.applied_seq !== r.max_acked) v.push({ check: "downstream_mismatch", ref: r.content_id, detail: r });
  for (const r of rows<{ review_id: string }>(
    `SELECT h.review_id FROM human_queue h WHERE h.closed_at IS NULL AND NOT EXISTS(SELECT 1 FROM downstream_human d WHERE d.review_id=h.review_id AND d.pending=1)
     UNION SELECT d.review_id FROM downstream_human d WHERE d.pending=1 AND NOT EXISTS(SELECT 1 FROM human_queue h WHERE h.review_id=d.review_id AND h.closed_at IS NULL)`))
    v.push({ check: "human_pending_mismatch", ref: r.review_id });
  for (const r of rows<{ event_id: string }>("SELECT event_id FROM outbox WHERE status<>'acked'")) v.push({ check: "outbox_not_drained", ref: r.event_id });
  return v;
}
