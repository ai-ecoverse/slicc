#!/usr/bin/env bash
# dev-extension-fresh — launch the chrome-extension thin-bridge float against
# the hosted webapp on a fresh, isolated Chrome for Testing profile so it can
# run alongside a live node-server (:5710/:9222) and swift-server (:5720/:9224)
# harness without port/profile collisions.  Mirrors dev-standalone-fresh.sh /
# dev-swift-fresh.sh.
#
# Unlike the node/swift floats there is NO separate thin-bridge process: the
# extension's MV3 service worker IS the bridge.  This script therefore owns the
# Chrome for Testing lifecycle directly — it builds the extension with
# SLICC_EXT_DEV=1 (strips the manifest `key`, widens `externally_connectable`
# to localhost), syncs it to a stable scratch path (stable path-derived
# extension ID), ensures the wrangler UI/leader origin is up on :8787, and
# launches Chrome for Testing with the extension preloaded on CDP :9333.  It
# launches through LaunchServices (`/usr/bin/open -n -a <AppBundle>`, mirroring
# node-server's planChromeSpawn) so Chrome gets a full macOS app-bundle identity
# — without it Chrome's Web Speech network backend never initializes and builtin
# webkitSpeechRecognition is a silent no-op (raw-binary exec lacks that
# identity).  The
# extension's service worker then pins the leader tab at
# http://localhost:8787/?slicc=leader (the DEV_LEADER_TAB_URL the dev build
# resolves to).
#
# It is careful NOT to disturb a node/swift harness that may already be running:
#   - uses its own CDP port (9333) and its own profile path
#   - reuses an existing wrangler on :8787 instead of starting a second one
#   - NEVER blanket-kills "Google Chrome for Testing" by name (that would close
#     the node/swift harness windows too); it reaps only the PID bound to its
#     own CDP port and, on exit, kills only the Chrome it launched.
#
# Usage:
#   npm run dev:extension:fresh
#   CDP_PORT=9444 bash packages/dev-tools/tools/dev-extension-fresh.sh
#
# Prerequisites:
#   - npm install   (extension deps; NS3 hash/zlib deps already installed)
#   - npx playwright install chromium
#
# Pairs with slicc-debug.mjs (SLICC_CDP_PORT=9333) for verification, and with
# `npm run dev:extension -w @slicc/chrome-extension` for live rebuild+reload
# (that watcher syncs to SLICC_EXT_PATH and CDP-reloads on SLICC_CDP_PORT).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

CDP_PORT="${CDP_PORT:-9333}"
WRANGLER_PORT="${WRANGLER_PORT:-8787}"
EXT_PATH="${SLICC_EXT_PATH:-/tmp/slicc-ext-build}"
EXT_PROFILE="${SLICC_EXT_PROFILE:-/tmp/slicc-ext-profile}"

STAGING_WORKER="https://slicc-tray-hub-staging.minivelos.workers.dev"
STAGING_GH_CLIENT_ID="Ov23liUe1b3b6GDjPGz4"

# ── 1. Build the extension (dev manifest: key stripped, localhost widened) ──
echo "🏗  Building chrome-extension (SLICC_EXT_DEV=1)…"
SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension
if [ ! -f "${REPO_ROOT}/dist/extension/manifest.json" ]; then
  echo "❌  Extension build missing: ${REPO_ROOT}/dist/extension/manifest.json"
  exit 1
fi

# ── 2. Sync to a stable scratch path (stable path-derived extension ID) ──
echo "📦  Syncing dist/extension → ${EXT_PATH}"
rm -rf "$EXT_PATH"
cp -r "${REPO_ROOT}/dist/extension" "$EXT_PATH"

# ── 3. Resolve Chrome for Testing ────────────────────────────────────
CFT=""
PW_CACHE="${HOME}/Library/Caches/ms-playwright"
if [ -d "$PW_CACHE" ]; then
  CFT=$(find "$PW_CACHE" -name "Google Chrome for Testing" -type f 2>/dev/null | sort -V | tail -1)
