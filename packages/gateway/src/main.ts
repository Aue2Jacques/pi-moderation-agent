// Process G entry. Reads .env + config, opens app.db, starts intake/control/dispatch/metrics loops and HTTP on 127.0.0.1:8080.
// usage: node --experimental-strip-types packages/gateway/src/main.ts
// DEMO=1: demo mode, no .env and no API key: scripted judge, the repository's fitted temperatures, demo prices and demo
// account history (packages/worker/src/demo.ts); everything else is the normal gateway. Started by scripts/console.ts.
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { createModels } from "@earendil-works/pi-ai/models";
import * as core from "@mod/core";
import { identityCalibrator, jevModel, jevProvider, loadCalibrator } from "@mod/judges";
import { loadBundle } from "@mod/policy";
import { DEMO_AGENT_MODEL, DEMO_JUDGE_MODEL, DEMO_SAMPLES, demoCalibrator, demoJudge, demoPrices, piJudge, seedDemoHistory, type JudgeClient } from "@mod/worker";
import { Gateway, DEFAULT_GATEWAY_CONFIG } from "./gateway.ts";
import { dirImageStore, relayImageChecker } from "./image.ts";
import { createHttpServer } from "./http.ts";
import { readCalibFiles } from "./console-api.ts";
import { DemoTraffic, MAX_PER_SEC, SIM_PREFIX, SIM_REVIEWER } from "./demo-traffic.ts";
import { DemoRetention } from "./demo-retention.ts";

export function loadDotEnv(): void {
  try {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
    }
  } catch { /* no .env */ }
}
export const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
export const envNum = (k: string, d: number): number => Number(process.env[k] ?? d);

export function loadPrices(): core.PriceTable {
  const raw = readFileSync("config/prices.yaml", "utf8");
  return { pricesVer: `prices@${core.sha256(raw).slice(0, 12)}`, perMillion: (parse(raw) as { models: core.PriceTable["perMillion"] }).models };
}

