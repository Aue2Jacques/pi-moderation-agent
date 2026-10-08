// Tool-count hard limit and cost soft limit. docs/dev-doc-v1.md §7.5, T11/T11'/T12/T13.
import { tx, type Db } from "./db.ts";
import { microOfUsage, type PriceTable, type Usage } from "./prices.ts";
import { CoreError } from "./errors.ts";

export const TERMINAL_TOOLS: ReadonlySet<string> = new Set(["dispose", "release"]);

export function usedToolSlots(db: Db, reviewId: string): number {
  const row = db.prepare("SELECT COALESCE(SUM(counts_toward_limit),0) AS n FROM tool_slot WHERE review_id=? AND status<>'blocked'").get(reviewId) as { n: number };
  return row.n;
}

export type SlotResult = { status: "reserved" | "blocked"; created: boolean };

/** T11. Idempotent on (review_id, call_id). Throws E_BUDGET_EXCEEDED when blocked (new or replayed). */
export function reserveToolSlot(db: Db, reviewId: string, attempt: number, callId: string, tool: string, estMicro: number, budgetTools: number, at: number): SlotResult {
  // The blocked row must be committed (it is the audit trail of the block), so decide inside the tx and throw after it.
  const out = tx(db, (): SlotResult & { replay?: boolean } => {
    const counts = TERMINAL_TOOLS.has(tool) ? 0 : 1;
    const res = db.prepare("INSERT OR IGNORE INTO tool_slot(review_id, call_id, attempt, tool, counts_toward_limit, reserved_micro, status, created_at) VALUES (?,?,?,?,?,?,'reserved',?)")
      .run(reviewId, callId, attempt, tool, counts, estMicro, at);
    if (res.changes === 0) {
      const existing = db.prepare("SELECT status FROM tool_slot WHERE review_id=? AND call_id=?").get(reviewId, callId) as { status: "reserved" | "blocked" };
      return { status: existing.status, created: false, replay: true };
    }
    if (counts === 1 && usedToolSlots(db, reviewId) > budgetTools) {
      db.prepare("UPDATE tool_slot SET status='blocked', block_reason='budget_tools' WHERE review_id=? AND call_id=?").run(reviewId, callId);
      return { status: "blocked", created: true };
    }
    return { status: "reserved", created: true };
  });
  if (out.status === "blocked") throw new CoreError("E_BUDGET_EXCEEDED", out.replay ? `call ${callId} was blocked` : `tool budget ${budgetTools} exhausted`, { replay: !!out.replay });
  return { status: out.status, created: out.created };
}

export function roundHadBlocked(db: Db, reviewId: string, reason: string, sinceMs: number): boolean {
  const row = db.prepare("SELECT COUNT(*) AS n FROM tool_slot WHERE review_id=? AND status='blocked' AND block_reason=? AND created_at >= ?").get(reviewId, reason, sinceMs) as { n: number };
  return row.n > 0;
}

/** T11'. Opens a physical request row; returns its request_no. Replays open a new row. */
export function openToolRequest(db: Db, reviewId: string, callId: string, at: number): number {
  return tx(db, () => {
    const row = db.prepare("SELECT COALESCE(MAX(request_no),0)+1 AS n FROM tool_request WHERE review_id=? AND call_id=?").get(reviewId, callId) as { n: number };
    db.prepare("INSERT INTO tool_request(review_id, call_id, request_no, cost_status, created_at) VALUES (?,?,?,'inflight',?)").run(reviewId, callId, row.n, at);
    return row.n;
  });
}

/** T12. Idempotent: only an inflight row settles. */
export function settleToolRequest(db: Db, reviewId: string, callId: string, requestNo: number, micro: number | null, judgeCallId: string | null, at: number): boolean {
  return tx(db, () => db.prepare(
    "UPDATE tool_request SET cost_micro=?, cost_status=?, judge_call_id=?, settled_at=? WHERE review_id=? AND call_id=? AND request_no=? AND cost_status='inflight'",
  ).run(micro, micro === null ? "unknown" : "settled", judgeCallId, at, reviewId, callId, requestNo).changes === 1);
}

