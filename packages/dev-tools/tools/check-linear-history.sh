#!/usr/bin/env bash
# Guard against non-linear PR history.
#
# The merge queue lands PRs with a linear history (rebase, no merge commits).
# A branch that merged `main` in — instead of rebasing onto it — carries merge
# commits the queue rejects late, after the PR has already gone green. That is
# expensive to discover: the PR re-runs the whole pipeline only to bounce out
# of the queue. This check surfaces it at PR time instead.
#
# It fails if any commit unique to the PR branch (base..head) is a merge commit
# (has 2+ parents).
#
# Usage: check-linear-history.sh [base-ref] [head-ref]
#   base-ref defaults to origin/${GITHUB_BASE_REF:-main}; head-ref to HEAD.
#   In CI, pass the PR's real base/head SHAs explicitly — on `pull_request`
#   events the checked-out HEAD is a synthetic test-merge commit, so relying on
#   the default HEAD would always report a (spurious) merge.

set -euo pipefail

BASE="${1:-}"
HEAD_REF="${2:-HEAD}"

if [[ -z "$BASE" ]]; then
  BASE_BRANCH="${GITHUB_BASE_REF:-main}"
  if git rev-parse --verify --quiet "origin/$BASE_BRANCH" >/dev/null; then
    BASE="origin/$BASE_BRANCH"
  else
    BASE="$BASE_BRANCH"
  fi
fi

# Merge commits reachable from the PR head but not from the base — i.e. the
# branch's own commits. A clean rebase yields none; merging the base in yields
# at least one.
MERGES="$(git rev-list --merges "$BASE..$HEAD_REF")"

if [[ -n "$MERGES" ]]; then
  echo "::error::PR history is not linear — found merge commit(s) in $BASE..$HEAD_REF:" >&2
  while IFS= read -r sha; do
    [[ -z "$sha" ]] && continue
    echo "  - $(git log -1 --format='%h %s' "$sha")" >&2
  done <<<"$MERGES"
  echo "" >&2
  echo "The merge queue requires a linear history. Rebase your branch onto" >&2
  echo "$BASE instead of merging it in, then force-push:" >&2
  echo "" >&2
  echo "  git fetch origin" >&2
  echo "  git rebase $BASE" >&2
  echo "  git push --force-with-lease" >&2
  exit 1
fi

echo "✓ PR history is linear (no merge commits in $BASE..$HEAD_REF)"
exit 0
