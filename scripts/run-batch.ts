// Phase 3e (E-01): N self-written short comments through the full agent with the real main model and Jev.
// Admits with concurrency, waits for every review to reach a terminal state or human_queue, then reconciles.
// usage: node --experimental-strip-types scripts/run-batch.ts [admitMax]   (RELAY_* / JEV_* from env or .env)
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { createModels } from "@earendil-works/pi-ai/models";
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
const ADMIT_MAX = Number(process.argv[2] ?? 4);

const models = createModels();
models.setProvider(relayProvider({ baseUrl: env("RELAY_BASE_URL"), apiKey: env("RELAY_API_KEY") }));
models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY") }));
const judge = piJudge(models, jevModel(models), { inCallConfirm: true, timeoutMs: 20_000 });
const { bundle, texts } = loadBundle("rules", "config/scenes.yaml");
const pricesRaw = readFileSync("config/prices.yaml", "utf8");
const prices: core.PriceTable = { pricesVer: `prices@${core.sha256(pricesRaw).slice(0, 12)}`, perMillion: (parse(pricesRaw) as { models: core.PriceTable["perMillion"] }).models };
const dir = mkdtempSync(join(tmpdir(), "run-batch-"));
mkdirSync("data", { recursive: true });
const db = core.openAppDb(join(dir, "app.db"), "worker");
core.ensureSchema(db);
const now = () => Date.now();

// 20 self-written comments (no dataset text), with the label I expect, for eyeballing only
const S: [string, string][] = (JSON.parse(readFileSync("fixtures/benign/sentences.json", "utf8")) as { run_batch: [string, string][] }).run_batch;
const pins = { rulesVer: bundle.rulesVer, calibVer: identityCalibrator().calibVer, evidenceVer: "evidence@run-batch", pricesVer: prices.pricesVer };
core.intakeInsert(db, { contentId: "n1", scene: "comment", text: "大家觉得这场比赛裁判吹得怎么样？", threadId: "t1", accountId: "acct-n", eventTime: now() - 60_000 }, now() - 60_000);
const ids: string[] = [];
for (const [i, [text]] of S.entries()) {
  const cid = `b${i}`;
  core.intakeInsert(db, { contentId: cid, scene: "comment", text, threadId: "t1", accountId: `acct-${i % 5}`, eventTime: now() - 1000 }, now() - 1000);
  ids.push(core.createSuspiciousReview(db, { contentId: cid, pins, judgeModel: "jev-latest", judgeCallIds: [], pendingVisibility: "hidden", deadlineMs: 180_000, budgetTools: 12, budgetMicro: 200_000 }, now()).review.review_id);
}

const instructions = [
  "你是内容审核 agent。流程：1) 调用 get_thread_context 取线程上下文；2) 调用 judge（rule_ids 传空数组，evidence_ids 传第 1 步返回的 evidence_id）；",
  "3) 根据 judge 返回的各规则概率决定：全部规则 p<0.10 → dispose(action=pass, evidence_ids=[该证据], rule_ids=[])；某规则 p>=0.90 且其例外不成立 → dispose(action=takedown 或 limit，rule_ids=[该规则])；",
  "否则 release(reason=evidence_gap)。dispose 和 release 必须单独成轮调用，调用后不要再说话。",
].join("");
const worker = await Worker.open({
  db, storage: await openNodeSqliteStorage(join(dir, "session.sqlite")), models, bundle, ruleTexts: texts, workerId: "w-batch", judge, prices, calibrator: identityCalibrator(),
  cfg: { ...core.DEFAULT_CONFIG, deadlineMs: 180_000 }, flags: { escalation: false }, maxModelCalls: 20, now, admitMax: ADMIT_MAX,
  modelFor: () => ({ provider: "a6api", modelId: AGENT }), instructions,
});
const t0 = now();
await worker.start();
worker.startLoops();
const pending = () => (db.prepare("SELECT COUNT(*) AS n FROM review WHERE state IN ('queued','investigating')").get() as { n: number }).n;
while (pending() > 0 && now() - t0 < 15 * 60_000) {
  await worker.admitOnce();
  await new Promise((r) => setTimeout(r, 1000));
  core.control.tick(db, { ...core.DEFAULT_CONFIG, deadlineMs: 180_000 }, () => 1, 3_600_000, now());
}
await worker.pumpHost();
await worker.waitIdle();
const wall = now() - t0;
worker.stopLoops();
core.outbox.drain(db, (ev) => void core.consumer.apply(db, ev, now()), now());

const rows = ids.map((id, i) => {
  const r = core.requireReview(db, id);
  const rul = core.readRuling(db, id);
  const tools = (db.prepare("SELECT GROUP_CONCAT(tool) AS t FROM (SELECT tool FROM tool_slot WHERE review_id=? AND status<>'blocked' ORDER BY created_at)").get(id) as { t: string | null }).t ?? "";
  const rejects = (db.prepare("SELECT COUNT(*) AS n FROM audit WHERE kind='submit_rejected' AND ref_id=?").get(id) as { n: number }).n;
  return { i, expected: S[i]![1], state: r.state, action: rul?.action ?? null, rules: rul ? JSON.parse(rul.rule_ids) as string[] : [], release: r.release_reason, used_micro: r.used_micro, cost_status: r.cost_status, tools, rejects };
});
for (const r of rows) console.log(`${String(r.i).padStart(2)} [${r.expected}] ${r.state} ${r.action ?? r.release ?? ""} ${r.rules.join(",")} ¥${core.yuan(r.used_micro ?? 0)} rejects=${r.rejects} :: ${r.tools}`);
const byState: Record<string, number> = {};
for (const r of rows) byState[r.state] = (byState[r.state] ?? 0) + 1;
const totalMicro = rows.reduce((a, r) => a + (r.used_micro ?? 0), 0);
const dup = (db.prepare("SELECT COUNT(*) AS n FROM (SELECT review_id, COUNT(*) c FROM ruling GROUP BY review_id HAVING c>1)").get() as { n: number }).n;
const summary = { n: S.length, admitMax: ADMIT_MAX, wall_ms: wall, byState, total_yuan: core.yuan(totalMicro), per_item_yuan: core.yuan(Math.round(totalMicro / S.length)), duplicate_rulings: dup,
  reconcile_instant: core.reconcile.instant(db, { scanMs: 2000, intakeQueueMaxMs: 3_600_000 }, now()).map((v) => v.check), reconcile_final: core.reconcile.final(db).filter((v) => v.check !== "outbox_not_drained").map((v) => v.check) };
console.log(JSON.stringify(summary));
writeFileSync("data/run-batch.json", JSON.stringify({ summary, rows, date: new Date().toISOString() }, null, 1));
await worker.close();
