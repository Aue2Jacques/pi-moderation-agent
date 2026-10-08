// Self-written hard negatives for the 20k evaluation set (docs/eval-dataset-plan.md): content an over-eager judge tends
// to block but the platform allows. Three resumable phases, prints counts only (the files under data/ hold the text):
//   gen     one generator model writes 25 candidates per (kind, topic)            -> data/eval/hn-candidates.jsonl
//   verify  two other models judge every candidate (v2 abuse prompt, or the spam
//           prompt for the recommendation kind)                                     -> data/eval/hn-verify.jsonl
//   select  keep candidates both verifiers call 允许, dedup, up to 150 per kind    -> data/eval/hard-negatives.jsonl
// usage: node --experimental-strip-types scripts/gen-hard-negatives.ts <gen|verify|select> [concurrency=32]
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse } from "yaml";
import { judgeV2 } from "./lib/abuse-v2.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const phase = process.argv[2];
const CONCURRENCY = Number(process.argv[3] ?? 32);
const BASE = env("RELAY_BASE_URL").replace(/\/+$/, ""), KEY = env("RELAY_API_KEY");
const GEN_MODEL = env("HN_GEN_MODEL", "deepseek-v4.1-flash");
const VERIFIERS = env("HN_VERIFY_MODELS").split(",");
const PER_CALL = 25, PER_KIND = 150;

type Spec = { generator: string; topics: string[]; kinds: Record<string, { desc: string; check: "abuse" | "spam" }>; spam_check: string };
const spec = parse(readFileSync(join(import.meta.dirname, "..", "rules", "prompts", "hard-negatives.yaml"), "utf8")) as Spec;
mkdirSync("data/eval", { recursive: true });
const CAND = "data/eval/hn-candidates.jsonl", VER = "data/eval/hn-verify.jsonl", OUT = "data/eval/hard-negatives.jsonl";
const readJsonl = <T>(p: string): T[] => existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : [];

function knobs(model: string): Record<string, unknown> {
  if (model.startsWith("deepseek")) return { max_tokens: 393216, thinking: { type: "disabled" } };
  if (model.startsWith("qwen")) return { max_tokens: 131072, enable_thinking: false };
  if (model.startsWith("gemini")) return { max_tokens: 65536 };
  return { max_tokens: 131072 };
}
async function chat(model: string, user: string, temperature?: number): Promise<string | null> {
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model, stream: false, ...knobs(model), ...(temperature === undefined ? {} : { temperature }), messages: [{ role: "user", content: user }] }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) { await new Promise((s) => setTimeout(s, 2000 * (a + 1))); continue; }
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return body.choices?.[0]?.message?.content ?? null;
    } catch { /* retry */ }
  }
  return null;
}
async function pool<T>(items: T[], fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (next < items.length) await fn(items[next++]!); }));
}
const norm = (t: string): string => t.replace(/\s+/g, "");

type Cand = { cid: string; kind: string; topic: number; text: string; gen_model: string };
type Ver = { cid: string; model: string; decision: string | null };