/** Tool-side part of the cost formula: settled requests + reserved estimate for inflight/unknown requests. */
export function toolSpentMicro(db: Db, reviewId: string): { settled: number; estimated: number; hasUnknown: boolean } {
  const row = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN r.cost_status='settled' THEN r.cost_micro ELSE 0 END),0) AS settled,
            COALESCE(SUM(CASE WHEN r.cost_status<>'settled' THEN s.reserved_micro ELSE 0 END),0) AS estimated,
            COALESCE(SUM(CASE WHEN r.cost_status<>'settled' THEN 1 ELSE 0 END),0) AS unknown_n
     FROM tool_request r JOIN tool_slot s ON s.review_id=r.review_id AND s.call_id=r.call_id WHERE r.review_id=?`,
  ).get(reviewId) as { settled: number; estimated: number; unknown_n: number };
  return { settled: row.settled, estimated: row.estimated, hasUnknown: row.unknown_n > 0 };
}

/** Model cost from our own ledger: every physical response in model_call, priced now (R5a). Used by the host loop and
 *  settlement, where no UsageDoc is at hand. */
export function modelSpentMicro(db: Db, prices: PriceTable, reviewId: string): number {
  const rows = db.prepare("SELECT model, usage FROM model_call WHERE review_id=?").all(reviewId) as { model: string; usage: string }[];
  let total = 0;
  for (const r of rows) {
    const u = JSON.parse(r.usage) as Partial<Usage> | null;
    if (!u) continue;
    total += microOfUsage(prices, r.model, { input: u.input ?? 0, output: u.output ?? 0, ...(u.cacheRead !== undefined ? { cacheRead: u.cacheRead } : {}) });
  }
  return total;
}

/** §7.5 formula from the ledger alone: model_call priced + tool settled + reserved for inflight/unknown (round-9 item 7). */
export function spentFromLedger(db: Db, prices: PriceTable, reviewId: string): { spent: number; settled: boolean; models: number; tools: number } {
  const models = modelSpentMicro(db, prices, reviewId);
  const t = toolSpentMicro(db, reviewId);
  return { spent: models + t.settled + t.estimated, settled: !t.hasUnknown, models, tools: t.settled + t.estimated };
}

/** §7.5 formula: pi.usage.models (priced by caller) + tool settled + reserved for inflight/unknown. */
export function spentMicro(db: Db, reviewId: string, modelsMicro: number): { spent: number; settled: boolean } {
  const t = toolSpentMicro(db, reviewId);
  return { spent: modelsMicro + t.settled + t.estimated, settled: !t.hasUnknown };
}

/** T13: one row per physical provider response (R5a). `responseKey` identifies the response (responseId, else its
 *  timestamp), so a hook replayed for the same response does not bill it twice. */
export function recordModelCall(db: Db, generationTaskId: string, responseKey: string, reviewId: string, attempt: number, conversationId: string, model: string, usage: unknown, stopReason: string, at: number): boolean {
  return tx(db, () => db.prepare(
    "INSERT OR IGNORE INTO model_call(generation_task_id, response_key, review_id, attempt, conversation_id, model, usage, stop_reason, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(generationTaskId, responseKey, reviewId, attempt, conversationId, model, JSON.stringify(usage), stopReason, at).changes === 1);
}

export type UsageTotals = Record<string, { input: number; output: number; cacheRead: number; responses?: number }>;
/** Ledger side of the usage reconcile (stage-① known gap): model_call rows (one per physical response) summed per bare
 *  model id; optionally only the given conversations (the ones a W instance owns). */
export function ledgerUsageByModel(db: Db, conversationIds?: readonly string[]): UsageTotals {
  const rows = db.prepare("SELECT conversation_id, model, usage FROM model_call").all() as { conversation_id: string; model: string; usage: string | null }[];
  const keep = conversationIds ? new Set(conversationIds) : undefined;
  const out: UsageTotals = {};
  for (const r of rows) {
    if (keep && !keep.has(r.conversation_id)) continue;
    const u = (r.usage ? JSON.parse(r.usage) : {}) as Partial<Usage>;
    const k = r.model.split("/").pop()!;
    const t = (out[k] ??= { input: 0, output: 0, cacheRead: 0, responses: 0 });
    t.input += u.input ?? 0; t.output += u.output ?? 0; t.cacheRead += u.cacheRead ?? 0; t.responses! += 1;
  }
  return out;
}

/** Compare Pi's pi.usage (keyed provider/model) with the ledger (keyed by bare model): every counter must match. */
export function compareUsage(pi: Readonly<Record<string, Partial<Usage>>>, ledger: UsageTotals): { model: string; counter: string; pi: number; ledger: number }[] {
  const piBare: UsageTotals = {};
  for (const [k, u] of Object.entries(pi)) {
    const b = k.split("/").pop()!;
    const t = (piBare[b] ??= { input: 0, output: 0, cacheRead: 0 });
    t.input += u.input ?? 0; t.output += u.output ?? 0; t.cacheRead += u.cacheRead ?? 0;
  }
  const diffs: { model: string; counter: string; pi: number; ledger: number }[] = [];
  for (const m of new Set([...Object.keys(piBare), ...Object.keys(ledger)])) {
    for (const c of ["input", "output", "cacheRead"] as const) {
      const a = piBare[m]?.[c] ?? 0, b = ledger[m]?.[c] ?? 0;
      if (a !== b) diffs.push({ model: m, counter: c, pi: a, ledger: b });
    }
  }
  return diffs;
}
