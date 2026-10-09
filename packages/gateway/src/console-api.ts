// Read models for the web console, built from app.db only (the business source of truth): a content's timeline across
// all its reviews, review / human-queue / appeal lists, cumulative stats and the rules view. Agent steps are
// reconstructed from the ledger (tool_slot, tool_request, evidence, judge_call, ruling, audit), not from the Pi
// transcript, so they survive worker restarts and need no access to session.sqlite. Default views are redacted: no
// content text, no neighbour text, no model- or person-written free text (docs §6.6); `restricted` adds them.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "@mod/core";
import type { Db, PolicyBundle, Question } from "@mod/core";
import type {
  AgentStep, AppealItem, ContentTimeline, HumanQueueItem, JudgeRound, ProbPair, QuestionScore, ReviewListItem, ReviewTimeline,
  RouteKind, RulesInfo, Stats, SubmitRejection, TimelineEvent,
} from "./console-types.ts";

type BundleOf = (rulesVer: string) => PolicyBundle | undefined;

const parse = <T>(s: string | null | undefined, d: T): T => { if (!s) return d; try { return JSON.parse(s) as T; } catch { return d; } };

/** Route of a review from its row (no ruling needed): the same classification the list filter uses in SQL. */
export function routeOf(r: Pick<core.ReviewRow, "trigger" | "suspect_reason" | "state">, action: string | null): RouteKind {
  if (r.trigger === "fast") return action === "pass" ? "fast_pass" : "fast_block";
  if (r.trigger === "appeal") return "appeal";
  if (r.trigger === "suspicious") return r.suspect_reason ? "agent" : "human_direct";
  return "other";
}
export const ROUTE_SQL: Record<string, string> = {
  fast_pass: "r.trigger='fast' AND ru.action='pass'",
  fast_block: "r.trigger='fast' AND ru.action<>'pass'",
  agent: "r.trigger='suspicious' AND r.suspect_reason IS NOT NULL",
  human_direct: "r.trigger='suspicious' AND r.suspect_reason IS NULL",
  appeal: "r.trigger='appeal'",
};

// ---------- judge rounds ----------

type CallRow = core.JudgeCallRow;
type AnswerRow = core.JudgeAnswerRow;

function pairOf(a: AnswerRow | undefined, q: Question | undefined): ProbPair | null {
  if (!a) return null;
  const vo = q?.violationOption ?? "violate";
  const raw = parse<Record<string, number> | null>(a.raw_probs, null);
  const cal = parse<Record<string, number> | null>(a.calibrated_probs, null);
  return { choice: a.choice, raw: raw ? (raw[vo] ?? null) : null, cal: cal ? (cal[vo] ?? null) : null };
}

function scoreQuestions(bundle: PolicyBundle | undefined, scene: core.Scene, stage: "fast" | "agent", primary: AnswerRow[], copy: AnswerRow[]): QuestionScore[] {
  const qs = bundle ? core.allQuestions(bundle) : new Map<string, Question>();
  const guard = bundle?.scenes[scene]?.injectionGuard;
  const shas = [...new Set([...primary, ...copy].map((a) => a.question_sha))];
  const order = (k: QuestionScore["kind"]): number => (k === "rule" ? 0 : k === "exception" ? 1 : k === "guard" ? 2 : 3);
  return shas.map((sha): QuestionScore => {
    const q = qs.get(sha);
    const a = primary.find((x) => x.question_sha === sha);
    const b = copy.find((x) => x.question_sha === sha);
    const kind = (a ?? b)!.question_kind;
    const ruleId = (a ?? b)!.rule_id;
    const rule = ruleId ? bundle?.rules.find((x) => x.ruleId === ruleId) : undefined;
    const lines = kind === "guard" ? (guard ? { block: guard.threshold, pass: guard.threshold } : null)
      : kind === "rule" && rule ? (stage === "agent" && rule.agentThresholds ? rule.agentThresholds : rule.thresholds) : null;
    const pa = pairOf(a, q), pb = pairOf(b, q);
    const cals = [pa?.cal, pb?.cal].filter((x): x is number => typeof x === "number");
    const mean = cals.length ? cals.reduce((s, x) => s + x, 0) / cals.length : null;
    let verdict: QuestionScore["verdict"];
    if (!pa && !pb) verdict = "missing";
    else if (mean === null) verdict = "uncalibrated";
    else if (kind === "guard") verdict = lines && mean >= lines.block ? "flagged" : "clear";
    else if (!lines) verdict = mean >= 0.5 ? "flagged" : "clear";
    else if (mean >= lines.block) verdict = "block";
    else if (cals.every((x) => x < lines.pass)) verdict = "pass";
    else verdict = "middle";
    const temp = (a ?? b)!.temperature;
    return { question_sha: sha, key: q ? core.questionKey(q) : (ruleId ?? kind), kind, rule_id: ruleId, lines, primary: pa, confirm: pb, mean, temperature: temp, verdict };
  }).sort((x, y) => order(x.kind) - order(y.kind) || x.key.localeCompare(y.key));
}

