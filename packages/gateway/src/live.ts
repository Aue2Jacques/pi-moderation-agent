// Global live stream of the console (GET /api/events, SSE). One poller is shared by every subscriber, so the cost of
// watching app.db does not grow with the number of open consoles: every `pollMs` it reads a few aggregate counters;
// when they changed (or every `heartbeatMs`, so time-based numbers such as overdue tasks and the per-minute series move
// on), it builds one frame — cumulative stats, the reviews created or updated since the previous frame, per-list change
// counters and the demo traffic status — and sends it to everyone. Lists use the counters to re-read only when they
// changed; the overview applies the frame directly.
import * as core from "@mod/core";
import type { Db } from "@mod/core";
import { listReviews, stats } from "./console-api.ts";
import type { Flow, LiveFrame, ReviewListItem, TrafficStatus } from "./console-types.ts";

export type LiveDeps = {
  db: Db; now: () => number;
  /** how often the counters are read (ms) */
  pollMs?: number;
  /** a frame at least this often even without changes (ms) */
  heartbeatMs?: number;
  /** at most one frame per this many ms (changes in between go out with the next frame) */
  minGapMs?: number;
  traffic?: () => TrafficStatus | null;
  /** fast-path throughput (G's memory) */
  flow?: () => Flow;
};

type Sub = (f: LiveFrame) => void;

export class LiveHub {
  readonly d: LiveDeps;
  readonly #subs = new Set<Sub>();
  #timer: NodeJS.Timeout | undefined;
  #sig = "";
  #lastAt = 0;
  #seq = 0;
  /** incremental cursor over review.updated_at, and the reviews already sent at exactly that time */
  #cursor = 0;
  #atCursor = new Set<string>();

  constructor(d: LiveDeps) { this.d = d; }

  get subscribers(): number { return this.#subs.size; }

  /** Subscribe; the new subscriber gets a snapshot frame (latest reviews as `changed`) right away. */
  subscribe(fn: Sub): () => void {
    this.#subs.add(fn);
    if (this.#subs.size === 1) { this.#cursor = this.d.now(); this.#atCursor = new Set(); }   // first watcher: changes from now on
    fn(this.#frame(this.#versions(), listReviews(this.d.db, { limit: 20, offset: 0 }).items, true));
    if (!this.#timer) {
      this.#timer = setInterval(() => { try { this.tick(); } catch (e) { console.error("live stream", core.redact(e)); } }, this.d.pollMs ?? 500);
      this.#timer.unref();
    }
    return () => {
      this.#subs.delete(fn);
      if (this.#subs.size === 0 && this.#timer) { clearInterval(this.#timer); this.#timer = undefined; }
    };
  }

  #versions(): LiveFrame["versions"] {
    const { db } = this.d;
    const one = (sql: string): Record<string, number | null> => db.prepare(sql).get() as Record<string, number | null>;
    const r = one("SELECT COUNT(*) AS c, MAX(updated_at) AS u FROM review");
    const h = one("SELECT COUNT(*) AS c, COUNT(closed_at) AS x, COUNT(claimed_by) AS y, MAX(created_at) AS a, MAX(closed_at) AS b, MAX(claimed_at) AS d FROM human_queue");
    const a = one("SELECT COUNT(*) AS c, MAX(updated_at) AS u FROM review WHERE trigger='appeal'");
    const i = one("SELECT COUNT(*) AS c, SUM(status='judged') AS j FROM intake");
    const t = this.d.traffic?.() ?? null;
    return {
      reviews: `${r["c"]}.${r["u"] ?? 0}`,
      human: `${h["c"]}.${h["x"]}.${h["y"]}.${h["a"] ?? 0}.${h["b"] ?? 0}.${h["d"] ?? 0}`,
      appeals: `${a["c"]}.${a["u"] ?? 0}`,
      contents: `${i["c"]}.${i["j"] ?? 0}`,
      traffic: t ? `${t.per_sec}.${t.paused ? 1 : 0}.${t.generated}.${t.sim_reviewer.decided}.${t.sim_reviewer.claimed}` : "",
    };
  }

  #frame(versions: LiveFrame["versions"], changed: ReviewListItem[], snapshot: boolean): LiveFrame {
    const now = this.d.now();
    return { seq: ++this.#seq, at: now, snapshot, stats: stats(this.d.db, now), changed, versions, traffic: this.d.traffic?.() ?? null, flow: this.d.flow?.() ?? null };
  }

  /** Reviews changed since the cursor (newest change first), advancing the cursor. */
  #changes(): ReviewListItem[] {
    const rows = listReviews(this.d.db, { updatedSince: this.#cursor, limit: 100, offset: 0 }).items.filter((x) => !(x.updated_at === this.#cursor && this.#atCursor.has(x.review_id)));
    if (!rows.length) return rows;
    const top = Math.max(...rows.map((x) => x.updated_at));
    const at = rows.filter((x) => x.updated_at === top).map((x) => x.review_id);
    this.#atCursor = top === this.#cursor ? new Set([...this.#atCursor, ...at]) : new Set(at);
    this.#cursor = top;
    return rows;
  }

  /** One poll: send a frame when something changed (or on the heartbeat). Exposed for tests. */
  tick(): LiveFrame | undefined {
    if (this.#subs.size === 0) return undefined;
    const now = this.d.now();
    if (now - this.#lastAt < (this.d.minGapMs ?? 800)) return undefined;
    const v = this.#versions();
    const sig = JSON.stringify(v);
    if (sig === this.#sig && now - this.#lastAt < (this.d.heartbeatMs ?? 5000)) return undefined;
    this.#sig = sig;
    this.#lastAt = now;
    const f = this.#frame(v, this.#changes(), false);
    for (const s of this.#subs) { try { s(f); } catch (e) { console.error("live subscriber", core.redact(e)); } }
    return f;
  }
}
