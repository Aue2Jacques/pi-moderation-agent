// A/C comparison on the frozen case pool (dev plan 2026-10-08 §3). Functional trial, not a claim of a significant effect.
//   prepare <outDir> [limit]   ingest the cases (parents as context content, account history as synth events, targets
//                              through intake) and run the real fast path (Jev) once -> <outDir>/base.db; both arms
//                              start from a copy of it, so they share the fast path's results and the evidence environment
//   run <outDir> <A|C>         copy base.db, run the worker with the real main model on every queued review, wait for
//                              terminal / human, write <outDir>/<arm>.json (per case: route, final state, action, rules,
//                              tools, judge calls, cost of every physical request, latency, outcome vs the expectation)
//   report <outDir>            compare the arms -> <outDir>/report.md and report.json (counts only, no text)
// A = fixed evidence (always thread context and account history, then judge with both); C = the agent decides what to
// fetch from its task brief. Everything else is the same: case pool, main model, rules, calibration, evidence, budget,
// deadline and the submit path. Every run writes a manifest (code commit, rules / calib / prices versions, models, case
// pool sha, parameters, start / end, output sha) next to its results.
// usage: node --experimental-strip-types scripts/run-ac.ts prepare|run|report ...   (RELAY_* / JEV_* / CALIB_DIR from env or .env)
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse } from "yaml";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import * as core from "../packages/core/src/index.ts";
import { Gateway, DEFAULT_GATEWAY_CONFIG } from "../packages/gateway/src/index.ts";
import { identityCalibrator, jevModel, jevProvider, loadCalibrator } from "../packages/judges/src/index.ts";
import { loadBundle } from "../packages/policy/src/index.ts";
import { Worker, piJudge, relayProvider } from "../packages/worker/src/index.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const [phase, outDir, arg3] = process.argv.slice(2);
if (!phase || !outDir) throw new Error("usage: run-ac.ts prepare <outDir> [limit] | run <outDir> <A|C> | report <outDir>");

const CASES = env("CASE_POOL", "data/cases/pool-v1.jsonl");
const AGENT = env("AGENT_MODEL", "qwen3.8-flash");
const JEV = env("JEV_MODEL", "jev-latest");
const CALIB = env("CALIB_DIR", "");   // empty -> identity (raw probabilities), recorded in the manifest
const ADMIT = Number(env("ADMIT_MAX", "8"));
// queued reviews get their deadline re-based to the start of the arm's run (base.db was made earlier; the scene's 60 s
// would have passed), the same window for both arms; latency is measured per case separately
const DEADLINE_MS = Number(env("AGENT_DEADLINE_MS", "900000"));
const { bundle, texts } = loadBundle("rules", "config/scenes.yaml");
const pricesRaw = readFileSync("config/prices.yaml", "utf8");
const prices: core.PriceTable = { pricesVer: `prices@${core.sha256(pricesRaw).slice(0, 12)}`, perMillion: (parse(pricesRaw) as { models: core.PriceTable["perMillion"] }).models };
const calibrator = CALIB ? loadCalibrator(CALIB, JEV) : identityCalibrator();
const models = createModels();
const judgeFor = () => {
  models.setProvider(relayProvider({ baseUrl: env("RELAY_BASE_URL"), apiKey: env("RELAY_API_KEY") }));
  models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY"), modelId: JEV }));
  return piJudge(models, jevModel(models, JEV), { inCallConfirm: true, timeoutMs: 20_000 });
};
type Case = {
  case_id: string; kind: string; source: string; pair?: number;
  target: { text: string; account: string; mentions: string[]; images: string[] };
  thread: { ref: string; text: string; account: string; offset_min: number }[];
  reply_to: string | null; history: { kind: "prior_ruling" | "post"; payload: unknown; offset_days: number }[];
  expected: { disposition: "pass" | "limit" | "takedown" | "human"; rules: string[] };
};
/** sha over the code and policy actually on disk (each package src dir, scripts, rules, config, calib): the dev box is synced
 *  by copying files, so its git HEAD does not say which code ran */