async function main(): Promise<void> {
  const demo = process.env["DEMO"] === "1";
  if (!demo) loadDotEnv();   // demo mode never reads .env: it needs no key and must not pick up real settings
  mkdirSync("data", { recursive: true });
  const db = core.openAppDb(env("APP_DB", "data/app.db"), "gateway");
  core.ensureSchema(db);
  const { bundle, texts } = loadBundle("rules", "config/scenes.yaml");
  const prices = demo ? demoPrices(loadPrices()) : loadPrices();
  // round-9 item 5: strict by default — answers without a fitted calibration bucket never auto-dispose.
  // CALIB_MODE=identity is the explicit smoke/联调 mode (raw probabilities, pin calib@identity).
  const calibMode = env("CALIB_MODE", "strict");
  if (calibMode !== "strict" && calibMode !== "identity") throw new Error(`CALIB_MODE must be strict|identity, got ${calibMode}`);
  const calibJudge = env("JEV_MODEL", "jev-latest");
  const calibrator = demo ? demoCalibrator(env("CALIB_DIR", "calib"), calibJudge, bundle.rulesVer)
    : calibMode === "identity" ? identityCalibrator() : loadCalibrator(env("CALIB_DIR", "calib"), calibJudge);
  let judge: JudgeClient;
  if (demo) {
    judge = demoJudge({ delayMs: envNum("DEMO_JUDGE_MS", 350) });
    seedDemoHistory(db, Date.now());
  } else {
    const models = createModels();
    models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY"), modelId: env("JEV_MODEL", "jev-latest") }));
    judge = piJudge(models, jevModel(models, env("JEV_MODEL", "jev-latest")), { inCallConfirm: true, timeoutMs: envNum("JUDGE_TIMEOUT_MS", 8000) });
  }
  const judgeModel = demo ? DEMO_JUDGE_MODEL : env("JEV_MODEL", "jev-latest");
  const blacklist = (() => { try { return (parse(readFileSync("rules/wordlist.yaml", "utf8")) as { words: string[] }).words ?? []; } catch { return []; } })();
  const gateway = new Gateway({
    db, bundle, ruleTexts: texts, judge, prices, calibrator, evidenceVer: env("EVIDENCE_VER", "evidence@local"), judgeModel,
    // demo mode: larger intake batches and more fast-path calls in flight (the scripted judge only waits on a timer), more
    // room in the agent queue, a small near-duplicate index (the demo texts repeat, so every lookup would match thousands)
    cfg: { ...DEFAULT_GATEWAY_CONFIG, scanMs: envNum("SCAN_MS", 2000), queueAgentMax: envNum("QUEUE_AGENT_MAX", demo ? 200 : 50), queueHumanMax: envNum("QUEUE_HUMAN_MAX", 500), outstandingMax: envNum("OUTSTANDING_MAX", 2000), maxAttempts: envNum("MAX_ATTEMPTS", 3), blacklist,
      intakeBatch: envNum("INTAKE_BATCH", demo ? 96 : DEFAULT_GATEWAY_CONFIG.intakeBatch), intakeConcurrency: envNum("INTAKE_CONCURRENCY", demo ? 48 : DEFAULT_GATEWAY_CONFIG.intakeConcurrency),
      ...(demo ? { simhashMax: envNum("SIMHASH_MAX", 2000) } : process.env["SIMHASH_MAX"] ? { simhashMax: envNum("SIMHASH_MAX", 50_000) } : {}) },
    now: () => Date.now(), gatewayId: `g-${process.pid}`,
    // stage ③ minimal image channel, off unless both are set: IMAGE_DIR (where image refs resolve) and IMAGE_MODEL (TEMPORARY
    // relay implementation; the online interface is the owner's decision)
    ...(!demo && process.env["IMAGE_DIR"] && process.env["IMAGE_MODEL"] ? { imageStore: dirImageStore(env("IMAGE_DIR")), imageChecker: relayImageChecker({ baseUrl: env("RELAY_BASE_URL"), apiKey: env("RELAY_API_KEY"), model: env("IMAGE_MODEL") }) } : {}),
  });
  gateway.startLoops({ intakeMs: envNum("INTAKE_MS", demo ? 200 : 500) });
  const configured = (() => { try { return (JSON.parse(readFileSync("config/reviewers.json", "utf8")) as { reviewers: string[] }).reviewers; } catch { return ["rev1"]; } })();
  // demo mode adds the simulated reviewer of the demo traffic (it only ever decides simulated contents)
  const reviewers = demo ? [...configured.filter((r) => r !== SIM_REVIEWER), SIM_REVIEWER] : configured;
  const humanAuth = { token: env("HUMAN_REVIEW_TOKEN", "dev-token"), reviewers };
  // demo traffic (demo mode only; real mode never generates content): DEMO_TRAFFIC_PER_SEC contents a second (0 = off,
  // can be switched on from the console; DEMO_TRAFFIC_PER_MIN is the older per-minute form), a simulated reviewer and
  // the occasional appeal; see demo-traffic.ts
  const perSec = process.env["DEMO_TRAFFIC_PER_SEC"] !== undefined ? envNum("DEMO_TRAFFIC_PER_SEC", 10) : process.env["DEMO_TRAFFIC_PER_MIN"] !== undefined ? envNum("DEMO_TRAFFIC_PER_MIN", 600) / 60 : 10;
  const traffic = demo ? new DemoTraffic({ db, gateway, bundle, humanAuth, now: () => Date.now(), mode: "demo" }, {
    perSec, maxPerSec: envNum("DEMO_MAX_PER_SEC", MAX_PER_SEC), simReviewsPerMin: envNum("DEMO_SIM_REVIEWS_PER_MIN", 6), simMinAgeMs: envNum("DEMO_SIM_MIN_AGE_MS", 30_000),
    simThinkMs: envNum("DEMO_SIM_THINK_MS", 4_000), humanCap: envNum("DEMO_HUMAN_CAP", 12), appealPct: envNum("DEMO_APPEAL_PCT", 0.5),
    ...(process.env["DEMO_TRAFFIC_SEED"] ? { seed: envNum("DEMO_TRAFFIC_SEED", 1) } : {}),
  }) : undefined;
  // demo retention: the newest DEMO_KEEP_CONTENTS simulated contents stay, older finished ones are removed with their
  // counts kept in a rollup (W removes their agent sessions); 0 = off; see demo-retention.ts
  const retention = demo ? new DemoRetention({ db, now: () => Date.now(), dbPath: env("APP_DB", "data/app.db"), mode: "demo" }, { keep: envNum("DEMO_KEEP_CONTENTS", 4000), everyMs: envNum("DEMO_PRUNE_MS", 5_000), quietMs: envNum("DEMO_PRUNE_QUIET_MS", 60_000) }) : undefined;
  const trafficApi = traffic ? { status: () => ({ ...traffic.status(), retention: retention && retention.cfg.keep > 0 ? retention.status() : null }), set: (o: { perSec?: number; paused?: boolean }) => traffic.set(o) } : undefined;
  const server = createHttpServer({ db, gateway, bundle, humanAuth, now: () => Date.now(),
    console: {
      mode: demo ? "demo" : "real", dir: resolve(env("CONSOLE_DIR", "packages/console/dist")), agentModel: demo ? DEMO_AGENT_MODEL : env("AGENT_MODEL", "qwen3.8-flash"),
      samples: demo ? DEMO_SAMPLES.map((x) => ({ id: x.id, title: x.title, route: x.route, scene: x.scene, text: x.text, account_id: x.accountId, parent: x.parent ? { text: x.parent.text, account_id: x.parent.accountId } : null })) : [],
      calibFiles: readCalibFiles(env("CALIB_DIR", "calib"), calibJudge), streamPollMs: envNum("STREAM_POLL_MS", 250), livePollMs: envNum("LIVE_POLL_MS", 500),
      ...(trafficApi ? { traffic: trafficApi, simPrefix: SIM_PREFIX, simReviewer: SIM_REVIEWER } : {}),
    } });
  const port = envNum("G_PORT", 8080);
  server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ msg: "gateway up", port, mode: demo ? "demo" : "real", ...(traffic ? { demo_traffic_per_sec: traffic.cfg.perSec } : {}), rules_ver: bundle.rulesVer, prices_ver: prices.pricesVer, calib_mode: calibrator.mode, calib_ver: calibrator.calibVer, note: demo ? "演示模式：判官与 agent 是脚本，数字只作演示" : calibrator.mode === "identity" ? "未校准联调模式：原始概率直接参与处置，结果不是校准门槛下的自动审核" : calibrator.calibVer === "calib@none" ? "strict 且无校准文件：快判只会产生疑似，不会自动放行/拦截" : "strict：按校准文件" })));
  traffic?.start();
  retention?.start();
  const stop = () => { traffic?.stop(); retention?.stop(); gateway.stopLoops(); server.close(); db.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && /main\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(core.redact(e)); process.exit(1); });
