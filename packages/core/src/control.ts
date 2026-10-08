// Control loop tick (§6.3): deadlines → T6/S11; expired leases → T7 or T6. Called by G every SCAN_MS; tests call it directly.
import { tx, type Db } from "./db.ts";
import { releaseToHuman, revokeAndRelease, requeue, type Config } from "./review.ts";
import type { ReviewRow } from "./types.ts";
import type { PriceTable } from "./prices.ts";

export type TickResult = { timedOut: string[]; requeued: string[]; revoked: string[] };

export function tick(db: Db, cfg: Config, severityOf: (r: ReviewRow) => number, humanSlaMs: number, at: number, prices?: PriceTable): TickResult {
  const out: TickResult = { timedOut: [], requeued: [], revoked: [] };
  const due = db.prepare("SELECT * FROM review WHERE state IN ('queued','investigating') AND deadline_at < ?").all(at) as ReviewRow[];
  for (const r of due) {
    if (r.state === "queued") releaseToHuman(db, r.review_id, { kind: "control" }, "timeout", severityOf(r), humanSlaMs, at);
    else revokeAndRelease(db, r.review_id, "timeout", severityOf(r), humanSlaMs, at, prices);
    out.timedOut.push(r.review_id);
  }
  const expired = db.prepare("SELECT * FROM review WHERE state='investigating' AND lease_until < ? AND deadline_at >= ?").all(at, at) as ReviewRow[];
  for (const r of expired) {
    if (r.attempt < cfg.maxAttempts) {
      if (requeue(db, r.review_id, cfg, at)) out.requeued.push(r.review_id);
    } else {
      revokeAndRelease(db, r.review_id, "revoked", severityOf(r), humanSlaMs, at, prices);
      out.revoked.push(r.review_id);
    }
  }
  tx(db, () => db.prepare("INSERT INTO control_health(id, last_tick) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET last_tick=excluded.last_tick").run(at));
  return out;
}

export type Backpressure = { queueAgent: number; queueHuman: number; outstanding: number };

export function backpressure(db: Db): Backpressure {
  const q = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    queueAgent: q("SELECT COUNT(*) AS n FROM review WHERE state='queued'"),
    queueHuman: q("SELECT COUNT(*) AS n FROM human_queue WHERE closed_at IS NULL"),
    outstanding: q("SELECT (SELECT COUNT(*) FROM intake WHERE status<>'judged') + (SELECT COUNT(*) FROM review WHERE state IN ('queued','investigating')) AS n"),
  };
}
