#!/bin/bash
# Push a kernel folder under kaggle/ to Kaggle (GPU), wait for it, and download its outputs.
# Credentials (never print them): either the legacy ~/.kaggle/kaggle.json, or a new-style API token
# (~/.kaggle/access_token or KAGGLE_API_TOKEN) together with KAGGLE_USERNAME.
# usage: scripts/kaggle-run.sh kaggle/laya-zeroshot data/kaggle/laya-zeroshot   (WAIT_ONLY=1: do not push, just wait and download)
set -euo pipefail
src=$1; out=$2
user=${KAGGLE_USERNAME:-$(python3 -I -c "import json,os;print(json.load(open(os.path.expanduser('~/.kaggle/kaggle.json')))['username'])" 2>/dev/null || true)}
[ -n "$user" ] || { echo "set KAGGLE_USERNAME or provide ~/.kaggle/kaggle.json"; exit 2; }
work=$(mktemp -d); cp "$src"/*.py "$work"/
sed "s/__KAGGLE_USER__/$user/g" "$src/kernel-metadata.template.json" > "$work/kernel-metadata.json"
slug=$(python3 -I -c "import json;print(json.load(open('$work/kernel-metadata.json'))['id'])")
[ "${WAIT_ONLY:-0}" = 1 ] || kaggle kernels push -p "$work"
for i in $(seq 1 240); do
  st=$(kaggle kernels status "$slug" 2>&1 | tail -1 || true)   # transient API/network errors must not end the wait
  echo "$(date +%H:%M:%S) $st"
  case "$st" in *complete*|*COMPLETE*) break;; *error*|*ERROR*|*cancel*) echo "kernel failed"; break;; esac
  sleep 30
done
mkdir -p "$out"
# results are scored on Kaggle; by default only the (small) run log comes back. FETCH_OUTPUTS=1 also downloads files.
for i in 1 2 3 4 5; do timeout 120 kaggle kernels logs "$slug" > "$out/run-log.json" 2>/dev/null && [ -s "$out/run-log.json" ] && break; sleep 10; done
python3 -I -c "import json,sys;d=json.load(open(sys.argv[1]));print(''.join(x.get('data','') for x in d if x.get('stream_name')=='stdout'))" "$out/run-log.json" > "$out/stdout.txt" 2>/dev/null || true
if [ "${FETCH_OUTPUTS:-0}" = 1 ]; then for i in 1 2 3; do timeout 180 kaggle kernels output "$slug" -p "$out" > /dev/null && break; sleep 10; done; fi
ls -la "$out"; tail -40 "$out/stdout.txt"
