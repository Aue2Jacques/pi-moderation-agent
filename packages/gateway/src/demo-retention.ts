// Demo retention (demo mode only): with the traffic running for hours app.db would grow without bound, and every live
// frame's counts would get slower. Every `everyMs` the oldest finished simulated contents beyond the newest `keep` are
// removed with everything hanging off them (reviews, rulings, judge calls, evidence, tool slots, human tasks, outbox and
// downstream rows). Before the delete, the same transaction adds their counters (console-api statCounts: contents,
// routes, effective actions, release reasons, costs, the per-minute series, ...) to `console_rollup`, which stats()
// adds back — the totals on the console stay continuous and exact. Kept as they are:
// - a person's submissions (only `sim-` contents are removed) and anything not finished (a review still queued,
//   investigating or waiting for a person, an undelivered outbox event, or a change in the last minute);
// - the audit log: it is append-only by design (a trigger refuses deletes, rows are hash-chained), so it keeps one row
//   per ruling — the one table that still grows (docs/console-2026-10-09.md §6.4).
// The constructor refuses any mode but "demo": real mode never deletes anything.
import { statSync } from "node:fs";
import * as core from "@mod/core";
import type { Db } from "@mod/core";
import { statCounts } from "./console-api.ts";
import type { RetentionStatus } from "./console-types.ts";
import { SIM_PREFIX } from "./demo-traffic.ts";

export type RetentionConfig = {
  /** simulated contents to keep (the newest); 0 = retention off */
  keep: number;
  /** how often to check (ms) */
  everyMs: number;
  /** at most this many contents removed per run */
  batch: number;
  /** a content whose reviews changed within this many ms is kept (W may still settle its cost) */
  quietMs: number;
};
export const DEFAULT_RETENTION: RetentionConfig = { keep: 4000, everyMs: 5_000, batch: 600, quietMs: 60_000 };

/** Series keys older than this many minutes are dropped from the rollup (the console shows 30). */
const SERIES_KEEP_MIN = 60;

export class DemoRetention {
  readonly d: { db: Db; now: () => number; dbPath?: string };
  readonly cfg: RetentionConfig;
  #timer: NodeJS.Timeout | undefined;
  #pruned = 0;
  #runs = 0;
  #lastAt: number | null = null;
  #lastMs: number | null = null;
  #bytes: number | null = null;

  constructor(d: { db: Db; now: () => number; dbPath?: string; mode: "demo" | "real" }, cfg: Partial<RetentionConfig> = {}) {
    if (d.mode !== "demo") throw new Error("demo retention runs in demo mode only");
    this.d = d;
    this.cfg = { ...DEFAULT_RETENTION, ...cfg };
    d.db.exec("CREATE TABLE IF NOT EXISTS console_rollup (key TEXT PRIMARY KEY, n INTEGER NOT NULL)");
  }

