// Stage ③ rule release (dev plan 2026-10-08 §5): minimal shadow check, gate record, calibration carry-over, limited
// rollout and rollback for a candidate rules version. The gateway serves the candidate only with a passed gate run for
// its exact config and only inside its rollout percentage (packages/gateway/src/gateway.ts Candidate).
//   shadow <candRulesDir> <candScenes> <collect.jsonl> [maxFlipPct=5]
//       classify every rule change (threshold_only / semantic / none). Threshold-only changes are replayed offline: the
//       recorded fast-path answers (fit-calib collect rows: full probabilities, primary + in-call copy) are decided under
//       the stable and the candidate bundle with the same calibration; flips are counted. A semantic change cannot be
//       replayed from old answers (insufficient) and fails the shadow: it needs a re-judge and a refit first.
//       Passes when nothing is insufficient and flips <= maxFlipPct. Writes data/release/shadow-<candidate>.json.
//   calib-carry <calibDir> <candRulesDir> <candScenes> [judge=jev-latest]
//       threshold-only: the questions are unchanged, so each stable calibration file is copied with the candidate's
//       rules_ver (file comment-<key>.<rulesVer>.json); semantic rules are not carried (they need a refit)
//   gate <app.db> <shadow.json> <calibDir> <agentModel> [judge=jev-latest]
//       record a gate run for the candidate's exact config, passed = the shadow's verdict
//   rollout <app.db> <candidateRulesVer> <pct>      set the rollout percentage (0 = rollback)
// usage: node --experimental-strip-types scripts/rules-release.ts <phase> ...
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "../packages/core/src/index.ts";
import { loadCalibrator } from "../packages/judges/src/index.ts";
import { classifyChange, decide, isInsufficient, loadBundle } from "../packages/policy/src/index.ts";

const [phase, ...a] = process.argv.slice(2);
const stable = loadBundle("rules", "config/scenes.yaml").bundle;
const pricesVer = `prices@${core.sha256(readFileSync("config/prices.yaml", "utf8")).slice(0, 12)}`;

