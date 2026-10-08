// Where did the agent's time go? (round-9 item 11). For every suspicious review in an app.db: queue wait (created →
// first model request), work time (first model request → ruling/release), model requests, tool calls by tool, repeated
// evidence calls (same evidence tool called more than once), rejected submissions, and how the review ended.
// Model requests are recorded when their response arrives, so "queue wait" includes the first request's latency.
// usage: node --experimental-strip-types scripts/agent-breakdown.ts [app.db]
import * as core from "../packages/core/src/index.ts";

const db = core.openAppDb(process.argv[2] ?? "data/app.db", "tool");
type Row = { review_id: string; state: string; release_reason: string | null; created_at: number; updated_at: number; deadline_at: number; ruled_at: number | null; action: string | null };
const rows = db.prepare(
  `SELECT rv.review_id, rv.state, rv.release_reason, rv.created_at, rv.updated_at, rv.deadline_at, r.created_at AS ruled_at, r.action
   FROM review rv LEFT JOIN ruling r ON r.review_id=rv.review_id WHERE rv.trigger='suspicious' ORDER BY rv.created_at`,
).all() as Row[];

const EVIDENCE = new Set(["get_thread_context", "get_account_history", "load_rule"]);
const pct = (xs: number[], p: number): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : 0; };
const per = rows.map((r) => {
  const mc = db.prepare("SELECT created_at FROM model_call WHERE review_id=? ORDER BY created_at").all(r.review_id) as { created_at: number }[];
  const tools = db.prepare("SELECT tool, status FROM tool_slot WHERE review_id=?").all(r.review_id) as { tool: string; status: string }[];
  const byTool: Record<string, number> = {};
  for (const t of tools) byTool[t.tool] = (byTool[t.tool] ?? 0) + 1;
  const repeatedEvidence = Object.entries(byTool).filter(([k]) => EVIDENCE.has(k)).reduce((a, [, n]) => a + Math.max(0, n - 1), 0);
  const rejected = (db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='submit_rejected' AND ref_id=?").get(r.review_id) as { n: number }).n;
  const end = r.ruled_at ?? r.updated_at;
  const start = mc[0]?.created_at ?? null;
  return {
    outcome: r.action ? `disposed:${r.action}` : `human:${r.release_reason}`,
    queue_ms: start === null ? null : start - r.created_at,
    work_ms: start === null ? null : end - start,
    total_ms: end - r.created_at,
    budget_ms: r.deadline_at - r.created_at,
    model_calls: mc.length,
    tool_calls: tools.length,
    judge_calls: (byTool["judge"] ?? 0) + (byTool["confirm"] ?? 0),
    repeated_evidence: repeatedEvidence,
    blocked: tools.filter((t) => t.status === "blocked").length,
    rejected_submits: rejected,
  };
});

const groups = new Map<string, typeof per>();
for (const p of per) groups.set(p.outcome, [...(groups.get(p.outcome) ?? []), p]);
const summarize = (xs: typeof per) => {
  const q = xs.map((x) => x.queue_ms).filter((v): v is number => v !== null);
  const w = xs.map((x) => x.work_ms).filter((v): v is number => v !== null);
  const sum = (k: keyof (typeof per)[number]) => xs.reduce((a, x) => a + (Number(x[k]) || 0), 0);
  return {
    n: xs.length,
    never_started: xs.filter((x) => x.queue_ms === null).length,
    queue_p50_ms: pct(q, 0.5), queue_p95_ms: pct(q, 0.95),
    work_p50_ms: pct(w, 0.5), work_p95_ms: pct(w, 0.95),
    model_calls_avg: +(sum("model_calls") / xs.length).toFixed(1),
    tool_calls_avg: +(sum("tool_calls") / xs.length).toFixed(1),
    judge_calls_avg: +(sum("judge_calls") / xs.length).toFixed(1),
    repeated_evidence_total: sum("repeated_evidence"),
    rejected_submits_total: sum("rejected_submits"),
    blocked_total: sum("blocked"),
  };
};
console.log(JSON.stringify({
  reviews: per.length,
  deadline_ms: [...new Set(per.map((p) => p.budget_ms))],
  all: summarize(per),
  by_outcome: Object.fromEntries([...groups.entries()].map(([k, v]) => [k, summarize(v)])),
}, null, 1));