function judgeRounds(db: Db, reviewId: string, bundle: PolicyBundle | undefined, scene: core.Scene, evidenceIdOf: (sha: string) => string): JudgeRound[] {
  const calls = db.prepare("SELECT * FROM judge_call WHERE review_id=? ORDER BY created_at, judge_call_id").all(reviewId) as CallRow[];
  const answers = (id: string): AnswerRow[] => db.prepare("SELECT * FROM judge_answer WHERE judge_call_id=?").all(id) as AnswerRow[];
  const requested = new Set((db.prepare("SELECT judge_call_id FROM tool_request WHERE review_id=? AND judge_call_id IS NOT NULL").all(reviewId) as { judge_call_id: string }[]).map((r) => r.judge_call_id));
  // an in-call copy confirms its primary and was not requested on its own (fast-path copies have no tool_request at all)
  const isCopy = (c: CallRow): boolean => !!c.confirms_call_id && !requested.has(c.judge_call_id) && calls.some((p) => p.judge_call_id === c.confirms_call_id && p.request_sha === c.request_sha);
  return calls.filter((c) => !isCopy(c)).map((c): JudgeRound => {
    const copy = calls.find((x) => x.confirms_call_id === c.judge_call_id && isCopy(x));
    const stage = c.attempt === null ? "fast" : "agent";
    return {
      judge_call_id: c.judge_call_id, copy_call_id: copy?.judge_call_id ?? null, stage, explicit_confirm_of: c.confirms_call_id,
      attempt: c.attempt, status: c.status, model: c.model, latency_ms: c.latency_ms, cost_micro: c.cost_micro,
      evidence_ids: parse<string[]>(c.evidence_set, []).map(evidenceIdOf),
      questions: scoreQuestions(bundle, scene, stage, answers(c.judge_call_id), copy ? answers(copy.judge_call_id) : []),
      at: c.created_at,
    };
  });
}

// ---------- agent steps ----------

type SlotRow = { call_id: string; attempt: number; tool: string; status: string; block_reason: string | null; created_at: number };
type EvRow = { evidence_id: string; kind: string; source_ref: string; body_sha: string; model_view: string; body: string; created_at: number };

/** What the agent saw from an evidence row; redacted: neighbour text becomes its length. */
function evidenceResult(e: EvRow, restricted: boolean): Record<string, unknown> {
  const v = parse<Record<string, unknown>>(e.model_view, {});
  if (e.kind === "thread_context") {
    const ns = (v["neighbors"] as { relation?: string; account_id?: string | null; text?: string; content_id?: string; prior_effective_action?: string | null }[] | undefined) ?? [];
    return { evidence_id: e.evidence_id, neighbors: ns.map((n) => ({ relation: n.relation ?? null, content_id: n.content_id ?? null, account_id: n.account_id ?? null, text_len: (n.text ?? "").length, prior_effective_action: n.prior_effective_action ?? null, ...(restricted ? { text: n.text ?? "" } : {}) })) };
  }
  if (e.kind === "rule") {
    const { text, ...rest } = v as { text?: string };
    return { evidence_id: e.evidence_id, ...rest, text_len: (text ?? "").length, ...(restricted ? { text } : {}) };
  }
  return { evidence_id: e.evidence_id, ...v };
}

