// Outbox dispatcher (T8). At-least-once: mark sent → deliver → mark acked. CRASH_AT=D sits between deliver and ack.
import { tx, type Db } from "./db.ts";
import type { OutboxEvent } from "./consumer.ts";

export type Deliver = (ev: OutboxEvent) => void;

export type DispatchOptions = { maxAttempts?: number; backoffMs?: (attempt: number) => number; crashBeforeAck?: () => void };

/** Dispatch one due event. Returns false when nothing is due. */
export function dispatchOnce(db: Db, deliver: Deliver, at: number, opts: DispatchOptions = {}): boolean {
  const maxAttempts = opts.maxAttempts ?? 10;
  const backoff = opts.backoffMs ?? ((n: number) => Math.min(60_000, 500 * 2 ** n));
  const ev = tx(db, () => {
    const row = db.prepare("SELECT event_id, review_id, content_id, seq, kind, payload, attempts FROM outbox WHERE status IN ('pending','sent') AND next_at <= ? ORDER BY next_at LIMIT 1").get(at) as (OutboxEvent & { attempts: number }) | undefined;
    if (!row) return undefined;
    db.prepare("UPDATE outbox SET status='sent', attempts=attempts+1, next_at=? WHERE event_id=?").run(at + backoff(row.attempts + 1), row.event_id);
    return row;
  });
  if (!ev) return false;
  try {
    deliver(ev);
  } catch {
    tx(db, () => {
      if (ev.attempts + 1 >= maxAttempts) db.prepare("UPDATE outbox SET status='dead' WHERE event_id=?").run(ev.event_id);
    });
    return true;
  }
  opts.crashBeforeAck?.();
  tx(db, () => db.prepare("UPDATE outbox SET status='acked' WHERE event_id=? AND status='sent'").run(ev.event_id));
  return true;
}

export function drain(db: Db, deliver: Deliver, at: number, opts: DispatchOptions = {}): number {
  let n = 0;
  while (dispatchOnce(db, deliver, at + n, opts)) n++;
  return n;
}
