// Pilot of a platform labeling standard (scripts/lib/labeling.ts) before it is frozen (dev plan 2026-10-08 §0.1).
// Two phases; prints counts only, rows hold no text.
//   run <standard> <ids.txt> [concurrency=48]   both labeling models answer every item; resumable, and a row recorded
//                                                under another prompt version is never reused (identity = prompt sha)
//   score <standard> <ids.txt>                  per group: two-model agreement on the 3-way label and on violate vs
//                                                not, uncertain share, per-question agreement
//   compare <stdA> <stdB> <ids.txt>             on items both models answered under both versions: violate-vs-not
//                                                agreement and which model alone said violate, by group
//   stability <std> <ids.txt> <tag>             per model: same label in the main run and the repeat run <tag>
//   vote <std> <ids.txt> <runsA> [runsB]         each model's label = majority of the runs listed (e.g. main,rep2,rep3;
//                                                "main" is the untagged run; no label with a majority -> uncertain);
//                                                by group: two-model agreement on the voted labels; with runsB, also
//                                                whether each model's voted label is the same across the two run sets
//   sample <group> <n> <out.txt> [exclude.txt…]  fresh dev-split ids of one group, none from the exclude files, by a
//                                                fixed hash order (no text read) — a holdout for a reworded standard
// Labeling models: deepseek-v4.1-flash and qwen3.8-flash (owner decision); deepseek's channel does not take a
// temperature, so none is sent.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { STANDARDS, followUpFor, majority, readAnswers, type Answer, type Label } from "./lib/labeling.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const [phase, stdId, idsPath, conc] = process.argv.slice(2);
if (phase === "compare") {
  const [, aId, bId, idsFile] = process.argv.slice(2);
  const sa = STANDARDS[aId ?? ""], sb = STANDARDS[bId ?? ""];
  if (!sa || !sb || !idsFile) throw new Error("usage: label-pilot.ts compare <stdA> <stdB> <ids.txt>");
  const M = ["deepseek-v4.1-flash", "qwen3.8-flash"];
  const load = (st: typeof sa) => {
    const by = new Map<string, Record<string, { label: string }>>();
    const f = `data/eval/label-pilot-${st.id}.jsonl`;
    for (const l of (existsSync(f) ? readFileSync(f, "utf8") : "").split("\n").filter(Boolean)) {
      const r = JSON.parse(l) as { id: string; model: string; ok: boolean; promptSha: string; label: string };
      if (r.ok && r.promptSha === st.promptSha) (by.get(r.id) ?? by.set(r.id, {}).get(r.id)!)[r.model] = r;
    }
    return by;
  };
  const A = load(sa), B = load(sb);
  const want = new Set(readFileSync(idsFile, "utf8").split("\n").filter(Boolean));
  const out = new Map<string, Record<string, number>>();
  for (const l of readFileSync("data/eval/eval20k.jsonl", "utf8").split("\n").filter(Boolean)) {
    const it = JSON.parse(l) as { id: string; group: string };
    if (!want.has(it.id)) continue;
    const a = A.get(it.id), b = B.get(it.id);
    if (!a || !b || !M.every((m) => a[m] && b[m])) continue;
    for (const g of [it.group, "ALL"]) {
      const c = out.get(g) ?? out.set(g, { n: 0 }).get(g)!;
      c.n!++;
      for (const [v, z] of [[sa.id, a], [sb.id, b]] as const) {
        const dv = z[M[0]!]!.label === "violate", qv = z[M[1]!]!.label === "violate";
        const k = `${v} ${dv === qv ? "agree" : dv ? "ds-only-violate" : "qw-only-violate"}`;
        c[k] = (c[k] ?? 0) + 1;
      }
    }
  }
  for (const [g, c] of [...out].sort()) console.log(g.padEnd(14), JSON.stringify(c));
  process.exit(0);
}
if (phase === "stability") {
  const [, sId, idsFile, tag] = process.argv.slice(2);
  if (!STANDARDS[sId ?? ""] || !idsFile || !tag) throw new Error("usage: label-pilot.ts stability <std> <ids.txt> <tag>");
  const sha = STANDARDS[sId!]!.promptSha;
  const want = new Set(readFileSync(idsFile, "utf8").split("\n").filter(Boolean));
  const read = (f: string) => {
    const m = new Map<string, string>();
    for (const l of (existsSync(f) ? readFileSync(f, "utf8") : "").split("\n").filter(Boolean)) {
      const r = JSON.parse(l) as { id: string; model: string; ok: boolean; promptSha: string; label: string };
      if (r.ok && r.promptSha === sha && want.has(r.id)) m.set(`${r.id}|${r.model}`, r.label);
    }
    return m;
  };
  const a = read(`data/eval/label-pilot-${sId}.jsonl`), b = read(`data/eval/label-pilot-${sId}.${tag}.jsonl`);
  for (const model of ["deepseek-v4.1-flash", "qwen3.8-flash"]) {
    let n = 0, same3 = 0, sameBin = 0;
    for (const [k, la] of a) {
      if (!k.endsWith(`|${model}`) || !b.has(k)) continue;
      const lb = b.get(k)!;
      n++; if (la === lb) same3++; if ((la === "violate") === (lb === "violate")) sameBin++;
    }
    console.log(`${model.padEnd(22)} n=${n}  same 3-way ${((100 * same3) / Math.max(1, n)).toFixed(1)}%  same violate-vs-not ${((100 * sameBin) / Math.max(1, n)).toFixed(1)}%`);
  }
  process.exit(0);
}
if (phase === "vote") {
  const [, sId, idsFile, runsA, runsB] = process.argv.slice(2);
  if (!STANDARDS[sId ?? ""] || !idsFile || !runsA) throw new Error("usage: label-pilot.ts vote <std> <ids.txt> <runsA> [runsB]");
  const sha = STANDARDS[sId!]!.promptSha;
  const M = ["deepseek-v4.1-flash", "qwen3.8-flash"];
  const want = new Set(readFileSync(idsFile, "utf8").split("\n").filter(Boolean));
  const runCache = new Map<string, Map<string, string>>();
  const run = (tag: string) => {
    if (!runCache.has(tag)) {
      const m = new Map<string, string>(), f = `data/eval/label-pilot-${sId}${tag === "main" ? "" : `.${tag}`}.jsonl`;
      for (const l of (existsSync(f) ? readFileSync(f, "utf8") : "").split("\n").filter(Boolean)) {
        const r = JSON.parse(l) as { id: string; model: string; ok: boolean; promptSha: string; label: string };
        if (r.ok && r.promptSha === sha && want.has(r.id)) m.set(`${r.id}|${r.model}`, r.label);
      }
      runCache.set(tag, m);
    }
    return runCache.get(tag)!;
  };
  /** voted label of one model on one item over a run set; undefined unless every run answered */
  const voted = (tags: string[], id: string, model: string): string | undefined => {
    const ls = tags.map((t) => run(t).get(`${id}|${model}`));
    if (ls.some((l) => l === undefined)) return undefined;
    return majority(ls as Label[]);
  };
  const A = runsA.split(","), B = runsB?.split(",");
  const out = new Map<string, Record<string, number>>();
  const bump = (g: string, k: string) => { const c = out.get(g) ?? out.set(g, {}).get(g)!; c[k] = (c[k] ?? 0) + 1; };
  for (const l of readFileSync("data/eval/eval20k.jsonl", "utf8").split("\n").filter(Boolean)) {
    const it = JSON.parse(l) as { id: string; group: string };
    if (!want.has(it.id)) continue;
    const va = M.map((m) => voted(A, it.id, m)), vb = B ? M.map((m) => voted(B, it.id, m)) : undefined;
    if (va.some((v) => !v) || (vb && vb.some((v) => !v))) continue;
    for (const g of [it.group, "ALL"]) {
      bump(g, "n");
      if ((va[0] === "violate") === (va[1] === "violate")) bump(g, "A agree");
      if (va[0] === va[1]) bump(g, "A agree3");
      if (va.some((v) => v === "uncertain")) bump(g, "A anyUncertain");
      if (vb) {
        if ((vb[0] === "violate") === (vb[1] === "violate")) bump(g, "B agree");
        M.forEach((m, i) => { if ((va[i] === "violate") === (vb[i] === "violate")) bump(g, `${m.slice(0, 4)} A=B`); });
      }
    }
  }
  const pct = (a = 0, n = 1) => `${((100 * a) / Math.max(1, n)).toFixed(1)}%`;
  console.log(JSON.stringify({ standard: sId, runsA, runsB: runsB ?? null }));
  for (const [g, c] of [...out].sort()) {
    const n = c.n!;
    console.log(`${g.padEnd(14)} n=${String(n).padStart(4)}  A violate-vs-not agree ${pct(c["A agree"], n)}  A 3-way ${pct(c["A agree3"], n)}  A any-uncertain ${pct(c["A anyUncertain"], n)}` +
      (B ? `  B agree ${pct(c["B agree"], n)}  same voted label A vs B: ds ${pct(c["deep A=B"], n)} qw ${pct(c["qwen A=B"], n)}` : ""));
  }
  process.exit(0);
}
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
if (!std || !idsPath) throw new Error("usage: label-pilot.ts run|score|sample <abuse-v4|abuse-v4.1|abuse-v4.2|marketing-v1|guard-v1> <ids.txt> [concurrency]");
const MODELS = ["deepseek-v4.1-flash", "qwen3.8-flash"];
// LABEL_PILOT_TAG=rep2 writes / reads a separate repeat run (same prompt, same models) to measure run-to-run stability
const OUT = `data/eval/label-pilot-${std.id}${process.env.LABEL_PILOT_TAG ? `.${process.env.LABEL_PILOT_TAG}` : ""}.jsonl`;
type Item = { id: string; text: string; group: string; slice: string; label_bin: number };
type Row = { id: string; model: string; promptSha: string; ok: boolean; followUp?: boolean; answers?: Record<string, Answer>; label?: Label };
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
      let answers: Record<string, Answer> | undefined, followUp = false;
      const ask = async (messages: { role: string; content: string }[]): Promise<string | undefined> => {
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, stream: false, ...knobs(model), messages }), signal: AbortSignal.timeout(120_000),
        });
        return res.ok ? ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "" : undefined;
      };
      for (let a = 0; a < 3 && !answers; a++) {
        try {
          const messages = [{ role: "system", content: "你是中文内容审核标注员。只输出一个 JSON 对象，不要输出任何其他文字。" }, { role: "user", content: std.prompt.trimEnd().replace("{{TEXT}}", () => it.text) }];
          const first = await ask(messages);
          const r = first === undefined ? undefined : readAnswers(std, first);
          if (r && r.missing.length === 0) answers = r.got;
          else if (r) {
            // a model that skipped questions is asked once, in the same conversation, for only those questions
            const more = await ask([...messages, { role: "assistant", content: first! }, { role: "user", content: followUpFor(r.missing) }]);
            const r2 = more === undefined ? undefined : readAnswers({ ...std, questions: r.missing }, more);
            if (r2 && r2.missing.length === 0) { answers = { ...r.got, ...r2.got }; followUp = true; }
          }
        } catch { /* retry */ }
      }
      if (answers) ok++; else failed++;
      appendFileSync(OUT, JSON.stringify({ id: it.id, model, promptSha: std.promptSha, ok: !!answers, ...(followUp ? { followUp } : {}), ...(answers ? { answers, label: std.label(answers) } : {}) }) + "\n");
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
