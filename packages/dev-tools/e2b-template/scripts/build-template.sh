#!/bin/bash
set -euo pipefail

# E2B v2 template build for the SLICC hosted leader.
#
# Requires:
#   - E2B_API_KEY exported (and pointed at the team you want to push to)
#   - `npm run build` already run (produces dist/node-server)

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"

if [ ! -f dist/node-server/index.js ]; then
  echo "dist/node-server/index.js not found. Run 'npm run build' first." >&2
  exit 1
fi

if [ -z "${E2B_API_KEY:-}" ]; then
  echo "E2B_API_KEY not set." >&2
  exit 1
fi

npx tsx packages/dev-tools/e2b-template/template.ts
