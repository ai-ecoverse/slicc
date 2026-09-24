#!/usr/bin/env bash

















set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

BRIDGE_PORT="${PORT:-5720}"
CDP_PORT="${CDP_PORT:-9224}"
WRANGLER_PORT="${WRANGLER_PORT:-8787}"

SWIFT_BIN="${REPO_ROOT}/packages/swift-server/.build/debug/slicc-server"
STAGING_WORKER="https://slicc-tray-hub-staging.minivelos.workers.dev"
STAGING_GH_CLIENT_ID="Ov23liUe1b3b6GDjPGz4"


if [ ! -x "$SWIFT_BIN" ]; then
  echo "❌  swift-server binary not found at: $SWIFT_BIN"
  echo "    Build it first:  ( cd packages/swift-server && swift build )"
  exit 1
fi
echo "✔  swift-server: $SWIFT_BIN"






DEV_SIGN_IDENTITY="SLICC Dev Code Signing"
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$DEV_SIGN_IDENTITY"; then
  echo "🔏  Signing swift-server with stable dev identity: $DEV_SIGN_IDENTITY"
  codesign --force --sign "$DEV_SIGN_IDENTITY" "$SWIFT_BIN" 2>/dev/null \
    || echo "⚠️   codesign failed; continuing with the existing signature"
else
  echo "ℹ️   No stable dev signing identity found — continuing with the ad-hoc"
  echo "    signature. Run packages/dev-tools/tools/setup-dev-cert.sh once to"
  echo "    stop repeated Keychain prompts across rebuilds."
fi









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
reap_port "$CDP_PORT" "Chrome CDP"


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









CHROME_LABEL="${CHROME_LABEL:-SLICC-Swift}"
CHROME_BIN="$CFT"
CFT_APP=""
case "$CFT" in
  *.app/Contents/MacOS/*) CFT_APP="${CFT%.app/Contents/MacOS/*}.app" ;;
esac
if [ -n "$CFT_APP" ]; then
  if LABELED_APP="$(bash "$SCRIPT_DIR/clone-labeled-chrome.sh" "$CFT_APP" "$CHROME_LABEL")" \
    && [ -x "$LABELED_APP/Contents/MacOS/$(basename "$CFT")" ]; then
    CHROME_BIN="$LABELED_APP/Contents/MacOS/$(basename "$CFT")"
    echo "✔  Labeled bundle: $LABELED_APP (⌘-Tab: $CHROME_LABEL)"
  else
    echo "⚠️   Labeled-clone failed — launching unlabeled $CFT_APP"
  fi
fi







SWIFT_PROFILE="${HOME}/Library/Application Support/Slicc/profiles/browser-coding-agent-chrome-${BRIDGE_PORT}"
rm -rf "$SWIFT_PROFILE" 2>/dev/null || true
echo "✔  Fresh swift profile: $SWIFT_PROFILE"





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










wrangler_up() {
  curl -s --max-time 2 "http://127.0.0.1:${WRANGLER_PORT}/status" 2>/dev/null |
    grep -q '"service"[[:space:]]*:[[:space:]]*"slicc-tray-hub"'
}




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
    if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then
      echo "❌  Wrangler exited before binding :${WRANGLER_PORT}"
      echo "    If something else already holds that port, it is not the SLICC"
      echo "    worker (/status did not identify it) — stop it or set WRANGLER_PORT."
      exit 1
    fi
    [ "$i" -eq 30 ] && { echo "❌  Wrangler failed to start"; kill "$WRANGLER_PID" 2>/dev/null || true; exit 1; }
    sleep 1
  done
fi


SWIFT_PID=""
cleanup() {
  echo ""
  echo "⏹  Shutting down swift harness…"
  if [ -n "$SWIFT_PID" ]; then

    kill -TERM "$SWIFT_PID" 2>/dev/null || true
    wait "$SWIFT_PID" 2>/dev/null || true
  fi
  if [ "$STARTED_WRANGLER" -eq 1 ] && [ -n "$WRANGLER_PID" ]; then
    kill "$WRANGLER_PID" 2>/dev/null || true
  fi


}
trap cleanup EXIT INT TERM


echo "🔗  Starting swift thin-bridge on :${BRIDGE_PORT} (Chrome CDP :${CDP_PORT})…"
echo ""










CHROME_PATH="$CHROME_BIN" \
WORKER_BASE_URL="http://localhost:${WRANGLER_PORT}" \
BRIDGE_DEV_ALLOWED_ORIGINS="http://localhost:${WRANGLER_PORT}" \
SLICC_KEYCHAIN_NONINTERACTIVE="${SLICC_KEYCHAIN_NONINTERACTIVE:-1}" \
SLICC_CHROME_MOCK_KEYCHAIN=1 \
PORT="$BRIDGE_PORT" \
  "$SWIFT_BIN" --cdp-port "$CDP_PORT" &
SWIFT_PID=$!


wait "$SWIFT_PID"
