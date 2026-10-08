// Process G entry. Reads .env + config, opens app.db, starts intake/control/dispatch/metrics loops and HTTP on 127.0.0.1:8080.
// usage: node --experimental-strip-types packages/gateway/src/main.ts
import { readFileSync, mkdirSync } from "node:fs";
import { parse } from "yaml";
import { createModels } from "@earendil-works/pi-ai/models";
import * as core from "@mod/core";
import { identityCalibrator, jevModel, jevProvider, loadCalibrator } from "@mod/judges";
import { loadBundle } from "@mod/policy";
import { piJudge } from "@mod/worker";
import { Gateway, DEFAULT_GATEWAY_CONFIG } from "./gateway.ts";
import { createHttpServer } from "./http.ts";

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
  loadDotEnv();
  mkdirSync("data", { recursive: true });
  const db = core.openAppDb(env("APP_DB", "data/app.db"), "gateway");
  core.ensureSchema(db);
  const { bundle, texts } = loadBundle("rules", "config/scenes.yaml");
  const prices = loadPrices();
  // round-9 item 5: strict by default — answers without a fitted calibration bucket never auto-dispose.
  // CALIB_MODE=identity is the explicit smoke/联调 mode (raw probabilities, pin calib@identity).
  const calibMode = env("CALIB_MODE", "strict");
  if (calibMode !== "strict" && calibMode !== "identity") throw new Error(`CALIB_MODE must be strict|identity, got ${calibMode}`);
  const calibrator = calibMode === "identity" ? identityCalibrator() : loadCalibrator(env("CALIB_DIR", "calib"), env("JEV_MODEL", "jev-latest"));
  const models = createModels();
  models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY"), modelId: env("JEV_MODEL", "jev-latest") }));
  const judge = piJudge(models, jevModel(models, env("JEV_MODEL", "jev-latest")), { inCallConfirm: true, timeoutMs: envNum("JUDGE_TIMEOUT_MS", 8000) });
  const blacklist = (() => { try { return (parse(readFileSync("rules/wordlist.yaml", "utf8")) as { words: string[] }).words ?? []; } catch { return []; } })();
  const gateway = new Gateway({
    db, bundle, ruleTexts: texts, judge, prices, calibrator, evidenceVer: env("EVIDENCE_VER", "evidence@local"), judgeModel: env("JEV_MODEL", "jev-latest"),
    cfg: { ...DEFAULT_GATEWAY_CONFIG, scanMs: envNum("SCAN_MS", 2000), queueAgentMax: envNum("QUEUE_AGENT_MAX", 50), queueHumanMax: envNum("QUEUE_HUMAN_MAX", 500), outstandingMax: envNum("OUTSTANDING_MAX", 2000), maxAttempts: envNum("MAX_ATTEMPTS", 3), blacklist },
    now: () => Date.now(), gatewayId: `g-${process.pid}`,
  });
  gateway.startLoops();
  const reviewers = (() => { try { return (JSON.parse(readFileSync("config/reviewers.json", "utf8")) as { reviewers: string[] }).reviewers; } catch { return ["rev1"]; } })();
  const server = createHttpServer({ db, gateway, bundle, humanAuth: { token: env("HUMAN_REVIEW_TOKEN", "dev-token"), reviewers }, now: () => Date.now() });
  const port = envNum("G_PORT", 8080);
  server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ msg: "gateway up", port, rules_ver: bundle.rulesVer, prices_ver: prices.pricesVer, calib_mode: calibrator.mode, calib_ver: calibrator.calibVer, note: calibrator.mode === "identity" ? "未校准联调模式：原始概率直接参与处置，结果不是校准门槛下的自动审核" : calibrator.calibVer === "calib@none" ? "strict 且无校准文件：快判只会产生疑似，不会自动放行/拦截" : "strict：按校准文件" })));
  const stop = () => { gateway.stopLoops(); server.close(); db.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && /main\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(core.redact(e)); process.exit(1); });