if (phase === "shadow") {
  const [candRules, candScenes, collect, maxFlip = "5"] = a;
  if (!candRules || !candScenes || !collect) throw new Error("usage: shadow <candRulesDir> <candScenes> <collect.jsonl> [maxFlipPct]");
  const cand = loadBundle(candRules, candScenes).bundle;
  const changes = cand.rules.map((r) => {
    const old = stable.rules.find((x) => x.ruleId === r.ruleId);
    return { rule: r.ruleId, change: old ? classifyChange(old, r) : "semantic" as const };
  });
  // what the recorded answers contain: the stable bundle's question shas
  const recorded = new Set(core.rulesFor(stable, "comment").flatMap((r) => [r.question.sha, ...r.exceptions.map((x) => x.question.sha)]));
  const insufficient = core.rulesFor(cand, "comment").filter((r) => isInsufficient(r, recorded)).map((r) => r.ruleId);
  const cal = loadCalibrator(process.env.CALIB_DIR ?? "calib", process.env.JEV_MODEL ?? "jev-latest");
  type Row = { id: string; ok: boolean; rulesVer: string; primary?: Record<string, Record<string, number>>; copy?: Record<string, Record<string, number>> };
  const rows = readFileSync(collect, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row).filter((r) => r.ok && r.rulesVer === stable.rulesVer && r.primary);
  const decideUnder = (b: core.PolicyBundle, r: Row) => {
    const qs = [...core.rulesFor(b, "comment").flatMap((x) => [x.question, ...x.exceptions.map((e) => e.question)]), ...(b.scenes.comment.injectionGuard ? [b.scenes.comment.injectionGuard.question] : [])];
    const byKey = new Map(qs.map((q) => [core.questionKey(q), q] as const));
    const rec = (ans: Record<string, Record<string, number>>, id: string, confirms: string | null, at: number): core.AnswerRecord[] => Object.entries(ans).flatMap(([key, probs]) => {
      const q = byKey.get(key);
      if (!q) return [];
      // the candidate asks the same questions (threshold-only): calibrate with the stable version's buckets
      const c = cal.apply({ judge: process.env.JEV_MODEL ?? "jev-latest", rulesVer: stable.rulesVer, scene: "comment", nOptions: Object.keys(q.criteria).length, question: key }, probs);
      const top = Object.entries(c?.probs ?? probs).sort((x, y) => y[1] - x[1])[0]![0];
      return [{ judgeCallId: id, questionSha: q.sha, choice: top, p: c ? (c.probs[q.violationOption] ?? 0) : null, evidenceSet: [], inputSha: "shadow", model: "shadow", calibVer: cal.calibVer, confirmsCallId: confirms, createdAt: at }];
    });
    const d = decide({ bundle: b, scene: "comment", hasImages: false, answers: [...rec(r.primary!, `p-${r.id}`, null, 1), ...(r.copy ? rec(r.copy, `c-${r.id}`, `p-${r.id}`, 2) : [])], judgeOk: true });
    return d.state === "block" ? `block:${d.action}` : d.state === "suspicious" ? `suspicious:${d.route}` : d.state;
  };
  const flips: Record<string, number> = {};
  let flipped = 0;
  for (const r of rows) {
    const s = decideUnder(stable, r), c = decideUnder(cand, r);
    if (s !== c) { flipped++; flips[`${s} -> ${c}`] = (flips[`${s} -> ${c}`] ?? 0) + 1; }
  }
  const semantic = changes.filter((c) => c.change === "semantic").map((c) => c.rule);
  const flipPct = (100 * flipped) / Math.max(1, rows.length);
  const passed = insufficient.length === 0 && semantic.length === 0 && flipPct <= Number(maxFlip);
  const report = { stable: stable.rulesVer, candidate: cand.rulesVer, changes, insufficient, semantic, rows: rows.length, flipped, flipPct: +flipPct.toFixed(2), maxFlipPct: Number(maxFlip), flips, calibVer: cal.calibVer, passed,
    note: semantic.length ? "semantic change: old answers cannot replay it; re-judge a sample and refit calibration before a gate can pass" : undefined };
  mkdirSync("data/release", { recursive: true });
  writeFileSync(`data/release/shadow-${cand.rulesVer.replace(/[^\w.-]/g, "_")}.json`, JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
} else if (phase === "calib-carry") {
  const [calibDir, candRules, candScenes, judge = "jev-latest"] = a;
  if (!calibDir || !candRules || !candScenes) throw new Error("usage: calib-carry <calibDir> <candRulesDir> <candScenes> [judge]");
  const cand = loadBundle(candRules, candScenes).bundle;
  const dir = join(calibDir, judge);
  const thresholdOnly = new Set(cand.rules.filter((r) => { const o = stable.rules.find((x) => x.ruleId === r.ruleId); return o && classifyChange(o, r) !== "semantic"; }).map((r) => r.ruleId));
  const carried: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as { bucket: { rules_ver: string; question: string } };
    if (c.bucket.rules_ver !== stable.rulesVer) continue;
    const ruleOf = c.bucket.question.split(".")[0]!;
    // rule questions follow their rule; scene questions (injection guard, image check) carry when the scenes' questions are unchanged
    const sceneQ = !stable.rules.some((r) => r.ruleId === ruleOf);
    if (!sceneQ && !thresholdOnly.has(ruleOf)) continue;
    const out = join(dir, f.replace(/\.json$/, `.${cand.rulesVer.replace(/[^\w.-]/g, "_")}.json`));
    if (existsSync(out)) continue;
    writeFileSync(out, JSON.stringify({ ...c, bucket: { ...c.bucket, rules_ver: cand.rulesVer }, carried_from: stable.rulesVer, carried_at: Date.now() }, null, 1) + "\n");
    carried.push(out);
  }
  console.log(JSON.stringify({ candidate: cand.rulesVer, carried, calibVer: loadCalibrator(calibDir, judge).calibVer }));
} else if (phase === "gate") {
  const [dbPath, shadowPath, calibDir, agentModel, judge = "jev-latest"] = a;
  if (!dbPath || !shadowPath || !calibDir || !agentModel) throw new Error("usage: gate <app.db> <shadow.json> <calibDir> <agentModel> [judge]");
  const shadow = JSON.parse(readFileSync(shadowPath, "utf8")) as { candidate: string; passed: boolean };
  const db = core.openAppDb(dbPath, "tool");
  core.ensureSchema(db);
  const cfg: core.GateConfig = { rulesVer: shadow.candidate, calibVer: loadCalibrator(calibDir, judge).calibVer, judgeModel: judge, agentModel, pricesVer };
  core.recordGateRun(db, `gate:${core.configSha(cfg).slice(0, 16)}:${Date.now()}`, cfg, shadow.passed, shadow, Date.now());
  console.log(JSON.stringify({ gate: cfg, passed: shadow.passed, allows: core.gateAllows(db, cfg) }));
} else if (phase === "rollout") {
  const [dbPath, ver, pct] = a;
  if (!dbPath || !ver || pct === undefined) throw new Error("usage: rollout <app.db> <candidateRulesVer> <pct>");
  const db = core.openAppDb(dbPath, "tool");
  core.ensureSchema(db);
  core.setRollout(db, "rules", ver, core.sha256(ver).slice(0, 16), Number(pct), Date.now());
  console.log(JSON.stringify({ version: ver, rollout_pct: core.rolloutPct(db, "rules", ver) }));
} else {
  throw new Error("phase: shadow | calib-carry | gate | rollout");
}
