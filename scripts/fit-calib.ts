// Fit per-question temperature calibration for the fast-path judge from public labels (dev plan 2026-10-08 §2.2/§3;
// owner decision 2026-10-07: calibrate with public datasets' own labels). Two phases, prints numbers only:
//   collect <in.jsonl> <out.jsonl> [concurrency=32]
//       in rows: {id, text, labels: {"<question key>": 0|1, ...}}; asks the judge exactly what the fast path asks (every
//       comment-scene question, in-call confirmation copy) and stores the full probability vectors (no text). Resumable;
//       a row recorded under another rules version or judge model is not reused.
//   fit <out.jsonl> [calibDir=calib]
//       per question: rows with a label for it, split 80/20 by a hash of the id; fit T on 80% (primary and copy answers
//       as samples), report NLL and ECE before/after on the held-out 20%, write <calibDir>/<judge>/comment-<key>.json.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import * as core from "../packages/core/src/index.ts";
import { applyTemperature, ece, fitTemperature, jevModel, jevProvider, type JudgeLayout, type Sample } from "../packages/judges/src/index.ts";
import { loadBundle } from "../packages/policy/src/index.ts";
import { piJudge } from "../packages/worker/src/pi-judge.ts";
import { sceneQuestions } from "./lib/contract-fixtures.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const { bundle } = loadBundle("rules", "config/scenes.yaml");
const questions = sceneQuestions(bundle, "comment");
const keyOf = new Map(questions.map((q) => [q.sha, core.questionKey(q)] as const));
const modelId = env("JEV_MODEL", "jev-latest");
const layout = env("JEV_LAYOUT", "content-first") as JudgeLayout;   // see eval-test.ts
const inCallConfirm = env("JEV_IN_CALL_CONFIRM", "1") !== "0";       // see eval-test.ts
const sameRun = (r: Out) => r.rulesVer === bundle.rulesVer && r.model === modelId && (r.layout ?? "content-first") === layout;
type Probs = Record<string, number>;
type Out = { id: string; rulesVer: string; model: string; layout?: JudgeLayout; ok: boolean; labels?: Record<string, number>; primary?: Record<string, Probs>; copy?: Record<string, Probs> };
const readJsonl = <T>(p: string): T[] => existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : [];

const [phase, a1, a2, a3] = process.argv.slice(2);
if (phase === "collect") {
  const [inPath, outPath, conc] = [a1!, a2!, Number(a3 ?? 32)];
  const models = createModels();
  models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY"), modelId }));
  const judge = piJudge(models, jevModel(models, modelId), { inCallConfirm, timeoutMs: 30_000, layout });
  const done = new Set(readJsonl<Out>(outPath).filter((r) => r.ok && sameRun(r)).map((r) => r.id));
  const rows = readJsonl<{ id: string; text: string; labels: Record<string, number> }>(inPath).filter((r) => !done.has(r.id));
  let next = 0, ok = 0, failed = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: conc }, async () => {
    while (next < rows.length) {
      const r = rows[next++]!;
      let res = await judge.classify({ contentId: r.id, text: r.text, scene: "comment", evidence: [], questions });
      for (let a = 0; a < 2 && res.status !== "ok"; a++) res = await judge.classify({ contentId: r.id, text: r.text, scene: "comment", evidence: [], questions });
      const byKey = (ans: Record<string, { probs: Probs }>) => Object.fromEntries(Object.entries(ans).map(([sha, x]) => [keyOf.get(sha) ?? sha, x.probs]));
      const row: Out = res.status === "ok"
        ? { id: r.id, rulesVer: bundle.rulesVer, model: modelId, ...(layout !== "content-first" ? { layout } : {}), ok: true, labels: r.labels, primary: byKey(res.answers), ...(res.variant ? { copy: byKey(res.variant.answers) } : {}) }
        : { id: r.id, rulesVer: bundle.rulesVer, model: modelId, ...(layout !== "content-first" ? { layout } : {}), ok: false };
      if (row.ok) ok++; else failed++;
      appendFileSync(outPath, JSON.stringify(row) + "\n");
    }
  }));
  console.log(JSON.stringify({ phase, rulesVer: bundle.rulesVer, ran: rows.length, ok, failed, wall_s: Math.round((Date.now() - t0) / 1000) }));
} else if (phase === "fit") {
  const [outPath, calibDir] = [a1!, a2 ?? "calib"];
  const rows = readJsonl<Out>(outPath).filter((r) => r.ok && sameRun(r));
  const hold = (id: string): boolean => parseInt(core.sha256(`calib-holdout:${id}`).slice(0, 8), 16) % 5 === 0;   // 20% held out
  mkdirSync(join(calibDir, modelId), { recursive: true });
  const report: Record<string, unknown> = { rulesVer: bundle.rulesVer, rows: rows.length };
  for (const q of questions) {
    const key = core.questionKey(q);
    const none = q.passChoices[0] ?? "none";
    const samplesOf = (rs: Out[]): Sample[] => rs.flatMap((r) => {
      const lab = r.labels?.[key];
      if (lab !== 0 && lab !== 1) return [];
      const label = lab === 1 ? q.violationOption : none;
      return [r.primary?.[key], r.copy?.[key]].filter((p): p is Probs => !!p).map((probs) => ({ probs, label }));
    });
    const fitS = samplesOf(rows.filter((r) => !hold(r.id)));
    const testS = samplesOf(rows.filter((r) => hold(r.id)));
    if (fitS.length < 100) { report[key] = { skipped: `only ${fitS.length} labelled samples` }; continue; }
    const f = fitTemperature(fitS);
    const nll = (ss: Sample[], T: number) => ss.reduce((a, x) => a - Math.log(Math.max(applyTemperature(x.probs, T)[x.label] ?? 1e-12, 1e-12)), 0) / ss.length;
    const heldOut = { n: testS.length, nll_before: nll(testS, 1), nll_after: nll(testS, f.T), ece_before: ece(testS), ece_after: ece(testS.map((x) => ({ ...x, probs: applyTemperature(x.probs, f.T) }))) };
    const file = { T: f.T, n: fitS.length, ece_before: heldOut.ece_before, ece_after: heldOut.ece_after, fitted_at: Date.now(),
      bucket: { judge: modelId, rules_ver: bundle.rulesVer, scene: "comment", n_options: Object.keys(q.criteria).length, question: key },
      source: "scripts/fit-calib.ts; ece_* on the 20% held out", held_out: heldOut };
    writeFileSync(join(calibDir, modelId, `comment-${key}.json`), JSON.stringify(file, null, 1) + "\n");
    report[key] = { T: f.T, fit_samples: fitS.length, held_out: heldOut };
  }
  console.log(JSON.stringify(report, null, 1));
} else {
  throw new Error("phase must be collect | fit");
}
