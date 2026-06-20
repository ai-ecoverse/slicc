#!/usr/bin/env bash
# dev:standalone:fresh — launch the two-service standalone harness
# (wrangler UI + node-server thin-bridge) with a brand-new Chrome for
# Testing profile.  Kills leftover Chrome for Testing instances and
# nukes all cached Slicc browser profiles so the session starts clean.
#
# Usage:
#   npm run dev:standalone:fresh
#   PORT=5720 npm run dev:standalone:fresh   # override bridge port
#
# Prerequisites:
#   - npm run build  (or at least webapp + node-server)
#   - npx playwright install chromium
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

BRIDGE_PORT="${PORT:-5710}"
WRANGLER_PORT="${WRANGLER_PORT:-8787}"

# ── 1. Resolve Chrome for Testing ────────────────────────────────────
CFT=""
PW_CACHE="${HOME}/Library/Caches/ms-playwright"
if [ -d "$PW_CACHE" ]; then
  # Pick the newest chromium-* revision
  CFT=$(find "$PW_CACHE" -name "Google Chrome for Testing" -type f 2>/dev/null \
    | sort -V | tail -1)
fi
if [ -z "$CFT" ]; then
  echo "❌  Chrome for Testing not found.  Run:  npx playwright install chromium"
  exit 1
fi
echo "✔  Chrome for Testing: $CFT"

# ── 2. Kill leftover Chrome for Testing processes ────────────────────
if pgrep -f "Google Chrome for Testing" >/dev/null 2>&1; then
  echo "⏹  Killing leftover Chrome for Testing…"
  pkill -9 -f "Google Chrome for Testing" 2>/dev/null || true
  sleep 1
fi

# ── 3. Create an ephemeral profile (no production profiles touched) ──
FRESH_PROFILE="$(mktemp -d)"
echo "✔  Fresh profile: $FRESH_PROFILE"

# ── 4. Start wrangler (UI origin) in background ─────────────────────
echo "🌐  Starting wrangler on :${WRANGLER_PORT}…"
npx wrangler dev \
  --config "${REPO_ROOT}/packages/cloudflare-worker/wrangler.jsonc" \
  --port "$WRANGLER_PORT" --ip 127.0.0.1 &
WRANGLER_PID=$!

# Wait for wrangler to be ready
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${WRANGLER_PORT}" >/dev/null 2>&1; then
    echo "✔  Wrangler ready on :${WRANGLER_PORT}"
    break
  fi
  [ "$i" -eq 30 ] && { echo "❌  Wrangler failed to start"; kill $WRANGLER_PID 2>/dev/null; exit 1; }
  sleep 1
done

# ── 5. Start node-server thin-bridge (foreground) ────────────────────
echo "🔗  Starting thin-bridge on :${BRIDGE_PORT}…"
echo ""

cleanup() {
  echo ""
  echo "⏹  Shutting down…"
  kill $WRANGLER_PID 2>/dev/null || true
  pkill -f "Google Chrome for Testing" 2>/dev/null || true
  rm -rf "$FRESH_PROFILE" 2>/dev/null || true
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

CHROME_PATH="$CFT" \
WORKER_BASE_URL="http://localhost:${WRANGLER_PORT}" \
SLICC_CDP_LAUNCH_TIMEOUT_MS=30000 \
BRIDGE_DEV_ALLOWED_ORIGINS="http://localhost:${WRANGLER_PORT}" \
SLICC_USER_DATA_DIR="$FRESH_PROFILE" \
PORT="$BRIDGE_PORT" \
  node "${REPO_ROOT}/dist/node-server/index.js"
