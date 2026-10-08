// Record contract fixtures with the REAL judge (Jev via pi-ai), exactly as the fast path asks: every comment-scene rule +
// exception question, in-call confirmation copy. Writes fixtures/contract/<ref>.json. Costs ≈ ¥0.0004 per ref.
// usage: node --experimental-strip-types scripts/record-contract.ts [ref ...]   (JEV_* from env or .env; run on the dev box)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import * as core from "../packages/core/src/index.ts";
import { jevModel, jevProvider } from "../packages/judges/src/index.ts";
import { loadBundle } from "../packages/policy/src/index.ts";
import { piJudge } from "../packages/worker/src/pi-judge.ts";
import { fixturePath, loadRefs, questionKey, sceneQuestions, sentence, type Fixture } from "./lib/contract-fixtures.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };

const modelId = env("JEV_MODEL", "jev-latest");
const models = createModels();
models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY"), modelId }));
const judge = piJudge(models, jevModel(models, modelId), { inCallConfirm: true, timeoutMs: 20_000 });
const { bundle } = loadBundle("rules", "config/scenes.yaml");
const refs = loadRefs();
const only = process.argv.slice(2);
mkdirSync("fixtures/contract", { recursive: true });

const results = await Promise.all(Object.entries(refs).filter(([ref]) => only.length === 0 || only.includes(ref)).map(async ([ref, e]) => {
  const text = sentence(e);
  const questions = sceneQuestions(bundle, e.scene);
  const res = await judge.classify({ contentId: `contract:${ref}`, text, scene: e.scene, evidence: [], questions });
  if (res.status !== "ok") return { ref, status: res.status };
  const f: Fixture = {
    ref, scene: e.scene, source: e.source, index: e.index, text_sha: core.sha256(text), recorded_at: new Date().toISOString(),
    judge: { provider: judge.provider, api: judge.api, model: res.model }, rules_ver: bundle.rulesVer,
    questions: Object.fromEntries(questions.map((q) => [questionKey(q), q.sha])),
    primary: res.answers, variant: res.variant ? { seed: res.variant.shuffleSeed, answers: res.variant.answers } : null,
    latency_ms: res.latencyMs, usage: res.usage,
  };
  writeFileSync(fixturePath(ref), `${JSON.stringify(f, null, 1)}\n`);
  const view = Object.fromEntries(questions.map((q) => [questionKey(q), `${res.answers[q.sha]?.choice}(${(res.answers[q.sha]?.probs[q.violationOption] ?? 0).toFixed(3)})`]));
  return { ref, status: "ok", latency_ms: res.latencyMs, answers: view };
}));
for (const r of results) console.log(JSON.stringify(r));
if (results.some((r) => r.status !== "ok")) process.exit(1);
