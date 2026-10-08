// Offline decisions through the production policy entry (dev plan 2026-10-08 §2.3; review finding: score-cold.py
// re-implemented the three-state logic in Python and disagreed with policy.decide on missing confirmations, missing
// exception answers and marketing blocks). Reads judge outputs in the eval-cold.ts format, maps each answer to its
// question BY KEY in the given rules version, and calls policy.decide — uncalibrated (identity), as those runs were.
// Writes one row per item: {i, label, fine, state, action, reason, route, hits}; prints counts only.
// usage: node --experimental-strip-types scripts/decide.ts <eval-cold-output.jsonl> <out.jsonl> [rulesDir=rules] [scenes=config/scenes.yaml]
//   Score a run with the rules version it was recorded under: export that version's rules/ and config/scenes.yaml
//   (e.g. `git archive <commit> rules config/scenes.yaml | tar -x -C /tmp/rules-<commit>`) and pass those paths.
import { readFileSync, writeFileSync } from "node:fs";
import * as core from "../packages/core/src/index.ts";
import { identityCalibrator } from "../packages/judges/src/index.ts";
import { decide, loadBundle } from "../packages/policy/src/index.ts";

const [inPath, outPath, rulesDir = "rules", scenesFile = "config/scenes.yaml"] = process.argv.slice(2);
if (!inPath || !outPath) throw new Error("usage: decide.ts <in.jsonl> <out.jsonl> [rulesDir] [scenes.yaml]");
const { bundle } = loadBundle(rulesDir, scenesFile);
const cal = identityCalibrator();
const scene: core.Scene = "comment";
const qs = [...core.rulesFor(bundle, scene).flatMap((r) => [r.question, ...r.exceptions.map((x) => x.question)]),
  ...(bundle.scenes[scene].injectionGuard ? [bundle.scenes[scene].injectionGuard!.question] : [])];
const byKey = new Map(qs.map((q) => [core.questionKey(q), q] as const));

type Ans = Record<string, { choice: string; p: number }>;
type Row = { i: number; label: number; fine: number | null; status: string; primary?: Ans; copy?: Ans | null };
const rows = new Map<number, Row>();
for (const l of readFileSync(inPath, "utf8").split("\n")) {
  if (!l.trim()) continue;
  const r = JSON.parse(l) as Row;
  if (!rows.has(r.i) || r.status === "ok") rows.set(r.i, r);   // a resumed run may retry a failed row: keep the ok line
}

const unknownKeys = new Map<string, number>();
const out: string[] = [];
const counts: Record<string, number> = {};
for (const r of rows.values()) {
  let d: ReturnType<typeof decide>;
  if (r.status !== "ok" || !r.primary) {
    d = decide({ bundle, scene, hasImages: false, answers: [], judgeOk: false });
  } else {
    const rec = (ans: Ans, id: string, confirms: string | null, at: number): core.AnswerRecord[] => Object.entries(ans).flatMap(([key, a]) => {
      const q = byKey.get(key);
      if (!q) { unknownKeys.set(key, (unknownKeys.get(key) ?? 0) + 1); return []; }
      // eval-cold stored the probability of the violation option; identity calibration passes it through
      const c = cal.apply({ judge: "offline", rulesVer: bundle.rulesVer, scene, nOptions: Object.keys(q.criteria).length, question: key }, { [q.violationOption]: a.p });
      return [{ judgeCallId: id, questionSha: q.sha, choice: a.choice, p: c ? (c.probs[q.violationOption] ?? 0) : null, evidenceSet: [], inputSha: "offline", model: "offline", calibVer: cal.calibVer, confirmsCallId: confirms, createdAt: at }];
    });
    const answers = [...rec(r.primary, `p${r.i}`, null, 1), ...(r.copy ? rec(r.copy, `c${r.i}`, `p${r.i}`, 2) : [])];
    d = decide({ bundle, scene, hasImages: false, answers, judgeOk: true });
  }
  counts[d.state] = (counts[d.state] ?? 0) + 1;
  out.push(JSON.stringify({ i: r.i, label: r.label, fine: r.fine, state: d.state, action: d.action, reason: d.reason, route: d.route ?? null, hits: d.hits }));
}
writeFileSync(outPath, out.join("\n") + "\n");
console.log(JSON.stringify({ rulesVer: bundle.rulesVer, rows: rows.size, states: counts, answer_keys_not_in_this_rules_version: Object.fromEntries(unknownKeys) }));
