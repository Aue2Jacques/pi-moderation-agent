#!/bin/bash
# kill -9 the worker (crash demo / fault injection). Usage: scripts/kill-w.sh
cd "$(dirname "$0")/.."
[ -f run/w.pid ] && kill -9 "$(cat run/w.pid)" && echo "killed W pid $(cat run/w.pid)" && rm -f run/w.pid data/w.lock.pid
