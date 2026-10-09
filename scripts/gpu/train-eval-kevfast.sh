#!/bin/bash
# Train a Kev checkpoint on rules-first / short-question records and evaluate it through kevfast (the only server that
# speaks that form): train -> kevfast serve (KF_* switches from the environment, defaults below) -> run-judge.sh with
# JEV_LAYOUT=rules-first (calibration fit, test split both views, routing, separation) -> stop the server.
# usage (GPU server, repo copy as cwd): [BATCH=4 ACCUM=2 MAX_STATE=768 KF_PATH=/hy-tmp/kf] \
#   bash scripts/gpu/train-eval-kevfast.sh <records.jsonl> <tag> [epochs=1] [lr=2e-5]
#   EVAL_ONLY=1: skip training, evaluate the existing run /hy-tmp/train/runs/<train tag> (TRAIN_TAG, default = tag)
set -euo pipefail
DATA=$1; TAG=$2; EP=${3:-1}; LR=${4:-2e-5}; BATCH=${BATCH:-4}; ACCUM=${ACCUM:-2}; MAX_STATE=${MAX_STATE:-768}
KEV=/hy-tmp/work/kev; RUN=/hy-tmp/train/runs/${TRAIN_TAG:-$TAG}; REPO=$(pwd); KF_PATH=${KF_PATH:-/hy-tmp/kf}
. /etc/profile.d/mirrors.sh
if [ "${EVAL_ONLY:-0}" != 1 ]; then
  (cd $KEV && uv run --extra serve python -m kev.train --data "$DATA" --init_from jaredpalmer/kev-4b --base Qwen/Qwen3.5-4B-Base \
    --epochs "$EP" --lr "$LR" --batch "$BATCH" --accum "$ACCUM" --max_state "$MAX_STATE" --dtype bf16 --weights_dtype bf16 --checkpointing 1 --device cuda --out "$RUN")
fi
export KF_LAYOUT=${KF_LAYOUT:-rules_first} KF_QUESTIONS=${KF_QUESTIONS:-short} KF_CONFIRM=${KF_CONFIRM:-on} KF_FP8=${KF_FP8:-on}
(cd $KEV && PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True PYTHONPATH=$KF_PATH setsid .venv/bin/python -m kevfast.serve --run "$RUN" --port 8010 \
  > /hy-tmp/train/$TAG-serve.log 2>&1 < /dev/null &)
until curl -s -m 3 http://127.0.0.1:8010/v1/models | grep -q kevfast; do sleep 10; done
curl -s http://127.0.0.1:8010/v1/models > /hy-tmp/train/$TAG-models.json
cd "$REPO" && JEV_LAYOUT=rules-first bash scripts/gpu/run-judge.sh 8010 kev-latest "$TAG"
for p in $(pgrep -f "kevfast[.]serve"); do kill "$p"; done
echo "TRAIN_EVAL_DONE $TAG"
