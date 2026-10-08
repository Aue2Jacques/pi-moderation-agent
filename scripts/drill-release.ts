// Stage ③ release drill (dev plan 2026-10-08 §5): one candidate rules version through shadow -> calibration carry-over
// -> gate -> 50% rollout -> rollback, with the real fast path (Jev) on the case pool's target texts.
// The candidate is a threshold-only change made for the drill: ABUSE-001 block line 0.90 -> 0.85.
// Checks: before the rollback exactly the contents whose bucket is < 50 are pinned to the candidate; after it none is;
// candidate-pinned reviews stay on the candidate; their stored bundle loads (W and people can continue them); a human
// ruling on a candidate-pinned review goes through under the candidate's version.
// usage: node --experimental-strip-types scripts/drill-release.ts <outDir>   (CALIB_DIR = the stable calibration dir)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { createModels } from "@earendil-works/pi-ai/models";
import * as core from "../packages/core/src/index.ts";
import { DEFAULT_GATEWAY_CONFIG, Gateway } from "../packages/gateway/src/index.ts";
import { jevModel, jevProvider, loadCalibrator } from "../packages/judges/src/index.ts";
import { loadBundle } from "../packages/policy/src/index.ts";
import { piJudge, relayProvider } from "../packages/worker/src/index.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const outDir = process.argv[2];
if (!outDir) throw new Error("usage: drill-release.ts <outDir>");
if (existsSync(outDir)) throw new Error(`${outDir} exists`);
mkdirSync(outDir, { recursive: true });
const JEV = env("JEV_MODEL", "jev-latest"), AGENT = env("AGENT_MODEL", "qwen3.8-flash");
const run = (...args: string[]) => JSON.parse(execFileSync("node", ["--experimental-strip-types", "scripts/rules-release.ts", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, CALIB_DIR: calibDir } })) as Record<string, unknown>;

