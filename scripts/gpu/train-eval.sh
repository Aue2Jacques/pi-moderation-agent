#!/bin/bash
# Fine-tune Kev-4B on our platform-labelled training records and score it exactly like the other judges.
#   1) kev.train --data <records> warm-started from the released jaredpalmer/kev-4b (delta mode, LoRA + pointer head),
#      bf16 weights and autocast, gradient checkpointing (fits the 16 GB card; ~0.4 s / record with fla + causal-conv1d)
#   2) serve the new run on port 8009, 3) scripts/gpu/run-judge.sh with <tag> (own calibration on the 1,884 calibration
#      rows — leave them out of the training records — then the test split, score and separation), 4) stop the server.
# Records come from scripts/export-kev-train.ts on the dev box (they carry dataset text: servers only).
# BATCH / ACCUM (default 2 / 4, the baseline run): records per pass and passes per optimizer step; keep BATCH x ACCUM = 8
# when comparing runs (owner 2026-10-09: the cleaned run uses 4 / 2 — the GPU sat at ~65 % with 6 GB free).
# usage (on the GPU server, repo copy /hy-tmp/pma): [BATCH=4 ACCUM=2] bash scripts/gpu/train-eval.sh <records.jsonl> <tag> [epochs=1] [lr=2e-5]
set -euo pipefail
DATA=$1; TAG=$2; EP=${3:-1}; LR=${4:-2e-5}; BATCH=${BATCH:-2}; ACCUM=${ACCUM:-4}
KEV=/hy-tmp/work/kev; RUN=/hy-tmp/train/runs/$TAG; REPO=$(pwd)
. /etc/profile.d/mirrors.sh
(cd $KEV && uv run --extra serve python -m kev.train --data "$DATA" --init_from jaredpalmer/kev-4b --base Qwen/Qwen3.5-4B-Base \
  --epochs "$EP" --lr "$LR" --batch "$BATCH" --accum "$ACCUM" --dtype bf16 --weights_dtype bf16 --checkpointing 1 --device cuda --out "$RUN")
(cd $KEV && KEV_RUN=$RUN setsid uv run --extra serve python -m kev.serve --run "$RUN" --port 8009 > /hy-tmp/train/$TAG-serve.log 2>&1 < /dev/null &)
until curl -s -m 3 http://127.0.0.1:8009/v1/models | grep -q "$RUN"; do sleep 10; done
cd "$REPO" && bash scripts/gpu/run-judge.sh 8009 kev-latest "$TAG"
for p in $(pgrep -f "kev[.]serve"); do kill "$p"; done
echo "TRAIN_EVAL_DONE $TAG"
