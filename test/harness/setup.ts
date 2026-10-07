// Phase-2 fixtures: a Worker over faux model + recorded judge. Model steps are indexed by the number of assistant
// messages already in the transcript, so a recovered run continues deterministically.
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { Storage } from "@earendil-works/pi-durable";
import * as core from "../../packages/core/src/index.ts";
import { Worker, recordedJudge, uniform, type JudgeClient, type JudgeRequest, type JudgeResponse } from "../../packages/worker/src/index.ts";
import { BUNDLE, CFG, PINS, T0, seedContent } from "../helpers.ts";

export type Step = { tool: string; args: Record<string, unknown>; id?: string } | { text: string } | { tools: { tool: string; args: Record<string, unknown>; id?: string }[] };

/** Build a faux response factory that answers step[i] for the i-th assistant turn (replay-safe). */
export function scripted(steps: Step[]): FauxResponseStep {
  return (context) => {
    const i = context.messages.filter((m) => m.role === "assistant").length;
    const s = steps[Math.min(i, steps.length - 1)]!;
    if ("text" in s) return fauxAssistantMessage(s.text);
    const calls = "tools" in s ? s.tools : [s];
    return fauxAssistantMessage(calls.map((c, k) => fauxToolCall(c.tool, c.args, { id: c.id ?? `${i}-${k}-${c.tool}` })), { stopReason: "toolUse" });
  };
}

export const PRICES: core.PriceTable = { pricesVer: "prices@t1", perMillion: { "faux/faux-1": { input: 0, output: 0 }, "jev-recorded": { input: 1_000_000, output: 0 } } };

export type JudgeScript = (req: JudgeRequest) => JudgeResponse;

/** Low-risk everywhere: p=0.02 for rules, exceptions not_applies, image none. */
export const lowRisk: JudgeScript = (req) => ({ status: "ok", model: "jev-recorded", answers: uniform(req.questions, 0.02), usage: { input: 480, output: 50 }, latencyMs: 250 });
/** High risk on rule questions, exceptions verified not_applies, image none. */
export const highRisk: JudgeScript = (req) => ({
  status: "ok", model: "jev-recorded", usage: { input: 480, output: 50 }, latencyMs: 250,
  answers: { ...uniform(req.questions.filter((q) => q.kind === "rule"), 0.99), ...uniform(req.questions.filter((q) => q.kind !== "rule"), 0.01) },
});

export type WorkerFixture = { db: core.Db; worker: Worker; calls: { conversationId: string; kind: string; at: number }[]; faux: ReturnType<typeof fauxProvider>; close: () => Promise<void> };

export async function makeWorker(o: { db: core.Db; storage?: Storage; steps: Step[]; judge?: JudgeScript | JudgeClient; workerId?: string; admitMax?: number; cfg?: core.Config; now?: () => number; escalation?: boolean }): Promise<WorkerFixture> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array.from({ length: 200 }, () => scripted(o.steps)));
  const calls: WorkerFixture["calls"] = [];
  const now = o.now ?? (() => Date.now());
  const judge = typeof o.judge === "function" ? recordedJudge(o.judge) : (o.judge ?? recordedJudge(lowRisk));
  const worker = await Worker.open({
    db: o.db, storage: o.storage ?? new MemoryStorage(), models, bundle: BUNDLE, ruleTexts: { "ABUSE-001": "rule text", "MARKETING-003": "rule text" },
    workerId: o.workerId ?? "w1", judge, prices: PRICES, cfg: o.cfg ?? CFG, flags: { escalation: o.escalation ?? false }, maxModelCalls: 40, now,
    admitMax: o.admitMax ?? 10, modelFor: () => ({ provider: "faux", modelId: "faux-1" }), instructions: "审核这条内容。",
    onExternalCall: (conversationId, kind) => calls.push({ conversationId, kind, at: now() }),
  });
  return { db: o.db, worker, calls, faux, close: () => worker.close() };
}

/** Seed one content and a queued suspicious review; returns the review. */
export function queuedReview(db: core.Db, id: string, o: { thread?: string; account?: string; at?: number; budgetTools?: number } = {}): core.ReviewRow {
  const at = o.at ?? T0;
  seedContent(db, id, "comment", { ...(o.thread ? { threadId: o.thread } : {}), ...(o.account ? { accountId: o.account } : {}), eventTime: at });
  return core.createSuspiciousReview(db, { contentId: id, pins: PINS, judgeModel: "jev", judgeCallIds: [], pendingVisibility: "hidden", deadlineMs: CFG.deadlineMs, budgetTools: o.budgetTools ?? 12, budgetMicro: 50_000 }, at).review;
}

/** The faux queue consumes one factory per request; install enough copies for any scenario. */
export function setScript(fx: WorkerFixture, step: FauxResponseStep): void {
  fx.faux.setResponses(Array.from({ length: 200 }, () => step));
}

export async function runToIdle(fx: WorkerFixture): Promise<void> {
  await fx.worker.waitIdle();
  await fx.worker.pumpHost();
  await fx.worker.waitIdle();
}

export const review = (db: core.Db, id: string): core.ReviewRow => core.requireReview(db, id);
export const ruling = (db: core.Db, id: string): core.RulingRow | undefined => core.readRuling(db, id);

/** A complete agent script: read thread → judge with that evidence → confirm → dispose. */
export const PASS_SCRIPT: Step[] = [
  { tool: "get_thread_context", args: {} },
  { tool: "judge", args: { rule_ids: [], evidence_ids: ["$E1"] } },
  { tool: "confirm", args: { judge_call_id: "$J1", rule_ids: [], evidence_ids: ["$E1"] } },
  { tool: "dispose", args: { action: "pass", evidence_ids: ["$E1"], rule_ids: [], reason: "low risk, confirmed" } },
  { text: "done" },
];

/**
 * Steps may reference "$E<n>" (n-th evidence id of the review) and "$J<n>" (n-th judge_call id). The scripted model
 * cannot read tool results, so the fixture resolves placeholders against app.db at request time.
 */
export function resolving(db: core.Db, reviewIdOf: () => string | undefined, steps: Step[]): FauxResponseStep {
  const base = scripted(steps);
  return (context, options, state, model) => {
    const rid = reviewIdOf();
    const sub = (v: unknown): unknown => {
      if (typeof v === "string" && rid) {
        const e = /^\$E(\d+)$/.exec(v);
        if (e) return core.evidenceId(rid, Number(e[1]));
        const j = /^\$J(\d+)$/.exec(v);
        if (j) {
          const rows = db.prepare("SELECT judge_call_id FROM judge_call WHERE review_id=? ORDER BY created_at").all(rid) as { judge_call_id: string }[];
          return rows[Number(j[1]) - 1]?.judge_call_id ?? v;
        }
      }
      if (Array.isArray(v)) return v.map(sub);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, sub(x)]));
      return v;
    };
    const msg = typeof base === "function" ? base(context, options, state, model) : base;
    const resolved = msg instanceof Promise ? msg : Promise.resolve(msg);
    return resolved.then((m) => ({ ...m, content: m.content.map((c) => (c.type === "toolCall" ? { ...c, arguments: sub(c.arguments) as Record<string, unknown> } : c)) }));
  };
}