function agentSteps(db: Db, r: core.ReviewRow, rounds: JudgeRound[], ruling: core.RulingRow | undefined, rejections: SubmitRejection[], restricted: boolean): AgentStep[] {
  const slots = db.prepare("SELECT call_id, attempt, tool, status, block_reason, created_at FROM tool_slot WHERE review_id=? ORDER BY created_at, rowid").all(r.review_id) as SlotRow[];
  const evidence = db.prepare("SELECT evidence_id, kind, source_ref, body_sha, model_view, body, created_at FROM evidence WHERE review_id=? ORDER BY created_at, rowid").all(r.review_id) as EvRow[];
  const used = new Set<string>();
  const kindOf: Record<string, string> = { load_rule: "rule", get_thread_context: "thread_context", get_account_history: "account_history" };
  const requests = db.prepare("SELECT call_id, judge_call_id FROM tool_request WHERE review_id=? ORDER BY request_no").all(r.review_id) as { call_id: string; judge_call_id: string | null }[];
  const rejectQueue = rejections.filter((x) => x.actor === "agent");
  return slots.map((s): AgentStep => {
    const base = { call_id: s.call_id, tool: s.tool, attempt: s.attempt, at: s.created_at, block_reason: s.block_reason };
    if (s.status === "blocked") return { ...base, status: "blocked", args: {}, result: null };
    const kind = kindOf[s.tool];
    if (kind) {
      const e = evidence.find((x) => x.kind === kind && !used.has(x.evidence_id) && x.created_at >= s.created_at);
      if (e) used.add(e.evidence_id);
      const args = s.tool === "load_rule" && e ? { rule_id: e.source_ref } : {};
      if (e) return { ...base, status: "ok", args, result: evidenceResult(e, restricted) };
      const earlier = evidence.find((x) => x.kind === kind && x.created_at <= s.created_at);
      return { ...base, status: earlier ? "reused" : "pending", args, result: earlier ? { evidence_id: earlier.evidence_id, already_fetched: true } : null };
    }
    if (s.tool === "judge" || s.tool === "confirm") {
      const jc = requests.filter((x) => x.call_id === s.call_id && x.judge_call_id).map((x) => x.judge_call_id!).pop();
      const round = rounds.find((x) => x.judge_call_id === jc);
      // no judge request under this call: either still in flight, or the tool returned the earlier answer (same request)
      const moved = r.state !== "investigating" || slots.some((x) => x.created_at > s.created_at);
      if (!round) return { ...base, status: jc === undefined && moved ? "reused" : "pending", args: {}, result: jc === undefined && moved ? { already_judged: true } : null };
      const ruleIds = [...new Set(round.questions.map((q) => q.rule_id).filter((x): x is string => !!x))];
      const args: Record<string, unknown> = { rule_ids: ruleIds, evidence_ids: round.evidence_ids, ...(round.explicit_confirm_of ? { judge_call_id: round.explicit_confirm_of } : {}) };
      return { ...base, status: "ok", args, result: { judge_call_id: round.judge_call_id, status: round.status, scores: round.questions.map((q) => ({ key: q.key, mean: q.mean, verdict: q.verdict })) } };
    }
    if (s.tool === "dispose") {
      if (ruling && ruling.actor === "agent" && ruling.attempt === s.attempt && ruling.created_at >= s.created_at) {
        return { ...base, status: "ok", args: { action: ruling.action, rule_ids: parse(ruling.rule_ids, []), evidence_ids: parse(ruling.evidence_ids, []) }, result: { ruling: ruling.action, allowed_actions: parse(ruling.allowed_actions, []) } };
      }
      const rej = rejectQueue.find((x) => x.at >= s.created_at && x.attempt === s.attempt);
      if (rej) { rejectQueue.splice(rejectQueue.indexOf(rej), 1); return { ...base, status: "rejected", args: { action: rej.action }, result: { code: rej.code, step: rej.step } }; }
      return { ...base, status: "pending", args: {}, result: null };
    }
    if (s.tool === "release") {
      const done = r.release_reason && (r.state === "human_queue" || r.state === "human_disposed");
      return { ...base, status: done ? "ok" : "pending", args: done ? { reason: r.release_reason } : {}, result: done ? { released: true, reason: r.release_reason } : null };
    }
    return { ...base, status: "ok", args: {}, result: null };
  });
}

// ---------- one review, one content ----------

