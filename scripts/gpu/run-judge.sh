#!/bin/bash
# Open judge on the GPU server, same procedure as Jev (dev plan §6: judges are scored on the test set only):
#   1) the fast path's questions on the 1,884 dev rows with platform labels (fit-calib collect), 2) fit its own
#   temperature per question, 3) the test split in the main view and the full-strip control (eval-test collect),
#   4) score with its own calibration through policy.decide, 5) the threshold-free separation on the raw answers. The judge is a local server speaking Jev's
#   /v1/systemone protocol (laya-serve, kev.serve), so the same scripts run unchanged.
# usage: bash scripts/gpu/run-judge.sh <port> <model id sent in requests> [tag for file names, default = model id]
#   (run from the repo root on the server; kev.serve answers to kev-latest whatever size it serves, hence the tag)
set -euo pipefail
PORT=$1; MODEL=$2; TAG=${3:-$2}
. /etc/profile.d/mirrors.sh
export JEV_BASE_URL=http://127.0.0.1:$PORT/v1 JEV_API_KEY=local JEV_MODEL=$MODEL
N="node --experimental-strip-types --no-warnings"
mkdir -p data/calib data/eval/test-v1-$TAG
$N scripts/fit-calib.ts collect data/calib/platform-input.jsonl data/calib/$TAG-collect.jsonl 16
$N scripts/fit-calib.ts fit data/calib/$TAG-collect.jsonl data/calib/fitted-$TAG
for v in text text_strip; do $N scripts/eval-test.ts collect data/eval/test-v1-$TAG $v 16; done
for v in text text_strip; do CALIB_DIR=data/calib/fitted-$TAG $N scripts/eval-test.ts score data/eval/test-v1-$TAG $v > data/eval/test-v1-$TAG/score-$v.out; done
for v in text text_strip; do $N scripts/eval-test.ts separation data/eval/test-v1-$TAG $v > /dev/null; done
CALIB_DIR=data/calib/fitted-$TAG $N scripts/calib-routing-check.ts data/calib/$TAG-collect.jsonl data/calib/fitted-$TAG $MODEL > data/eval/test-v1-$TAG/routing-check.out
echo "RUN_JUDGE_DONE $TAG"
