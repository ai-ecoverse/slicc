#!/usr/bin/env bash
# Scan the built chrome extension for forbidden third-party CDN URL literals.
#
# Chrome Web Store's MV3 Remote Hosted Code reviewer string-matches full CDN
# URLs in built JS/HTML/JSON/CSS. Even a literal that we override at runtime
# (e.g. the `https://unpkg.com/@ffmpeg/core@.../ffmpeg-core.js` baked into
# `@ffmpeg/ffmpeg`'s worker source) is enough to fail review.
#
# Policy: full `https://<host>/<path>` URLs to unpkg.com / esm.sh /
# cdn.jsdelivr.net/npm are forbidden in `dist/extension/`. Construct them at
# runtime via `cdn-url-builder.ts` instead so only the bare hostnames
# (`unpkg.com`, `esm.sh`, `cdn.jsdelivr.net`) ever appear as string literals.
#
# Usage: bash packages/dev-tools/tools/check-extension-rhc.sh [dist-dir]
#   Defaults to `dist/extension/` relative to the repo root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DIST_DIR="${1:-$REPO_ROOT/dist/extension}"

if [[ ! -d "$DIST_DIR" ]]; then
  echo "::error::Extension build not found at $DIST_DIR" >&2
  echo "Run \`npm run build -w @slicc/chrome-extension\` first." >&2
  exit 2
fi

# ERE pattern: full URLs (host + path) for the three forbidden CDNs.
# Bare hostnames like `unpkg.com` or `https://unpkg.com` (no path) remain OK —
# the URL builder leaves those behind when composing URLs at runtime.
FORBIDDEN_PATTERN='https://(unpkg\.com|esm\.sh|cdn\.jsdelivr\.net/npm)/[a-zA-Z0-9@._/~+-]'

# Limit the scan to file types where a literal could survive. Source maps are
# excluded — they often inline raw worker source containing forbidden literals
# even after the runtime references have been masked, and they don't ship to
# the store in our build.
# Many bundles are minified to a single long line, so `grep -n` would dump
# the whole file. Use `grep -onE` to emit just the offending URL literal —
# file:line:URL — which is the actionable signal anyway.
MATCHES=$(
  find "$DIST_DIR" \
    -type f \
    \( -name '*.js' -o -name '*.html' -o -name '*.json' -o -name '*.css' \) \
    ! -name '*.map' \
    -print0 \
  | xargs -0 grep -HonE "${FORBIDDEN_PATTERN}[^\"'\`)[:space:]]*" 2>/dev/null || true
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
echo "  packages/webapp/src/shell/cdn-url-builder.ts" >&2
echo "" >&2
echo "Only bare hostnames (\`unpkg.com\`, \`esm.sh\`, \`cdn.jsdelivr.net\`)" >&2
echo "are allowed as string literals in the built extension." >&2
exit 1
