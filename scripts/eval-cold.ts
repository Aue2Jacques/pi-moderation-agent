// Run the real fast-path judge request on a COLD split and record scores against COLD's own labels.
// Input: a JSONL made by scripts/cold-to-jsonl.py ({i, label, fine, text}); the text is sent to Jev and never written out.
// Output: one JSONL line per row {i, label, fine, status, latency_ms, usage, primary:{key:{choice,p}}, copy:{...}} — no text.
// Resumable: rows already present in the output file are skipped.
// usage: node --experimental-strip-types scripts/eval-cold.ts <in.jsonl> <out.jsonl> [concurrency=32] [limit]
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import { jevModel, jevProvider } from "../packages/judges/src/index.ts";
import { loadBundle } from "../packages/policy/src/index.ts";
import { piJudge } from "../packages/worker/src/pi-judge.ts";
import { sceneQuestions } from "./lib/contract-fixtures.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const [inPath, outPath] = [process.argv[2]!, process.argv[3]!];
const CONCURRENCY = Number(process.argv[4] ?? 32);
const LIMIT = process.argv[5] ? Number(process.argv[5]) : Infinity;

const modelId = env("JEV_MODEL", "jev-latest");
const models = createModels();
models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY"), modelId }));
const judge = piJudge(models, jevModel(models, modelId), { inCallConfirm: true, timeoutMs: 30_000 });
const { bundle } = loadBundle("rules", "config/scenes.yaml");
const questions = sceneQuestions(bundle, "comment");
const keyOf = new Map(questions.map((q) => [q.sha, q.key ?? q.sha] as const));
const vo = new Map(questions.map((q) => [q.sha, q.violationOption] as const));

type Row = { i: number; label: number; fine: number | null; text: string };
const rows = readFileSync(inPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row).slice(0, LIMIT);
const prior = existsSync(outPath) ? readFileSync(outPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { i: number; status: string }) : [];
const done = new Set<number>(prior.filter((p) => p.status === "ok").map((p) => p.i));
const todo = rows.filter((r) => !done.has(r.i));
console.log(JSON.stringify({ rows: rows.length, already_done: rows.length - todo.length, todo: todo.length, concurrency: CONCURRENCY, questions: questions.map((q) => q.key), rules_ver: bundle.rulesVer }));

const pick = (ans: Record<string, { choice: string; probs: Record<string, number> }>) =>
  Object.fromEntries(Object.entries(ans).map(([sha, a]) => [keyOf.get(sha) ?? sha, { choice: a.choice, p: a.probs[vo.get(sha) ?? "violate"] ?? 0, probs: a.probs }]));

let next = 0, ok = 0, failed = 0;
const t0 = Date.now();
const timer = setInterval(() => console.log(JSON.stringify({ progress: ok + failed, ok, failed, elapsed_s: Math.round((Date.now() - t0) / 1000) })), 15_000);
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < todo.length) {
    const r = todo[next++]!;
    let res: Awaited<ReturnType<typeof judge.classify>> | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await judge.classify({ contentId: `cold:${r.i}`, text: r.text, scene: "comment", evidence: [], questions });
      if (res.status === "ok") break;
      await new Promise((s) => setTimeout(s, 1000 * (attempt + 1)));
    }
    const base = { i: r.i, label: r.label, fine: r.fine };
    if (!res || res.status !== "ok") {
      failed++;
      appendFileSync(outPath, `${JSON.stringify({ ...base, status: res?.status ?? "error", latency_ms: res?.latencyMs ?? 0 })}\n`);
      continue;
    }
    ok++;
    appendFileSync(outPath, `${JSON.stringify({ ...base, status: "ok", latency_ms: res.latencyMs, usage: res.usage, model: res.model, primary: pick(res.answers), copy: res.variant ? pick(res.variant.answers) : null })}\n`);
  }
}));
clearInterval(timer);
console.log(JSON.stringify({ done: true, ok, failed, wall_s: Math.round((Date.now() - t0) / 1000) }));
