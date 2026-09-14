#!/usr/bin/env bash















set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DIST_DIR="${1:-$REPO_ROOT/dist/extension}"

if [[ ! -d "$DIST_DIR" ]]; then
  echo "::error::Extension build not found at $DIST_DIR" >&2
  echo "Run \`npm run build -w @slicc/chrome-extension\` first." >&2
  exit 2
fi




FORBIDDEN_PATTERN='https://(unpkg\.com|esm\.sh|cdn\.jsdelivr\.net/npm)/[a-zA-Z0-9@._/~+-]'








MATCHES=$(
  find "$DIST_DIR" \
    -type f \
    \( -name '*.js' -o -name '*.html' -o -name '*.json' -o -name '*.css' \) \
    ! -name '*.map' \
    -print0 \
  | xargs -0 grep -HonE "${FORBIDDEN_PATTERN}[^\"'\`)[[:space:]]]*" 2>/dev/null || true
)

if [[ -z "$MATCHES" ]]; then
  echo "✓ No forbidden CDN URL literals found in $DIST_DIR"
  exit 0
fi

echo "::error::Forbidden third-party CDN URL literals found in $DIST_DIR" >&2
echo "" >&2
# shellcheck disable=SC2001
echo "$MATCHES" | sed 's/^/  /' >&2
echo "" >&2
COUNT=$(echo "$MATCHES" | wc -l | tr -d ' ')
FILE_COUNT=$(echo "$MATCHES" | awk -F: '{print $1}' | sort -u | wc -l | tr -d ' ')
echo "Found $COUNT forbidden URL literal match(es) across $FILE_COUNT file(s)." >&2
echo "" >&2
echo "These literals will trip Chrome Web Store's MV3 RHC scanner." >&2
echo "Migrate the call site to construct URLs at runtime via:" >&2
echo "  packages/webapp/src/shell/supplemental-commands/cdn-url-builder.ts" >&2
echo "" >&2
echo "Only bare hostnames (\`unpkg.com\`, \`esm.sh\`, \`cdn.jsdelivr.net\`)" >&2
echo "are allowed as string literals in the built extension." >&2
exit 1
