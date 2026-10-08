// Contract-test runner entry for CI (dev-doc §12.4, round-9 item 9). Replaces the placeholder contract.mjs.
// Evaluates each rule's contract_tests through the real policy engine on recorded real-judge answers.
// Calibration: if calib files exist for the fixture's judge, answers are calibrated through them (strict); otherwise the
// report says so and evaluates raw recorded probabilities (identity) — this checks rule/threshold/exception logic only.
// Exit 1 when any required test fails or a required fixture is missing/stale.
// usage: node --experimental-strip-types scripts/contract.ts
import * as core from "../packages/core/src/index.ts";
import { identityCalibrator, loadCalibrator } from "../packages/judges/src/index.ts";
import { contractPassed, loadBundle, runContract, type Recorded } from "../packages/policy/src/index.ts";
import { loadRefs, readFixture, sceneQuestions, staleReasons, type FixtureAnswers } from "./lib/contract-fixtures.ts";

const { bundle, contractTests } = loadBundle("rules", "config/scenes.yaml");
const refs = loadRefs();
const calibDir = process.env["CALIB_DIR"] ?? "calib";
const stale: Record<string, string[]> = {};
const calibUsed = new Set<string>();

function recorded(ref: string): Recorded | undefined {
  const e = refs[ref];
  const f = readFixture(ref);
  if (!e || !f) return undefined;
  const why = staleReasons(f, e, bundle);
  if (why.length) { stale[ref] = why; return undefined; }
  let cal = loadCalibrator(calibDir, f.judge.model);
  if (cal.calibVer === "calib@none") cal = identityCalibrator();
  calibUsed.add(`${f.judge.model}:${cal.calibVer}`);
  const qs = sceneQuestions(bundle, e.scene);
  const toRecords = (id: string, answers: FixtureAnswers, confirms: string | null, at: number): core.AnswerRecord[] => qs.flatMap((q) => {
    const a = answers[q.sha];
    if (!a) return [];
    const c = cal.apply({ judge: f.judge.model, rulesVer: bundle.rulesVer, scene: e.scene, nOptions: Object.keys(q.criteria).length, question: core.questionKey(q) }, a.probs);
    return [{ judgeCallId: id, questionSha: q.sha, choice: a.choice, p: c ? (c.probs[q.violationOption] ?? 0) : null, evidenceSet: [], inputSha: f.text_sha, model: f.judge.model, calibVer: cal.calibVer, confirmsCallId: confirms, createdAt: at }];
  });
  const answers = [...toRecords("p", f.primary, null, 1), ...(f.variant ? toRecords("v", f.variant.answers, "p", 2) : [])];
  return { scene: e.scene, hasImages: false, judgeOk: true, answers };
}

const report = runContract(bundle, contractTests, recorded);
const staleRequired = Object.keys(stale).filter((r) => refs[r]?.required);
// a stale optional fixture is reported as skipped, a stale required one as failed (runContract already counted it as fixture_missing)
const out = {
  rules_ver: bundle.rulesVer,
  calibration: [...calibUsed].map((s) => (s.endsWith("calib@identity") ? `${s} (no fitted calib files: raw recorded probabilities; checks rule/threshold/exception logic only)` : s)),
  ...report, stale, passed_all: contractPassed(report) && staleRequired.length === 0,
};
console.log(JSON.stringify(out, null, 1));
// optional tests that ran and failed are reported but do not fail CI; required ones do
const requiredFailed = report.failed.filter((f) => {
  const [ruleId, id] = f.id.split("/");
  const t = contractTests[ruleId!]?.find((x) => x.id === id);
  return t?.required ?? true;
});
if (requiredFailed.length || staleRequired.length) process.exit(1);
