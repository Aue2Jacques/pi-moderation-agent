#!/bin/bash
# Open judge on the GPU server, same procedure as Jev (dev plan §6: judges are scored on the test set only):
#   1) the fast path's questions on the 1,884 dev rows with platform labels (fit-calib collect), 2) fit its own
#   temperature per question, 3) the test split in the main view and the full-strip control (eval-test collect),
#   4) score with its own calibration through policy.decide. The judge is a local server speaking Jev's
#   /v1/systemone protocol (laya-serve, kev.serve), so the same scripts run unchanged.
# usage: bash scripts/gpu/run-judge.sh <port> <model id sent in requests>   (run from the repo root on the server)
set -euo pipefail
PORT=$1; MODEL=$2
. /etc/profile.d/mirrors.sh
export JEV_BASE_URL=http://127.0.0.1:$PORT/v1 JEV_API_KEY=local JEV_MODEL=$MODEL
N="node --experimental-strip-types --no-warnings"
mkdir -p data/calib data/eval/test-v1-$MODEL
$N scripts/fit-calib.ts collect data/calib/platform-input.jsonl data/calib/$MODEL-collect.jsonl 16
$N scripts/fit-calib.ts fit data/calib/$MODEL-collect.jsonl data/calib/fitted-$MODEL
for v in text text_strip; do $N scripts/eval-test.ts collect data/eval/test-v1-$MODEL $v 16; done
for v in text text_strip; do CALIB_DIR=data/calib/fitted-$MODEL $N scripts/eval-test.ts score data/eval/test-v1-$MODEL $v > data/eval/test-v1-$MODEL/score-$v.out; done
CALIB_DIR=data/calib/fitted-$MODEL $N scripts/calib-routing-check.ts data/calib/$MODEL-collect.jsonl data/calib/fitted-$MODEL $MODEL > data/eval/test-v1-$MODEL/routing-check.out
echo "RUN_JUDGE_DONE $MODEL"
