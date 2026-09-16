#!/usr/bin/env bash


















set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MANIFEST="${1:-$REPO_ROOT/packages/chrome-extension/manifest.json}"
DOC="${2:-$REPO_ROOT/docs/chrome-web-store-submission.md}"

if [[ -f "$REPO_ROOT/.no-comment" ]]; then
  echo "ok: skipping Chrome Web Store justification gate on no-comment tree"
  exit 0
fi

if [[ ! -f "$MANIFEST" ]]; then
  echo "::error::Manifest not found at $MANIFEST" >&2
  exit 2
fi
if [[ ! -f "$DOC" ]]; then
  echo "::error::Submission doc not found at $DOC" >&2
  echo "Expected the Chrome Web Store justification pack to exist." >&2
  exit 2
fi


MANIFEST_ENTRIES="$(
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const out = [...(m.permissions || []), ...(m.host_permissions || [])];
    process.stdout.write(out.join("\n"));
  ' "$MANIFEST"
)"



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
