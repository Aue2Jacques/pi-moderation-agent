// Stage ④ judge evaluation on the frozen test split (dev plan 2026-10-08 §6: judges are scored on the test set only).
//   collect <outDir> [view=text|text_strip] [concurrency=16]
//       the fast path's question set asked to the judge for every test item, in the main model view (`text`, E5) or the
//       full-strip control (`text_strip`); one row per item with the full probabilities (primary + in-call copy) and
//       one row per PHYSICAL request (E3: every try, its latency, status and usage). Resumable by identity (E2): a row
//       counts only for the same item text, view, rules version and judge model. Writes a run manifest (E1).
//   score <outDir> [view=text]
//       calibrated with CALIB_DIR exactly as the runtime and routed through policy.decide; per group, against the
//       platform labels (frozen procedure; "uncertain" kept out of the binary counts and reported) and, separately,
//       against the datasets' own labels (never mixed). Prints counts only.
//   agent-lines <outDir> text [n=200]   (EVAL_SPLIT=val)
//       temporary agent-stage thresholds: picks n items the fast path sends to the agent, then (once they carry
//       platform labels) replays a grid of per-rule agent lines through allowedActions(stage "agent")
//   suspects <outDir> text   (EVAL_SPLIT=train)
//       data cleaning: items whose unified source label disagrees with a confident judge answer (primary and copy);
//       precision / recall of that flag against the platform labels where they exist
//   separation <outDir> [view=text]
//       threshold-free judge comparison on the raw answers against the platform labels: AUROC per question (primary,
//       in-call copy, their mean), primary/copy top-option agreement, mass on "unknown", allow items passed at a line
//       that lets ≤1% of violate items through.
// usage: node --experimental-strip-types scripts/eval-test.ts collect|score|separation|agent-lines|suspects <outDir> ...
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import * as core from "../packages/core/src/index.ts";
import { jevModel, jevProvider, loadCalibrator, type JudgeLayout } from "../packages/judges/src/index.ts";
import { decide, loadBundle } from "../packages/policy/src/index.ts";
import { piJudge } from "../packages/worker/src/pi-judge.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const [phase, outDir, viewArg, concArg] = process.argv.slice(2);
if (!phase || !outDir) throw new Error("usage: eval-test.ts collect|score|separation|agent-lines|suspects <outDir> [view] [concurrency]");
const VIEW = (viewArg ?? "text") as "text" | "text_strip";
if (VIEW !== "text" && VIEW !== "text_strip") throw new Error("view: text | text_strip");
const JEV = env("JEV_MODEL", "jev-latest");
const { bundle } = loadBundle("rules", "config/scenes.yaml");
const scene: core.Scene = "comment";
const questions = [...core.rulesFor(bundle, scene).flatMap((r) => [r.question, ...r.exceptions.map((x) => x.question)]), ...(bundle.scenes[scene].injectionGuard ? [bundle.scenes[scene].injectionGuard!.question] : [])];
const keyOf = new Map(questions.map((q) => [q.sha, core.questionKey(q)] as const));
const byKey = new Map(questions.map((q) => [core.questionKey(q), q] as const));
const sha = (t: string | Buffer) => createHash("sha256").update(t).digest("hex").slice(0, 16);
type Item = { id: string; text: string; text_strip: string; group: string; slice: string; source: string; label_bin: number };
// EVAL_SPLIT=val only for choosing settings (e.g. agent-stage thresholds); EVAL_SPLIT=train only for data cleaning
// (finding train items whose label disagrees with a confident judge answer); judges are scored on test (the default).
const PART = process.env.EVAL_SPLIT ?? "test";
if (PART !== "test" && PART !== "val" && PART !== "train") throw new Error("EVAL_SPLIT: test | val | train");
const testIds = new Set(readFileSync("data/eval/split-v1.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; split: string }).filter((r) => r.split === PART).map((r) => r.id));
const items = readFileSync("data/eval/eval20k.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Item).filter((x) => testIds.has(x.id));
mkdirSync(outDir, { recursive: true });
const OUT = join(outDir, `answers-${VIEW}.jsonl`), REQ = join(outDir, `requests-${VIEW}.jsonl`);
type Probs = Record<string, number>;
type Row = { id: string; view: string; textSha: string; rulesVer: string; model: string; layout?: JudgeLayout; ok: boolean; primary?: Record<string, Probs>; copy?: Record<string, Probs>; tries: number };
const readJsonl = <T>(p: string): T[] => existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : [];
const LAYOUT = env("JEV_LAYOUT", "content-first") as JudgeLayout;   // rules-first: rules at the front of the state (an open judge trained on it)
const IN_CALL_CONFIRM = env("JEV_IN_CALL_CONFIRM", "1") !== "0";   // 0: no shuffled-option copies in the request (a kevfast KF_CONFIRM=off judge)
const identity = (it: Item) => `${it.id}|${VIEW}|${sha(it[VIEW])}|${bundle.rulesVer}|${JEV}|${LAYOUT}`;

// calibrated answer records for one row (primary, then the in-call copy confirming it), exactly as the runtime builds them
const recordsOf = (cal: core.Calibrator, r: Row): core.AnswerRecord[] => {
  const rec = (ans: Record<string, Probs>, id: string, confirms: string | null, at: number): core.AnswerRecord[] => Object.entries(ans).flatMap(([key, probs]) => {
    const q = byKey.get(key);
    if (!q) return [];
    const c = cal.apply({ judge: JEV, rulesVer: bundle.rulesVer, scene, nOptions: Object.keys(q.criteria).length, question: key }, probs);
    const top = Object.entries(c?.probs ?? probs).sort((a, b) => b[1] - a[1])[0]![0];
    return [{ judgeCallId: id, questionSha: q.sha, choice: top, p: c ? (c.probs[q.violationOption] ?? 0) : null, evidenceSet: [], inputSha: "eval", model: JEV, calibVer: cal.calibVer, confirmsCallId: confirms, createdAt: at }];
  });
  return [...rec(r.primary!, `p-${r.id}`, null, 1), ...(r.copy ? rec(r.copy, `c-${r.id}`, `p-${r.id}`, 2) : [])];
};
const fastRoute = (cal: core.Calibrator, r: Row): string => {
  const d = decide({ bundle, scene, hasImages: false, answers: recordsOf(cal, r), judgeOk: true });
  return d.state === "pass" ? "auto_pass" : d.state === "block" ? `auto_${d.action}` : d.route === "human" ? "human" : "agent";
};

if (phase === "collect") {
  const models = createModels();
  models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY"), modelId: JEV }));
  const judge = piJudge(models, jevModel(models, JEV), { inCallConfirm: IN_CALL_CONFIRM, timeoutMs: 30_000, layout: LAYOUT });
  const done = new Set(readJsonl<Row>(OUT).filter((r) => r.ok).map((r) => `${r.id}|${r.view}|${r.textSha}|${r.rulesVer}|${r.model}|${r.layout ?? "content-first"}`));
  const todo = items.filter((it) => !done.has(identity(it)));
  const t0 = Date.now();
  let next = 0, ok = 0, failed = 0, requests = 0;
  await Promise.all(Array.from({ length: Number(concArg ?? 16) }, async () => {
    while (next < todo.length) {
      const it = todo[next++]!;
      let res: Awaited<ReturnType<typeof judge.classify>> | undefined, tries = 0;
      for (; tries < 3 && (!res || res.status !== "ok"); tries++) {
        const s = Date.now();
        res = await judge.classify({ contentId: it.id, text: it[VIEW], scene, evidence: [], questions });
        requests++;
        appendFileSync(REQ, JSON.stringify({ id: it.id, view: VIEW, try: tries + 1, status: res.status, latency_ms: Date.now() - s, reported_latency_ms: res.latencyMs, ...(res.status === "ok" ? { input: res.usage.input, output: res.usage.output, model: res.model } : {}) }) + "\n");
      }
      const byK = (a: Record<string, { probs: Probs }>) => Object.fromEntries(Object.entries(a).map(([q, x]) => [keyOf.get(q) ?? q, x.probs]));
      const row: Row = { id: it.id, view: VIEW, textSha: sha(it[VIEW]), rulesVer: bundle.rulesVer, model: JEV, ...(LAYOUT !== "content-first" ? { layout: LAYOUT } : {}), ok: res!.status === "ok", tries,
        ...(res!.status === "ok" ? { primary: byK(res!.answers), ...(res!.variant ? { copy: byK(res!.variant.answers) } : {}) } : {}) };
      if (row.ok) ok++; else failed++;
      appendFileSync(OUT, JSON.stringify(row) + "\n");
    }
  }));
  const manifest = { phase, view: VIEW, gitHead: (() => { try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { return "unknown"; } })(),
    scriptSha: sha(readFileSync("scripts/eval-test.ts")), rulesVer: bundle.rulesVer, judge: JEV, layout: LAYOUT, inCallConfirm: IN_CALL_CONFIRM, split: "split-v1", splitPart: PART, splitManifestSha: sha(readFileSync("eval/split-v1.manifest.jsonl")),
    evalSha: sha(readFileSync("data/eval/eval20k.jsonl")), items: items.length, todo: todo.length, ok, failed, requests, concurrency: Number(concArg ?? 16), retries: "up to 3 tries per item",
    started: new Date(t0).toISOString(), ended: new Date().toISOString(), outputSha: sha(readFileSync(OUT)) };
  writeFileSync(join(outDir, `manifest-collect-${VIEW}-${Date.now()}.json`), JSON.stringify(manifest, null, 1));
  console.log(JSON.stringify(manifest));
} else if (phase === "score") {
  const cal = loadCalibrator(env("CALIB_DIR", "calib"), JEV);
  const rows = new Map(readJsonl<Row>(OUT).filter((r) => r.ok && r.rulesVer === bundle.rulesVer && r.model === JEV).map((r) => [`${r.id}|${r.textSha}`, r] as const));
  const lab = (std: string) => new Map(readJsonl<{ id: string; label: string; source: string }>(`data/eval/labels-${std}.jsonl`).map((r) => [r.id, r] as const));
  const L = { abuse: lab("abuse-v4.3"), marketing: lab("marketing-v2"), guard: lab("guard-v1") };
  const route = (r: Row) => fastRoute(cal, r);
  // platform truth per item: violate if abuse or marketing violate; allow if both allow (and guard not violate); else uncertain/unlabelled
  const platform = (id: string): "violate" | "allow" | "uncertain" | "unlabelled" => {
    const a = L.abuse.get(id)?.label, m = L.marketing.get(id)?.label;
    if (!a || !m) return "unlabelled";
    if (a === "violate" || m === "violate") return "violate";
    if (a === "allow" && m === "allow") return "allow";
    return "uncertain";
  };
  const out: Record<string, Record<string, Record<string, number>>> = { platform: {}, dataset: {} };
  const bump = (set: string, g: string, k: string) => { const t = ((out[set]![g] ??= {})); t[k] = (t[k] ?? 0) + 1; };
  let missing = 0;
  for (const it of items) {
    const r = rows.get(`${it.id}|${sha(it[VIEW])}`);
    if (!r) { missing++; continue; }
    const got = route(r);
    for (const g of [it.group, "ALL"]) {
      const p = platform(it.id);
      bump("platform", g, `${p}:${got}`); bump("platform", g, `${p}:n`);
      const d = it.label_bin === 1 ? "violate" : "allow";
      bump("dataset", g, `${d}:${got}`); bump("dataset", g, `${d}:n`);
    }
  }
  const rate = (t: Record<string, number>, truth: string, k: string) => +(((t[`${truth}:${k}`] ?? 0) / Math.max(1, t[`${truth}:n`] ?? 0)) * 100).toFixed(1);
  const table = (set: "platform" | "dataset") => Object.fromEntries(Object.entries(out[set]!).map(([g, t]) => [g, {
    violate_n: t["violate:n"] ?? 0, allow_n: t["allow:n"] ?? 0, ...(set === "platform" ? { uncertain_n: t["uncertain:n"] ?? 0, unlabelled_n: t["unlabelled:n"] ?? 0 } : {}),
    violate_auto_pass_pct: rate(t, "violate", "auto_pass"), violate_auto_action_pct: +(rate(t, "violate", "auto_takedown") + rate(t, "violate", "auto_limit")).toFixed(1), violate_agent_pct: rate(t, "violate", "agent"),
    allow_auto_pass_pct: rate(t, "allow", "auto_pass"), allow_auto_action_pct: +(rate(t, "allow", "auto_takedown") + rate(t, "allow", "auto_limit")).toFixed(1), allow_agent_pct: rate(t, "allow", "agent"),
  }]));
  const req = readJsonl<{ status: string; latency_ms: number; try: number }>(REQ);
  const lat = req.filter((x) => x.status === "ok").map((x) => x.latency_ms).sort((a, b) => a - b);
  const summary = { view: VIEW, rulesVer: bundle.rulesVer, calibVer: cal.calibVer, items: items.length, scored: items.length - missing, missing,
    requests: { total: req.length, failed: req.filter((x) => x.status !== "ok").length, retries: req.filter((x) => x.try > 1).length, ok_latency_p50_ms: lat[Math.floor(lat.length / 2)] ?? null, ok_latency_p95_ms: lat[Math.floor(lat.length * 0.95)] ?? null },
    platform: table("platform"), dataset: table("dataset") };
  writeFileSync(join(outDir, `score-${VIEW}.json`), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
} else if (phase === "separation") {
  // Threshold-free comparison between judges (raw answers, no calibration): per question, how well p(violate) separates
  // the platform labels ("uncertain" left out), how often the primary and the in-call copy pick the same option, how
  // much mass goes to "unknown", and how many allow items fall under the highest pass line that lets ≤1% of the
  // violate items through. Temperature calibration cannot change the ranking much, so this isolates the judge itself.
  const lab = (std: string) => new Map(readJsonl<{ id: string; label: string }>(`data/eval/labels-${std}.jsonl`).map((r) => [r.id, r.label] as const));
  const truthOf: Record<string, Map<string, string>> = { "ABUSE-001": lab("abuse-v4.3"), "MARKETING-003": lab("marketing-v2"), injection_guard: lab("guard-v1") };
  const rows = new Map(readJsonl<Row>(OUT).filter((r) => r.ok && r.rulesVer === bundle.rulesVer && r.model === JEV).map((r) => [`${r.id}|${r.textSha}`, r] as const));
  const auc = (pos: number[], neg: number[]) => {
    const all = [...pos.map((p) => [p, 1] as const), ...neg.map((p) => [p, 0] as const)].sort((a, b) => a[0] - b[0]);
    let rankSum = 0;
    for (let i = 0; i < all.length;) { let j = i; while (j < all.length && all[j]![0] === all[i]![0]) j++; const r = (i + j + 1) / 2; for (let k = i; k < j; k++) if (all[k]![1] === 1) rankSum += r; i = j; }
    return pos.length && neg.length ? +((rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length)).toFixed(4) : null;
  };
  const passAt1 = (pos: number[], neg: number[]) => {
    const s = [...pos].sort((a, b) => a - b), allowed = Math.floor(s.length * 0.01);
    const line = s[allowed] ?? Infinity; // items strictly below this line pass; at most `allowed` violate items do
    return { line: +line.toFixed(4), allow_passed_pct: +((neg.filter((p) => p < line).length / Math.max(1, neg.length)) * 100).toFixed(1) };
  };
  const out: Record<string, unknown> = {};
  for (const [key, truth] of Object.entries(truthOf)) {
    const q = byKey.get(key);
    if (!q) continue;
    const v = q.violationOption, P = { primary: { pos: [] as number[], neg: [] as number[] }, copy: { pos: [] as number[], neg: [] as number[] }, mean: { pos: [] as number[], neg: [] as number[] } };
    let both = 0, agree = 0, unknownMass = 0, answered = 0;
    for (const it of items) {
      const r = rows.get(`${it.id}|${sha(it[VIEW])}`), a = r?.primary?.[key], c = r?.copy?.[key];
      if (!a) continue;
      answered++; unknownMass += a.unknown ?? 0;
      const top = (x: Probs) => Object.entries(x).sort((m, n) => n[1] - m[1])[0]![0];
      if (c) { both++; if (top(a) === top(c)) agree++; }
      const t = truth.get(it.id);
      if (t !== "violate" && t !== "allow") continue;
      const side = t === "violate" ? "pos" : "neg";
      P.primary[side].push(a[v] ?? 0);
      if (c) { P.copy[side].push(c[v] ?? 0); P.mean[side].push(((a[v] ?? 0) + (c[v] ?? 0)) / 2); }
    }
    out[key] = { violate_n: P.primary.pos.length, allow_n: P.primary.neg.length, auroc_primary: auc(P.primary.pos, P.primary.neg), auroc_copy: auc(P.copy.pos, P.copy.neg), auroc_mean: auc(P.mean.pos, P.mean.neg),
      primary_copy_same_top_pct: +((agree / Math.max(1, both)) * 100).toFixed(1), mean_unknown_mass: +(unknownMass / Math.max(1, answered)).toFixed(3),
      pass_line_at_1pct_miss_primary: passAt1(P.primary.pos, P.primary.neg), pass_line_at_1pct_miss_mean: passAt1(P.mean.pos, P.mean.neg) };
  }
  const summary = { view: VIEW, model: JEV, rulesVer: bundle.rulesVer, items: items.length, answered: [...rows.keys()].length, questions: out };
  writeFileSync(join(outDir, `separation-${VIEW}.json`), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
} else if (phase === "agent-lines") {
  // Temporary agent-stage thresholds (dev plan 2026-10-08 §3.1 problem 1), chosen on the VALIDATION split only.
  // 1) the agent's population: items the fast path sends to the agent with the shipped calibration; a fixed hash order
  //    picks n of them (ids written once, then reused); 2) they need platform labels by the frozen procedure; 3) every
  //    pair of per-rule lines on a grid is replayed through core.allowedActions(stage "agent") on the recorded answers.
  //    Approximation: the item's own fast-path answers stand in for the agent's re-judge (eval items have no thread).
  const N = Number(concArg ?? 200);
  const cal = loadCalibrator(env("CALIB_DIR", "calib"), JEV);
  const rows = new Map(readJsonl<Row>(OUT).filter((r) => r.ok && r.rulesVer === bundle.rulesVer && r.model === JEV).map((r) => [`${r.id}|${r.textSha}`, r] as const));
  const IDS = join(outDir, "agent-lines-ids.txt");
  const routed = items.map((it) => ({ it, r: rows.get(`${it.id}|${sha(it[VIEW])}`) })).filter((x): x is { it: Item; r: Row } => !!x.r);
  const agentPop = routed.filter((x) => fastRoute(cal, x.r) === "agent");
  if (!existsSync(IDS)) writeFileSync(IDS, agentPop.map((x) => x.it.id).sort((a, b) => sha(`agent-lines|${a}`).localeCompare(sha(`agent-lines|${b}`))).slice(0, N).join("\n") + "\n");
  const ids = new Set(readFileSync(IDS, "utf8").split("\n").filter(Boolean));
  const lab = (std: string) => new Map(readJsonl<{ id: string; label: string }>(`data/eval/labels-${std}.jsonl`).map((r) => [r.id, r.label] as const));
  const LA = lab("abuse-v4.3"), LM = lab("marketing-v2");
  const truthOf = (id: string) => { const a = LA.get(id), m = LM.get(id); if (!a || !m) return "unlabelled"; return a === "violate" || m === "violate" ? "violate" : a === "allow" && m === "allow" ? "allow" : "uncertain"; };
  const pool = routed.filter((x) => ids.has(x.it.id)).map((x) => ({ id: x.it.id, group: x.it.group, truth: truthOf(x.it.id), answers: recordsOf(cal, x.r) }));
  const counts = pool.reduce<Record<string, number>>((m, x) => ((m[x.truth] = (m[x.truth] ?? 0) + 1), m), {});
  const scored = pool.filter((x) => x.truth === "violate" || x.truth === "allow");
  const vN = scored.filter((x) => x.truth === "violate").length, aN = scored.length - vN;
  const PASS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45], BLOCK = [0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55];
  const evalLines = (ab: { pass: number; block: number }, mk: { pass: number; block: number }) => {
    const b: core.PolicyBundle = { ...bundle, rules: bundle.rules.map((r) => (r.ruleId === "ABUSE-001" ? { ...r, agentThresholds: ab } : r.ruleId === "MARKETING-003" ? { ...r, agentThresholds: mk } : r)) };
    let passOk = 0, actOk = 0, miss = 0, wrongAct = 0;
    for (const x of scored) {
      const al = core.allowedActions({ bundle: b, scene, hasImages: false, answers: x.answers, stage: "agent" }).allowed;
      const out = al.has("takedown") || al.has("limit") ? "act" : al.has("pass") ? "pass" : "human";
      if (out === "pass") x.truth === "allow" ? passOk++ : miss++;
      if (out === "act") x.truth === "violate" ? actOk++ : wrongAct++;
    }
    return { abuse: ab, marketing: mk, auto_pass_correct: passOk, auto_act_correct: actOk, violate_passed: miss, allow_acted: wrongAct, to_human: scored.length - passOk - actOk - miss - wrongAct };
  };
  const grid: ReturnType<typeof evalLines>[] = [];
  for (const ap of PASS) for (const abk of BLOCK) for (const mp of PASS) for (const mb of BLOCK) grid.push(evalLines({ pass: ap, block: abk }, { pass: mp, block: mb }));
  // bound: errors at most 2% of each class in this sample (temporary bound, not an owner decision)
  const maxMiss = Math.floor(vN * 0.02), maxWrong = Math.floor(aN * 0.02);
  const dist = (g: (typeof grid)[number]) => (g.abuse.pass - 0.1) + (0.9 - g.abuse.block) + (g.marketing.pass - 0.1) + (0.9 - g.marketing.block);
  const ok = grid.filter((g) => g.violate_passed <= maxMiss && g.allow_acted <= maxWrong)
    .sort((x, y) => y.auto_pass_correct + y.auto_act_correct - (x.auto_pass_correct + x.auto_act_correct) || x.violate_passed + x.allow_acted - (y.violate_passed + y.allow_acted) || dist(x) - dist(y));
  const shared = PASS.flatMap((ps) => BLOCK.map((bk) => evalLines({ pass: ps, block: bk }, { pass: ps, block: bk })));
  // why these items left the fast path, and where their calibrated p sits per rule (primary answer)
  const reasons = scored.reduce<Record<string, number>>((m, x) => { const d = decide({ bundle, scene, hasImages: false, answers: x.answers, judgeOk: true }); const k = `${d.state}:${d.reason ?? ""}`; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const bands = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.01];
  const pBands = Object.fromEntries(["ABUSE-001", "MARKETING-003"].map((rid) => {
    const qs = bundle.rules.find((r) => r.ruleId === rid)!.question.sha;
    const h: Record<string, number> = {};
    for (const x of scored) {
      const a = x.answers.find((r) => r.questionSha === qs && r.confirmsCallId === null);
      const k = a?.p == null ? "none" : `${bands.find((b, i) => a.p! < bands[i + 1]!)}-${bands[bands.findIndex((b, i) => a.p! < bands[i + 1]!) + 1]}|${x.truth}`;
      h[k] = (h[k] ?? 0) + 1;
    }
    return [rid, h];
  }));
  const summary = { split: PART, view: VIEW, calibVer: cal.calibVer, rulesVer: bundle.rulesVer, agent_population: agentPop.length, fast_reasons: reasons, p_bands: pBands, picked: ids.size, labels: counts, scored: scored.length, violate_n: vN, allow_n: aN,
    bound: { max_violate_passed: maxMiss, max_allow_acted: maxWrong }, current: evalLines(bundle.rules.find((r) => r.ruleId === "ABUSE-001")!.thresholds, bundle.rules.find((r) => r.ruleId === "MARKETING-003")!.thresholds), chosen: ok[0] ?? null, next_best: ok.slice(1, 6),
    shared_lines: shared.filter((g) => g.abuse.pass <= 0.3 && g.abuse.block >= 0.7) };
  writeFileSync(join(outDir, `agent-lines-${VIEW}.json`), JSON.stringify({ ...summary, grid }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
} else if (phase === "suspects") {
  // Data cleaning (owner 2026-10-09): items whose unified source label (data/eval/source-labels-v1.jsonl) disagrees with
  // a confident judge answer — both the primary and the in-call copy, calibrated as the runtime does — on the fast
  // path's own lines (pass < rule.thresholds.pass, block >= rule.thresholds.block). Where platform labels exist, how
  // well the flag finds items whose source label the frozen procedure contradicts (precision / recall).
  const cal = loadCalibrator(env("CALIB_DIR", "calib"), JEV);
  const rows = new Map(readJsonl<Row>(OUT).filter((r) => r.ok && r.model === JEV).map((r) => [`${r.id}|${r.textSha}`, r] as const));
  const src = new Map(readJsonl<{ id: string; cat: string; basis: string }>("data/eval/source-labels-v1.jsonl").map((r) => [r.id, r] as const));
  const lab = (std: string) => new Map(readJsonl<{ id: string; label: string }>(`data/eval/labels-${std}.jsonl`).map((r) => [r.id, r.label] as const));
  const LA = lab("abuse-v4.3"), LM = lab("marketing-v2");
  const rule = (id: string) => bundle.rules.find((r) => r.ruleId === id)!;
  const A = rule("ABUSE-001"), M = rule("MARKETING-003");
  const both = (recs: core.AnswerRecord[], q: core.Question, f: (p: number) => boolean) => { const g = recs.filter((a) => a.questionSha === q.sha); return g.length > 0 && g.every((a) => a.p !== null && f(a.p)); };
  const flagged: { id: string; basis: string; cat: string; reason: string }[] = [];
  const evalC: Record<string, number> = {};
  const bump = (k: string) => { evalC[k] = (evalC[k] ?? 0) + 1; };
  let answered = 0;
  for (const it of items) {
    const r = rows.get(`${it.id}|${sha(it[VIEW])}`), s = src.get(it.id);
    if (!r || !s) continue;
    answered++;
    const recs = recordsOf(cal, r);
    const hiA = both(recs, A.question, (p) => p >= A.thresholds.block), hiM = both(recs, M.question, (p) => p >= M.thresholds.block);
    const loA = both(recs, A.question, (p) => p < A.thresholds.pass), loM = both(recs, M.question, (p) => p < M.thresholds.pass);
    const reason = s.cat === "SAFE" ? (hiA ? "safe_but_judge_abuse" : hiM ? "safe_but_judge_marketing" : null)
      : s.cat === "ABUSE" ? (loA ? (hiM ? "abuse_but_judge_marketing" : "abuse_but_judge_clear") : null)
      : s.cat === "MARKETING" ? (loM ? (hiA ? "marketing_but_judge_abuse" : "marketing_but_judge_clear") : null) : null;
    if (reason) flagged.push({ id: it.id, basis: s.basis, cat: s.cat, reason });
    // against the platform labels where they exist: does the platform contradict the source label?
    const a = LA.get(it.id), m = LM.get(it.id);
    if (a && m && !(a === "uncertain" || m === "uncertain") && (a === "violate" || a === "allow") && (m === "violate" || m === "allow")) {
      const pc = a === "violate" ? "ABUSE" : m === "violate" ? "MARKETING" : "SAFE";
      const contradicts = !(pc === s.cat || (a === "violate" && m === "violate" && s.cat !== "SAFE"));
      bump(`${reason ? "flagged" : "not_flagged"}:${contradicts ? "platform_contradicts" : "platform_agrees"}`);
    }
  }
  writeFileSync(join(outDir, `suspects-${VIEW}.jsonl`), flagged.map((x) => JSON.stringify(x)).join("\n") + (flagged.length ? "\n" : ""));
  const by = (k: (x: (typeof flagged)[number]) => string) => flagged.reduce<Record<string, number>>((m2, x) => ((m2[k(x)] = (m2[k(x)] ?? 0) + 1), m2), {});
  const tp = evalC["flagged:platform_contradicts"] ?? 0, fp = evalC["flagged:platform_agrees"] ?? 0, fn = evalC["not_flagged:platform_contradicts"] ?? 0;
  console.log(JSON.stringify({ split: PART, view: VIEW, calibVer: cal.calibVer, items: items.length, answered, flagged: flagged.length, by_reason: by((x) => x.reason), by_basis: by((x) => x.basis),
    vs_platform: { ...evalC, precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null, recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null } }, null, 1));
} else {
  throw new Error("phase must be collect | score | separation | agent-lines | suspects");
}
