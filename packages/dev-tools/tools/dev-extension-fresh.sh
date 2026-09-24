#!/usr/bin/env bash








































set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

CDP_PORT="${CDP_PORT:-9333}"
WRANGLER_PORT="${WRANGLER_PORT:-8787}"
EXT_PATH="${SLICC_EXT_PATH:-/tmp/slicc-ext-build}"
EXT_PROFILE="${SLICC_EXT_PROFILE:-/tmp/slicc-ext-profile}"

STAGING_WORKER="https://slicc-tray-hub-staging.minivelos.workers.dev"
STAGING_GH_CLIENT_ID="Ov23liUe1b3b6GDjPGz4"


echo "🏗  Building chrome-extension (SLICC_EXT_DEV=1)…"
SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension
if [ ! -f "${REPO_ROOT}/dist/extension/manifest.json" ]; then
  echo "❌  Extension build missing: ${REPO_ROOT}/dist/extension/manifest.json"
  exit 1
fi


echo "📦  Syncing dist/extension → ${EXT_PATH}"
rm -rf "$EXT_PATH"
cp -r "${REPO_ROOT}/dist/extension" "$EXT_PATH"


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









CFT_APP=""
case "$CFT" in
  *.app/Contents/MacOS/*) CFT_APP="${CFT%.app/Contents/MacOS/*}.app" ;;
esac
if [ -n "$CFT_APP" ]; then
  echo "✔  App bundle: $CFT_APP (launching via LaunchServices)"
else
  echo "⚠️   No .app bundle resolved for $CFT — raw-exec fallback (Web Speech may be inert)"
fi






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


rm -rf "$EXT_PROFILE"
mkdir -p "$EXT_PROFILE"
echo "✔  Fresh extension profile: $EXT_PROFILE"







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




  RC="$(curl -s "http://localhost:${WRANGLER_PORT}/api/runtime-config" 2>/dev/null || true)"
  if ! printf '%s' "$RC" | grep -q '"trayWorkerBaseUrl":"http://localhost:8787"'; then
    echo "✖  Reused wrangler on :${WRANGLER_PORT} is NOT a same-origin local tray"
    echo "   (trayWorkerBaseUrl must be exactly http://localhost:8787; got: ${RC})."
    echo "   Kill it (pkill -f 'wrangler dev') and re-run so the cherry panel can connect."
    exit 1
  fi
else
  echo "🌐  Starting wrangler on :${WRANGLER_PORT}…"
  npx wrangler dev \
    --config "${REPO_ROOT}/packages/cloudflare-worker/wrangler.jsonc" \
    --env staging \
    --port "$WRANGLER_PORT" --ip 127.0.0.1 \
    --var "GITHUB_CLIENT_ID:${STAGING_GH_CLIENT_ID}" \
    --var "ALLOWED_CHERRY_HOST_ORIGINS:* chrome-extension://bdgicfcdbgckhdcpklcefkogmahcogbd" &
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


CHROME_PID=""
OPEN_PID=""
cleanup() {
  echo ""
  echo "⏹  Shutting down extension harness…"
  if [ -n "$CHROME_PID" ]; then
    kill -TERM "$CHROME_PID" 2>/dev/null || true
    wait "$CHROME_PID" 2>/dev/null || true
  elif [ -n "$OPEN_PID" ]; then



    reap_port "$CDP_PORT"
    kill -TERM "$OPEN_PID" 2>/dev/null || true
    wait "$OPEN_PID" 2>/dev/null || true
  fi
  [ "$STARTED_WRANGLER" -eq 1 ] && [ -n "$WRANGLER_PID" ] && kill "$WRANGLER_PID" 2>/dev/null || true


}
trap cleanup EXIT INT TERM


echo "🧩  Launching Chrome for Testing with the extension (CDP :${CDP_PORT})…"
echo "    Leader: http://localhost:${WRANGLER_PORT}/?slicc=leader"
echo ""
CHROME_ARGS=(
  --user-data-dir="$EXT_PROFILE"
  --remote-debugging-port="$CDP_PORT"
  --no-first-run
  --no-default-browser-check
  --disable-crash-reporter



  --use-mock-keychain
  --password-store=basic
  --disable-extensions-except="$EXT_PATH"
  --load-extension="$EXT_PATH"
  "http://localhost:${WRANGLER_PORT}/?slicc=leader"
)
if [ -n "$CFT_APP" ]; then




  GOOGLE_CRASHPAD_DISABLE=1 /usr/bin/open -n -W -a "$LAUNCH_APP" --args "${CHROME_ARGS[@]}" &
  OPEN_PID=$!
else
  GOOGLE_CRASHPAD_DISABLE=1 "$CFT" "${CHROME_ARGS[@]}" &
  CHROME_PID=$!
fi


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




if [ -n "$CHROME_PID" ]; then
  wait "$CHROME_PID"
else
  wait "$OPEN_PID"
fi
