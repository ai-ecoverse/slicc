#!/usr/bin/env bash
























set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

BIOME="$REPO_ROOT/node_modules/.bin/biome"
if [[ ! -x "$BIOME" ]]; then
  echo "check-autofix-drift: biome not found in node_modules/.bin — run 'npm ci' first." >&2
  exit 2
fi

snapshot() {
  {
    git diff
    git ls-files --others --exclude-standard | git hash-object --stdin-paths
  } | git hash-object --stdin
}

before="$(snapshot)"



if ! out="$("$BIOME" check --write . 2>&1)"; then
  printf '%s\n' "$out" >&2
  echo "check-autofix-drift: biome check --write failed." >&2
  exit 1
fi
after="$(snapshot)"

if [[ "$before" != "$after" ]]; then
  echo "::error::'biome check --write' rewrote files that 'biome check' accepted:" >&2
  git status --short >&2
  git diff >&2
  echo "Run 'npm run lint' and commit the result." >&2
  exit 1
fi
echo "check-autofix-drift: npm run lint is a no-op on this tree."