function codeSha(): string {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "dist" && e.name !== "dist-types" && e.name !== "__pycache__") walk(p); } else files.push(p); } };
  for (const d of [...readdirSync("packages").map((x) => join("packages", x, "src")), "scripts", "rules", "config", "calib"]) if (existsSync(d)) walk(d);
  const h = createHash("sha256");
  for (const f of files.sort()) h.update(`${f}\n`).update(readFileSync(f));
  return h.digest("hex").slice(0, 16);
}
const manifest = (extra: Record<string, unknown>) => ({
  gitHead: (() => { try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { return "unknown"; } })(),
  codeSha: codeSha(),
  rulesVer: bundle.rulesVer, calibVer: calibrator.calibVer, calibDir: CALIB || "identity", pricesVer: prices.pricesVer, judge: JEV, agent: AGENT,
  casePool: CASES, casePoolSha: sha(readFileSync(CASES)), modelView: core.MODEL_VIEW_VERSION, admitMax: ADMIT, deadlineMs: DEADLINE_MS,
  budgetTools: DEFAULT_GATEWAY_CONFIG.budgetTools, budgetMicro: DEFAULT_GATEWAY_CONFIG.budgetMicro, ...extra,
});
mkdirSync(outDir, { recursive: true });

if (phase === "prepare") {
  const cases = readFileSync(CASES, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Case).slice(0, arg3 ? Number(arg3) : undefined);
  const dbPath = join(outDir, "base.db");
  if (existsSync(dbPath)) throw new Error(`${dbPath} exists; use a new outDir`);
  const db = core.openAppDb(dbPath, "tool");
  core.ensureSchema(db);
  const t0 = Date.now();
  const at = t0 - 60_000;
  for (const c of cases) {
    const thread = `t-${c.case_id}`;
    for (const p of c.thread) core.contextInsert(db, { contentId: `${c.case_id}-${p.ref}`, scene: "comment", text: p.text, threadId: thread, accountId: p.account, eventTime: at - p.offset_min * 60_000 }, at - 1000);
    c.history.forEach((h, k) => core.synthEventInsert(db, { eventId: `${c.case_id}-h${k}`, accountId: c.target.account, kind: h.kind, payload: h.payload, eventTime: at - h.offset_days * 86_400_000 }));
    const replyTo = c.reply_to === "parent" ? `${c.case_id}-parent` : c.reply_to === "deleted-parent" ? `${c.case_id}-deleted` : undefined;
    core.intakeInsert(db, { contentId: c.case_id, scene: "comment", text: c.target.text, threadId: thread, accountId: c.target.account, eventTime: at,
      ...(replyTo ? { replyTo } : {}), ...(c.target.mentions.length ? { mentions: c.target.mentions } : {}), ...(c.target.images.length ? { imageRefs: c.target.images } : {}) }, at);
  }
  const gw = new Gateway({ db, bundle, ruleTexts: texts, judge: judgeFor(), prices, calibrator, evidenceVer: "evidence@ac", judgeModel: JEV, cfg: DEFAULT_GATEWAY_CONFIG, now: () => Date.now(), gatewayId: "g-ac" });
  const outcomes: unknown[] = [];
  for (let round = 0; round < 50; round++) {
    const left = (db.prepare("SELECT COUNT(*) AS n FROM intake WHERE status<>'judged'").get() as { n: number }).n;
    if (left === 0) break;
    outcomes.push(...await gw.processIntakeOnce());
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const byDecision: Record<string, number> = {};
  for (const o of outcomes as { decision: string }[]) byDecision[o.decision] = (byDecision[o.decision] ?? 0) + 1;
  db.close();
  const m = manifest({ phase, cases: cases.length, fastpath: byDecision, started: new Date(t0).toISOString(), ended: new Date().toISOString(), baseDbSha: sha(readFileSync(dbPath)) });
  writeFileSync(join(outDir, "prepare.json"), JSON.stringify({ manifest: m, outcomes }, null, 1));
  console.log(JSON.stringify(m));
} else if (phase === "run") {
  const arm = arg3 as "A" | "C";
  if (arm !== "A" && arm !== "C") throw new Error("arm must be A or C");
  const dir = join(outDir, arm);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "app.db");
  if (existsSync(dbPath)) throw new Error(`${dbPath} exists; an arm runs once per outDir`);
  copyFileSync(join(outDir, "base.db"), dbPath);
  const db = core.openAppDb(dbPath, "worker");
  core.ensureSchema(db);
  const INSTR: Record<"A" | "C", string> = {
    A: [
      "你是内容审核 agent，按固定流程取证：1) get_thread_context；2) get_account_history；3) judge（rule_ids 传空数组，evidence_ids 传前两步的两个 evidence_id）；",
      "4) 看 judge 返回的 support：allowed_now 里有处置就 dispose 这个处置（rule_ids 用支持它的规则，evidence_ids 用 dispose_with）；缺 confirm 就先 confirm 再看 support；否则 release(reason=evidence_gap)。",
      "dispose 和 release 必须单独成轮调用，调用后不要再说话。",
    ].join(""),
    C: [
      "你是内容审核 agent。读下面的任务说明，自己决定需要哪些证据：只取能改变判断的证据，不需要的不取。取证后用 judge 带上证据复判；",
      "看 judge 返回的 support：allowed_now 里有处置就 dispose（rule_ids 用支持它的规则，evidence_ids 用 dispose_with）；缺 confirm 就先 confirm；能取的证据都取过仍不能放行或处置就 release(reason=evidence_gap)。",
      "dispose 和 release 必须单独成轮调用，调用后不要再说话。",
    ].join(""),
  };
  const now = () => Date.now();
  const worker = await Worker.open({
    db, storage: await openNodeSqliteStorage(join(dir, "session.sqlite")), models, bundle, ruleTexts: texts, workerId: `w-ac-${arm}`, judge: judgeFor(), prices, calibrator,
    cfg: { ...core.DEFAULT_CONFIG, deadlineMs: DEADLINE_MS }, flags: { escalation: false }, maxModelCalls: 20, now, admitMax: ADMIT,
    modelFor: () => ({ provider: "a6api", modelId: AGENT }), instructions: INSTR[arm],
  });
  const t0 = now();
  const rebased = db.prepare("UPDATE review SET deadline_at=?, updated_at=? WHERE state='queued'").run(t0 + DEADLINE_MS, t0).changes;
  await worker.start();
  worker.startLoops();
  const pending = () => (db.prepare("SELECT COUNT(*) AS n FROM review WHERE state IN ('queued','investigating')").get() as { n: number }).n;
  while (pending() > 0 && now() - t0 < DEADLINE_MS + 120_000) {
    await worker.admitOnce();
    await new Promise((r) => setTimeout(r, 1000));
    core.control.tick(db, { ...core.DEFAULT_CONFIG, deadlineMs: DEADLINE_MS }, () => 1, 3_600_000, now());
  }
  await worker.pumpHost();
  await worker.waitIdle();
  worker.stopLoops();
  core.outbox.drain(db, (ev) => void core.consumer.apply(db, ev, now()), now());
  const cases = readFileSync(CASES, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Case);
  const rows = cases.filter((c) => db.prepare("SELECT 1 FROM content WHERE content_id=?").get(c.case_id)).map((c) => {
    const reviews = db.prepare("SELECT * FROM review WHERE content_id=? ORDER BY seq").all(c.case_id) as core.ReviewRow[];
    const r = reviews[reviews.length - 1]!;
    const rul = core.readRuling(db, r.review_id);
    const agentRan = (db.prepare("SELECT COUNT(*) AS n FROM tool_slot WHERE review_id=?").get(r.review_id) as { n: number }).n > 0;
    const tools = ((db.prepare("SELECT GROUP_CONCAT(tool) AS t FROM (SELECT tool FROM tool_slot WHERE review_id=? AND status<>'blocked' ORDER BY created_at)").get(r.review_id) as { t: string | null }).t ?? "").split(",").filter(Boolean);
    const judgeCalls = (db.prepare("SELECT COUNT(*) AS n FROM judge_call WHERE content_id=? AND confirms_call_id IS NULL").get(c.case_id) as { n: number }).n;
    // every physical request: fast-path judge calls (bound to the review) + the agent's model calls and tool requests
    const fastMicro = (db.prepare("SELECT COALESCE(SUM(cost_micro),0) AS m FROM judge_call WHERE content_id=? AND attempt IS NULL").get(c.case_id) as { m: number }).m;
    const agentMicro = agentRan ? core.spentFromLedger(db, prices, r.review_id).spent : 0;
    const done = (db.prepare("SELECT MAX(created_at) AS t FROM ruling WHERE review_id=?").get(r.review_id) as { t: number | null }).t ?? r.updated_at;
    const route = r.suspect_reason !== null || agentRan ? "agent" : r.state === "human_queue" ? "human_direct" : "fastpath";
    const action = rul?.action ?? null;
    const sys = ["judge_unavailable", "fastpath_error", "budget_cost", "budget_tools", "deadline", "crash", "lease_lost"].some((x) => (r.release_reason ?? "").startsWith(x));
    const outcome = r.state === "human_queue"
      ? (c.expected.disposition === "human" ? "correct_human" : sys ? "system_failure" : "human_instead_of_auto")
      : action === null ? "system_failure"
        : c.expected.disposition === "human" ? "auto_when_human_expected"
          : action === c.expected.disposition ? "correct_auto" : "wrong_auto";
    return { case_id: c.case_id, kind: c.kind, expected: c.expected.disposition, route, state: r.state, action, rules: rul ? JSON.parse(rul.rule_ids) as string[] : [], release: r.release_reason, suspect: r.suspect_reason,
      outcome, tools, judge_calls: judgeCalls, cost_micro: fastMicro + agentMicro, latency_ms: done - (db.prepare("SELECT created_at FROM intake WHERE content_id=?").get(c.case_id) as { created_at: number }).created_at };
  });
  const m = manifest({ phase, arm, instructions: INSTR[arm], deadlineMode: `queued reviews re-based to run start + ${DEADLINE_MS} ms (${rebased} rows)`, started: new Date(t0).toISOString(), ended: new Date().toISOString(), wallMs: now() - t0,
    reconcile: core.reconcile.final(db).filter((v) => v.check !== "outbox_not_drained").map((v) => v.check) });
  const out = JSON.stringify({ manifest: m, rows }, null, 1);
  writeFileSync(join(outDir, `${arm}.json`), out);
  console.log(JSON.stringify({ arm, cases: rows.length, outputSha: sha(out), outcomes: rows.reduce((a: Record<string, number>, r) => { a[r.outcome] = (a[r.outcome] ?? 0) + 1; return a; }, {}) }));
  await worker.close();
} else if (phase === "report") {
  type Row = { case_id: string; kind: string; expected: string; route: string; outcome: string; tools: string[]; judge_calls: number; cost_micro: number; latency_ms: number; action: string | null; release: string | null };
  const load = (arm: string) => JSON.parse(readFileSync(join(outDir, `${arm}.json`), "utf8")) as { manifest: Record<string, unknown>; rows: Row[] };
  const A = load("A"), C = load("C");
  const OUT = ["correct_auto", "correct_human", "human_instead_of_auto", "wrong_auto", "auto_when_human_expected", "system_failure"];
  const sum = (rows: Row[]) => {
    const n = rows.length, agent = rows.filter((r) => r.route === "agent");
    const by = Object.fromEntries(OUT.map((o) => [o, rows.filter((r) => r.outcome === o).length]));
    const lat = agent.map((r) => r.latency_ms).sort((a, b) => a - b);
    return { n, ...by, auto_coverage: (by.correct_auto! + by.wrong_auto! + by.auto_when_human_expected!) / Math.max(1, n), agent_cases: agent.length,
      tool_calls_per_agent_case: agent.reduce((a, r) => a + r.tools.length, 0) / Math.max(1, agent.length), judge_calls: rows.reduce((a, r) => a + r.judge_calls, 0),
      cost_yuan: rows.reduce((a, r) => a + r.cost_micro, 0) / 1e6, agent_latency_p50_s: (lat[Math.floor(lat.length / 2)] ?? 0) / 1000, agent_latency_max_s: (lat[lat.length - 1] ?? 0) / 1000 };
  };
  const kinds = ["context_changes", "missing_evidence", "history_decoy", "control"];
  const res = { A: sum(A.rows), C: sum(C.rows), byKind: Object.fromEntries(kinds.map((k) => [k, { A: sum(A.rows.filter((r) => r.kind === k)), C: sum(C.rows.filter((r) => r.kind === k)) }])),
    differ: A.rows.filter((a) => { const c = C.rows.find((x) => x.case_id === a.case_id); return c && c.outcome !== a.outcome; }).map((a) => ({ case_id: a.case_id, kind: a.kind, expected: a.expected, A: a.outcome, C: C.rows.find((x) => x.case_id === a.case_id)!.outcome })),
    manifests: { A: A.manifest, C: C.manifest } };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(res, null, 1));
  const f = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(3));
  const cols = ["n", ...OUT, "auto_coverage", "agent_cases", "tool_calls_per_agent_case", "judge_calls", "cost_yuan", "agent_latency_p50_s", "agent_latency_max_s"] as const;
  let md = `| 指标 | A | C |\n|---|---|---|\n${cols.map((k) => `| ${k} | ${f((res.A as Record<string, number>)[k]!)} | ${f((res.C as Record<string, number>)[k]!)} |`).join("\n")}\n\n`;
  for (const k of kinds) md += `**${k}**：A ${OUT.map((o) => `${o}=${(res.byKind[k]!.A as Record<string, number>)[o]}`).join(" ")}；C ${OUT.map((o) => `${o}=${(res.byKind[k]!.C as Record<string, number>)[o]}`).join(" ")}\n\n`;
  writeFileSync(join(outDir, "report.md"), md);
  console.log(md);
} else {
  throw new Error("phase must be prepare | run | report");
}
