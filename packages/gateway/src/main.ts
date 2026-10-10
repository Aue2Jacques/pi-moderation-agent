// Process G entry. Reads .env + config, opens app.db, starts intake/control/dispatch/metrics loops and HTTP on 127.0.0.1:8080.
// usage: node --experimental-strip-types packages/gateway/src/main.ts
// DEMO=1: demo mode, no .env and no API key: scripted judge, the repository's fitted temperatures, demo prices and demo
// account history (packages/worker/src/demo.ts); everything else is the normal gateway. Started by scripts/console.ts.
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { createModels } from "@earendil-works/pi-ai/models";
import * as core from "@mod/core";
import { identityCalibrator, jevModel, jevProvider, loadCalibrator } from "@mod/judges";
import { loadBundle } from "@mod/policy";
import { DEMO_AGENT_MODEL, DEMO_SAMPLES, demoCalibrator, demoImageText, demoJudge, corpusCategory, demoJudgeModel, demoPrices, loadDemoCorpus, loadDemoImages, piJudge, seedDemoHistory, type JudgeClient } from "@mod/worker";
import { Gateway, DEFAULT_GATEWAY_CONFIG } from "./gateway.ts";
import { dirImageStore, relayImageChecker } from "./image.ts";
import { createHttpServer } from "./http.ts";
import { readCalibFiles } from "./console-api.ts";
import { DemoTraffic, MAX_PER_SEC, SIM_PREFIX, SIM_REVIEWER } from "./demo-traffic.ts";
import { DemoRetention } from "./demo-retention.ts";
import { HarnessRecordStore } from "./harness-record.ts";
import { demoImageChecker, storeImage } from "./demo-images.ts";

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
  // DEMO_CORPUS: real test texts with a real judge run's answers; the demo traffic draws from it and the demo judge replays
  // the answers (packages/worker/src/demo-corpus.ts). The file holds dataset text and stays on the demo server.
  const corpus = demo && process.env["DEMO_CORPUS"] ? loadDemoCorpus(env("DEMO_CORPUS"), env("DEMO_CORPUS_JUDGE", "kev4b-v1")) : undefined;
  const prices = demo ? demoPrices(loadPrices(), corpus) : loadPrices();
  // round-9 item 5: strict by default — answers without a fitted calibration bucket never auto-dispose.
  // CALIB_MODE=identity is the explicit smoke/联调 mode (raw probabilities, pin calib@identity).
  const calibMode = env("CALIB_MODE", "strict");
  if (calibMode !== "strict" && calibMode !== "identity") throw new Error(`CALIB_MODE must be strict|identity, got ${calibMode}`);
  const calibJudge = corpus?.judge ?? env("JEV_MODEL", "jev-latest");
  const calibrator = demo ? demoCalibrator(env("CALIB_DIR", "calib"), calibJudge, bundle.rulesVer)
    : calibMode === "identity" ? identityCalibrator() : loadCalibrator(env("CALIB_DIR", "calib"), calibJudge);
  // demo images: the preset screenshots (demo/images) go into the demo data dir's image store under their refs; the
  // scripted judge reads a preset's known content, the scripted image check answers through the real image channel
  const demoImgDir = join(dirname(resolve(env("APP_DB", "data/app.db"))), "images");
  const presets = demo ? loadDemoImages(env("DEMO_IMAGES_DIR", "demo/images")) : [];
  for (const x of presets) storeImage(demoImgDir, x.bytes, "png");
  let judge: JudgeClient;
  if (demo) {
    judge = demoJudge({ delayMs: envNum("DEMO_JUDGE_MS", 350), imageText: demoImageText(db, presets), ...(corpus ? { corpus, corpusHumanPct: envNum("DEMO_CORPUS_HUMAN_PCT", 10) } : {}) });
    seedDemoHistory(db, Date.now());
  } else {
    const models = createModels();
    models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY"), modelId: env("JEV_MODEL", "jev-latest") }));
    judge = piJudge(models, jevModel(models, env("JEV_MODEL", "jev-latest")), { inCallConfirm: true, timeoutMs: envNum("JUDGE_TIMEOUT_MS", 8000) });
  }
  const judgeModel = demo ? demoJudgeModel(corpus) : env("JEV_MODEL", "jev-latest");
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
    // demo: the scripted image check behind the same channel; middle-band image content goes to the agent first
    ...(demo ? { imageStore: dirImageStore(demoImgDir), imageChecker: demoImageChecker(presets, { delayMs: envNum("DEMO_VISION_MS", 300) }), imageToAgent: true } : {}),
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
  const traffic = demo ? new DemoTraffic({ db, gateway, bundle, humanAuth, now: () => Date.now(), mode: "demo", ...(corpus ? { corpus } : {}) }, {
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
      ...(corpus ? { corpus: { judge: corpus.judge, items: corpus.items.length } } : {}),
      // HARNESS_RECORD_DB: a recorded real harness run for the Agent page (scripts/run-ac.ts output, read only)
      ...(process.env["HARNESS_RECORD_DB"] && existsSync(env("HARNESS_RECORD_DB")) ? { harnessRecord: new HarnessRecordStore(env("HARNESS_RECORD_DB"), (v) => (v === bundle.rulesVer ? bundle : undefined), process.env["HARNESS_RECORD_NOTE"]) }
        // demo mode with a corpus: the Agent page's numbers come from this console's own app.db, the same rows every
        // other page reads (one source, no separate record to drift from)
        : demo && corpus ? { harnessRecord: new HarnessRecordStore(env("APP_DB", "data/app.db"), (v) => (v === bundle.rulesVer ? bundle : undefined),
          "评论取自测试集；父帖、同线程回复与账号历史按合成方案生成；快判与复判分数为 Kev-4B 在这些评论上的实测结果回放；agent 每一步的决策由按协议运行的脚本给出。",
          { live: true, categoryOfText: (t) => { const it = t ? corpus.lookup(t) : undefined; return it ? corpusCategory(it) : "other"; } }) } : {}),
      // image intake: demo -> its data dir + presets; real -> IMAGE_DIR when set (then the existing image channel, or
      // image_unsupported -> a person when IMAGE_MODEL is not set); otherwise images are refused
      ...(demo ? { images: { dir: demoImgDir, note: "演示模式：图片由脚本判官模拟（预置截图按已知内容打分，其他图片给中间带概率）",
        samples: presets.map((x) => ({ id: x.id, title: x.title, route: x.route, scene: x.scene, account_id: x.accountId, url: `/api/demo/image-samples/${x.id}`, ref: x.ref, file: x.file })) } }
        : process.env["IMAGE_DIR"] ? { images: { dir: resolve(env("IMAGE_DIR")) } } : {}),
    } });
  const port = envNum("G_PORT", 8080);
  server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ msg: "gateway up", port, mode: demo ? "demo" : "real", ...(traffic ? { demo_traffic_per_sec: traffic.cfg.perSec } : {}), rules_ver: bundle.rulesVer, prices_ver: prices.pricesVer, calib_mode: calibrator.mode, calib_ver: calibrator.calibVer, ...(corpus ? { demo_corpus: { judge: corpus.judge, items: corpus.items.length } } : {}), note: demo ? (corpus ? `演示模式：内容取自测试集真实文本（联系方式已打码），快判回放 ${corpus.judge} 的实测打分；agent 是脚本` : "演示模式：判官与 agent 是脚本，数字只作演示") : calibrator.mode === "identity" ? "未校准联调模式：原始概率直接参与处置，结果不是校准门槛下的自动审核" : calibrator.calibVer === "calib@none" ? "strict 且无校准文件：快判只会产生疑似，不会自动放行/拦截" : "strict：按校准文件" })));
  traffic?.start();
  retention?.start();
  const stop = () => { traffic?.stop(); retention?.stop(); gateway.stopLoops(); server.close(); db.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && /main\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(core.redact(e)); process.exit(1); });
