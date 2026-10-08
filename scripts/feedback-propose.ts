// Stage ③ feedback loop (dev plan 2026-10-08 §5): human rulings -> threshold proposal -> approve / reject. A proposal
// never changes the live config: it is written as a candidate rules directory and recorded as "proposed"; an approved
// one goes through scripts/rules-release.ts (shadow -> calibration carry -> gate -> rollout) like any other release.
//   propose <app.db> [minN=10] [target=0.95]
//       pairs = every human ruling whose review has judge answers: per rule, the machine's calibrated violation
//       probability on the review's last evidence set (mean of primary and copy), and whether the human found that rule
//       violated (action other than pass, rule cited). proposeThresholds() per rule; writes data/feedback/<id>/rules
//       when something moves, and records the proposal. Prints counts only.
//   decide <app.db> <proposalId> approve|reject <who> <reason>
// usage: node --experimental-strip-types scripts/feedback-propose.ts <phase> ...
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import * as core from "../packages/core/src/index.ts";
import { loadBundle } from "../packages/policy/src/index.ts";

const [phase, dbPath, ...a] = process.argv.slice(2);
if (!phase || !dbPath) throw new Error("usage: feedback-propose.ts propose <app.db> [minN] [target] | decide <app.db> <id> approve|reject <who> <reason>");
const db = core.openAppDb(dbPath, "tool");
core.ensureSchema(db);

if (phase === "propose") {
  const [minN = "10", target = "0.95"] = a;
  const live = loadBundle("rules", "config/scenes.yaml");
  const rulings = db.prepare("SELECT r.review_id, r.content_id, r.action, r.rule_ids FROM ruling r WHERE r.actor='human'").all() as { review_id: string; content_id: string; action: string; rule_ids: string }[];
  const pairs: core.FeedbackPair[] = [];
  let noAnswers = 0;
  for (const ru of rulings) {
    // the human ruled on this review; the machine's view is the judge answers of the same content (fast path + agent)
    const reviews = db.prepare("SELECT * FROM review WHERE content_id=? ORDER BY seq").all(ru.content_id) as core.ReviewRow[];
    let used = false;
    for (const rv of [...reviews].reverse()) {
      const calls = db.prepare("SELECT judge_call_id, evidence_set FROM judge_call WHERE review_id=? AND status='ok' ORDER BY created_at").all(rv.review_id) as { judge_call_id: string; evidence_set: string }[];
      if (!calls.length) continue;
      const stored = core.loadStoredBundle(db, rv.rules_ver);
      if (!stored) continue;
      const bundle = stored.bundle as core.PolicyBundle;
      const lastSet = calls[calls.length - 1]!.evidence_set;
      let answers: core.AnswerRecord[];
      try { answers = core.trustedAnswers(db, rv, bundle, calls.filter((c) => c.evidence_set === lastSet).map((c) => c.judge_call_id), rv.evidence_ver).answers; } catch { continue; }
      const cited = JSON.parse(ru.rule_ids) as string[];
      for (const rule of core.rulesFor(bundle, core.readContent(db, ru.content_id)!.scene as core.Scene)) {
        const ps = answers.filter((x) => x.questionSha === rule.question.sha && x.p !== null).map((x) => x.p!);
        if (!ps.length) continue;
        pairs.push({ ruleId: rule.ruleId, p: ps.reduce((s, x) => s + x, 0) / ps.length, violate: ru.action !== "pass" && cited.includes(rule.ruleId) });
      }
      used = true;
      break;
    }
    if (!used) noAnswers++;
  }
  const current = Object.fromEntries(live.bundle.rules.map((r) => [r.ruleId, { ...r.thresholds }]));
  const proposals = core.proposeThresholds(pairs, current, { minN: Number(minN), target: Number(target) });
  const perRule = Object.fromEntries(live.bundle.rules.map((r) => { const ps = pairs.filter((x) => x.ruleId === r.ruleId); return [r.ruleId, { n: ps.length, violate: ps.filter((x) => x.violate).length }]; }));
  let id: string | null = null, dir: string | null = null;
  if (proposals.length) {
    id = core.recordProposal(db, live.bundle.rulesVer, proposals, null, Date.now());
    dir = join("data/feedback", id, "rules");
    mkdirSync(dir, { recursive: true });
    cpSync("rules", dir, { recursive: true });
    for (const p of proposals) {
      const f = join(dir, `${p.ruleId}.yaml`);
      const y = parse(readFileSync(f, "utf8")) as { thresholds: { block: number; pass: number } };
      y.thresholds = { ...y.thresholds, ...p.to };
      writeFileSync(f, stringify(y));
    }
    db.prepare("UPDATE feedback_proposal SET candidate_dir=? WHERE proposal_id=?").run(dir, id);
  }
  console.log(JSON.stringify({ humanRulings: rulings.length, withoutJudgeAnswers: noAnswers, pairs: pairs.length, perRule, minN: Number(minN), target: Number(target), proposals, proposalId: id, candidateDir: dir,
    next: id ? `node --experimental-strip-types scripts/rules-release.ts shadow ${dir} config/scenes.yaml <collect.jsonl>` : "nothing to propose" }, null, 1));
} else if (phase === "decide") {
  const [id, decision, who, ...reason] = a;
  if (!id || (decision !== "approve" && decision !== "reject") || !who) throw new Error("usage: decide <app.db> <id> approve|reject <who> <reason>");
  core.decideProposal(db, id, decision === "approve" ? "approved" : "rejected", who, reason.join(" "), Date.now());
  console.log(JSON.stringify(db.prepare("SELECT proposal_id, status, decided_by, decision_reason FROM feedback_proposal WHERE proposal_id=?").get(id)));
} else {
  throw new Error("phase must be propose | decide");
}
