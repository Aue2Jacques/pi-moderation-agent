// Stage ③ drill (dev plan 2026-10-08 §5): a batch of real reviews goes through human claim, human ruling, appeal
// re-review and the downstream state update, through the real entry points — the gateway's HTTP API for people, the
// worker with the real main model and Jev for the appeal re-reviews, the outbox and the simulated downstream consumer.
// Starts from a copy of an A/C arm's app.db (whose human queue holds real agent releases and image cases).
// The "reviewer" is a script: it rules what the case pool expects; for cases whose expectation is "human" it uses the
// frozen platform label of the target text (model consensus) — this stands in for a person and is recorded as such.
// usage: node --experimental-strip-types scripts/drill-human-appeal.ts <armDir with app.db> <outDir> [appeals=10]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import * as core from "../packages/core/src/index.ts";
import { DEFAULT_GATEWAY_CONFIG, Gateway, createHttpServer } from "../packages/gateway/src/index.ts";
import { jevModel, jevProvider, loadCalibrator } from "../packages/judges/src/index.ts";
import { loadBundle } from "../packages/policy/src/index.ts";
import { Worker, piJudge, relayProvider } from "../packages/worker/src/index.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const [armDir, outDir, nAppeals = "10"] = process.argv.slice(2);
if (!armDir || !outDir) throw new Error("usage: drill-human-appeal.ts <armDir> <outDir> [appeals]");
mkdirSync(outDir, { recursive: true });
const dbPath = join(outDir, "app.db");
if (existsSync(dbPath)) throw new Error(`${dbPath} exists`);
copyFileSync(join(armDir, "app.db"), dbPath);
const db = core.openAppDb(dbPath, "gateway");
core.ensureSchema(db);
const JEV = env("JEV_MODEL", "jev-latest");
const { bundle, texts } = loadBundle("rules", "config/scenes.yaml");
const pricesRaw = readFileSync("config/prices.yaml", "utf8");
const prices: core.PriceTable = { pricesVer: `prices@${core.sha256(pricesRaw).slice(0, 12)}`, perMillion: (parse(pricesRaw) as { models: core.PriceTable["perMillion"] }).models };
const calibrator = loadCalibrator(env("CALIB_DIR", "calib"), JEV);
const models = createModels();
models.setProvider(relayProvider({ baseUrl: env("RELAY_BASE_URL"), apiKey: env("RELAY_API_KEY") }));
models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY"), modelId: JEV }));
const judge = piJudge(models, jevModel(models, JEV), { inCallConfirm: true, timeoutMs: 20_000 });
const now = () => Date.now();
const gateway = new Gateway({ db, bundle, ruleTexts: texts, judge, prices, calibrator, evidenceVer: "evidence@ac", judgeModel: JEV, cfg: DEFAULT_GATEWAY_CONFIG, now, gatewayId: "g-drill" });
const HUMAN: core.HumanAuth = { token: `drill-${Math.random().toString(36).slice(2)}`, reviewers: ["rev-script"] };
const server = createHttpServer({ db, gateway, bundle, humanAuth: HUMAN, now });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const H = { authorization: `Bearer ${HUMAN.token}`, "x-reviewer": "rev-script", "content-type": "application/json" };

