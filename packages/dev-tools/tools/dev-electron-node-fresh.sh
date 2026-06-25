#!/usr/bin/env bash
# dev-electron-node-fresh — attach the node-server thin-bridge to an external
# Electron app (Slack/Discord/Teams/…) against the hosted webapp, with a clean
# bridge process and a freshly relaunched target app.  The node sibling of
# dev-electron-swift-fresh.sh; both mirror dev-standalone-fresh.sh / dev-swift-
# fresh.sh / dev-extension-fresh.sh.
#
# Unlike the standalone floats there is NO Chrome for Testing here: node-server
# ATTACHES to the Electron app's own renderer over CDP and injects the overlay,
# which loads the hosted webapp from /electron?bridge=…&bridgeToken=…&role=… and
# dials back to ws://localhost:<PORT>/cdp.  "Fresh" therefore means: reap a stale
# bridge on our ports, and relaunch the target app clean with remote debugging
# enabled (--kill).  The app keeps its OWN profile — we never nuke a third-party
# app's user data — so seed providers via packages/webapp/providers.json (build)
# or the leader overlay UI as usual.
#
# Thin-electron mode is gated by SLICC_HOSTED_LEADER_ORIGIN + SLICC_BRIDGE_TOKEN
# (see resolveOverlayThinBridge / resolveServerBridgeToken).  We also allowlist
# the wrangler origin via BRIDGE_DEV_ALLOWED_ORIGINS so the overlay iframe's
# cross-origin /cdp upgrade passes the origin gate.
#
# Usage:
#   npm run dev:electron:node:fresh                      # defaults to Slack
#   npm run dev:electron:node:fresh -- /Applications/Discord.app
#   PORT=5730 CDP_PORT=9225 bash packages/dev-tools/tools/dev-electron-node-fresh.sh /Applications/Slack.app
#
# Prerequisites:
#   - npm run build   (dist/node-server/index.js + the electron-overlay entry)
#   - Quit the target app first (or rely on --kill to relaunch it).
#
# Verify it: SLICC_CDP_PORT=$CDP_PORT node packages/dev-tools/tools/slicc-debug.mjs targets
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

BRIDGE_PORT="${PORT:-5730}"
CDP_PORT="${CDP_PORT:-9225}"
WRANGLER_PORT="${WRANGLER_PORT:-8787}"
ELECTRON_APP="${1:-${ELECTRON_APP:-/Applications/Slack.app}}"

NODE_ENTRY="${REPO_ROOT}/dist/node-server/index.js"
STAGING_WORKER="https://slicc-tray-hub-staging.minivelos.workers.dev"
STAGING_GH_CLIENT_ID="Ov23liUe1b3b6GDjPGz4"

# ── 1. Validate the built node-server + the target Electron app ──────
if [ ! -f "$NODE_ENTRY" ]; then
  echo "❌  node-server build missing: $NODE_ENTRY"
  echo "    Build it first:  npm run build"
  exit 1
fi
if [ ! -d "$ELECTRON_APP" ]; then
  echo "❌  Electron app not found: $ELECTRON_APP"
  echo "    Pass a path:  npm run dev:electron:node:fresh -- /Applications/Slack.app"
  exit 1
fi
echo "✔  node-server: $NODE_ENTRY"
echo "✔  Electron app: $ELECTRON_APP"

# ── 2. Reap stale processes on OUR OWN ports (strictly port-scoped) ──
# A prior hung run can leave a node-server holding :$BRIDGE_PORT or the Electron
# app holding CDP :$CDP_PORT.  Resolve the PID from the specific listening port
# and kill ONLY that PID.  NEVER blanket-kill by app name — a concurrent node
# (:5710/:9222) / swift (:5720/:9224) / ext (:9333) harness must survive.
reap_port() {
  local port="$1" label="$2" pids pid
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  for pid in $pids; do
    echo "♻️   Reaping stale pid $pid on :$port ($label) — TERM"
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 2
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  for pid in $pids; do
    echo "♻️   pid $pid still bound to :$port — KILL"
    kill -KILL "$pid" 2>/dev/null || true
  done
  sleep 1
}
reap_port "$BRIDGE_PORT" "bridge"
reap_port "$CDP_PORT" "Electron CDP"

