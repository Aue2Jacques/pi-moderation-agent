// T10: simulated downstream endpoint. docs/dev-doc-v1.md §4 "T10 消费规则".
import { tx, type Db } from "./db.ts";

export type OutboxEvent = { event_id: string; review_id: string; content_id: string; seq: number; kind: "ruling" | "release"; payload: string };
export type ConsumerResult = "applied" | "stale" | "notified" | "stale_notification";

export function apply(db: Db, ev: OutboxEvent, at: number): { result: ConsumerResult; duplicate: boolean } {
  return tx(db, () => {
    db.prepare("INSERT INTO delivery_receipt(event_id, received_at) VALUES (?,?)").run(ev.event_id, at);
    const prior = db.prepare("SELECT result FROM consumer_log WHERE event_id=?").get(ev.event_id) as { result: ConsumerResult } | undefined;
    if (prior) return { result: prior.result, duplicate: true };
    let result: ConsumerResult;
    if (ev.kind === "ruling") {
      const action = (JSON.parse(ev.payload) as { action: string }).action;
      const st = db.prepare("SELECT applied_seq FROM downstream_state WHERE content_id=?").get(ev.content_id) as { applied_seq: number } | undefined;
      if (ev.seq > (st?.applied_seq ?? 0)) {
        db.prepare("INSERT INTO downstream_state(content_id, applied_action, applied_seq, updated_at) VALUES (?,?,?,?) ON CONFLICT(content_id) DO UPDATE SET applied_action=excluded.applied_action, applied_seq=excluded.applied_seq, updated_at=excluded.updated_at")
          .run(ev.content_id, action, ev.seq, at);
        result = "applied";
      } else result = "stale";
      db.prepare("INSERT INTO downstream_human(review_id, content_id, pending, closed_by, updated_at) VALUES (?,?,0,?,?) ON CONFLICT(review_id) DO UPDATE SET pending=0, closed_by=excluded.closed_by, updated_at=excluded.updated_at")
        .run(ev.review_id, ev.content_id, ev.event_id, at);
    } else {
      const ruled = db.prepare("SELECT 1 FROM consumer_log WHERE review_id=? AND kind='ruling'").get(ev.review_id);
      if (ruled) result = "stale_notification";
      else {
        db.prepare("INSERT INTO downstream_human(review_id, content_id, pending, opened_by, updated_at) VALUES (?,?,1,?,?) ON CONFLICT(review_id) DO UPDATE SET pending=1, opened_by=excluded.opened_by, updated_at=excluded.updated_at")
          .run(ev.review_id, ev.content_id, ev.event_id, at);
        result = "notified";
      }
    }
    db.prepare("INSERT INTO consumer_log(event_id, kind, review_id, content_id, seq, result, created_at) VALUES (?,?,?,?,?,?,?)").run(ev.event_id, ev.kind, ev.review_id, ev.content_id, ev.seq, result, at);
    return { result, duplicate: false };
  });
}

export function humanPending(db: Db, contentId: string): boolean {
  return !!db.prepare("SELECT 1 FROM downstream_human WHERE content_id=? AND pending=1 LIMIT 1").get(contentId);
}
