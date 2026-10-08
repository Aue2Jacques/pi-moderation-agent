#!/bin/bash
# Push a kernel folder under kaggle/ to Kaggle (GPU), wait for it, and download its outputs.
# Credentials (never print them): either the legacy ~/.kaggle/kaggle.json, or a new-style API token
# (~/.kaggle/access_token or KAGGLE_API_TOKEN) together with KAGGLE_USERNAME.
# usage: scripts/kaggle-run.sh kaggle/laya-zeroshot data/kaggle/laya-zeroshot
set -euo pipefail
src=$1; out=$2
user=${KAGGLE_USERNAME:-$(python3 -I -c "import json,os;print(json.load(open(os.path.expanduser('~/.kaggle/kaggle.json')))['username'])" 2>/dev/null || true)}
[ -n "$user" ] || { echo "set KAGGLE_USERNAME or provide ~/.kaggle/kaggle.json"; exit 2; }
work=$(mktemp -d); cp "$src"/*.py "$work"/
sed "s/__KAGGLE_USER__/$user/" "$src/kernel-metadata.template.json" > "$work/kernel-metadata.json"
slug=$(python3 -I -c "import json;print(json.load(open('$work/kernel-metadata.json'))['id'])")
kaggle kernels push -p "$work"
for i in $(seq 1 240); do
  st=$(kaggle kernels status "$slug" 2>&1 | tail -1)
  echo "$(date +%H:%M:%S) $st"
  case "$st" in *complete*|*COMPLETE*) break;; *error*|*ERROR*|*cancel*) echo "kernel failed"; break;; esac
  sleep 30
done
mkdir -p "$out"; kaggle kernels output "$slug" -p "$out" > /dev/null; ls -la "$out"
