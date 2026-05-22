#!/bin/bash
set -euo pipefail

# Build the SLICC e2b template, tagging with the root package.json version.

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"

if [ ! -f dist/node-server/index.js ]; then
  echo "dist/node-server/index.js not found. Run 'npm run build' first." >&2
  exit 1
fi

if [ ! -f dist/ui/index.html ]; then
  echo "dist/ui/index.html not found. Run 'npm run build' first." >&2
  exit 1
fi

if ! command -v e2b >/dev/null 2>&1; then
  echo "e2b CLI not found. Install: npm i -g @e2b/cli" >&2
  exit 1
fi

cd packages/dev-tools/e2b-template

e2b template build \
  --name "slicc" \
  --dockerfile e2b.Dockerfile \
  --metadata "sliccVersion=$VERSION" \
  --root "$ROOT"

echo "Published template slicc (sliccVersion=$VERSION)"
