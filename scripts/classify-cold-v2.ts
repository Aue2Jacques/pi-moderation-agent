// Run the v2 policy prompt over COLD rows with one model (resumable). Output per row (under data/, contains model text):
// {i, model, ok, decision, rule, target, basis, basis_ok, confidence, reason, level, ms}
// usage: node --experimental-strip-types scripts/classify-cold-v2.ts <test.jsonl> <ids.jsonl> <out.jsonl> <model> [concurrency=32]
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basisAnchored, judgeV2, v2Level } from "./lib/abuse-v2.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string): string => { const v = process.env[k]; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const [textPath, idsPath, outPath, model] = [process.argv[2]!, process.argv[3]!, process.argv[4]!, process.argv[5]!];
const CONCURRENCY = Number(process.argv[6] ?? 32);
const cfg = { model, base: env("RELAY_BASE_URL").replace(/\/+$/, ""), key: env("RELAY_API_KEY") };

const texts = new Map<number, string>();
for (const l of readFileSync(textPath, "utf8").split("\n")) if (l) { const r = JSON.parse(l) as { i: number; text: string }; texts.set(r.i, r.text); }
const ids = [...new Set(readFileSync(idsPath, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { i: number }).i))];
const done = new Set<number>(existsSync(outPath) ? readFileSync(outPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { i: number; ok: boolean }).filter((r) => r.ok).map((r) => r.i) : []);
const todo = ids.filter((i) => !done.has(i));

let next = 0, ok = 0, failed = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < todo.length) {
    const i = todo[next++]!;
    const t = Date.now();
    const v = await judgeV2(cfg, texts.get(i)!);
    if (v) ok++; else failed++;
    appendFileSync(outPath, `${JSON.stringify({ i, model, ok: !!v, ...(v ? { ...v, basis_ok: basisAnchored(v), ...v2Level(v) } : {}), ms: Date.now() - t })}\n`);
  }
}));
console.log(JSON.stringify({ model, done: true, ok, failed, wall_s: Math.round((Date.now() - t0) / 1000) }));
