// Stage ④ load test (dev plan 2026-10-08 §6): the running system (G and W processes, real Jev and main model) fed with
// the test split's texts in a loop. Three scenarios:
//   steady <rate>/s for <duration>          does the backlog stay flat (queues, completion, timeouts, cost)?
//   burst  <rate>/s, then <burst>/s for 60 s, then <rate>/s again: backpressure or explicit degradation, then drain
//   recover <rate>/s; W is killed at half time and restarted 30 s later: does it come back within the admission limit?
// Every arrival is a new content id (loops over the texts are counted: first pass vs repeat); account ids rotate over
// 2,000 so the per-account rate limit (30/min) is not what is measured. There is no judge-result cache in the system,
// so a repeated text is a full new request. Samples every 5 s; after arrivals stop, waits for the queues to drain
// (max 15 min). Reports intake, fast-path and full-review rates separately, queue slopes, waiting vs execution time,
// timeouts and cost. Writes <outDir>/<scenario>.json; prints a summary (counts only, no text).
// usage: node --experimental-strip-types scripts/loadtest.ts <outDir> steady|burst|recover <rate> <durationS> [burstRate]
//        (APP_DB = the database G and W use; G_URL; scripts/start.sh starts them)
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "../packages/core/src/index.ts";

const [outDir, scenario, rateS, durS, burstS] = process.argv.slice(2);
if (!outDir || !scenario || !rateS || !durS) throw new Error("usage: loadtest.ts <outDir> steady|burst|recover <rate> <durationS> [burstRate]");
const RATE = Number(rateS), DUR = Number(durS) * 1000, BURST = Number(burstS ?? RATE * 3);
const db = core.openAppDb(process.env.APP_DB ?? "data/app.db", "tool");
core.ensureSchema(db);
mkdirSync(outDir, { recursive: true });
const ids = new Set(readFileSync("data/eval/test-v1-ids.txt", "utf8").split("\n").filter(Boolean));
const texts = readFileSync("data/eval/eval20k.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; text: string }).filter((x) => ids.has(x.id)).map((x) => x.text);
const RUN = core.sha256(`${Date.now()}:${process.pid}`).slice(0, 6);
const prefix = `lt-${RUN}-`;
let sent = 0;
const t0 = Date.now();
const q = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).get(...(a as [])) as T;
const sample = () => {
  const like = `${prefix}%`;
  const n = (sql: string) => (q<{ n: number }>(sql, like)).n;
  return {
    t_s: Math.round((Date.now() - t0) / 1000), sent,
    intake_backlog: n("SELECT COUNT(*) AS n FROM intake WHERE content_id LIKE ? AND status<>'judged'"),
    fast_done: n("SELECT COUNT(*) AS n FROM intake WHERE content_id LIKE ? AND status='judged'"),
    agent_queued: n("SELECT COUNT(*) AS n FROM review WHERE content_id LIKE ? AND state='queued'"),
    agent_running: n("SELECT COUNT(*) AS n FROM review WHERE content_id LIKE ? AND state='investigating'"),
    human_open: n("SELECT COUNT(*) AS n FROM review r JOIN human_queue h ON h.review_id=r.review_id WHERE r.content_id LIKE ? AND h.closed_at IS NULL"),
    terminal: n("SELECT COUNT(*) AS n FROM review WHERE content_id LIKE ? AND state IN ('disposed','human_queue','human_disposed')"),
  };
};
const series: ReturnType<typeof sample>[] = [];
const sampler = setInterval(() => series.push(sample()), 5000);
const events: { t_s: number; what: string }[] = [];
const rateAt = (ms: number) => (scenario === "burst" && ms >= DUR / 3 && ms < DUR / 3 + 60_000 ? BURST : RATE);
let killed = false, restarted = false;
while (Date.now() - t0 < DUR) {
  const el = Date.now() - t0;
  if (scenario === "recover" && !killed && el >= DUR / 2) {
    try { execSync("kill $(cat run/w.pid)"); } catch { /* already gone */ }
    killed = true; events.push({ t_s: Math.round(el / 1000), what: "W killed" });
  }
  if (scenario === "recover" && killed && !restarted && el >= DUR / 2 + 30_000) {
    execSync("bash scripts/start.sh w", { stdio: "ignore" });
    restarted = true; events.push({ t_s: Math.round(el / 1000), what: "W restarted" });
  }
  const i = sent++;
  core.intakeInsert(db, { contentId: `${prefix}${i}`, scene: "comment", text: texts[i % texts.length]!, accountId: `lt-acc-${i % 2000}`, eventTime: Date.now() }, Date.now());
  await new Promise((r) => setTimeout(r, -Math.log(1 - Math.random()) * 1000 / rateAt(el)));   // Poisson arrivals
}
const arrivalsEnd = Date.now();
events.push({ t_s: Math.round((arrivalsEnd - t0) / 1000), what: "arrivals stopped" });
// drain
while (Date.now() - arrivalsEnd < 15 * 60_000) {
  const s = sample();
  if (s.intake_backlog === 0 && s.agent_queued === 0 && s.agent_running === 0) break;
  await new Promise((r) => setTimeout(r, 5000));
}
clearInterval(sampler);
series.push(sample());
const drainedAt = Date.now();
// per-review timings: fast path = intake created -> judged; agent wait = review created -> first model call; agent exec =
// first model call -> ruling / release; end to end = intake created -> terminal
const like = `${prefix}%`;
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : null; };
const fast = db.prepare("SELECT i.updated_at - i.created_at AS ms FROM intake i WHERE i.content_id LIKE ? AND i.status='judged'").all(like) as { ms: number }[];
const agent = db.prepare(`SELECT r.created_at AS c, (SELECT MIN(created_at) FROM model_call m WHERE m.review_id=r.review_id) AS m0, r.updated_at AS u, r.state, r.release_reason AS rr
  FROM review r WHERE r.content_id LIKE ? AND r.trigger='suspicious'`).all(like) as { c: number; m0: number | null; u: number; state: string; rr: string | null }[];