  start(): void {
    if (this.cfg.keep <= 0 || this.#timer) return;
    this.#timer = setInterval(() => { try { this.runOnce(); } catch (e) { console.error("demo retention", core.redact(e)); } }, this.cfg.everyMs);
    this.#timer.unref();
  }

  stop(): void { clearInterval(this.#timer); this.#timer = undefined; }

  /** One pass; returns how many simulated contents were removed. */
  runOnce(): number {
    if (this.cfg.keep <= 0) return 0;
    const { db } = this.d;
    const t0 = Date.now();
    const now = this.d.now();
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM intake WHERE content_id LIKE '${SIM_PREFIX}%'`).get() as { n: number }).n;
    const excess = Math.min(total - this.cfg.keep, this.cfg.batch);
    let removed = 0;
    if (excess > 0) {
      const ids = (db.prepare(
        `SELECT i.content_id FROM intake i WHERE i.content_id LIKE '${SIM_PREFIX}%' AND i.status='judged'
           AND NOT EXISTS (SELECT 1 FROM review r WHERE r.content_id=i.content_id AND (r.state NOT IN ('disposed','human_disposed') OR r.updated_at > ?))
           AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.content_id=i.content_id AND o.status IN ('pending','sent'))
         ORDER BY i.created_at LIMIT ?`).all(now - this.cfg.quietMs, excess) as { content_id: string }[]).map((r) => r.content_id);
      if (ids.length) removed = core.tx(db, () => this.#remove(ids, now));
    }
    this.#pruned += removed;
    this.#runs++;
    this.#lastAt = now;
    this.#lastMs = Date.now() - t0;
    if (this.d.dbPath) {
      const size = (p: string): number => { try { return statSync(p).size; } catch { return 0; } };
      this.#bytes = size(this.d.dbPath) + size(`${this.d.dbPath}-wal`);
    }
    return removed;
  }

  #remove(ids: string[], now: number): number {
    const { db } = this.d;
    db.exec("CREATE TEMP TABLE IF NOT EXISTS prune_c (content_id TEXT PRIMARY KEY); CREATE TEMP TABLE IF NOT EXISTS prune_r (review_id TEXT PRIMARY KEY); DELETE FROM prune_c; DELETE FROM prune_r;");
    const ins = db.prepare("INSERT OR IGNORE INTO prune_c(content_id) VALUES (?)");
    for (const id of ids) ins.run(id);
    db.exec("INSERT OR IGNORE INTO prune_r(review_id) SELECT review_id FROM review WHERE content_id IN (SELECT content_id FROM prune_c)");
    // counters first, in the same transaction as the delete: the totals never dip or double
    const add = db.prepare("INSERT INTO console_rollup(key, n) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET n = n + excluded.n");
    for (const [k, v] of Object.entries(statCounts(db, now, "prune_c"))) if (v) add.run(k, v);
    const oldest = Math.floor(now / 60_000) - SERIES_KEEP_MIN;
    const del = db.prepare("DELETE FROM console_rollup WHERE key=?");
    for (const { key } of db.prepare("SELECT key FROM console_rollup WHERE key LIKE 'series:%'").all() as { key: string }[]) if (Number(key.split(":")[1]) < oldest) del.run(key);
    // children before parents (foreign keys are on)
    const R = "(SELECT review_id FROM prune_r)", C = "(SELECT content_id FROM prune_c)";
    db.exec(`
      DELETE FROM judge_answer WHERE judge_call_id IN (SELECT judge_call_id FROM judge_call WHERE content_id IN ${C});
      DELETE FROM judge_call WHERE content_id IN ${C};
      DELETE FROM tool_request WHERE review_id IN ${R};
      DELETE FROM tool_slot WHERE review_id IN ${R};
      DELETE FROM evidence WHERE review_id IN ${R};
      DELETE FROM model_call WHERE review_id IN ${R};
      DELETE FROM feedback WHERE review_id IN ${R};
      DELETE FROM human_queue WHERE review_id IN ${R};
      DELETE FROM worker_command WHERE review_id IN ${R};
      DELETE FROM consumer_log WHERE review_id IN ${R};
      DELETE FROM downstream_human WHERE review_id IN ${R};
      DELETE FROM delivery_receipt WHERE event_id IN (SELECT event_id FROM outbox WHERE review_id IN ${R});
      DELETE FROM outbox WHERE review_id IN ${R};
      DELETE FROM ruling WHERE review_id IN ${R};
      DELETE FROM synth_event WHERE event_id IN (SELECT 'appeal:' || review_id FROM prune_r);
      DELETE FROM review WHERE review_id IN ${R};
      DELETE FROM downstream_state WHERE content_id IN ${C};
      DELETE FROM content_state WHERE content_id IN ${C};
      DELETE FROM intake WHERE content_id IN ${C};
      DELETE FROM content WHERE content_id IN ${C} OR content_id IN (SELECT content_id || '.parent' FROM prune_c);
      DELETE FROM prune_c; DELETE FROM prune_r;`);
    return ids.length;
  }

  status(): RetentionStatus {
    return { keep: this.cfg.keep, every_ms: this.cfg.everyMs, pruned: this.#pruned, runs: this.#runs, last_at: this.#lastAt, last_ms: this.#lastMs, db_bytes: this.#bytes };
  }
}
