#!/usr/bin/env bash
# Guard against autofix drift: `npm run lint` must be a no-op on a committed
# tree.
#
# `npm run lint` runs `biome check --write`, which applies every *safe* fix
# regardless of the rule's severity. CI runs `biome check` (no `--write`),
# which only fails on *errors*. Biome ships ~30 recommended rules at
# warn/info severity with a safe fix (`noAdjacentSpacesInRegex`,
# `useNumericLiterals`, `noUselessEscapeInRegex`, ...), so a violation of any
# of them is green in CI yet gets rewritten by every local `npm run lint` —
# re-dirtying every worktree until someone commits the rewrite by hand.
# lint-staged normally applies the fix at commit time, but commits made
# outside the hook (GitHub web UI, Copilot Autofix, `--no-verify`) skip it.
#
# Runs the writing linter and fails if it changed anything. Compares the
# working-tree diff before and after instead of demanding a clean tree, so an
# on-demand `npm run verify` on a dirty checkout still works; the pre-push
# hook already guarantees the tree matches the pushed commit. On a dirty tree
# the `--stat` below lists pre-existing local edits too.
#
# Usage: bash packages/dev-tools/tools/check-autofix-drift.sh
# Fix:   npm run lint, then commit the rewrites.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

BIOME="$REPO_ROOT/node_modules/.bin/biome"
if [[ ! -x "$BIOME" ]]; then
  echo "check-autofix-drift: biome not found in node_modules/.bin — run 'npm ci' first." >&2
  exit 2
fi

snapshot() {
  git diff | git hash-object --stdin
}

before="$(snapshot)"
# Warnings are expected (naming convention, noExplicitAny, unused
# suppressions); only a non-zero exit — an unfixable error — fails here, and
# `biome check` in lint:ci already reports those with full context.
if ! out="$("$BIOME" check --write . 2>&1)"; then
  printf '%s\n' "$out" >&2
  echo "check-autofix-drift: biome check --write failed." >&2
  exit 1
fi
after="$(snapshot)"

if [[ "$before" != "$after" ]]; then
  echo "::error::'biome check --write' rewrote files that 'biome check' accepted:" >&2
  git diff --stat >&2
  git diff >&2
  echo "Run 'npm run lint' and commit the result." >&2
  exit 1
fi
echo "check-autofix-drift: npm run lint is a no-op on this tree."
