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

# ── 1b. Stable code-signing for Keychain DR continuity (optional) ─────
# An ad-hoc-signed binary's Designated Requirement changes every `swift build`,
# so the Keychain "Always Allow" grant never sticks and macOS re-prompts —
# which HANGS this headless launch. If the stable dev identity exists (created
# by setup-dev-cert.sh), re-sign with it so the DR is constant across rebuilds.
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

# ── 1c. Reap stale processes on OUR OWN ports ────────────────────────
# A prior hung run can leave a slicc-server holding :$BRIDGE_PORT or a
# Chrome for Testing holding :$CDP_PORT, which makes this launch abort with
# "Port already in use".  Reap them — but STRICTLY port-scoped: resolve the
# PID from the specific listening port and kill ONLY that PID.  NEVER
# blanket-kill "Google Chrome for Testing" by name (a concurrent node harness
# Chrome must survive — see the header invariant).  :5710/:9222 (node float)
# and :8787 (shared wrangler) are different ports and are never touched here.
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

# ── 2b. Labeled bundle clone for ⌘-Tab distinguishability (macOS) ─────
# Clone the resolved Chrome for Testing bundle under a distinct
# CFBundleName/CFBundleIdentifier so this float shows up as its own named
# entry ("SLICC-Swift") in the macOS ⌘-Tab App Switcher instead of yet another
# "Google Chrome for Testing".  swift-server resolves CHROME_PATH's enclosing
# .app and relaunches it via LaunchServices, so pointing CHROME_PATH at the
# clone's inner binary yields the labeled bundle.  Falls back to the original
# binary if cloning fails or no .app bundle can be resolved.
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
# SLICC_KEYCHAIN_NONINTERACTIVE defaults to 1 so SecretStore fail-fasts instead
# of hanging on the macOS Keychain ACL dialog this backgrounded launch can never
# answer. If access was already granted (stable DR + Always Allow, or the
# set-generic-password-partition-list grant) the read still succeeds; otherwise
# the server starts without Keychain secrets and prints an actionable hint.
# Override with SLICC_KEYCHAIN_NONINTERACTIVE=0 for a one-time INTERACTIVE run
# (foreground terminal) to answer the prompt and establish the durable grant.
CHROME_PATH="$CHROME_BIN" \
WORKER_BASE_URL="http://localhost:${WRANGLER_PORT}" \
BRIDGE_DEV_ALLOWED_ORIGINS="http://localhost:${WRANGLER_PORT}" \
SLICC_KEYCHAIN_NONINTERACTIVE="${SLICC_KEYCHAIN_NONINTERACTIVE:-1}" \
PORT="$BRIDGE_PORT" \
  "$SWIFT_BIN" --cdp-port "$CDP_PORT" &
SWIFT_PID=$!

# Forward signals to swift-server and block until it exits.
wait "$SWIFT_PID"
