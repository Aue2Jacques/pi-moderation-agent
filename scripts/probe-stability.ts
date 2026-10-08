// How stable is the judge on the same input? Asks Jev the exact fast-path question set for each pre-registered contract ref
// N times (in-call confirmation copy included), CONCURRENCY in parallel, and reports full-precision probabilities.
// usage: node --experimental-strip-types scripts/probe-stability.ts <N> <ref> [ref ...]   (JEV_* from env or .env)
import { readFileSync, writeFileSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import { jevModel, jevProvider } from "../packages/judges/src/index.ts";
import { loadBundle } from "../packages/policy/src/index.ts";
import { piJudge } from "../packages/worker/src/pi-judge.ts";
import { loadRefs, sceneQuestions, sentence } from "./lib/contract-fixtures.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const N = Number(process.argv[2] ?? 50);
const refsWanted = process.argv.slice(3);
const CONCURRENCY = Number(process.env["CONCURRENCY"] ?? 8);
const modelId = env("JEV_MODEL", "jev-latest");
const models = createModels();
models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY"), modelId }));
const judge = piJudge(models, jevModel(models, modelId), { inCallConfirm: true, timeoutMs: 20_000 });
const { bundle } = loadBundle("rules", "config/scenes.yaml");
const refs = loadRefs();

type Run = { ref: string; i: number; status: string; latency: number; model?: string; primary?: number; variant?: number; pChoice?: string; vChoice?: string; primaryProbs?: Record<string, number> };
const jobs: { ref: string; i: number }[] = refsWanted.flatMap((ref) => Array.from({ length: N }, (_, i) => ({ ref, i })));
const out: Run[] = [];
let next = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < jobs.length) {
    const { ref, i } = jobs[next++]!;
    const e = refs[ref]!;
    const qs = sceneQuestions(bundle, e.scene);
    const q = qs.find((x) => x.kind === "rule" && x.ruleId === "ABUSE-001")!;
    const res = await judge.classify({ contentId: `stab:${ref}:${i}`, text: sentence(e), scene: e.scene, evidence: [], questions: qs });
    if (res.status !== "ok") { out.push({ ref, i, status: res.status, latency: res.latencyMs }); continue; }
    const a = res.answers[q.sha]!;
    const v = res.variant?.answers[q.sha];
    out.push({ ref, i, status: "ok", latency: res.latencyMs, model: res.model, primary: a.probs[q.violationOption] ?? 0, pChoice: a.choice, ...(v ? { variant: v.probs[q.violationOption] ?? 0, vChoice: v.choice } : {}), primaryProbs: a.probs });
  }
}));
writeFileSync("/tmp/stability-runs.jsonl", out.map((r) => JSON.stringify(r)).join("\n") + "\n");

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  const hist: Record<string, number> = {};
  for (const x of xs) { const k = x.toFixed(2); hist[k] = (hist[k] ?? 0) + 1; }
  return { n: xs.length, min: s[0], max: s[s.length - 1], mean: +mean.toFixed(4), sd: +sd.toFixed(4), distinct_raw: new Set(xs).size, hist };
};
const th = bundle.rules.find((r) => r.ruleId === "ABUSE-001")!.thresholds.block;
for (const ref of refsWanted) {
  const ok = out.filter((r) => r.ref === ref && r.status === "ok");
  const p = ok.map((r) => r.primary!);
  const v = ok.filter((r) => r.variant !== undefined).map((r) => r.variant!);
  const blocks = ok.filter((r) => (r.variant ?? r.primary!) >= th).length;   // block support uses the latest answer of the group (the confirmation copy)
  console.log(JSON.stringify({
    ref, ok: ok.length, failed: out.filter((r) => r.ref === ref && r.status !== "ok").length,
    models: [...new Set(ok.map((r) => r.model))],
    primary: stats(p), variant: v.length ? stats(v) : null,
    same_call_gap: v.length ? stats(ok.filter((r) => r.variant !== undefined).map((r) => Math.abs(r.primary! - r.variant!))) : null,
    choices: { primary: [...new Set(ok.map((r) => r.pChoice))], variant: [...new Set(ok.map((r) => r.vChoice))] },
    block_threshold: th, would_block: `${blocks}/${ok.length}`,
    latency_p50_ms: [...ok.map((r) => r.latency)].sort((a, b) => a - b)[Math.floor(ok.length / 2)],
  }, null, 1));
}
console.log(JSON.stringify({ wall_ms: Date.now() - t0, calls: out.length, concurrency: CONCURRENCY }));
