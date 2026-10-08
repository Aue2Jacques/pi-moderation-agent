#!/bin/bash
# Repeat the SIGKILL crash matrix (test/harness/crash.test.ts) N times and count passes / failures per crash point
# (stage-1 known gap: "each crash point ran once; the >= 20-run matrix was not done"). Writes data/crash-matrix/.
# usage: bash scripts/crash-matrix.sh [N=20]
set -u
cd "$(dirname "$0")/.."
N=${1:-20}
OUT=data/crash-matrix
mkdir -p "$OUT"
for i in $(seq 1 "$N"); do
  npx vitest run test/harness/crash.test.ts --reporter=json --outputFile="$OUT/run-$i.json" > /dev/null 2>&1
  echo "run $i exit $?"
done
node -e '
const fs=require("fs");const dir=process.argv[1];const n=Number(process.argv[2]);const by={};let runs=0;
for(let i=1;i<=n;i++){const f=`${dir}/run-${i}.json`;if(!fs.existsSync(f))continue;runs++;const r=JSON.parse(fs.readFileSync(f,"utf8"));
 for(const file of r.testResults)for(const t of file.assertionResults){const k=t.title.slice(0,70);(by[k]??={passed:0,failed:0})[t.status==="passed"?"passed":"failed"]++}}
console.log(JSON.stringify({runs,points:by},null,1));' "$OUT" "$N" | tee "$OUT/summary.json"