fi
if [ -z "$CFT" ] && [ -d "${HOME}/.cache/puppeteer/chrome" ]; then
  CFT=$(find "${HOME}/.cache/puppeteer/chrome" -name "Google Chrome for Testing" -type f 2>/dev/null | sort -V | tail -1)
fi
if [ -z "$CFT" ]; then
  echo "❌  Chrome for Testing not found.  Run:  npx playwright install chromium"
  exit 1
fi
echo "✔  Chrome for Testing: $CFT"

# Resolve the enclosing .app bundle so we can launch via LaunchServices
# (/usr/bin/open -n -a), mirroring planChromeSpawn()/resolveChromeAppBundle()
# in packages/node-server/src/chrome-launch.ts. LaunchServices grants Chrome a
# full macOS app-bundle identity; Chrome's Web Speech network backend (and the
# TCC mic-grant path) only initialize with that identity. Exec'ing the raw CfT
# helper binary directly leaves builtin webkitSpeechRecognition a silent no-op
# (start() accepted, zero lifecycle events). Falls back to a raw exec when no
# bundle can be resolved (e.g. a bare-binary install).
CFT_APP=""
case "$CFT" in
  *.app/Contents/MacOS/*) CFT_APP="${CFT%.app/Contents/MacOS/*}.app" ;;
esac
if [ -n "$CFT_APP" ]; then
  echo "✔  App bundle: $CFT_APP (launching via LaunchServices)"
else
  echo "⚠️   No .app bundle resolved for $CFT — raw-exec fallback (Web Speech may be inert)"
fi

# Clone the bundle under a distinct CFBundleName/CFBundleIdentifier so this
# float shows up as its own named entry ("SLICC-Ext") in the macOS ⌘-Tab App
# Switcher instead of yet another "Google Chrome for Testing". Only applies on
# the LaunchServices path (a real .app bundle); the raw-exec fallback can't be
# relabeled. Falls back to the unlabeled bundle if the clone helper fails.
LAUNCH_APP="$CFT_APP"
CHROME_LABEL="${CHROME_LABEL:-SLICC-Ext}"
if [ -n "$CFT_APP" ]; then
  if LABELED_APP="$(bash "$SCRIPT_DIR/clone-labeled-chrome.sh" "$CFT_APP" "$CHROME_LABEL")" \
    && [ -d "$LABELED_APP" ]; then
    LAUNCH_APP="$LABELED_APP"
    echo "✔  Labeled bundle: $LAUNCH_APP (⌘-Tab: $CHROME_LABEL)"
  else
    echo "⚠️   Labeled-clone failed — launching unlabeled $CFT_APP"
  fi
fi

# ── 4. Reap a stale Chrome on OUR OWN CDP port (port-scoped, never by name) ──
reap_port() {
  local port="$1" pids pid
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  for pid in $pids; do
    echo "♻️   Reaping stale pid $pid on :$port — TERM"
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
reap_port "$CDP_PORT"

# ── 5. Fresh, dedicated Chrome profile ───────────────────────────────
rm -rf "$EXT_PROFILE"
mkdir -p "$EXT_PROFILE"
echo "✔  Fresh extension profile: $EXT_PROFILE"

# ── 6a. Build the leader UI (dist/ui) if missing ─────────────────────
# wrangler serves dist/ui via the ASSETS binding with SPA fallback
# (not_found_handling: "single-page-application"). When dist/ui/index.html is
# absent EVERY route 404s and the leader at /?slicc=leader never loads — the
# harness only builds the extension, never the webapp. Build it on demand (fast
# no-op when already present), hard-failing if the build does not produce it.
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

# ── 6b. Reuse-or-start wrangler (UI / leader origin) ─────────────────
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
      exit 1
    fi
    [ "$i" -eq 30 ] && { echo "❌  Wrangler failed to start"; kill "$WRANGLER_PID" 2>/dev/null || true; exit 1; }
    sleep 1
  done
fi

# ── 7. Cleanup trap (kills ONLY our own processes) ───────────────────
CHROME_PID=""
OPEN_PID=""
cleanup() {
  echo ""
  echo "⏹  Shutting down extension harness…"
  if [ -n "$CHROME_PID" ]; then
    kill -TERM "$CHROME_PID" 2>/dev/null || true
    wait "$CHROME_PID" 2>/dev/null || true
  elif [ -n "$OPEN_PID" ]; then
    # LaunchServices path: Chrome is NOT our child, and the `open -W` shim
    # does not forward a kill to the launched app. Reap our own Chrome by
    # its CDP port (port-scoped, never by name), then reap the open shim.
    reap_port "$CDP_PORT"
    kill -TERM "$OPEN_PID" 2>/dev/null || true
    wait "$OPEN_PID" 2>/dev/null || true
  fi
  [ "$STARTED_WRANGLER" -eq 1 ] && [ -n "$WRANGLER_PID" ] && kill "$WRANGLER_PID" 2>/dev/null || true
  # Intentionally NO `pkill Google Chrome for Testing` — node/swift harness
  # Chrome windows must survive.
}
trap cleanup EXIT INT TERM

# ── 8. Launch Chrome for Testing with the extension preloaded ────────
echo "🧩  Launching Chrome for Testing with the extension (CDP :${CDP_PORT})…"
echo "    Leader: http://localhost:${WRANGLER_PORT}/?slicc=leader"
echo ""
CHROME_ARGS=(
  --user-data-dir="$EXT_PROFILE"
  --remote-debugging-port="$CDP_PORT"
  --no-first-run
  --no-default-browser-check
  --disable-crash-reporter
  --disable-extensions-except="$EXT_PATH"
  --load-extension="$EXT_PATH"
  "http://localhost:${WRANGLER_PORT}/?slicc=leader"
)
if [ -n "$CFT_APP" ]; then
  # LaunchServices launch (app-bundle identity) — mirrors planChromeSpawn().
  # `-n` forces a new instance, `-W` keeps the open shim alive until Chrome
  # exits so the final `wait` blocks like a foreground service process.
  # $LAUNCH_APP is the relabeled clone ("SLICC-Ext") when available, else $CFT_APP.
  GOOGLE_CRASHPAD_DISABLE=1 /usr/bin/open -n -W -a "$LAUNCH_APP" --args "${CHROME_ARGS[@]}" &
  OPEN_PID=$!
else
  GOOGLE_CRASHPAD_DISABLE=1 "$CFT" "${CHROME_ARGS[@]}" &
  CHROME_PID=$!
fi

# ── 9. Wait for CDP, then report the path-derived extension ID ───────
for i in $(seq 1 30); do
  curl -sf -o /dev/null "http://localhost:${CDP_PORT}/json/version" 2>/dev/null && break
  [ "$i" -eq 30 ] && { echo "❌  CDP did not come up on :${CDP_PORT}"; exit 1; }
  sleep 1
done
EXT_ID=$(curl -sS "http://localhost:${CDP_PORT}/json/list" 2>/dev/null | python3 -c '
import json,sys
for t in json.load(sys.stdin):
    u = t.get("url") or ""
    if "service-worker.js" in u and u.startswith("chrome-extension://"):
        print(u.split("/")[2]); break
' 2>/dev/null || true)
if [ -n "$EXT_ID" ]; then
  echo "✔  Extension loaded — ID: $EXT_ID"
  echo "   SW: chrome-extension://$EXT_ID/service-worker.js"
else
  echo "⚠️   Extension SW target not visible yet (MV3 SW may be idle); CDP is up on :${CDP_PORT}."
fi
echo "✔  Extension float up. CDP :${CDP_PORT} · leader http://localhost:${WRANGLER_PORT}/?slicc=leader"
echo "   Drive it: SLICC_CDP_PORT=${CDP_PORT} node packages/dev-tools/tools/slicc-debug.mjs targets"
echo ""

# Block until Chrome exits (keeps this a foreground/service process). In the
# LaunchServices path Chrome isn't our child, so we block on the `open -W` shim
# (alive until Chrome quits); the raw-exec fallback blocks on Chrome directly.
if [ -n "$CHROME_PID" ]; then
  wait "$CHROME_PID"
else
  wait "$OPEN_PID"
fi
