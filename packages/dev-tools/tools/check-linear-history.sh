#!/usr/bin/env bash

















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