if (phase === "gen") {
  const have = new Set(readJsonl<Cand>(CAND).map((c) => `${c.kind}:${c.topic}`));
  const jobs = Object.keys(spec.kinds).flatMap((kind) => spec.topics.map((_, topic) => ({ kind, topic }))).filter((j) => !have.has(`${j.kind}:${j.topic}`));
  let ok = 0, bad = 0;
  await pool(jobs, async ({ kind, topic }) => {
    const prompt = spec.generator.replace("{{N}}", String(PER_CALL)).replace("{{KIND}}", spec.kinds[kind]!.desc).replace("{{TOPICS}}", spec.topics[topic]!);
    const out = await chat(GEN_MODEL, prompt, 1.0);
    const m = out ? /\[[\s\S]*\]/.exec(out) : null;
    let arr: unknown[] = [];
    try { arr = m ? (JSON.parse(m[0]) as unknown[]) : []; } catch { arr = []; }
    const texts = arr.filter((x): x is string => typeof x === "string" && x.trim().length > 1);
    if (!texts.length) { bad++; return; }
    ok++;
    appendFileSync(CAND, texts.map((text, k) => JSON.stringify({ cid: createHash("sha256").update(`${kind}:${topic}:${k}:${text}`).digest("hex").slice(0, 12), kind, topic, text: text.trim(), gen_model: GEN_MODEL })).join("\n") + "\n");
  });
  console.log(JSON.stringify({ phase, jobs: jobs.length, ok, failed: bad, candidates: readJsonl<Cand>(CAND).length }));
} else if (phase === "verify") {
  const cands = readJsonl<Cand>(CAND).filter((c) => spec.kinds[c.kind]);   // kinds dropped from the spec are not verified
  const done = new Set(readJsonl<Ver>(VER).filter((v) => v.decision).map((v) => `${v.cid}:${v.model}`));
  const jobs = cands.flatMap((c) => VERIFIERS.map((model) => ({ c, model }))).filter((j) => !done.has(`${j.c.cid}:${j.model}`));
  let ok = 0, bad = 0;
  await pool(jobs, async ({ c, model }) => {
    let decision: string | null = null;
    if (spec.kinds[c.kind]!.check === "abuse") {
      decision = (await judgeV2({ model, base: BASE, key: KEY }, c.text))?.decision ?? null;
    } else {
      const out = await chat(model, spec.spam_check.replace("{{TEXT}}", () => c.text));
      try { decision = (JSON.parse(/\{[\s\S]*\}/.exec(out ?? "")?.[0] ?? "null") as { decision?: string } | null)?.decision ?? null; } catch { decision = null; }
    }
    if (decision) ok++; else bad++;
    appendFileSync(VER, `${JSON.stringify({ cid: c.cid, model, decision })}\n`);
  });
  console.log(JSON.stringify({ phase, jobs: jobs.length, ok, failed: bad }));
} else if (phase === "select") {
  const verdicts = new Map<string, Map<string, string>>();
  for (const v of readJsonl<Ver>(VER)) if (v.decision) (verdicts.get(v.cid) ?? verdicts.set(v.cid, new Map()).get(v.cid)!).set(v.model, v.decision);
  const seen = new Set<string>();
  const byKind = new Map<string, Cand[]>();
  const stats: Record<string, Record<string, number>> = {};
  for (const c of readJsonl<Cand>(CAND).filter((x) => spec.kinds[x.kind])) {
    const s = (stats[c.kind] ??= { candidates: 0, dup: 0, both_allow: 0, any_violate: 0, other: 0 });
    s.candidates!++;
    if (seen.has(norm(c.text))) { s.dup!++; continue; }
    seen.add(norm(c.text));
    const d = VERIFIERS.map((m) => verdicts.get(c.cid)?.get(m));
    if (d.every((x) => x === "允许")) { s.both_allow!++; (byKind.get(c.kind) ?? byKind.set(c.kind, []).get(c.kind)!).push(c); }
    else if (d.some((x) => x === "违规")) s.any_violate!++;
    else s.other!++;
  }
  const lines: string[] = [];
  for (const [kind, list] of byKind) {
    list.sort((a, b) => (a.cid < b.cid ? -1 : 1));   // cid is a hash: a fixed, topic-mixed order
    const per = new Map<number, number>();
    const picked: Cand[] = [];
    for (const c of list) if ((per.get(c.topic) ?? 0) < Math.ceil(PER_KIND / spec.topics.length) && picked.length < PER_KIND) { picked.push(c); per.set(c.topic, (per.get(c.topic) ?? 0) + 1); }
    for (const c of list) if (picked.length < PER_KIND && !picked.includes(c)) picked.push(c);
    for (const c of picked) lines.push(JSON.stringify({ text: c.text, ref: c.cid, kind, gen_model: c.gen_model, verified_by: VERIFIERS }));
    stats[kind]!.kept = picked.length;
  }
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(JSON.stringify({ phase, kept: lines.length, per_kind: stats }, null, 1));
} else {
  throw new Error("phase must be gen | verify | select");
}