// 1) candidate: copy rules/ and change one threshold
const candRules = join(outDir, "rules");
cpSync("rules", candRules, { recursive: true });
const abusePath = join(candRules, "ABUSE-001.yaml");
const y = parse(readFileSync(abusePath, "utf8")) as { thresholds: { block: number; pass: number } };
y.thresholds.block = 0.85;
writeFileSync(abusePath, stringify(y));
const stable = loadBundle("rules", "config/scenes.yaml");
const cand = loadBundle(candRules, "config/scenes.yaml");
// 2) calibration: a copy of the stable dir, then carry the unchanged questions to the candidate
const calibDir = join(outDir, "calib");
cpSync(env("CALIB_DIR"), calibDir, { recursive: true });
const report: Record<string, unknown> = { stable: stable.bundle.rulesVer, candidate: cand.bundle.rulesVer };
report.shadow = run("shadow", candRules, "config/scenes.yaml", env("SHADOW_ROWS", "data/calib/platform-collect.jsonl"), "10");
report.carry = run("calib-carry", calibDir, candRules, "config/scenes.yaml", JEV);
// 3) gate + rollout on a fresh app.db
const dbPath = join(outDir, "app.db");
const db = core.openAppDb(dbPath, "gateway");
core.ensureSchema(db);
const shadowFile = `data/release/shadow-${cand.bundle.rulesVer.replace(/[^\w.-]/g, "_")}.json`;
report.gate = run("gate", dbPath, shadowFile, calibDir, AGENT, JEV);
report.rollout50 = run("rollout", dbPath, cand.bundle.rulesVer, "50");
// 4) the case pool's targets through the real fast path; roll back after half of them
const cases = readFileSync(env("CASE_POOL", "data/cases/pool-v1.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { case_id: string; target: { text: string; account: string; images: string[] } });
const models = createModels();
models.setProvider(relayProvider({ baseUrl: env("RELAY_BASE_URL"), apiKey: env("RELAY_API_KEY") }));
models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY"), modelId: JEV }));
const pricesRaw = readFileSync("config/prices.yaml", "utf8");
const prices: core.PriceTable = { pricesVer: `prices@${core.sha256(pricesRaw).slice(0, 12)}`, perMillion: (parse(pricesRaw) as { models: core.PriceTable["perMillion"] }).models };
const calibrator = loadCalibrator(calibDir, JEV);
const gw = new Gateway({ db, bundle: stable.bundle, ruleTexts: stable.texts, judge: piJudge(models, jevModel(models, JEV), { inCallConfirm: true, timeoutMs: 20_000 }), prices, calibrator, evidenceVer: "evidence@release", judgeModel: JEV,
  cfg: { ...DEFAULT_GATEWAY_CONFIG, queueAgentMax: 1e6, queueHumanMax: 1e6, outstandingMax: 1e6 }, now: () => Date.now(), gatewayId: "g-release", candidate: { bundle: cand.bundle, ruleTexts: cand.texts, agentModel: AGENT } });
const ingest = (cs: typeof cases) => { for (const c of cs) core.intakeInsert(db, { contentId: c.case_id, scene: "comment", text: c.target.text, accountId: c.target.account, eventTime: Date.now(), ...(c.target.images.length ? { imageRefs: c.target.images } : {}) }, Date.now()); };
const drainIntake = async () => { for (let i = 0; i < 50 && (db.prepare("SELECT COUNT(*) AS n FROM intake WHERE status<>'judged'").get() as { n: number }).n > 0; i++) await gw.processIntakeOnce(); };
const half = Math.floor(cases.length / 2);
ingest(cases.slice(0, half));
await drainIntake();
report.rollback = run("rollout", dbPath, cand.bundle.rulesVer, "0");
ingest(cases.slice(half));
await drainIntake();
// 5) checks
const pinnedOf = (id: string) => (db.prepare("SELECT rules_ver FROM review WHERE content_id=? ORDER BY seq LIMIT 1").get(id) as { rules_ver: string }).rules_ver;
const before = cases.slice(0, half).map((c) => ({ id: c.case_id, bucket: core.rolloutBucket(c.case_id), pinned: pinnedOf(c.case_id) }));
const after = cases.slice(half).map((c) => ({ id: c.case_id, pinned: pinnedOf(c.case_id) }));
const decisions = (ids: string[], ver: string) => {
  const c: Record<string, number> = {};
  for (const id of ids) { const r = db.prepare("SELECT state, release_reason FROM review WHERE content_id=? AND rules_ver=? ORDER BY seq LIMIT 1").get(id, ver) as { state: string; release_reason: string | null } | undefined; if (!r) continue; const a = (db.prepare("SELECT action FROM ruling WHERE content_id=? ORDER BY seq LIMIT 1").get(id) as { action: string } | undefined)?.action; const k = r.state === "disposed" ? `auto_${a}` : r.state; c[k] = (c[k] ?? 0) + 1; }
  return c;
};
const candIds = before.filter((x) => x.pinned === cand.bundle.rulesVer).map((x) => x.id);
// a human ruling on a candidate-pinned review, under the candidate's stored version (dev plan R7 path)
let humanOnCandidate: unknown = "no candidate review in human queue";
const hq = db.prepare("SELECT r.review_id FROM review r JOIN human_queue h ON h.review_id=r.review_id WHERE r.rules_ver=? AND h.closed_at IS NULL LIMIT 1").get(cand.bundle.rulesVer) as { review_id: string } | undefined;
const queued = db.prepare("SELECT review_id FROM review WHERE rules_ver=? AND state='queued' LIMIT 1").get(cand.bundle.rulesVer) as { review_id: string } | undefined;
const target = hq?.review_id ?? queued?.review_id;
if (target) {
  if (!hq) core.releaseToHuman(db, target, { kind: "control" }, "timeout", 2, 1000, Date.now());
  const stored = core.loadStoredBundle(db, cand.bundle.rulesVer)!;
  const r = core.requireReview(db, target);
  const auth = { token: "drill", reviewers: ["rev-drill"] };
  const out = core.submitRuling(db, stored.bundle as core.PolicyBundle, { reviewId: target, actor: "human", action: "pass", evidenceIds: [], ruleIds: [], judgeCallIds: [], pins: { rulesVer: r.rules_ver, calibVer: r.calib_ver, evidenceVer: r.evidence_ver }, reason: "drill: human on candidate-pinned review", humanAuth: { reviewerId: "rev-drill", token: "drill" } }, Date.now(), auth);
  humanOnCandidate = { review_id: target, rules_ver: (db.prepare("SELECT rules_ver FROM ruling WHERE review_id=?").get(target) as { rules_ver?: string } | undefined)?.rules_ver ?? r.rules_ver, action: out.ruling.action };
}
report.checks = {
  beforeRollback: { n: before.length, candidate: candIds.length, wrongPin: before.filter((x) => (x.bucket < 50) !== (x.pinned === cand.bundle.rulesVer)).length },
  afterRollback: { n: after.length, candidate: after.filter((x) => x.pinned === cand.bundle.rulesVer).length },
  storedCandidateLoads: !!core.loadStoredBundle(db, cand.bundle.rulesVer),
  candidateDecisions: decisions(candIds, cand.bundle.rulesVer),
  stableDecisionsSameHalf: decisions(before.filter((x) => x.pinned !== cand.bundle.rulesVer).map((x) => x.id), stable.bundle.rulesVer),
  humanOnCandidate,
};
writeFileSync(join(outDir, "drill-release.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
