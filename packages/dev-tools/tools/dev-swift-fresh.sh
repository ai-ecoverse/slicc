#!/usr/bin/env bash
# dev-swift-fresh — launch the two-service standalone harness against the
# native macOS swift-server thin-bridge with a brand-new Chrome for Testing
# profile.  Mirrors dev-standalone-fresh.sh (the node-server variant) but is
# careful NOT to disturb a node harness that may already be running:
#   - uses its own ports (bridge 5720 / Chrome CDP 9224)
#   - uses its own port-suffixed Chrome profile
#   - reuses an existing wrangler on :8787 instead of starting a second one
#   - NEVER blanket-kills "Google Chrome for Testing" (that would close the
#     node harness's window too); swift-server's SIGTERM handler closes only
#     the Chrome IT launched.
#
# Usage:
#   PORT=5720 CDP_PORT=9224 bash packages/dev-tools/tools/dev-swift-fresh.sh
#
# Prerequisites:
#   - cd packages/swift-server && swift build   (produces .build/debug/slicc-server)
#   - npx playwright install chromium
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

BRIDGE_PORT="${PORT:-5720}"
CDP_PORT="${CDP_PORT:-9224}"
WRANGLER_PORT="${WRANGLER_PORT:-8787}"

SWIFT_BIN="${REPO_ROOT}/packages/swift-server/.build/debug/slicc-server"
STAGING_WORKER="https://slicc-tray-hub-staging.minivelos.workers.dev"
STAGING_GH_CLIENT_ID="Ov23liUe1b3b6GDjPGz4"

# ── 1. Resolve the swift-server binary ───────────────────────────────
if [ ! -x "$SWIFT_BIN" ]; then
  echo "❌  swift-server binary not found at: $SWIFT_BIN"
  echo "    Build it first:  ( cd packages/swift-server && swift build )"
  exit 1
fi
echo "✔  swift-server: $SWIFT_BIN"

# ── 2. Resolve Chrome for Testing ────────────────────────────────────
CFT=""
PW_CACHE="${HOME}/Library/Caches/ms-playwright"
if [ -d "$PW_CACHE" ]; then
  CFT=$(find "$PW_CACHE" -name "Google Chrome for Testing" -type f 2>/dev/null \
    | sort -V | tail -1)
fi
if [ -z "$CFT" ]; then
  echo "❌  Chrome for Testing not found.  Run:  npx playwright install chromium"
  exit 1
fi
echo "✔  Chrome for Testing: $CFT"

# ── 3. Fresh, port-scoped Chrome profile ─────────────────────────────
# swift-server resolves its user-data-dir to
#   ~/Library/Application Support/Slicc/profiles/browser-coding-agent-chrome-<port>
# (the -<port> suffix is added whenever the serve port != 5710).  Removing
# only THIS path keeps the session fresh without touching the node harness's
# separate (mktemp) profile.
SWIFT_PROFILE="${HOME}/Library/Application Support/Slicc/profiles/browser-coding-agent-chrome-${BRIDGE_PORT}"
rm -rf "$SWIFT_PROFILE" 2>/dev/null || true
echo "✔  Fresh swift profile: $SWIFT_PROFILE"

# ── 4. Reuse-or-start wrangler (UI origin) ───────────────────────────
# A node harness usually already serves the SPA on :8787 — reuse it.  Only
# start (and later stop) our own wrangler if nothing is answering there.
STARTED_WRANGLER=0
WRANGLER_PID=""
if curl -sf -o /dev/null "http://127.0.0.1:${WRANGLER_PORT}" 2>/dev/null; then
  echo "✔  Reusing existing wrangler on :${WRANGLER_PORT} (not started by us)"
else
  echo "🌐  Starting wrangler on :${WRANGLER_PORT}…"
  npx wrangler dev \
    --config "${REPO_ROOT}/packages/cloudflare-worker/wrangler.jsonc" \
    --port "$WRANGLER_PORT" --ip 127.0.0.1 \
    --var "GITHUB_CLIENT_ID:${STAGING_GH_CLIENT_ID}" \
    --var "TRAY_WORKER_BASE_URL_OVERRIDE:${STAGING_WORKER}" &
  WRANGLER_PID=$!
  STARTED_WRANGLER=1
  for i in $(seq 1 30); do
    if curl -sf -o /dev/null "http://127.0.0.1:${WRANGLER_PORT}" 2>/dev/null; then
      echo "✔  Wrangler ready on :${WRANGLER_PORT}"
      break
    fi
    [ "$i" -eq 30 ] && { echo "❌  Wrangler failed to start"; kill "$WRANGLER_PID" 2>/dev/null || true; exit 1; }
    sleep 1
  done
fi

# ── 5. Cleanup trap (kills ONLY our own processes) ───────────────────
SWIFT_PID=""
cleanup() {
  echo ""
  echo "⏹  Shutting down swift harness…"
  if [ -n "$SWIFT_PID" ]; then
    # SIGTERM → swift-server's GracefulShutdown closes the Chrome it launched.
    kill -TERM "$SWIFT_PID" 2>/dev/null || true
    wait "$SWIFT_PID" 2>/dev/null || true
  fi
  if [ "$STARTED_WRANGLER" -eq 1 ] && [ -n "$WRANGLER_PID" ]; then
    kill "$WRANGLER_PID" 2>/dev/null || true
  fi
  # Intentionally NO `pkill Google Chrome for Testing` — a node harness Chrome
  # may be running and must survive.
}
trap cleanup EXIT INT TERM

# ── 6. Start swift-server thin-bridge ────────────────────────────────
echo "🔗  Starting swift thin-bridge on :${BRIDGE_PORT} (Chrome CDP :${CDP_PORT})…"
echo ""
CHROME_PATH="$CFT" \
WORKER_BASE_URL="http://localhost:${WRANGLER_PORT}" \
BRIDGE_DEV_ALLOWED_ORIGINS="http://localhost:${WRANGLER_PORT}" \
PORT="$BRIDGE_PORT" \
  "$SWIFT_BIN" --cdp-port "$CDP_PORT" &
SWIFT_PID=$!

# Forward signals to swift-server and block until it exits.
wait "$SWIFT_PID"
