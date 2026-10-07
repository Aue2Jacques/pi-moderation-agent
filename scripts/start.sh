#!/bin/bash
# Start G then W in the background (logs in logs/, pids in run/). Usage: scripts/start.sh [g|w|all]
set -u
cd "$(dirname "$0")/.."
mkdir -p logs run data
what=${1:-all}
start() { # name entry port
  if [ -f "run/$1.pid" ] && kill -0 "$(cat run/$1.pid)" 2>/dev/null; then echo "$1 already running (pid $(cat run/$1.pid))"; return; fi
  nohup node --experimental-strip-types --no-warnings "$2" > "logs/$1.log" 2>&1 < /dev/null &
  echo $! > "run/$1.pid"; echo "$1 started pid $! (port $3)"
}
[ "$what" = g ] || [ "$what" = all ] && start g packages/gateway/src/main.ts 8080
[ "$what" = w ] || [ "$what" = all ] && start w packages/worker/src/main.ts 8081
