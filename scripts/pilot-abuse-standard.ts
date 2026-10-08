// Pilot of the abuse labeling standard: label the same dev-split items with two models under the v2 prompt (baseline)
// and the v3 fact questions, so agreement can be compared like for like. Resumable. Output rows hold no text.
//   sample: python3 -I scripts/pilot-abuse-standard.py writes data/eval/pilot-ids.txt first
// usage: node --experimental-strip-types scripts/pilot-abuse-standard.ts [v2,v3,v3.1] [concurrency=64]
// env: PILOT_IDS (id list, default data/eval/pilot-ids.txt), PILOT_TEMP (temperature; unset = provider default),
//      PILOT_REP (repeat tag, so the same prompt can be run twice to measure a model's agreement with itself)
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { judgeV2 } from "./lib/abuse-v2.ts";
import type { ClassifierQuestion, JsonObject } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { jevModel, jevProvider } from "../packages/judges/src/index.ts";
import { type Facts, factsV3, jevQuestions, labelV3, QS } from "./lib/abuse-v3.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const prompts = (process.argv[2] ?? "v2,v3").split(",");
const CONCURRENCY = Number(process.argv[3] ?? 64);
const BASE = env("RELAY_BASE_URL").replace(/\/+$/, ""), KEY = env("RELAY_API_KEY");
// "jev" answers the v3 questions only, through its bool classifier; it is measured, never used to set labels
const MODELS = env("PILOT_MODELS", "deepseek-v4.1-flash,qwen3.8-flash,jev").split(",");
const OUT = env("PILOT_OUT", "data/eval/pilot-runs.jsonl");
const TEMP = process.env.PILOT_TEMP === undefined ? undefined : Number(process.env.PILOT_TEMP);
const REP = Number(env("PILOT_REP", "1"));

const ids = new Set(readFileSync(env("PILOT_IDS", "data/eval/pilot-ids.txt"), "utf8").split("\n").filter(Boolean));
const items = readFileSync("data/eval/eval20k.jsonl", "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l) as { id: string; text: string }).filter((x) => ids.has(x.id));
const done = new Set(existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; model: string; prompt: string; ok: boolean; rep?: number; temp?: number }).filter((r) => r.ok && (r.rep ?? 1) === REP && r.temp === TEMP).map((r) => `${r.id}:${r.model}:${r.prompt}`) : []);
const jobs = items.flatMap((it) => MODELS.flatMap((model) => prompts.filter((p) => model !== "jev" || p.startsWith("v3")).map((prompt) => ({ it, model, prompt })))).filter((j) => !done.has(`${j.it.id}:${j.model}:${j.prompt}`));

const models = createModels();
const JEV_ID = env("JEV_MODEL", "jev-latest");
if (MODELS.includes("jev")) models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY"), modelId: JEV_ID }));
async function factsJev(text: string, version: string): Promise<(Facts & { p: Record<string, number> }) | null> {
  for (let a = 0; a < 3; a++) {
    const res = await models.classify(jevModel(models, JEV_ID), { state: { content: { text, scene: "comment" } } as unknown as JsonObject, questions: jevQuestions(version) as unknown as Record<string, ClassifierQuestion> }, { timeoutMs: 30_000 });
    if (res.stopReason === "stop") {
      const ans = res.answers as Record<string, { probability: number }>;
      const p = Object.fromEntries(QS.map((q) => [q, ans[q]!.probability]));
      return { ...Object.fromEntries(QS.map((q) => [q, p[q]! >= 0.5])), reason: "", p } as Facts & { p: Record<string, number> };
    }
    await new Promise((s) => setTimeout(s, 1000 * (a + 1)));
  }
  return null;
}

let next = 0, ok = 0, failed = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < jobs.length) {
    const { it, model, prompt } = jobs[next++]!;
    const cfg = { model, base: BASE, key: KEY, temperature: TEMP };
    let row: Record<string, unknown> | null = null;
    if (prompt === "v2") {
      const v = await judgeV2(cfg, it.text);
      if (v) row = { decision: v.decision, rule: v.rule, target: v.target };
    } else {
      const f = model === "jev" ? await factsJev(it.text, prompt) : await factsV3(cfg, it.text, prompt);
      if (f) row = { ...labelV3(f), facts: Object.fromEntries(QS.map((q) => [q, f[q]])), ...("p" in f ? { p: f.p } : {}) };
    }
    if (row) ok++; else failed++;
    appendFileSync(OUT, `${JSON.stringify({ id: it.id, model, prompt, rep: REP, ...(TEMP === undefined ? {} : { temp: TEMP }), ok: !!row, ...(row ?? {}) })}\n`);
  }
}));
console.log(JSON.stringify({ items: items.length, jobs: jobs.length, ok, failed, wall_s: Math.round((Date.now() - t0) / 1000) }));