function reviewTimeline(db: Db, r: core.ReviewRow, bundleOf: BundleOf, scene: core.Scene, restricted: boolean): ReviewTimeline {
  const bundle = bundleOf(r.rules_ver);
  const shaToId = new Map((db.prepare("SELECT evidence_id, body_sha FROM evidence WHERE review_id=?").all(r.review_id) as { evidence_id: string; body_sha: string }[]).map((e) => [e.body_sha, e.evidence_id] as const));
  const evidenceIdOf = (sha: string): string => shaToId.get(sha) ?? sha.slice(0, 12);
  const rounds = judgeRounds(db, r.review_id, bundle, scene, evidenceIdOf);
  const rul = core.readRuling(db, r.review_id);
  const rejections = (db.prepare("SELECT payload, actor, created_at FROM audit WHERE kind='submit_rejected' AND ref_id=? ORDER BY audit_id").all(r.review_id) as { payload: string; actor: string; created_at: number }[])
    .map((a): SubmitRejection => { const p = parse<{ code?: string; step?: number; action?: string; attempt?: number }>(a.payload, {}); return { at: a.created_at, actor: a.actor, code: p.code ?? "?", step: p.step ?? 0, action: p.action ?? null, attempt: p.attempt ?? null }; });
  const hq = db.prepare("SELECT * FROM human_queue WHERE review_id=?").get(r.review_id) as { reason: string; severity: number; due_at: number; created_at: number; claimed_by: string | null; claimed_at: number | null; closed_at: number | null; closed_by: string | null } | undefined;
  const label = hq ? (db.prepare("SELECT human_label FROM feedback WHERE review_id=? ORDER BY created_at DESC LIMIT 1").get(r.review_id) as { human_label: string } | undefined)?.human_label ?? null : null;
  const appealEv = r.trigger === "appeal" ? db.prepare("SELECT payload FROM synth_event WHERE event_id=?").get(`appeal:${r.review_id}`) as { payload: string } | undefined : undefined;
  const tools = (db.prepare("SELECT COUNT(*) AS n FROM tool_slot WHERE review_id=? AND status<>'blocked' AND counts_toward_limit=1").get(r.review_id) as { n: number }).n;
  const freeText = (s: string | null): string | null => (restricted ? s : null);
  return {
    review_id: r.review_id, seq: r.seq, trigger: r.trigger, state: r.state, attempt: r.attempt,
    created_at: r.created_at, updated_at: r.updated_at, deadline_at: r.deadline_at,
    rules_ver: r.rules_ver, calib_ver: r.calib_ver, judge_model: r.judge_model,
    // review.agent_model is only written on escalation; otherwise the model is the one W ran the session with
    agent_model: r.agent_model ?? (db.prepare("SELECT model FROM model_call WHERE review_id=? ORDER BY created_at LIMIT 1").get(r.review_id) as { model: string } | undefined)?.model ?? null,
    budget_tools: r.budget_tools, budget_micro: r.budget_micro, used_micro: r.used_micro, cost_status: r.cost_status, tools_used: tools,
    route: { kind: routeOf(r, rul?.action ?? null), reason: r.trigger === "fast" ? (rul?.reason ?? null) : (r.suspect_reason ?? r.release_reason) },
    suspect_reason: r.suspect_reason, release_reason: r.release_reason,
    judge_rounds: rounds,
    steps: agentSteps(db, r, rounds, rul, rejections, restricted),
    rejections,
    ruling: rul ? {
      action: rul.action, actor: rul.actor, attempt: rul.attempt, rule_ids: parse(rul.rule_ids, []), evidence_ids: parse(rul.evidence_ids, []),
      judge_call_ids: parse(rul.judge_call_ids, []), allowed_actions: parse(rul.allowed_actions, []), model_id: rul.model_id,
      // the fast path's reason is a system code (block_support, ...); agent and human reasons are free text
      reason: rul.actor === "fastpath" ? rul.reason : freeText(rul.reason), reason_len: (rul.reason ?? "").length, reason_code: rul.actor === "fastpath" ? rul.reason : null,
      created_at: rul.created_at,
    } : null,
    human: hq ? { reason: hq.reason, severity: hq.severity, due_at: hq.due_at, queued_at: hq.created_at, claimed_by: hq.claimed_by, claimed_at: hq.claimed_at, closed_at: hq.closed_at, closed_by: hq.closed_by, label } : null,
    appeal: r.trigger === "appeal" ? { reason_code: (parse<{ reason_code?: string | null }>(appealEv?.payload, {}).reason_code ?? null) } : null,
  };
}

const ACTION_ZH: Record<string, string> = { pass: "放行", limit: "限流", takedown: "下架" };
const TOOL_ZH: Record<string, string> = { load_rule: "读取规则", get_thread_context: "取线程上下文", get_account_history: "取账号历史", judge: "带证据复判", confirm: "打乱选项复问", dispose: "提交处置", release: "交人工", escalate_model: "升级模型" };

