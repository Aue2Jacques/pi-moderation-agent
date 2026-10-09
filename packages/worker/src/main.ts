// Process W entry. Opens app.db + session.sqlite, runs the startup barrier, admission loop, heartbeat/pump loops, and a small HTTP on 127.0.0.1:8081.
// usage: node --experimental-strip-types packages/worker/src/main.ts
// DEMO=1: demo mode, no .env and no API key: the agent model is the scripted agent and the judge the scripted judge of
// demo.ts; leases, budgets, submit checks and recovery are unchanged. Started by scripts/console.ts.
import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { acquireSingleInstanceLock } from "./flock.ts";
import { parse } from "yaml";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import * as core from "@mod/core";
import { identityCalibrator, jevModel, jevProvider, loadCalibrator } from "@mod/judges";
import { loadBundle } from "@mod/policy";
import { piJudge } from "./pi-judge.ts";
import { DemoSessionRetention, demoAgentProvider, demoCalibrator, demoImageText, demoJudge, demoPrices, loadDemoImages } from "./demo.ts";
import type { JudgeClient } from "./judge-client.ts";
import { relayProvider } from "./relay.ts";
import { Worker } from "./worker.ts";

function loadDotEnv(): void {
  try {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
    }
  } catch { /* no .env */ }
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const envNum = (k: string, d: number): number => Number(process.env[k] ?? d);

// stage ②: the agent reads its task brief (worker.ts taskBrief) and the judge's `support` (allowed_now / missing); it
// decides what evidence to fetch (the C arm of reports/2026-10-08-ac-case-pool-v1.md)
export const INSTRUCTIONS = [
  "你是内容审核 agent。读下面的任务说明，自己决定需要哪些证据：只取能改变判断的证据，不需要的不取。取证后用 judge 带上证据复判；",
  "看 judge 返回的 support：allowed_now 里有处置就 dispose（rule_ids 用支持它的规则，evidence_ids 用 dispose_with）；缺 confirm 就先 confirm；能取的证据都取过仍不能放行或处置就 release(reason=evidence_gap)。",
  "dispose 和 release 必须单独成轮调用，调用后不要再说话。",
].join("");

