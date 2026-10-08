// Process G: intake → fast path, control loop, outbox dispatch (to the simulated downstream), backpressure, metrics. docs §6.1/§6.3.
import * as core from "@mod/core";
import type { Db, PolicyBundle, PriceTable, ReviewRow } from "@mod/core";
import { crashAt, type JudgeClient } from "@mod/worker";
import { runFastpath, type FastpathOutcome } from "./fastpath.ts";
import { Blacklist, RateLimit, SimhashIndex } from "./preprocess.ts";

export type GatewayConfig = {
  scanMs: number; intakeBatch: number; intakeConcurrency: number;
  queueAgentMax: number; queueHumanMax: number; outstandingMax: number;
  maxAttempts: number; budgetTools: number; budgetMicro: number;
  blacklist: string[]; rateMaxPerMinute: number;
};

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  scanMs: 2000, intakeBatch: 16, intakeConcurrency: 8, queueAgentMax: 50, queueHumanMax: 500, outstandingMax: 2000,
  maxAttempts: 3, budgetTools: 12, budgetMicro: 50_000, blacklist: [], rateMaxPerMinute: 30,
};

export type GatewayDeps = { db: Db; bundle: PolicyBundle; ruleTexts?: Record<string, string>; judge: JudgeClient; prices: PriceTable; calibrator: core.Calibrator; evidenceVer: string; judgeModel: string; cfg: GatewayConfig; now: () => number; gatewayId: string };

/**
 * Metric definitions (round-9 item 8). Window = last 300 s unless stated.
 * - pass_pct / block_pct / suspicious_pct: share of fast-path outcomes in the last 60 s (G side only; suspicious = handed to the agent).
 * - release_pct: share of ALL content judged in the window whose review ended in human hands, from either process:
 *   G direct releases (judge_down / backpressure / preprocess_error / image_unsupported) and W releases (evidence_gap / timeout / budget_* / model_release / revoked).
 *   release_by_reason breaks that down; release_fast_pct and release_agent_pct split by source.
 * - cost_micro_per_1k: total cost of the content stream in the window (fast-path judge calls + every review's used_micro) ÷ content judged in the window × 1000.
 *   Reviews whose cost is still 'estimated' are included and counted in cost_estimated_reviews.
 */
export type Metrics = {
  at: number; intake_rate: number; fast_rate: number; agent_rate: number;
  pass_pct: number; block_pct: number; suspicious_pct: number;
  release_pct: number; release_fast_pct: number; release_agent_pct: number; release_by_reason: Record<string, number>;
  queue_intake: number; queue_agent: number; queue_human: number; outstanding_total: number; replay_paused: boolean;
  p50_fast: number; p95_fast: number; p50_agent: number; p95_agent: number;
  cost_micro_per_1k: number; cost_micro_window: number; cost_denominator: number; cost_estimated_reviews: number;
  judge_abstain_pct: number; over_budget_count: number; outbox_pending: number;
  calib_ver: string; calib_mode: "strict" | "identity"; rules_ver: string;
};

export class Gateway {
  readonly d: GatewayDeps;
  readonly blacklist: Blacklist;
  readonly index = new SimhashIndex();
  readonly rate: RateLimit;
  readonly recent: { at: number; decision: FastpathOutcome["decision"]; latencyMs: number }[] = [];
  replayPaused = false;
  #timers: NodeJS.Timeout[] = [];
  #busy = false;

  constructor(d: GatewayDeps) {
    this.d = d;
    this.blacklist = new Blacklist(d.cfg.blacklist);
    this.rate = new RateLimit(d.cfg.rateMaxPerMinute, 60_000);
    // round-9 item 12: every bundle version G runs with is stored so W can continue reviews pinned to older versions
    core.storeBundle(d.db, d.bundle, d.ruleTexts ?? {}, d.now());
  }

  get pins(): core.Pins {
    return { rulesVer: this.d.bundle.rulesVer, calibVer: this.d.calibrator.calibVer, evidenceVer: this.d.evidenceVer, pricesVer: this.d.prices.pricesVer };
  }

  backpressure(): { agentFull: boolean; pause: boolean } & core.control.Backpressure {
    const b = core.control.backpressure(this.d.db);
    return { ...b, agentFull: b.queueAgent >= this.d.cfg.queueAgentMax, pause: b.queueHuman >= this.d.cfg.queueHumanMax || b.outstanding >= this.d.cfg.outstandingMax };
  }

