// A recorded harness run (HARNESS_RECORD_DB): the app.db of a real run — real fast path (Jev), real agent model, the
// real harness — over a balanced set of real texts (scripts/build-harness-set.py + scripts/run-ac.ts). Read only. The
// console's Agent page replays its sessions and shows what the harness did across all of them; the numbers here are
// counts over that one run, not a live window.
import { DatabaseSync } from "node:sqlite";
import * as core from "@mod/core";
import type { PolicyBundle } from "@mod/core";
import { buildTimeline } from "./console-api.ts";
import type { ContentTimeline } from "./console-types.ts";

import { RECORD_CATEGORIES, type HarnessRecord, type RecordCategory, type RecordSession } from "./console-types.ts";
export { RECORD_CATEGORIES, type HarnessRecord, type RecordCategory, type RecordSession };

const categoryOf = (contentId: string): RecordCategory | "other" => {
  const m = /^h\d+-([a-z_]+)-\d+$/.exec(contentId);
  return m && (RECORD_CATEGORIES as readonly string[]).includes(m[1]!) ? (m[1] as RecordCategory) : "other";
};
const pct = (xs: number[], q: number): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]!; };

export class HarnessRecordStore {
  readonly db: DatabaseSync;
  readonly bundleOf: (v: string) => PolicyBundle | undefined;
  #summary: HarnessRecord | null = null;
  constructor(path: string, bundleOf: (v: string) => PolicyBundle | undefined) {
    this.db = new DatabaseSync(path, { readOnly: true });
    this.bundleOf = bundleOf;
  }