async function main(): Promise<void> {
  const demo = process.env["DEMO"] === "1";
  if (!demo) loadDotEnv();   // demo mode never reads .env
  mkdirSync("data", { recursive: true });
  // single-instance lock (§7.3 step 0; OS-level since dev plan 2026-10-08 R1); W_LOCK lets a demo run beside a real one
  const lock = env("W_LOCK", "data/w.lock.db");
  if (!acquireSingleInstanceLock(lock)) { console.error(`another worker holds ${lock}`); process.exit(2); }
  const db = core.openAppDb(env("APP_DB", "data/app.db"), "worker");
  core.ensureSchema(db);
  const { bundle, texts } = loadBundle("rules", "config/scenes.yaml");
  const pricesRaw = readFileSync("config/prices.yaml", "utf8");
  const realPrices: core.PriceTable = { pricesVer: `prices@${core.sha256(pricesRaw).slice(0, 12)}`, perMillion: (parse(pricesRaw) as { models: core.PriceTable["perMillion"] }).models };
  const prices = demo ? demoPrices(realPrices) : realPrices;
  const models = createModels();
  let judge: JudgeClient;
  let agent: { provider: string; modelId: string };
  if (demo) {
    const scripted = demoAgentProvider({ delayMs: envNum("DEMO_AGENT_MS", 700) });
    models.setProvider(scripted.provider);
    agent = scripted.model;
    judge = demoJudge({ delayMs: envNum("DEMO_JUDGE_MS", 350), imageText: demoImageText(db, loadDemoImages(env("DEMO_IMAGES_DIR", "demo/images"))) });
  } else {
    models.setProvider(relayProvider({ baseUrl: env("RELAY_BASE_URL"), apiKey: env("RELAY_API_KEY") }));
    models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY"), modelId: env("JEV_MODEL", "jev-latest") }));
    judge = piJudge(models, jevModel(models, env("JEV_MODEL", "jev-latest")), { inCallConfirm: true, timeoutMs: envNum("JUDGE_TIMEOUT_MS", 8000) });
    agent = { provider: "a6api", modelId: env("AGENT_MODEL", "qwen3.8-flash") };
  }
  const agentModel = agent.modelId;
  const strong = env("STRONG_MODEL", "deepseek-v4.1-flash");   // model whitelist (owner 2026-10-08); escalation is off unless FLAG_ESCALATION=true
  const calibMode = env("CALIB_MODE", "strict");
  if (calibMode !== "strict" && calibMode !== "identity") throw new Error(`CALIB_MODE must be strict|identity, got ${calibMode}`);
  const calibrator = demo ? demoCalibrator(env("CALIB_DIR", "calib"), env("JEV_MODEL", "jev-latest"), bundle.rulesVer)
    : calibMode === "identity" ? identityCalibrator() : loadCalibrator(env("CALIB_DIR", "calib"), env("JEV_MODEL", "jev-latest"));
  const workerId = `w-${process.pid}-${Date.now()}`;
  const sessionDb = env("SESSION_DB", "data/session.sqlite");
  core.ensurePrivateDbFile(sessionDb);   // conversation content lives here: owner-only like app.db (dev plan R9c)
  const worker = await Worker.open({
    db, storage: await openNodeSqliteStorage(sessionDb), models, bundle, ruleTexts: texts, workerId, judge, prices, calibrator,
    cfg: { ...core.DEFAULT_CONFIG, leaseTtlMs: envNum("LEASE_TTL_MS", 30_000), deadlineMs: envNum("DEADLINE_MS_SHORT", 60_000), maxAttempts: envNum("MAX_ATTEMPTS", 3) },
    flags: { escalation: !demo && env("FLAG_ESCALATION", "false") === "true" }, maxModelCalls: envNum("MAX_MODEL_CALLS", 20), strongModel: { provider: "a6api", modelId: strong },
    // demo mode admits more sessions at once: the scripted agent waits on timers, not on a model, and the demo traffic
    // runs at up to MAX_PER_SEC contents a second (docs/console-2026-10-09.md §6.3)
    now: () => Date.now(), admitMax: envNum("ADMIT_MAX", demo ? 128 : 10), modelFor: () => agent, instructions: INSTRUCTIONS,
  });
  const started = await worker.start();
  console.log(JSON.stringify({ msg: "worker up", mode: demo ? "demo" : "real", workerId, ...started, agentModel, calib_mode: calibrator.mode, calib_ver: calibrator.calibVer }));
  worker.startLoops();
  const admit = setInterval(() => { worker.admitOnce().catch((e) => console.error("admit error", core.redact(e))); }, envNum("ADMIT_MS", demo ? 500 : 1000));
  admit.unref();
  // demo retention, W's half: conversations whose review G removed (DEMO_KEEP_CONTENTS=0 turns both halves off)
  const sessions = demo && envNum("DEMO_KEEP_CONTENTS", 4000) > 0 ? new DemoSessionRetention({ sessionDb, appDb: db, held: () => new Set(worker.grants.entries().map(([c]) => c)), mode: "demo" }) : undefined;
  const prune = sessions ? setInterval(() => { try { sessions.runOnce(); } catch (e) { console.error("session retention", core.redact(e)); } }, envNum("DEMO_PRUNE_MS", 5_000)) : undefined;
  prune?.unref();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      if (url.pathname === "/health") return json(200, { worker_id: workerId, grants: worker.grants.count(), active: worker.grants.count("active"), resumed_at: worker.resumedAt, ...(sessions ? { sessions_pruned: sessions.pruned } : {}) });
      if (url.pathname === "/sessions") return json(200, await worker.sessions());
      if (url.pathname === "/usage") return json(200, await worker.usageReconcile());   // ledger vs Pi's pi.usage
      if (url.pathname === "/abort" && req.method === "POST") { const n = await worker.pollCommands(); return json(200, { polled: n }); }
      json(404, { code: "NOT_FOUND" });
    } catch (e) { json(500, { code: "INTERNAL", message: core.redact(String(e)) }); }
  });
  server.listen(envNum("W_PORT", 8081), "127.0.0.1");
  const stop = async () => { clearInterval(admit); clearInterval(prune); sessions?.close(); server.close(); await worker.close(); process.exit(0); };   // exiting releases the single-instance lock
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

if (process.argv[1] && /main\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(core.redact(e)); process.exit(1); });
