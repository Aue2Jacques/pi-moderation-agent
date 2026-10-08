// CI gate (round-9 item 9): every contract_tests ref in rules/ must be registered in fixtures/refs.yaml, its sentence must
// resolve, and every REQUIRED ref must have a recorded fixture that is not stale. Exit 1 on any violation.
// usage: node --experimental-strip-types scripts/fixtures-check.ts
import { loadBundle } from "../packages/policy/src/index.ts";
import { loadRefs, readFixture, sentence, staleReasons } from "./lib/contract-fixtures.ts";

const { bundle, contractTests } = loadBundle("rules", "config/scenes.yaml");
const refs = loadRefs();
const problems: string[] = [];
let checked = 0;
for (const [ruleId, tests] of Object.entries(contractTests)) {
  for (const t of tests) {
    const e = refs[t.ref];
    if (!e) { problems.push(`${ruleId}/${t.id}: ref ${t.ref} not in fixtures/refs.yaml`); continue; }
    if ((t.required ?? true) !== e.required) problems.push(`${ruleId}/${t.id}: required=${t.required ?? true} in rule but ${e.required} in refs.yaml`);
    try { sentence(e); } catch (err) { problems.push(`${ruleId}/${t.id}: ${(err as Error).message}`); continue; }
    const f = readFixture(t.ref);
    if (!f) { if (e.required) problems.push(`${ruleId}/${t.id}: required fixture ${t.ref} missing`); continue; }
    const stale = staleReasons(f, e, bundle);
    if (stale.length && e.required) problems.push(`${ruleId}/${t.id}: fixture ${t.ref} stale: ${stale.join("; ")}`);
    checked++;
  }
}
console.log(JSON.stringify({ fixtures_checked: checked, problems }, null, 1));
if (problems.length) process.exit(1);
