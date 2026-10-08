// Does the fitted calibration route content sensibly on data it was not fitted on? (owner decision 2026-10-08: "having
// a calibration file does not mean it is usable; check the routing on independent data"). Reads the rows collected by
// `fit-calib.ts collect` (full probability vectors of the fast path's questions, primary and in-call copy), keeps the
// 20% held out from the fit (same hash rule as fit-calib.ts), calibrates every answer with the given calibration
// directory exactly as the runtime does, and routes it through policy.decide. Compares with identity (no calibration).
// Prints counts only.
// usage: node --experimental-strip-types scripts/calib-routing-check.ts <collect.jsonl> <calibDir> [judge=jev-latest]
import { readFileSync } from "node:fs";
import * as core from "../packages/core/src/index.ts";
import { identityCalibrator, loadCalibrator } from "../packages/judges/src/index.ts";
import { decide, loadBundle } from "../packages/policy/src/index.ts";

const [inPath, calibDir, judge = "jev-latest"] = process.argv.slice(2);
if (!inPath || !calibDir) throw new Error("usage: calib-routing-check.ts <collect.jsonl> <calibDir> [judge]");
const { bundle } = loadBundle("rules", "config/scenes.yaml");
const scene: core.Scene = "comment";
const qs = [...core.rulesFor(bundle, scene).flatMap((r) => [r.question, ...r.exceptions.map((x) => x.question)]), ...(bundle.scenes[scene].injectionGuard ? [bundle.scenes[scene].injectionGuard!.question] : [])];
const byKey = new Map(qs.map((q) => [core.questionKey(q), q] as const));
type Probs = Record<string, number>;
type Row = { id: string; ok: boolean; rulesVer: string; labels: Record<string, number>; primary?: Record<string, Probs>; copy?: Record<string, Probs> };
const hold = (id: string): boolean => parseInt(core.sha256(`calib-holdout:${id}`).slice(0, 8), 16) % 5 === 0;
const rows = readFileSync(inPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row).filter((r) => r.ok && r.rulesVer === bundle.rulesVer && hold(r.id));

function route(cal: core.Calibrator, r: Row) {
  const rec = (ans: Record<string, Probs>, id: string, confirms: string | null, at: number): core.AnswerRecord[] => Object.entries(ans).flatMap(([key, probs]) => {
    const q = byKey.get(key);
    if (!q) return [];
    const c = cal.apply({ judge, rulesVer: bundle.rulesVer, scene, nOptions: Object.keys(q.criteria).length, question: key }, probs);
    const top = Object.entries(c?.probs ?? probs).sort((a, b) => b[1] - a[1])[0]![0];
    return [{ judgeCallId: id, questionSha: q.sha, choice: top, p: c ? (c.probs[q.violationOption] ?? 0) : null, evidenceSet: [], inputSha: "offline", model: judge, calibVer: cal.calibVer, confirmsCallId: confirms, createdAt: at }];
  });
  const answers = [...rec(r.primary!, `p-${r.id}`, null, 1), ...(r.copy ? rec(r.copy, `c-${r.id}`, `p-${r.id}`, 2) : [])];
  return decide({ bundle, scene, hasImages: false, answers, judgeOk: true });
}

const report: Record<string, unknown> = { rulesVer: bundle.rulesVer, heldOut: rows.length };
for (const [name, cal] of [["identity", identityCalibrator()], ["fitted", loadCalibrator(calibDir, judge)]] as const) {
  // groups by the platform labels: any rule violation; no violation on every labelled rule; injection
  const g: Record<string, Record<string, number>> = {};
  const bump = (grp: string, k: string) => { (g[grp] ??= {})[k] = (g[grp]![k] ?? 0) + 1; };
  for (const r of rows) {
    const d = route(cal, r);
    const k = d.state === "pass" ? "auto_pass" : d.state === "block" ? `auto_${d.action}` : d.route === "human" ? `human:${d.reason.split(":")[0]}` : `agent:${d.reason.split(":")[0]}`;
    const v = (q: string) => r.labels[q];
    const grp = v("injection_guard") === 1 ? "injection" : v("ABUSE-001") === 1 ? "abuse" : v("MARKETING-003") === 1 ? "marketing" : Object.values(r.labels).every((x) => x === 0) ? "no_violation" : "other";
    bump(grp, k); bump(grp, "n");
  }
  report[name] = { calibVer: cal.calibVer, ...g };
}
console.log(JSON.stringify(report, null, 1));
