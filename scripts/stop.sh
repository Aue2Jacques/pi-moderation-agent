#!/bin/bash
cd "$(dirname "$0")/.."
for p in w g; do [ -f run/$p.pid ] && kill "$(cat run/$p.pid)" 2>/dev/null && echo "stopped $p"; rm -f run/$p.pid; done