// the script reviewer's decision for a content id
type Case = { case_id: string; expected: { disposition: string; rules: string[] }; platform_target_only?: Record<string, { label: string } | null> };
const cases = new Map(readFileSync(env("CASE_POOL", "data/cases/pool-v1.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Case).map((c) => [c.case_id, c] as const));
const decisionFor = (contentId: string): { action: core.Action; rule_ids: string[]; basis: string } => {
  const c = cases.get(contentId);
  if (c && c.expected.disposition !== "human") return { action: c.expected.disposition as core.Action, rule_ids: c.expected.rules, basis: "case expectation" };
  const p = c?.platform_target_only;
  if (p?.abuse?.label === "violate") return { action: "takedown", rule_ids: ["ABUSE-001"], basis: "platform label (target only)" };
  if (p?.marketing?.label === "violate") return { action: "limit", rule_ids: ["MARKETING-003"], basis: "platform label (target only)" };
  return { action: "pass", rule_ids: [], basis: c ? "platform label (target only) or none" : "not a case: pass" };
};
const log: Record<string, unknown>[] = [];
async function humanRound(round: string): Promise<number> {
  let n = 0;
  for (;;) {
    const claim = await fetch(`${base}/api/human/claim`, { method: "POST", headers: H });
    const body = (await claim.json()) as { review: { review_id: string; content_id: string } | null };
    if (claim.status !== 200 || !body.review) { if (claim.status !== 200) log.push({ round, step: "claim", status: claim.status, body }); break; }
    const d = decisionFor(body.review.content_id);
    const sub = await fetch(`${base}/api/human/submit`, { method: "POST", headers: H, body: JSON.stringify({ review_id: body.review.review_id, action: d.action, rule_ids: d.rule_ids, reason: `drill: ${d.basis}` }) });
    const sb = (await sub.json()) as Record<string, unknown>;
    log.push({ round, step: "submit", review_id: body.review.review_id, content_id: body.review.content_id, action: d.action, basis: d.basis, status: sub.status, ...(sub.status === 200 ? {} : { error: sb }) });
    n++;
    if (n > 500) break;
  }
  return n;
}
const drain = () => { let k = 0; for (let i = 0; i < 20; i++) { const x = gateway.dispatchOutbox(); k += x; if (!x) break; } return k; };
/** every content's downstream state must equal its latest ruling */
const downstreamCheck = () => {
  const rows = db.prepare(`SELECT c.content_id, (SELECT action FROM ruling r WHERE r.content_id=c.content_id ORDER BY r.seq DESC LIMIT 1) AS ruled,
      d.applied_action AS applied FROM content c LEFT JOIN downstream_state d ON d.content_id=c.content_id WHERE c.content_id IN (SELECT content_id FROM ruling)`).all() as { content_id: string; ruled: string; applied: string | null }[];
  return { contents_with_ruling: rows.length, mismatched: rows.filter((r) => r.ruled !== r.applied).length };
};

const t0 = now();
const summary: Record<string, unknown> = { armDir, started: new Date(t0).toISOString(), humanQueueAtStart: (db.prepare("SELECT COUNT(*) AS n FROM human_queue WHERE closed_at IS NULL").get() as { n: number }).n };
summary.drainBefore = drain();
summary.round1Submitted = await humanRound("1");
summary.drainAfterRound1 = drain();
summary.downstreamAfterRound1 = downstreamCheck();

// appeals: contents whose latest ruling is a takedown / limit first, then some passes
const ruled = db.prepare(`SELECT r.content_id, r.action FROM ruling r WHERE r.seq=(SELECT MAX(seq) FROM ruling x WHERE x.content_id=r.content_id) ORDER BY r.content_id`).all() as { content_id: string; action: string }[];
const pickA = [...ruled.filter((r) => r.action !== "pass"), ...ruled.filter((r) => r.action === "pass")].slice(0, Number(nAppeals));
const appeals: Record<string, unknown>[] = [];
for (const [k, r] of pickA.entries()) {
  const res = await fetch(`${base}/api/appeals`, { method: "POST", headers: H, body: JSON.stringify({ content_id: r.content_id, trigger_request_id: `drill-appeal-${k}`, reason_code: r.action === "pass" ? "reporter_disagrees" : "author_disagrees" }) });
  const b = (await res.json()) as { review_id?: string };
  appeals.push({ content_id: r.content_id, before: r.action, status: res.status, review_id: b.review_id });
  // the same appeal sent again must not create a second review
  const again = await fetch(`${base}/api/appeals`, { method: "POST", headers: H, body: JSON.stringify({ content_id: r.content_id, trigger_request_id: `drill-appeal-${k}`, reason_code: r.action === "pass" ? "reporter_disagrees" : "author_disagrees" }) });
  appeals[appeals.length - 1]!.resend_status = again.status;
}
summary.appealsFiled = appeals.length;

// the agent re-reviews the appeals (real main model + Jev), exactly like run-ac's C arm
const worker = await Worker.open({
  db: core.openAppDb(dbPath, "worker"), storage: await openNodeSqliteStorage(join(outDir, "session.sqlite")), models, bundle, ruleTexts: texts, workerId: "w-drill", judge, prices, calibrator,
  cfg: { ...core.DEFAULT_CONFIG, deadlineMs: 900_000 }, flags: { escalation: false }, maxModelCalls: 20, now, admitMax: 8,
  modelFor: () => ({ provider: "a6api", modelId: env("AGENT_MODEL", "qwen3.8-flash") }),
  instructions: "你是内容审核 agent。读下面的任务说明，自己决定需要哪些证据；取证后用 judge 带上证据复判；看 judge 返回的 support：allowed_now 里有处置就 dispose（rule_ids 用支持它的规则，evidence_ids 用 dispose_with）；缺 confirm 就先 confirm；能取的证据都取过仍不能放行或处置就 release(reason=evidence_gap)。dispose 和 release 必须单独成轮调用，调用后不要再说话。",
});
db.prepare("UPDATE review SET deadline_at=? WHERE state='queued'").run(now() + 900_000);
await worker.start();
worker.startLoops();
const pending = () => (db.prepare("SELECT COUNT(*) AS n FROM review WHERE state IN ('queued','investigating')").get() as { n: number }).n;
const w0 = now();
while (pending() > 0 && now() - w0 < 20 * 60_000) { await worker.admitOnce(); await new Promise((r) => setTimeout(r, 1000)); gateway.tickControl(); }
await worker.pumpHost();
await worker.waitIdle();
worker.stopLoops();
summary.appealOutcomes = appeals.map((a) => { const r = core.readReview(db, String(a.review_id)); const rul = r ? core.readRuling(db, r.review_id) : undefined; return { before: a.before, state: r?.state, after: rul?.action ?? null, release: r?.release_reason ?? null, status: a.status, resend_status: a.resend_status }; });
summary.drainAfterAgent = drain();
summary.round2Submitted = await humanRound("2");
summary.drainAfterRound2 = drain();
summary.downstreamFinal = downstreamCheck();
summary.appealFinal = appeals.map((a) => { const latest = db.prepare("SELECT action, actor FROM ruling WHERE content_id=? ORDER BY seq DESC LIMIT 1").get(String(a.content_id)) as { action: string; actor: string }; const ds = db.prepare("SELECT applied_action FROM downstream_state WHERE content_id=?").get(String(a.content_id)) as { applied_action: string } | undefined; return { before: a.before, final: latest.action, by: latest.actor, downstream: ds?.applied_action ?? null }; });
summary.humanQueueOpenAtEnd = (db.prepare("SELECT COUNT(*) AS n FROM human_queue WHERE closed_at IS NULL").get() as { n: number }).n;
summary.submitErrors = log.filter((l) => l.step === "submit" && l.status !== 200).length;
summary.reconcile = core.reconcile.final(db).filter((v) => v.check !== "outbox_not_drained").map((v) => v.check);
summary.ended = new Date().toISOString();
writeFileSync(join(outDir, "drill.json"), JSON.stringify({ summary, log }, null, 1));
console.log(JSON.stringify(summary, null, 1));
server.close();
await worker.close();
