// Contract-test runner over recorded answers (docs §12.4). Reports planned/executed/passed/skipped/failed;
// a missing *required* fixture is a failure, a missing optional fixture is a skip.
import type { AnswerRecord, PolicyBundle, Scene } from "@mod/core";
import { decide } from "./engine.ts";
import type { ContractTestYaml } from "./rules.ts";

export type Recorded = { scene: Scene; hasImages: boolean; answers: AnswerRecord[]; judgeOk: boolean };
export type ContractReport = { planned: number; executed: number; passed: number; skipped: string[]; failed: { id: string; expected: string; got: string }[] };

const expectedState = (e: ContractTestYaml["expect"]): "pass" | "block" | "suspicious" => (e === "violate" ? "block" : e === "pass" ? "pass" : "suspicious");

export function runContract(bundle: PolicyBundle, tests: Record<string, ContractTestYaml[]>, recorded: (ref: string) => Recorded | undefined): ContractReport {
  const report: ContractReport = { planned: 0, executed: 0, passed: 0, skipped: [], failed: [] };
  for (const [ruleId, list] of Object.entries(tests)) {
    for (const t of list) {
      report.planned++;
      const rec = recorded(t.ref);
      if (!rec) {
        if (t.required ?? true) report.failed.push({ id: `${ruleId}/${t.id}`, expected: expectedState(t.expect), got: "fixture_missing" });
        else report.skipped.push(`${ruleId}/${t.id}`);
        continue;
      }
      report.executed++;
      const d = decide({ bundle, scene: rec.scene, hasImages: rec.hasImages, answers: rec.answers, judgeOk: rec.judgeOk });
      if (d.state === expectedState(t.expect)) report.passed++;
      else report.failed.push({ id: `${ruleId}/${t.id}`, expected: expectedState(t.expect), got: d.state });
    }
  }
  return report;
}

export const contractPassed = (r: ContractReport): boolean => r.failed.length === 0 && r.passed === r.executed;
