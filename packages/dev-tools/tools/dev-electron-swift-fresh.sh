#!/usr/bin/env bash
# dev-electron-swift-fresh — attach the native macOS swift-server thin-bridge to
# an external Electron app (Slack/Discord/Teams/…) against the hosted webapp.
# The swift sibling of dev-electron-node-fresh.sh; both mirror dev-swift-fresh.sh
# (binary resolve + stable signing + non-interactive Keychain) and the standalone
# /extension fresh harnesses.
#
# Like the node electron harness there is NO Chrome for Testing — swift-server
# ATTACHES to the Electron app's renderer over CDP and injects the overlay, which
# loads the hosted webapp from /electron?bridge=…&bridgeToken=…&role=… and dials
# back to ws://localhost:<PORT>/cdp.  "Fresh" = reap a stale bridge on our ports
# and relaunch the target app clean with remote debugging (--kill).  The app keeps
# its OWN profile; seed providers via packages/webapp/providers.json or the leader
# overlay UI.
#
# Swift thin-electron mode is gated by SLICC_HOSTED_LEADER_ORIGIN (+ a bridge
# token); see ServerCommand.isThinElectronMode / resolveBridgeToken.  We allowlist
# the wrangler origin via BRIDGE_DEV_ALLOWED_ORIGINS so the overlay iframe's
# cross-origin /cdp upgrade passes the origin gate.
#
# Usage:
#   npm run dev:electron:swift:fresh                      # defaults to Slack
#   npm run dev:electron:swift:fresh -- /Applications/Discord.app
#   PORT=5740 CDP_PORT=9226 bash packages/dev-tools/tools/dev-electron-swift-fresh.sh /Applications/Slack.app
#
# Prerequisites:
#   - cd packages/swift-server && swift build   (.build/debug/slicc-server)
#   - npm run build -w @slicc/webapp            (dist/ui; swift --electron mounts StaticFileMiddleware)
#   - Quit the target app first (or rely on --kill to relaunch it).
#
# Verify it: SLICC_CDP_PORT=$CDP_PORT node packages/dev-tools/tools/slicc-debug.mjs targets
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

BRIDGE_PORT="${PORT:-5740}"
CDP_PORT="${CDP_PORT:-9226}"
WRANGLER_PORT="${WRANGLER_PORT:-8787}"
ELECTRON_APP="${1:-${ELECTRON_APP:-/Applications/Slack.app}}"

SWIFT_BIN="${REPO_ROOT}/packages/swift-server/.build/debug/slicc-server"
STAGING_WORKER="https://slicc-tray-hub-staging.minivelos.workers.dev"
STAGING_GH_CLIENT_ID="Ov23liUe1b3b6GDjPGz4"

# ── 1. Validate the swift-server binary + the target Electron app ────
if [ ! -x "$SWIFT_BIN" ]; then
  echo "❌  swift-server binary not found at: $SWIFT_BIN"
  echo "    Build it first:  ( cd packages/swift-server && swift build )"
  exit 1
fi
if [ ! -d "$ELECTRON_APP" ]; then
  echo "❌  Electron app not found: $ELECTRON_APP"
  echo "    Pass a path:  npm run dev:electron:swift:fresh -- /Applications/Slack.app"
  exit 1
fi
echo "✔  swift-server: $SWIFT_BIN"
echo "✔  Electron app: $ELECTRON_APP"

# ── 1b. Stable code-signing for Keychain DR continuity (optional) ─────
# An ad-hoc-signed binary's Designated Requirement changes every `swift build`,
# so the Keychain "Always Allow" grant never sticks. Re-sign with the stable dev
# identity (setup-dev-cert.sh) when present so the DR is constant across rebuilds.
DEV_SIGN_IDENTITY="SLICC Dev Code Signing"
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$DEV_SIGN_IDENTITY"; then
  echo "🔏  Signing swift-server with stable dev identity: $DEV_SIGN_IDENTITY"
  codesign --force --sign "$DEV_SIGN_IDENTITY" "$SWIFT_BIN" 2>/dev/null \
    || echo "⚠️   codesign failed; continuing with the existing signature"
else
  echo "ℹ️   No stable dev signing identity — run setup-dev-cert.sh once to stop"
  echo "    repeated Keychain prompts across rebuilds."
fi

# ── 2. Reap stale processes on OUR OWN ports (strictly port-scoped) ──
# NEVER blanket-kill by app name — concurrent node (:5710/:9222), swift
# (:5720/:9224), ext (:9333), and electron-node (:5730/:9225) harnesses survive.
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

# ── 3. Reuse-or-start wrangler (UI / leader origin on :8787) ─────────
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

# ── 4. Cleanup trap (kills ONLY our own processes) ───────────────────
SWIFT_PID=""
cleanup() {
  echo ""
  echo "⏹  Shutting down electron-swift harness…"
  if [ -n "$SWIFT_PID" ]; then
    kill -TERM "$SWIFT_PID" 2>/dev/null || true
    wait "$SWIFT_PID" 2>/dev/null || true
  fi
  [ "$STARTED_WRANGLER" -eq 1 ] && [ -n "$WRANGLER_PID" ] && kill "$WRANGLER_PID" 2>/dev/null || true
  # Intentionally NO blanket app-kill — the relaunched app and concurrent
  # harnesses must survive.
}
trap cleanup EXIT INT TERM

# ── 5. Start swift-server in thin-electron attach mode ───────────────
# SLICC_HOSTED_LEADER_ORIGIN flips isThinElectronMode on; SLICC_BRIDGE_TOKEN (if
# present) is reused as the /cdp gate token, else swift mints one.
# SLICC_KEYCHAIN_NONINTERACTIVE=1 keeps SecretStore from hanging on a Keychain
# dialog this backgrounded launch can never answer (override with 0 once to grant).
echo "🔗  Attaching swift thin-bridge on :${BRIDGE_PORT} to ${ELECTRON_APP} (CDP :${CDP_PORT})…"
echo "    Overlay leader/follower load from http://localhost:${WRANGLER_PORT}/electron"
echo ""
WORKER_BASE_URL="http://localhost:${WRANGLER_PORT}" \
SLICC_HOSTED_LEADER_ORIGIN="http://localhost:${WRANGLER_PORT}" \
BRIDGE_DEV_ALLOWED_ORIGINS="http://localhost:${WRANGLER_PORT}" \
SLICC_KEYCHAIN_NONINTERACTIVE="${SLICC_KEYCHAIN_NONINTERACTIVE:-1}" \
PORT="$BRIDGE_PORT" \
  "$SWIFT_BIN" --electron --electron-app="$ELECTRON_APP" --kill --cdp-port="$CDP_PORT" &
SWIFT_PID=$!

wait "$SWIFT_PID"