  /** Lease a batch of received intake rows to this gateway and run the fast path with bounded concurrency. */
  async processIntakeOnce(): Promise<FastpathOutcome[]> {
    if (this.#busy) return [];
    this.#busy = true;
    try {
      const db = this.d.db;
      const now = this.d.now();
      const rows = core.tx(db, () => {
        const picked = db.prepare("SELECT content_id FROM intake WHERE status IN ('received','preprocessed') AND (lease_until IS NULL OR lease_until < ?) ORDER BY prio, created_at LIMIT ?").all(now, this.d.cfg.intakeBatch) as { content_id: string }[];
        const upd = db.prepare("UPDATE intake SET lease_owner=?, lease_until=?, attempts=attempts+1, updated_at=? WHERE content_id=?");
        for (const r of picked) upd.run(this.d.gatewayId, now + 60_000, now, r.content_id);
        return picked.map((r) => r.content_id);
      });
      const out: FastpathOutcome[] = [];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(this.d.cfg.intakeConcurrency, rows.length) }, async () => {
        while (next < rows.length) {
          const id = rows[next++]!;
          try {
            const o = await runFastpath({ db, bundle: this.d.bundle, judge: this.d.judge, prices: this.d.prices, pins: this.pins, judgeModel: this.d.judgeModel, calibrator: this.d.calibrator, blacklist: this.blacklist, index: this.index, rate: this.rate,
              backpressure: () => this.backpressure(), budgetTools: this.d.cfg.budgetTools, budgetMicro: this.d.cfg.budgetMicro, now: this.d.now }, id);
            out.push(o);
            this.recent.push({ at: this.d.now(), decision: o.decision, latencyMs: o.latencyMs });
          } catch (e) {
            console.error("fastpath failed", id, core.redact(e));
            core.tx(db, () => db.prepare("UPDATE intake SET lease_owner=NULL, lease_until=NULL, updated_at=? WHERE content_id=? AND status<>'judged'").run(this.d.now(), id));
          }
        }
      }));
      while (this.recent.length && this.recent[0]!.at < this.d.now() - 300_000) this.recent.shift();
      return out;
    } finally {
      this.#busy = false;
    }
  }

  tickControl(): core.control.TickResult {
    const cfg: core.Config = { ...core.DEFAULT_CONFIG, maxAttempts: this.d.cfg.maxAttempts, scanMs: this.d.cfg.scanMs };
    const sev = (r: ReviewRow): number => this.d.bundle.scenes[(core.readContent(this.d.db, r.content_id)?.scene ?? "comment") as core.Scene].defaultSeverity;
    const res = core.control.tick(this.d.db, cfg, sev, 3_600_000, this.d.now(), this.d.prices);
    const bp = this.backpressure();
    this.replayPaused = bp.pause ? true : bp.outstanding < this.d.cfg.outstandingMax * 0.8 && bp.queueHuman < this.d.cfg.queueHumanMax * 0.8 ? false : this.replayPaused;
    return res;
  }

  /** Deliver pending outbox events to the simulated downstream (same db, separate tables). */
  dispatchOutbox(max = 100): number {
    let n = 0;
    while (n < max && core.outbox.dispatchOnce(this.d.db, (ev) => void core.consumer.apply(this.d.db, ev, this.d.now()), this.d.now(), { crashBeforeAck: () => crashAt("D") })) n++;
    return n;
  }

  metrics(): Metrics {
    const db = this.d.db;
    const now = this.d.now();
    const W = 300_000;
    const q = (sql: string, ...p: unknown[]): number => (db.prepare(sql).get(...(p as never[])) as { n: number }).n;
    const win = this.recent.filter((r) => r.at > now - 60_000);
    const pct = (k: FastpathOutcome["decision"]): number => (win.length ? Math.round((100 * win.filter((r) => r.decision === k).length) / win.length) : 0);
    const lat = win.map((r) => r.latencyMs).sort((a, b) => a - b);
    const pc = (xs: number[], p: number): number => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]! : 0);
    const agentDone = db.prepare("SELECT (COALESCE(r.created_at, rv.updated_at) - rv.created_at) AS ms FROM review rv LEFT JOIN ruling r ON r.review_id=rv.review_id WHERE rv.trigger='suspicious' AND rv.state IN ('disposed','human_queue','human_disposed') AND rv.updated_at > ?").all(now - W) as { ms: number }[];
    const al = agentDone.map((r) => r.ms).sort((a, b) => a - b);
    // denominator: content judged in the window (every item leaves intake exactly once)
    const judged = q("SELECT COUNT(*) AS n FROM intake WHERE status='judged' AND updated_at > ?", now - W);
    // releases from both processes, by reason, over reviews that entered human hands in the window
    const byReason: Record<string, number> = {};
    for (const r of db.prepare("SELECT release_reason AS reason, COUNT(*) AS n FROM review WHERE release_reason IS NOT NULL AND state IN ('human_queue','human_disposed') AND updated_at > ? GROUP BY release_reason").all(now - W) as { reason: string; n: number }[]) byReason[r.reason] = r.n;
    const fastReasons = new Set(["judge_down", "backpressure", "preprocess_error", "image_unsupported"]);
    const relFast = Object.entries(byReason).filter(([k]) => fastReasons.has(k)).reduce((a, [, n]) => a + n, 0);
    const relAgent = Object.entries(byReason).filter(([k]) => !fastReasons.has(k)).reduce((a, [, n]) => a + n, 0);
    const share = (n: number): number => (judged ? Math.round((100 * n) / judged) : 0);
    // cost: fast-path judge calls (review_id NULL) + every review's used_micro, both inside the window
    const fastCost = (db.prepare("SELECT COALESCE(SUM(cost_micro),0) AS n FROM judge_call WHERE review_id IS NULL AND created_at > ?").get(now - W) as { n: number }).n;
    const revCost = db.prepare("SELECT COALESCE(SUM(used_micro),0) AS s, SUM(CASE WHEN cost_status='estimated' THEN 1 ELSE 0 END) AS est FROM review WHERE used_micro IS NOT NULL AND updated_at > ?").get(now - W) as { s: number; est: number | null };
    const abst = db.prepare("SELECT SUM(CASE WHEN status<>'ok' THEN 1 ELSE 0 END) AS a, COUNT(*) AS n FROM judge_call WHERE created_at > ?").get(now - W) as { a: number | null; n: number };
    const bp = this.backpressure();
    const costWindow = fastCost + revCost.s;
    return {
      at: now, intake_rate: q("SELECT COUNT(*) AS n FROM intake WHERE created_at > ?", now - 60_000) / 60, fast_rate: win.length / 60, agent_rate: agentDone.length / 300,
      pass_pct: pct("pass"), block_pct: pct("block"), suspicious_pct: pct("suspicious"),
      release_pct: share(relFast + relAgent), release_fast_pct: share(relFast), release_agent_pct: share(relAgent), release_by_reason: byReason,
      queue_intake: q("SELECT COUNT(*) AS n FROM intake WHERE status<>'judged'"), queue_agent: bp.queueAgent, queue_human: bp.queueHuman, outstanding_total: bp.outstanding, replay_paused: this.replayPaused,
      p50_fast: pc(lat, 0.5), p95_fast: pc(lat, 0.95), p50_agent: pc(al, 0.5), p95_agent: pc(al, 0.95),
      cost_micro_per_1k: judged ? Math.round((costWindow / judged) * 1000) : 0, cost_micro_window: costWindow, cost_denominator: judged, cost_estimated_reviews: revCost.est ?? 0,
      judge_abstain_pct: abst.n ? Math.round((100 * (abst.a ?? 0)) / abst.n) : 0,
      over_budget_count: q("SELECT COUNT(*) AS n FROM review WHERE over_budget_micro > 0"), outbox_pending: q("SELECT COUNT(*) AS n FROM outbox WHERE status IN ('pending','sent')"),
      calib_ver: this.d.calibrator.calibVer, calib_mode: this.d.calibrator.mode, rules_ver: this.d.bundle.rulesVer,
    };
  }

  startLoops(o: { intakeMs?: number; dispatchMs?: number; metricsMs?: number } = {}): void {
    const safe = (fn: () => unknown) => () => { Promise.resolve().then(fn).catch((e) => console.error("gateway loop error", core.redact(e))); };
    this.#timers.push(setInterval(safe(() => this.processIntakeOnce()), o.intakeMs ?? 500));
    this.#timers.push(setInterval(safe(() => this.tickControl()), this.d.cfg.scanMs));
    this.#timers.push(setInterval(safe(() => this.dispatchOutbox()), o.dispatchMs ?? 500));
    this.#timers.push(setInterval(safe(() => {
      const m = this.metrics();
      const minute = Math.floor(m.at / 60_000);
      core.tx(this.d.db, () => this.d.db.prepare("INSERT INTO metrics_minute(minute, payload) VALUES (?,?) ON CONFLICT(minute) DO UPDATE SET payload=excluded.payload").run(minute, JSON.stringify(m)));
    }), o.metricsMs ?? 10_000));
    for (const t of this.#timers) t.unref();
  }
  stopLoops(): void {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
  }
}
