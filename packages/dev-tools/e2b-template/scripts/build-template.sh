#!/bin/bash
set -euo pipefail

# TEMPORARY (e2b out of credits): when SLICC_SKIP_E2B_TEMPLATE=1, skip the
# template build entirely and exit 0. publish-worker.sh runs this first under
# `set -e`, so a failed `Template.build` (which is what an out-of-credits
# account returns) blocks the whole release. Skipping lets the release deploy
# the worker against the already-published template. Remove the env var (set in
# .github/workflows/release.yml) once e2b credits are restored.
if [ "${SLICC_SKIP_E2B_TEMPLATE:-}" = "1" ]; then
  echo "[build-template] SLICC_SKIP_E2B_TEMPLATE=1 set — skipping e2b template build (account out of credits)."
  exit 0
fi

# E2B v2 template build for the SLICC hosted leader.
#
# Requires:
#   - E2B_API_KEY exported (and pointed at the team you want to push to)
#   - `npm run build` already run (produces dist/node-server, dist/ui)

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"

if [ ! -f dist/node-server/index.js ]; then
  echo "dist/node-server/index.js not found. Run 'npm run build' first." >&2
  exit 1
fi

if [ ! -f dist/ui/index.html ]; then
  echo "dist/ui/index.html not found. Run 'npm run build' first." >&2
  exit 1
fi

if [ -z "${E2B_API_KEY:-}" ]; then
  echo "E2B_API_KEY not set." >&2
  exit 1
fi

npx tsx packages/dev-tools/e2b-template/template.ts
