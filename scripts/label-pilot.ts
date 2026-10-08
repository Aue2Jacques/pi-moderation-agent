// Pilot of a platform labeling standard (scripts/lib/labeling.ts) before it is frozen (dev plan 2026-10-08 §0.1).
// Two phases; prints counts only, rows hold no text.
//   run <standard> <ids.txt> [concurrency=48]   both labeling models answer every item; resumable, and a row recorded
//                                                under another prompt version is never reused (identity = prompt sha)
//   score <standard> <ids.txt>                  per group: two-model agreement on the 3-way label and on violate vs
//                                                not, uncertain share, per-question agreement
//   sample <group> <n> <out.txt> [exclude.txt…]  fresh dev-split ids of one group, none from the exclude files, by a
//                                                fixed hash order (no text read) — a holdout for a reworded standard
// Labeling models: deepseek-v4.1-flash and qwen3.8-flash (owner decision); deepseek's channel does not take a
// temperature, so none is sent.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { STANDARDS, parseAnswers, type Answer, type Label } from "./lib/labeling.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const [phase, stdId, idsPath, conc] = process.argv.slice(2);
if (phase === "sample") {
  const [, group, n, out, ...excl] = process.argv.slice(2);
  const skip = new Set(excl.flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean)));
  const h = (id: string) => createHash("sha256").update(`label-pilot-holdout|${id}`).digest("hex");
  const pick = readFileSync("data/eval/eval20k.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; group: string; split: string })
    .filter((x) => x.group === group && x.split === "dev" && !skip.has(x.id)).map((x) => x.id).sort((a, b) => h(a).localeCompare(h(b))).slice(0, Number(n));
  writeFileSync(out!, pick.join("\n") + "\n");
  console.log(JSON.stringify({ group, picked: pick.length, out }));
  process.exit(0);
}
const std = STANDARDS[stdId ?? ""];
if (!std || !idsPath) throw new Error("usage: label-pilot.ts run|score|sample <abuse-v4|abuse-v4.1|marketing-v1|guard-v1> <ids.txt> [concurrency]");
const MODELS = ["deepseek-v4.1-flash", "qwen3.8-flash"];
const OUT = `data/eval/label-pilot-${std.id}.jsonl`;
type Item = { id: string; text: string; group: string; slice: string; label_bin: number };
type Row = { id: string; model: string; promptSha: string; ok: boolean; answers?: Record<string, Answer>; label?: Label };
const ids = new Set(readFileSync(idsPath, "utf8").split("\n").filter(Boolean));
const items = readFileSync("data/eval/eval20k.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Item).filter((x) => ids.has(x.id));
const rowsNow = (): Row[] => (existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row) : []).filter((r) => r.ok && r.promptSha === std.promptSha);

function knobs(model: string): Record<string, unknown> {
  if (model.startsWith("deepseek")) return { max_tokens: 393216, thinking: { type: "disabled" } };
  if (model.startsWith("qwen")) return { max_tokens: 131072, enable_thinking: false };
  return { max_tokens: 131072 };
}

if (phase === "run") {
  const base = env("RELAY_BASE_URL").replace(/\/+$/, ""), key = env("RELAY_API_KEY");
  const done = new Set(rowsNow().map((r) => `${r.id}|${r.model}`));
  const jobs = items.flatMap((it) => MODELS.map((model) => ({ it, model }))).filter((j) => !done.has(`${j.it.id}|${j.model}`));
  let next = 0, ok = 0, failed = 0;
  await Promise.all(Array.from({ length: Number(conc ?? 48) }, async () => {
    while (next < jobs.length) {
      const { it, model } = jobs[next++]!;
      let answers: Record<string, Answer> | undefined;
      for (let a = 0; a < 3 && !answers; a++) {
        try {
          const res = await fetch(`${base}/chat/completions`, {
            method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
            body: JSON.stringify({ model, stream: false, ...knobs(model), messages: [{ role: "system", content: "你是中文内容审核标注员。只输出一个 JSON 对象，不要输出任何其他文字。" }, { role: "user", content: std.prompt.trimEnd().replace("{{TEXT}}", () => it.text) }] }),
            signal: AbortSignal.timeout(120_000),
          });
          if (res.ok) answers = parseAnswers(std, ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "");
        } catch { /* retry */ }
      }
      if (answers) ok++; else failed++;
      appendFileSync(OUT, JSON.stringify({ id: it.id, model, promptSha: std.promptSha, ok: !!answers, ...(answers ? { answers, label: std.label(answers) } : {}) }) + "\n");
    }
  }));
  console.log(JSON.stringify({ standard: std.id, promptSha: std.promptSha, items: items.length, jobs: jobs.length, ok, failed }));
} else if (phase === "score") {
  const by = new Map<string, Map<string, Row>>();
  for (const r of rowsNow()) (by.get(r.id) ?? by.set(r.id, new Map()).get(r.id)!).set(r.model, r);
  const groups = new Map<string, { n: number; same3: number; sameBin: number; uncertain: number; viol: [number, number]; q: Record<string, number> }>();
  const pairsFor = (it: Item) => { const m = by.get(it.id); return m && MODELS.every((x) => m.has(x)) ? MODELS.map((x) => m.get(x)!) : undefined; };
  for (const it of items) {
    const p = pairsFor(it);
    if (!p) continue;
    for (const g of [it.group, "ALL"]) {
      const s = groups.get(g) ?? { n: 0, same3: 0, sameBin: 0, uncertain: 0, viol: [0, 0] as [number, number], q: {} };
      s.n++;
      if (p[0]!.label === p[1]!.label) s.same3++;
      if ((p[0]!.label === "violate") === (p[1]!.label === "violate")) s.sameBin++;
      if (p.some((r) => r.label === "uncertain")) s.uncertain++;
      if (p[0]!.label === "violate") s.viol[0]++;
      if (p[1]!.label === "violate") s.viol[1]++;
      for (const q of std.questions) if (p[0]!.answers![q] === p[1]!.answers![q]) s.q[q] = (s.q[q] ?? 0) + 1;
      groups.set(g, s);
    }
  }
  const pct = (a: number, n: number) => `${((100 * a) / Math.max(1, n)).toFixed(1)}%`;
  console.log(JSON.stringify({ standard: std.id, promptSha: std.promptSha, items: items.length, complete: groups.get("ALL")?.n ?? 0 }));
  for (const [g, s] of [...groups].sort()) {
    console.log(`${g.padEnd(14)} n=${String(s.n).padStart(4)}  3-way agree ${pct(s.same3, s.n)}  violate-vs-not agree ${pct(s.sameBin, s.n)}  any-uncertain ${pct(s.uncertain, s.n)}  violate ${pct(s.viol[0], s.n)}/${pct(s.viol[1], s.n)}  per-question ${std.questions.map((q) => `${q} ${pct(s.q[q] ?? 0, s.n)}`).join(" ")}`);
  }
} else {
  throw new Error("phase must be run | score");
}
