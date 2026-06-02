#!/usr/bin/env bash
# Guard against Chrome Web Store manifest-permission drift.
#
# Every entry in `packages/chrome-extension/manifest.json`'s `permissions`
# array plus each `host_permissions` entry must have a matching reviewer
# justification row in `docs/chrome-web-store-submission.md`. This keeps the
# CWS submission pack honest: a permission can't be added (or removed) without
# updating the dashboard-ready justifications, and vice-versa.
#
# The doc's justification table is delimited by HTML marker comments:
#   <!-- manifest-justifications:begin -->
#   ... | `permission` | ... |
#   <!-- manifest-justifications:end -->
# The first backtick-wrapped token of each table row is the justified entry.
#
# Usage: bash packages/dev-tools/tools/check-manifest-justifications.sh \
#          [manifest.json] [submission.md]
#   Defaults to the in-repo paths.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MANIFEST="${1:-$REPO_ROOT/packages/chrome-extension/manifest.json}"
DOC="${2:-$REPO_ROOT/docs/chrome-web-store-submission.md}"

if [[ ! -f "$MANIFEST" ]]; then
  echo "::error::Manifest not found at $MANIFEST" >&2
  exit 2
fi
if [[ ! -f "$DOC" ]]; then
  echo "::error::Submission doc not found at $DOC" >&2
  echo "Expected the Chrome Web Store justification pack to exist." >&2
  exit 2
fi

# Manifest entries: `permissions` + `host_permissions`, one per line.
MANIFEST_ENTRIES="$(
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const out = [...(m.permissions || []), ...(m.host_permissions || [])];
    process.stdout.write(out.join("\n"));
  ' "$MANIFEST"
)"

# Doc entries: the first backtick-wrapped token of every table row inside the
# manifest-justifications marker block.
DOC_ENTRIES="$(
  awk '
    /<!-- manifest-justifications:begin -->/ { inblock = 1; next }
    /<!-- manifest-justifications:end -->/   { inblock = 0 }
    inblock && /^\|/ {
      if (match($0, /`[^`]+`/)) {
        token = substr($0, RSTART + 1, RLENGTH - 2)
        print token
      }
    }
  ' "$DOC"
)"

if [[ -z "$DOC_ENTRIES" ]]; then
  echo "::error::No justification rows found in $DOC" >&2
  echo "Expected a table between the manifest-justifications marker comments." >&2
  exit 1
fi

MISSING_IN_DOC=()
while IFS= read -r entry; do
  [[ -z "$entry" ]] && continue
  if ! grep -qxF -- "$entry" <<<"$DOC_ENTRIES"; then
    MISSING_IN_DOC+=("$entry")
  fi
done <<<"$MANIFEST_ENTRIES"

MISSING_IN_MANIFEST=()
while IFS= read -r entry; do
  [[ -z "$entry" ]] && continue
  if ! grep -qxF -- "$entry" <<<"$MANIFEST_ENTRIES"; then
    MISSING_IN_MANIFEST+=("$entry")
  fi
done <<<"$DOC_ENTRIES"

STATUS=0

if [[ ${#MISSING_IN_DOC[@]} -gt 0 ]]; then
  STATUS=1
  echo "::error::Manifest permissions missing a justification in $DOC" >&2
  for entry in "${MISSING_IN_DOC[@]}"; do
    echo "  - $entry" >&2
  done
  echo "" >&2
  echo "Add a row for each inside the manifest-justifications marker block." >&2
fi

if [[ ${#MISSING_IN_MANIFEST[@]} -gt 0 ]]; then
  STATUS=1
  echo "::error::Justifications in $DOC for entries not in the manifest" >&2
  for entry in "${MISSING_IN_MANIFEST[@]}"; do
    echo "  - $entry" >&2
  done
  echo "" >&2
  echo "Remove the stale rows, or restore the permission in manifest.json." >&2
fi

if [[ "$STATUS" -ne 0 ]]; then
  exit 1
fi

COUNT=$(grep -c '' <<<"$MANIFEST_ENTRIES")
echo "✓ All $COUNT manifest permission(s) have a Chrome Web Store justification"
exit 0