function eventsOf(content: { content_id: string; created_at: number }, reviews: ReviewTimeline[]): TimelineEvent[] {
  const ev: TimelineEvent[] = [{ id: "intake", at: content.created_at, review_id: null, kind: "intake", title: "内容进入" }];
  for (const r of reviews) {
    const rid = r.review_id;
    if (r.trigger === "appeal") ev.push({ id: `${rid}:appeal`, at: r.created_at, review_id: rid, kind: "appeal", title: "用户申诉，开新审次", ...(r.appeal?.reason_code ? { detail: r.appeal.reason_code } : {}) });
    for (const j of r.judge_rounds) ev.push({ id: `${rid}:judge:${j.judge_call_id}`, at: j.at, review_id: rid, kind: j.stage === "fast" ? "fast_judge" : "judge", title: j.stage === "fast" ? "快判打分" : j.explicit_confirm_of ? "复问" : "带证据复判", detail: j.questions.map((q) => `${q.key} ${q.mean === null ? "—" : q.mean.toFixed(2)}`).join(" · ") });
    const routeTitle: Record<RouteKind, string> = { fast_pass: "快判：自动放行", fast_block: "快判：自动处置", agent: "转 agent 查证据", human_direct: "直接转人工", appeal: "申诉审次排队", other: "新审次" };
    ev.push({ id: `${rid}:route`, at: r.created_at, review_id: rid, kind: "route", title: routeTitle[r.route.kind], ...(r.route.reason ? { detail: r.route.reason } : {}) });
    for (const s of r.steps) ev.push({ id: `${rid}:step:${s.call_id}`, at: s.at, review_id: rid, kind: "tool", title: TOOL_ZH[s.tool] ?? s.tool, detail: s.status });
    for (const x of r.rejections) ev.push({ id: `${rid}:rej:${x.at}:${x.code}`, at: x.at, review_id: rid, kind: "rejected", title: "提交检查拒绝", detail: `${x.code} (step ${x.step})` });
    if (r.human) {
      ev.push({ id: `${rid}:human`, at: r.human.queued_at, review_id: rid, kind: "human_queue", title: "进入人工队列", detail: r.human.reason });
      if (r.human.claimed_at) ev.push({ id: `${rid}:claim`, at: r.human.claimed_at, review_id: rid, kind: "human_claim", title: `审核员 ${r.human.claimed_by} 领取` });
    }
    if (r.ruling) ev.push({ id: `${rid}:ruling`, at: r.ruling.created_at, review_id: rid, kind: "ruling", title: `${r.ruling.actor === "fastpath" ? "快判" : r.ruling.actor === "agent" ? "agent " : "人工"}裁决：${ACTION_ZH[r.ruling.action] ?? r.ruling.action}`, ...(r.ruling.rule_ids.length ? { detail: r.ruling.rule_ids.join(", ") } : {}) });
  }
  const rank: Record<string, number> = { intake: 0, appeal: 1, fast_judge: 2, route: 3, tool: 4, judge: 4, rejected: 5, human_queue: 6, human_claim: 7, ruling: 8 };
  return ev.sort((a, b) => a.at - b.at || (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
}

export function buildTimeline(db: Db, contentId: string, bundleOf: BundleOf, o: { restricted?: boolean } = {}): ContentTimeline | undefined {
  const c = core.readContent(db, contentId);
  if (!c) return undefined;
  const restricted = !!o.restricted;
  const intake = db.prepare("SELECT status, attempts FROM intake WHERE content_id=?").get(contentId) as { status: string; attempts: number } | undefined;
  const st = db.prepare("SELECT effective_action, visibility FROM content_state WHERE content_id=?").get(contentId) as { effective_action: core.Action | null; visibility: string } | undefined;
  const rows = db.prepare("SELECT * FROM review WHERE content_id=? ORDER BY seq").all(contentId) as core.ReviewRow[];
  const reviews = rows.map((r) => reviewTimeline(db, r, bundleOf, c.scene, restricted));
  const latest = rows[rows.length - 1];
  const phase: ContentTimeline["phase"] = !latest ? "intake"
    : latest.state === "queued" || latest.state === "investigating" ? "agent"
    : latest.state === "human_queue" ? "human" : "done";
  const content = { content_id: c.content_id, scene: c.scene, account_id: c.account_id, thread_id: c.thread_id, reply_to: c.reply_to, text_len: (c.text ?? "").length, text_sha: c.text_sha ? c.text_sha.slice(0, 12) : null, created_at: c.created_at, text: restricted ? c.text : null };
  const body = { content, intake: intake ?? null, effective: st ? { action: st.effective_action, visibility: st.visibility } : null, phase, reviews, events: eventsOf(c, reviews), restricted };
  return { ...body, version: core.sha256(JSON.stringify(body)).slice(0, 16) };
}

// ---------- lists ----------

export type ReviewFilter = {
  state?: string; trigger?: string; route?: string; scene?: string; action?: string; actor?: string; q?: string; limit: number; offset: number;
  /** incremental read: only reviews created or updated at or after this time (ms), newest change first */
  updatedSince?: number;
};

export function listReviews(db: Db, f: ReviewFilter): { items: ReviewListItem[]; total: number } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.state) { where.push("r.state=?"); args.push(f.state); }
  if (f.trigger) { where.push("r.trigger=?"); args.push(f.trigger); }
  if (f.scene) { where.push("c.scene=?"); args.push(f.scene); }
  if (f.action) { where.push("ru.action=?"); args.push(f.action); }
  if (f.actor) { where.push("ru.actor=?"); args.push(f.actor); }
  if (f.q) { where.push("(r.content_id LIKE ? OR r.review_id LIKE ?)"); args.push(`%${f.q}%`, `%${f.q}%`); }
  if (f.route && ROUTE_SQL[f.route]) where.push(ROUTE_SQL[f.route]!);
  if (f.updatedSince !== undefined) { where.push("r.updated_at>=?"); args.push(f.updatedSince); }
  const from = "FROM review r JOIN content c ON c.content_id=r.content_id LEFT JOIN ruling ru ON ru.review_id=r.review_id";
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n ${from} ${w}`).get(...args) as { n: number }).n;
  const rows = db.prepare(`SELECT r.*, c.scene AS scene, ru.action AS action, ru.actor AS actor ${from} ${w} ORDER BY ${f.updatedSince !== undefined ? "r.updated_at DESC" : "r.created_at DESC"}, r.review_id LIMIT ? OFFSET ?`).all(...args, f.limit, f.offset) as (core.ReviewRow & { scene: string; action: core.Action | null; actor: string | null })[];
  return {
    total,
    items: rows.map((r) => ({
      review_id: r.review_id, content_id: r.content_id, seq: r.seq, trigger: r.trigger, state: r.state, attempt: r.attempt, scene: r.scene,
      route: routeOf(r, r.action), suspect_reason: r.suspect_reason, release_reason: r.release_reason, action: r.action, actor: r.actor,
      used_micro: r.used_micro, rules_ver: r.rules_ver, calib_ver: r.calib_ver, judge_model: r.judge_model, agent_model: r.agent_model, created_at: r.created_at, updated_at: r.updated_at,
    })),
  };
}

export function humanQueue(db: Db, status: "open" | "closed" | "all"): HumanQueueItem[] {
  const w = status === "open" ? "WHERE h.closed_at IS NULL" : status === "closed" ? "WHERE h.closed_at IS NOT NULL" : "";
  const order = status === "open" ? "ORDER BY h.severity DESC, h.due_at" : "ORDER BY COALESCE(h.closed_at, h.created_at) DESC";
  return (db.prepare(`SELECT h.*, r.content_id, r.trigger, r.suspect_reason, r.rules_ver, r.state, c.scene, ru.action FROM human_queue h JOIN review r ON r.review_id=h.review_id JOIN content c ON c.content_id=r.content_id LEFT JOIN ruling ru ON ru.review_id=h.review_id ${w} ${order} LIMIT 500`).all() as HumanQueueItem[])
    .map((x) => ({ review_id: x.review_id, content_id: x.content_id, scene: x.scene, trigger: x.trigger, reason: x.reason, severity: x.severity, due_at: x.due_at, created_at: x.created_at, claimed_by: x.claimed_by, claimed_at: x.claimed_at, closed_at: x.closed_at, closed_by: x.closed_by, suspect_reason: x.suspect_reason, rules_ver: x.rules_ver, state: x.state, action: x.action ?? null }));
}

export function listAppeals(db: Db): AppealItem[] {
  const rows = db.prepare("SELECT r.review_id, r.content_id, r.seq, r.state, r.created_at, c.scene, ru.action, ru.actor FROM review r JOIN content c ON c.content_id=r.content_id LEFT JOIN ruling ru ON ru.review_id=r.review_id WHERE r.trigger='appeal' ORDER BY r.created_at DESC LIMIT 200").all() as { review_id: string; content_id: string; seq: number; state: core.ReviewState; created_at: number; scene: string; action: core.Action | null; actor: string | null }[];
  return rows.map((r) => {
    const prior = db.prepare("SELECT action, actor FROM ruling WHERE content_id=? AND seq<? ORDER BY seq DESC LIMIT 1").get(r.content_id, r.seq) as { action: core.Action; actor: string } | undefined;
    const ev = db.prepare("SELECT payload FROM synth_event WHERE event_id=?").get(`appeal:${r.review_id}`) as { payload: string } | undefined;
    return { review_id: r.review_id, content_id: r.content_id, scene: r.scene, state: r.state, created_at: r.created_at, reason_code: parse<{ reason_code?: string | null }>(ev?.payload, {}).reason_code ?? null,
      prior: prior ?? null, result: r.action ? { action: r.action, actor: r.actor ?? "" } : null };
  });
}

// ---------- stats ----------

const pct = (xs: number[], p: number): number => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]!; };

export function stats(db: Db, now: number): Stats {
  const n = (sql: string, ...a: (string | number)[]): number => (db.prepare(sql).get(...a) as { n: number | null }).n ?? 0;
  const routes: Stats["routes"] = { fast_pass: 0, fast_block: 0, agent: 0, human_direct: 0, appeal: 0, other: 0 };
  for (const [k, sql] of Object.entries(ROUTE_SQL)) routes[k as RouteKind] = n(`SELECT COUNT(*) AS n FROM review r LEFT JOIN ruling ru ON ru.review_id=r.review_id WHERE ${sql}`);
  const effective: Record<string, number> = {};
  for (const r of db.prepare("SELECT COALESCE(effective_action,'pending') AS a, COUNT(*) AS n FROM content_state GROUP BY 1").all() as { a: string; n: number }[]) effective[r.a] = r.n;
  const releaseReasons: Record<string, number> = {};
  for (const r of db.prepare("SELECT release_reason AS k, COUNT(*) AS n FROM review WHERE release_reason IS NOT NULL GROUP BY 1").all() as { k: string; n: number }[]) releaseReasons[r.k] = r.n;
  const fastLat = (db.prepare("SELECT r.created_at - c.created_at AS ms FROM review r JOIN content c ON c.content_id=r.content_id WHERE r.seq=(SELECT MIN(seq) FROM review x WHERE x.content_id=r.content_id) AND r.trigger IN ('fast','suspicious') ORDER BY r.created_at DESC LIMIT 2000").all() as { ms: number }[]).map((x) => x.ms);
  const agentLat = (db.prepare("SELECT COALESCE(ru.created_at, r.updated_at) - r.created_at AS ms FROM review r LEFT JOIN ruling ru ON ru.review_id=r.review_id WHERE r.conversation_id IS NOT NULL AND r.state<>'queued' AND r.state<>'investigating' ORDER BY r.created_at DESC LIMIT 2000").all() as { ms: number }[]).map((x) => x.ms);
  const humanLat = (db.prepare("SELECT closed_at - created_at AS ms FROM human_queue WHERE closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 2000").all() as { ms: number }[]).map((x) => x.ms);
  const fastMicro = n("SELECT COALESCE(SUM(cost_micro),0) AS n FROM judge_call WHERE attempt IS NULL");
  const reviewMicro = n("SELECT COALESCE(SUM(used_micro),0) AS n FROM review");
  const contents = n("SELECT COUNT(*) AS n FROM intake");
  const judged = n("SELECT COUNT(*) AS n FROM intake WHERE status='judged'");
  const minute = Math.floor(now / 60_000);
  const series: Stats["series"] = Array.from({ length: 30 }, (_, i) => ({ minute: minute - 29 + i, fast_pass: 0, fast_block: 0, agent: 0, human_direct: 0, appeal: 0 }));
  const rows = db.prepare("SELECT r.trigger, r.suspect_reason, r.state, r.created_at, ru.action FROM review r LEFT JOIN ruling ru ON ru.review_id=r.review_id WHERE r.created_at >= ?").all((minute - 29) * 60_000) as { trigger: string; suspect_reason: string | null; state: core.ReviewState; created_at: number; action: string | null }[];
  for (const r of rows) {
    const k = routeOf({ trigger: r.trigger as core.Trigger, suspect_reason: r.suspect_reason, state: r.state }, r.action);
    const b = series[Math.floor(r.created_at / 60_000) - (minute - 29)];
    if (b && k !== "other") b[k]++;
  }
  return {
    at: now, contents, judged, reviews: n("SELECT COUNT(*) AS n FROM review"),
    routes, effective,
    agent: {
      disposed: n("SELECT COUNT(*) AS n FROM review r JOIN ruling ru ON ru.review_id=r.review_id WHERE ru.actor='agent'"),
      released: n("SELECT COUNT(*) AS n FROM review WHERE conversation_id IS NOT NULL AND release_reason IS NOT NULL"),
      open: n("SELECT COUNT(*) AS n FROM review WHERE state IN ('queued','investigating')"),
    },
    release_reasons: releaseReasons,
    human: {
      open: n("SELECT COUNT(*) AS n FROM human_queue WHERE closed_at IS NULL"),
      claimed: n("SELECT COUNT(*) AS n FROM human_queue WHERE closed_at IS NULL AND claimed_by IS NOT NULL"),
      closed: n("SELECT COUNT(*) AS n FROM human_queue WHERE closed_at IS NOT NULL"),
      overdue: n("SELECT COUNT(*) AS n FROM human_queue WHERE closed_at IS NULL AND due_at < ?", now),
    },
    appeals: {
      total: n("SELECT COUNT(*) AS n FROM review WHERE trigger='appeal'"),
      open: n("SELECT COUNT(*) AS n FROM review WHERE trigger='appeal' AND state IN ('queued','investigating','human_queue')"),
      changed: n("SELECT COUNT(*) AS n FROM review r JOIN ruling ru ON ru.review_id=r.review_id WHERE r.trigger='appeal' AND ru.action <> (SELECT p.action FROM ruling p WHERE p.content_id=r.content_id AND p.seq<r.seq ORDER BY p.seq DESC LIMIT 1)"),
    },
    cost: { fast_micro: fastMicro, review_micro: reviewMicro, per_content_micro: judged ? Math.round((fastMicro + reviewMicro) / judged) : 0, estimated_reviews: n("SELECT COUNT(*) AS n FROM review WHERE cost_status='estimated'") },
    latency_ms: { fast_p50: pct(fastLat, 0.5), fast_p95: pct(fastLat, 0.95), agent_p50: pct(agentLat, 0.5), agent_p95: pct(agentLat, 0.95), human_p50: pct(humanLat, 0.5) },
    series,
  };
}

// ---------- rules ----------

export type CalibFileInfo = RulesInfo["calibration"]["files"][number];

export function rulesInfo(db: Db, current: PolicyBundle, texts: Record<string, string>, o: { calibVer: string; calibMode: string; calibFiles: CalibFileInfo[]; candidate?: PolicyBundle }): RulesInfo {
  const rules = current.rules.map((r) => ({
    rule_id: r.ruleId, category: r.category, scenes: [...r.scenes], severity: r.severity, default_action: r.defaultAction,
    thresholds: r.thresholds, agent_thresholds: r.agentThresholds ?? null, text: texts[r.ruleId] ?? "",
    question: { instructions: r.question.instructions, options: r.question.criteria }, exceptions: r.exceptions.map((x) => x.id),
  }));
  const scenes = Object.entries(current.scenes).map(([k, s]) => ({
    scene: k, required_categories: [...s.requiredCategories], allowed_actions: [...s.allowedActions], pending_visibility: s.pendingVisibility,
    deadline_ms: s.deadlineMs, human_sla_ms: s.humanSlaMs, confirm_pass: s.confirmPass ?? true, injection_guard: s.injectionGuard?.threshold ?? null, context_route: s.contextRoute ?? null,
  }));
  const reviewsOf = (v: string): number => (db.prepare("SELECT COUNT(*) AS n FROM review WHERE rules_ver=?").get(v) as { n: number }).n;
  const versions = (db.prepare("SELECT rules_ver, bundle, created_at FROM policy_bundle ORDER BY created_at DESC").all() as { rules_ver: string; bundle: string; created_at: number }[])
    .map((v) => ({ rules_ver: v.rules_ver, created_at: v.created_at, rule_ids: parse<{ rules?: { ruleId: string }[] }>(v.bundle, {}).rules?.map((x) => x.ruleId) ?? [], current: v.rules_ver === current.rulesVer, reviews: reviewsOf(v.rules_ver) }));
  return {
    current: { rules_ver: current.rulesVer, rules, scenes },
    candidate: o.candidate ? { rules_ver: o.candidate.rulesVer, rollout_pct: core.rolloutPct(db, "rules", o.candidate.rulesVer) } : null,
    versions,
    rollouts: db.prepare("SELECT kind, version, rollout_pct, loaded_at FROM version_pin ORDER BY loaded_at DESC").all() as RulesInfo["rollouts"],
    gate_runs: (db.prepare("SELECT gate_run_id, passed, created_at FROM gate_run ORDER BY created_at DESC LIMIT 50").all() as { gate_run_id: string; passed: number; created_at: number }[]).map((g) => ({ ...g, passed: g.passed === 1 })),
    calibration: { calib_ver: o.calibVer, mode: o.calibMode, files: o.calibFiles },
    proposals: (db.prepare("SELECT proposal_id, base_rules_ver, status, changes, created_at FROM feedback_proposal ORDER BY created_at DESC LIMIT 50").all() as { proposal_id: string; base_rules_ver: string; status: string; changes: string; created_at: number }[]).map((p) => ({ ...p, changes: parse(p.changes, []) })),
  };
}

/** The fitted calibration files of one judge (calib/<judge>/*.json), for the rules view. Unreadable files are skipped. */
export function readCalibFiles(dir: string, judge: string): CalibFileInfo[] {
  let names: string[] = [];
  try { names = readdirSync(join(dir, judge)).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }
  const out: CalibFileInfo[] = [];
  for (const f of names) {
    const c = parse<{ T?: number; n?: number; ece_before?: number; ece_after?: number; bucket?: { question?: string; scene?: string; rules_ver?: string } }>(readFileSync(join(dir, judge, f), "utf8"), {});
    if (typeof c.T !== "number" || !c.bucket?.question) continue;
    out.push({ question: c.bucket.question, scene: c.bucket.scene ?? "", rules_ver: c.bucket.rules_ver ?? "", T: c.T, n: c.n ?? null, ece_before: c.ece_before ?? null, ece_after: c.ece_after ?? null });
  }
  return out;
}