# ── 3. Mint a per-process bridge token ───────────────────────────────
# Forwarded as SLICC_BRIDGE_TOKEN: node-server uses it BOTH as the /cdp upgrade
# gate token (resolveServerBridgeToken) AND as the token embedded in the overlay
# launch URL (resolveOverlayThinBridge), so the two sides always match.
BRIDGE_TOKEN="${SLICC_BRIDGE_TOKEN:-$(uuidgen | tr '[:upper:]' '[:lower:]')}"

# ── 4a. Build the leader UI (dist/ui) if missing ─────────────────────
# wrangler serves dist/ui via the ASSETS binding with SPA fallback; the overlay
# loads the hosted webapp from /electron (a dist/ui SPA route), so when
# dist/ui/index.html is absent every route 404s and the overlay never loads.
# Build on demand (fast no-op when present), hard-failing if it doesn't appear.
if [ -f "${REPO_ROOT}/dist/ui/index.html" ]; then
  echo "✔  Leader UI present (dist/ui/index.html)"
else
  echo "🏗  Building leader UI (npm run build -w @slicc/webapp)…"
  npm run build -w @slicc/webapp
  if [ ! -f "${REPO_ROOT}/dist/ui/index.html" ]; then
    echo "❌  Leader UI build did not produce ${REPO_ROOT}/dist/ui/index.html"
    exit 1
  fi
  echo "✔  Leader UI built (dist/ui/index.html)"
fi

# Treat ANY HTTP response from the wrangler port as "up". `curl -sf` exits
# non-zero on a 4xx (e.g. the SPA's 404 before dist/ui is built), which would
# false-negative the reuse/readiness check and try to bind a SECOND wrangler to
# the already-occupied port. Checking only that curl got a status line (non-000,
# non-empty) avoids that.
wrangler_up() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
    "http://127.0.0.1:${WRANGLER_PORT}/?slicc=leader" 2>/dev/null || true)"
  [ -n "$code" ] && [ "$code" != "000" ]
}

# ── 4b. Reuse-or-start wrangler (UI / leader origin on :8787) ────────
STARTED_WRANGLER=0
WRANGLER_PID=""
if wrangler_up; then
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
    if wrangler_up; then
      echo "✔  Wrangler ready on :${WRANGLER_PORT}"
      break
    fi
    [ "$i" -eq 30 ] && { echo "❌  Wrangler failed to start"; kill "$WRANGLER_PID" 2>/dev/null || true; exit 1; }
    sleep 1
  done
fi

# ── 5. Cleanup trap (kills ONLY our own processes) ───────────────────
NODE_PID=""
cleanup() {
  echo ""
  echo "⏹  Shutting down electron-node harness…"
  if [ -n "$NODE_PID" ]; then
    kill -TERM "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
  fi
  [ "$STARTED_WRANGLER" -eq 1 ] && [ -n "$WRANGLER_PID" ] && kill "$WRANGLER_PID" 2>/dev/null || true
  # Intentionally NO blanket app-kill — the relaunched Electron app is left for
  # the user to inspect/close, and concurrent harnesses must survive.
}
trap cleanup EXIT INT TERM

# ── 6. Start node-server in thin-electron attach mode ────────────────
echo "🔗  Attaching node thin-bridge on :${BRIDGE_PORT} to ${ELECTRON_APP} (CDP :${CDP_PORT})…"
echo "    Overlay leader/follower load from http://localhost:${WRANGLER_PORT}/electron"
echo ""
WORKER_BASE_URL="http://localhost:${WRANGLER_PORT}" \
SLICC_HOSTED_LEADER_ORIGIN="http://localhost:${WRANGLER_PORT}" \
SLICC_BRIDGE_TOKEN="$BRIDGE_TOKEN" \
BRIDGE_DEV_ALLOWED_ORIGINS="http://localhost:${WRANGLER_PORT}" \
SLICC_TRAY_WORKER_BASE_URL="${SLICC_TRAY_WORKER_BASE_URL:-$STAGING_WORKER}" \
SLICC_CDP_LAUNCH_TIMEOUT_MS=30000 \
PORT="$BRIDGE_PORT" \
  node "$NODE_ENTRY" --electron --electron-app="$ELECTRON_APP" --kill --cdp-port="$CDP_PORT" &
NODE_PID=$!

wait "$NODE_PID"