const ran = agent.filter((a) => a.m0 !== null);
const states = Object.fromEntries((db.prepare("SELECT state, COUNT(*) AS n FROM review WHERE content_id LIKE ? GROUP BY state").all(like) as { state: string; n: number }[]).map((r) => [r.state, r.n]));
const releases = Object.fromEntries((db.prepare("SELECT COALESCE(release_reason,'-') AS r, COUNT(*) AS n FROM review WHERE content_id LIKE ? AND state IN ('human_queue','human_disposed') GROUP BY r").all(like) as { r: string; n: number }[]).map((r) => [r.r, r.n]));
const fastDecisions = Object.fromEntries((db.prepare("SELECT trigger || ':' || state AS k, COUNT(*) AS n FROM review WHERE content_id LIKE ? GROUP BY k").all(like) as { k: string; n: number }[]).map((r) => [r.k, r.n]));
// fast-path judge calls only (attempt IS NULL); the agent's judge calls are inside the reviews' used_micro (ledger)
const judgeMicro = (q<{ m: number }>("SELECT COALESCE(SUM(cost_micro),0) AS m FROM judge_call WHERE content_id LIKE ? AND attempt IS NULL", like)).m;
const usedMicro = (q<{ m: number }>("SELECT COALESCE(SUM(used_micro),0) AS m FROM review WHERE content_id LIKE ? AND trigger='suspicious'", like)).m;
const steadyWindow = series.filter((s) => s.t_s >= 30 && s.t_s <= DUR / 1000);
const slope = (k: "intake_backlog" | "agent_queued") => { const xs = steadyWindow.map((s) => s.t_s), ys = steadyWindow.map((s) => s[k]); const n = xs.length; if (n < 3) return null; const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n; const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0), den = xs.reduce((a, x) => a + (x - mx) ** 2, 0); return den ? +(num / den).toFixed(3) : null; };
const summary = {
  scenario, rate: RATE, burst: scenario === "burst" ? BURST : null, duration_s: DUR / 1000, run: RUN, events,
  arrivals: { sent, achieved_rate: +(sent / ((arrivalsEnd - t0) / 1000)).toFixed(2), first_pass: Math.min(sent, texts.length), repeats: Math.max(0, sent - texts.length) },
  fastpath: { done: fast.length, rate_per_s: +(fast.length / ((drainedAt - t0) / 1000)).toFixed(2), p50_ms: pct(fast.map((f) => f.ms), 0.5), p95_ms: pct(fast.map((f) => f.ms), 0.95), decisions: fastDecisions },
  agent: { reviews: agent.length, started: ran.length, wait_p50_s: pct(ran.map((a) => (a.m0! - a.c) / 1000), 0.5), wait_p95_s: pct(ran.map((a) => (a.m0! - a.c) / 1000), 0.95),
    exec_p50_s: pct(ran.map((a) => (a.u - a.m0!) / 1000), 0.5), exec_p95_s: pct(ran.map((a) => (a.u - a.m0!) / 1000), 0.95) },
  states, releases, slope_per_s: { intake_backlog: slope("intake_backlog"), agent_queued: slope("agent_queued") },
  drain_s: Math.round((drainedAt - arrivalsEnd) / 1000), drained: series[series.length - 1]!.intake_backlog === 0 && series[series.length - 1]!.agent_queued === 0 && series[series.length - 1]!.agent_running === 0,
  cost_yuan: { fastpath_judge: judgeMicro / 1e6, agent_reviews_ledger: usedMicro / 1e6, per_item: +((judgeMicro + usedMicro) / 1e6 / Math.max(1, sent)).toFixed(5) },
  reconcile: core.reconcile.instant(db, { scanMs: 2000, intakeQueueMaxMs: 3_600_000 }, Date.now()).map((v) => v.check),
};
writeFileSync(join(outDir, `${scenario}-${RUN}.json`), JSON.stringify({ summary, series }, null, 1));
console.log(JSON.stringify(summary, null, 1));