  summary(): HarnessRecord {
    if (this.#summary) return this.#summary;
    const db = this.db;
    const reviews = db.prepare(`SELECT r.review_id, r.content_id, r.trigger, r.state, r.release_reason, r.suspect_reason, r.used_micro, r.budget_tools, r.budget_micro,
        r.over_budget_micro, r.attempt, r.yield_continues, r.judge_model, r.agent_model, r.conversation_id, r.updated_at, ru.action, ru.actor, ru.created_at AS ruled_at
      FROM review r LEFT JOIN ruling ru ON ru.review_id=r.review_id ORDER BY r.content_id, r.seq`).all() as Record<string, unknown>[];
    const slots = db.prepare("SELECT review_id, tool, counts_toward_limit, status, block_reason FROM tool_slot").all() as { review_id: string; tool: string; counts_toward_limit: number; status: string; block_reason: string | null }[];
    const firstModel = new Map((db.prepare("SELECT review_id, MIN(created_at) AS t FROM model_call GROUP BY review_id").all() as { review_id: string; t: number }[]).map((x) => [x.review_id, x.t]));
    const stepsOf = new Map<string, number>();
    const usedOf = new Map<string, number>();
    for (const s of slots) {
      stepsOf.set(s.review_id, (stepsOf.get(s.review_id) ?? 0) + 1);
      if (s.counts_toward_limit === 1 && s.status === "reserved") usedOf.set(s.review_id, (usedOf.get(s.review_id) ?? 0) + 1);
    }
    const sessions: RecordSession[] = reviews.map((r) => {
      const id = String(r["review_id"]);
      const agentRan = r["conversation_id"] !== null && r["conversation_id"] !== undefined;
      const route: RecordSession["route"] = r["trigger"] === "fast" ? (r["action"] === "pass" ? "fast_pass" : "fast_block") : agentRan || r["suspect_reason"] ? (agentRan ? "agent" : "human_direct") : "human_direct";
      const t0 = firstModel.get(id);
      const t1 = (r["ruled_at"] as number | null) ?? (r["updated_at"] as number);
      return { content_id: String(r["content_id"]), review_id: id, category: categoryOf(String(r["content_id"])), route, state: String(r["state"]),
        action: (r["action"] as string | null) ?? null, actor: (r["actor"] as string | null) ?? null, release_reason: (r["release_reason"] as string | null) ?? null,
        suspect_reason: (r["suspect_reason"] as string | null) ?? null, steps: stepsOf.get(id) ?? 0, tools_used: usedOf.get(id) ?? 0, used_micro: (r["used_micro"] as number | null) ?? null,
        agent_ms: t0 !== undefined && agentRan ? Math.max(0, t1 - t0) : null };
    });
    const by: HarnessRecord["by_category"] = {};
    for (const s of sessions) {
      const b = (by[s.category] ??= { n: 0, fast_pass: 0, fast_block: 0, agent: 0, agent_disposed: 0, agent_released: 0, human_direct: 0 });
      b.n++;
      if (s.route === "fast_pass") b.fast_pass++; else if (s.route === "fast_block") b.fast_block++; else if (s.route === "human_direct") b.human_direct++;
      else { b.agent++; if (s.actor === "agent") b.agent_disposed++; else if (s.release_reason) b.agent_released++; }
    }
    const tools = new Map<string, { calls: number; blocked: number }>();
    const blocked = new Map<string, number>();
    for (const s of slots) {
      const t = tools.get(s.tool) ?? { calls: 0, blocked: 0 };
      t.calls++;
      if (s.status === "blocked") { t.blocked++; const k = (s.block_reason ?? "blocked").split(":")[0]!.trim(); blocked.set(k, (blocked.get(k) ?? 0) + 1); }
      tools.set(s.tool, t);
    }
    const rejections = new Map<string, number>();
    for (const a of db.prepare("SELECT payload FROM audit WHERE kind='submit_rejected'").all() as { payload: string }[]) {
      let code = "unknown";
      try { code = String((JSON.parse(a.payload) as { code?: string }).code ?? "unknown"); } catch { /* keep unknown */ }
      rejections.set(code, (rejections.get(code) ?? 0) + 1);
    }
    const req = db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN request_no > 1 THEN 1 ELSE 0 END) AS retried FROM tool_request").get() as { n: number; retried: number | null };
    let input = 0, output = 0, calls = 0;
    for (const m of db.prepare("SELECT usage FROM model_call").all() as { usage: string | null }[]) {
      calls++;
      try { const u = JSON.parse(m.usage ?? "{}") as { input?: number; output?: number }; input += u.input ?? 0; output += u.output ?? 0; } catch { /* no usage */ }
    }
    const agentSessions = sessions.filter((s) => s.route === "agent");
    const agentReviews = reviews.filter((r) => r["conversation_id"]);
    const costs = agentSessions.map((s) => s.used_micro ?? 0);
    const released: Record<string, number> = {};
    for (const s of agentSessions) if (s.release_reason) released[s.release_reason] = (released[s.release_reason] ?? 0) + 1;
    const r0 = reviews[0];
    const times = agentSessions.map((s) => s.agent_ms).filter((x): x is number => x !== null);
    const firstT = Math.min(...[...firstModel.values()]);
    this.#summary = {
      available: true,
      run: { contents: new Set(sessions.map((s) => s.content_id)).size, judge_model: r0 ? String(r0["judge_model"]) : "—", agent_model: agentReviews[0] ? String(agentReviews[0]["agent_model"] ?? "") || null : null,
        started: Number.isFinite(firstT) ? firstT : null, ended: agentReviews.length ? Math.max(...agentReviews.map((r) => Number(r["updated_at"]))) : null },
      by_category: by,
      tools: [...tools.entries()].map(([tool, v]) => ({ tool, ...v })).sort((a, b) => b.calls - a.calls),
      blocked: [...blocked.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
      rejections: [...rejections.entries()].map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n),
      requests: { external: req.n, retried: req.retried ?? 0 },
      model: { calls, input_tokens: input, output_tokens: output },
      budget: { sessions: agentSessions.length, tools_avg: agentSessions.length ? agentSessions.reduce((a, s) => a + s.tools_used, 0) / agentSessions.length : 0,
        tools_max: Math.max(0, ...agentSessions.map((s) => s.tools_used)), tools_limit: r0 ? Number(r0["budget_tools"]) : core.DEFAULT_CONFIG.budgetTools,
        cost_avg_micro: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0, cost_max_micro: Math.max(0, ...costs), cost_limit_micro: r0 ? Number(r0["budget_micro"]) : core.DEFAULT_CONFIG.budgetMicro,
        over_budget: agentReviews.filter((r) => Number(r["over_budget_micro"] ?? 0) > 0).length },
      recovery: { reacquired: agentReviews.filter((r) => Number(r["attempt"]) > 1).length, yield_prompts: agentReviews.filter((r) => Number(r["yield_continues"]) > 0).length, released },
      latency_ms: { agent_p50: pct(times, 0.5), agent_p95: pct(times, 0.95) },
      sessions,
    };
    return this.#summary;
  }

  /** One recorded content's full timeline, text included (a showcase of public test texts). */
  timeline(contentId: string): ContentTimeline | undefined {
    const bundleOf = (v: string): PolicyBundle | undefined => this.bundleOf(v) ?? (core.loadStoredBundle(this.db as unknown as core.Db, v)?.bundle as PolicyBundle | undefined);
    return buildTimeline(this.db as unknown as core.Db, contentId, bundleOf, { restricted: true });
  }
}
