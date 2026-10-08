// Phase 3d: one review end to end with the real main model (relay) and Jev, on a temp app.db + session.sqlite.
// Prints the tool trace (redacted), the ruling, and reconciles pi.usage against app.db costs.
// usage: node --experimental-strip-types scripts/run-one.ts [text]   (RELAY_* and JEV_* from env or .env)
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { UsageDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import * as core from "../packages/core/src/index.ts";
import { identityCalibrator, jevModel, jevProvider } from "../packages/judges/src/index.ts";
import { loadBundle } from "../packages/policy/src/index.ts";
import { Worker, piJudge, relayProvider } from "../packages/worker/src/index.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const AGENT = env("AGENT_MODEL", "qwen3.8-flash");

const models = createModels();
models.setProvider(relayProvider({ baseUrl: env("RELAY_BASE_URL"), apiKey: env("RELAY_API_KEY") }));
models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY") }));
const judge = piJudge(models, jevModel(models), { inCallConfirm: true, timeoutMs: 20_000 });

const { bundle, texts } = loadBundle("rules", "config/scenes.yaml");
const pricesYaml = parse(readFileSync("config/prices.yaml", "utf8")) as { models: Record<string, { input: number; output: number; cacheRead?: number }> };
const prices: core.PriceTable = { pricesVer: `prices@${core.sha256(readFileSync("config/prices.yaml", "utf8")).slice(0, 12)}`, perMillion: pricesYaml.models };
const dir = mkdtempSync(join(tmpdir(), "run-one-"));
mkdirSync("data", { recursive: true });
const db = core.openAppDb(join(dir, "app.db"), "worker");
core.ensureSchema(db);
const now = () => Date.now();

// one self-written comment with a thread neighbor
const text = process.argv[2] ?? "楼上那位，请你闭嘴，没人想听你废话";
core.intakeInsert(db, { contentId: "n1", scene: "comment", text: "大家觉得这场比赛裁判吹得怎么样？", threadId: "t1", accountId: "acct-n", eventTime: now() - 60_000 }, now() - 60_000);
core.intakeInsert(db, { contentId: "c1", scene: "comment", text, threadId: "t1", accountId: "acct-1", eventTime: now() - 1000 }, now() - 1000);
const pins = { rulesVer: bundle.rulesVer, calibVer: identityCalibrator().calibVer, evidenceVer: "evidence@run-one", pricesVer: prices.pricesVer };
const review = core.createSuspiciousReview(db, { contentId: "c1", pins, judgeModel: "jev-latest", judgeCallIds: [], pendingVisibility: "hidden", deadlineMs: 120_000, budgetTools: 12, budgetMicro: 200_000 }, now()).review;

const instructions = [
  "你是内容审核 agent。流程：1) 调用 get_thread_context 取线程上下文；2) 调用 judge（rule_ids 传空数组，evidence_ids 传第 1 步返回的 evidence_id）；",
  "3) 根据 judge 返回的各规则概率决定：全部规则 p<0.10 → dispose(action=pass, evidence_ids=[该证据], rule_ids=[])；某规则 p>=0.90 且其例外不成立 → dispose(action=takedown 或 limit，rule_ids=[该规则])；",
  "否则 release(reason=evidence_gap)。dispose 和 release 必须单独成轮调用，调用后不要再说话。",
].join("");
const calls: { kind: string; at: number }[] = [];
const worker = await Worker.open({
  db, storage: await openNodeSqliteStorage(join(dir, "session.sqlite")), models, bundle, ruleTexts: texts, workerId: "w-run-one", judge, prices, calibrator: identityCalibrator(),
  cfg: { ...core.DEFAULT_CONFIG, deadlineMs: 120_000 }, flags: { escalation: false }, maxModelCalls: 20, now, admitMax: 1,
  modelFor: () => ({ provider: "a6api", modelId: AGENT }), instructions, onExternalCall: (_c, kind) => calls.push({ kind, at: now() }),
});
const t0 = now();
await worker.start();
worker.startLoops();
console.log("admitted", await worker.admitOnce());
await worker.waitIdle();
await worker.pumpHost();
await worker.waitIdle();
const wall = now() - t0;

const r = core.requireReview(db, review.review_id);
const ruling = core.readRuling(db, review.review_id);
console.log(JSON.stringify({ state: r.state, release_reason: r.release_reason, ruling: ruling ? { action: ruling.action, rule_ids: ruling.rule_ids, allowed: ruling.allowed_actions } : null, wall_ms: wall, calls: calls.map((c) => c.kind) }));
console.log("tool_slots", db.prepare("SELECT tool, status, block_reason FROM tool_slot WHERE review_id=? ORDER BY created_at").all(review.review_id));
console.log("judge_calls", db.prepare("SELECT status, confirms_call_id IS NOT NULL AS is_confirm, input_tokens, output_tokens, cost_micro FROM judge_call WHERE review_id=?").all(review.review_id));
console.log("rejections", db.prepare("SELECT payload FROM audit WHERE kind='submit_rejected'").all());
// cost reconciliation: pi.usage (durable) vs app.db
const usage = await worker.harness.snapshot(UsageDoc, Number(r.conversation_id) as never, BACKGROUND_CONTEXT);
const modelsMicro = usage ? core.microOfModels(prices, usage.models as Record<string, core.Usage>) : 0;
const spent = core.spentMicro(db, review.review_id, modelsMicro);
console.log(JSON.stringify({ pi_usage_models: usage?.models, models_micro: modelsMicro, tool_spent: core.toolSpentMicro(db, review.review_id), spent_formula: spent, review_used_micro: r.used_micro, review_cost_status: r.cost_status, yuan: core.yuan(spent.spent) }));
console.log("sessions", await worker.sessions());
console.log("transcript_kinds", db.prepare("SELECT tool, status FROM tool_slot WHERE review_id=? ORDER BY created_at").all(review.review_id).length, "tool slots");
await worker.close();
