#!/bin/bash
# Fixture gate (dev-doc §12.4, round-9 item 9). No public-dataset rows are pulled in this version: every contract fixture is
# a real judge recording on a self-written sentence (fixtures/refs.yaml → fixtures/contract/). This step fails when a rule's
# contract ref is unregistered, a sentence is missing, or a REQUIRED fixture is missing or stale.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node --experimental-strip-types --no-warnings scripts/fixtures-check.ts
