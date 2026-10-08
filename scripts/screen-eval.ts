// Screen the presumed-normal everyday comments of the 20k set with the v2 abuse prompt (two models, resumable).
// Items both models call 违规 go to data/eval/exclude.txt; build-eval20k.py then skips them and samples replacements.
// Disagreements are kept and counted for the owner's review. Prints counts only.
// usage: node --experimental-strip-types scripts/screen-eval.ts [groups=everyday] [concurrency=64]
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { judgeV2 } from "./lib/abuse-v2.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const groups = new Set((process.argv[2] ?? "everyday").split(","));
const CONCURRENCY = Number(process.argv[3] ?? 64);
const BASE = env("RELAY_BASE_URL").replace(/\/+$/, ""), KEY = env("RELAY_API_KEY");
const MODELS = env("SCREEN_MODELS", "qwen3.8-flash,deepseek-v4.1-flash").split(",");
const IN = "data/eval/eval20k.jsonl", OUT = "data/eval/screen.jsonl", EXCL = "data/eval/exclude.txt";

type Item = { id: string; text: string; group: string; slice: string };
type Res = { id: string; model: string; decision: string | null; rule?: string };
const items = readFileSync(IN, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Item).filter((x) => groups.has(x.group));
const prior = existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Res) : [];
const done = new Set(prior.filter((r) => r.decision).map((r) => `${r.id}:${r.model}`));
const jobs = items.flatMap((it) => MODELS.map((model) => ({ it, model }))).filter((j) => !done.has(`${j.it.id}:${j.model}`));

let next = 0, ok = 0, failed = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < jobs.length) {
    const { it, model } = jobs[next++]!;
    const v = await judgeV2({ model, base: BASE, key: KEY }, it.text);
    if (v) ok++; else failed++;
    appendFileSync(OUT, `${JSON.stringify({ id: it.id, model, decision: v?.decision ?? null, rule: v?.rule })}\n`);
  }
}));

const by = new Map<string, Map<string, string>>();
for (const l of readFileSync(OUT, "utf8").split("\n")) if (l) { const r = JSON.parse(l) as Res; if (r.decision) (by.get(r.id) ?? by.set(r.id, new Map()).get(r.id)!).set(r.model, r.decision); }
const prevExcl = existsSync(EXCL) ? readFileSync(EXCL, "utf8").split("\n").filter(Boolean) : [];
const excl = new Set(prevExcl);
const tally: Record<string, Record<string, number>> = {};
for (const it of items) {
  const d = MODELS.map((m) => by.get(it.id)?.get(m));
  const k = d.some((x) => !x) ? "missing" : d.every((x) => x === "违规") ? "both_violate" : d.every((x) => x === "允许") ? "both_allow" : d.some((x) => x === "违规") ? "split_violate" : "unsure";
  ((tally[it.slice] ??= {})[k] = (tally[it.slice]![k] ?? 0) + 1);
  if (k === "both_violate") excl.add(it.id);
}
writeFileSync(EXCL, [...excl].sort().join("\n") + "\n");
console.log(JSON.stringify({ ran: jobs.length, ok, failed, wall_s: Math.round((Date.now() - t0) / 1000), excluded_total: excl.size, per_slice: tally }, null, 1));
