#!/usr/bin/env bash
# dev-tray-follower-attach — repeatable follower-attach test rig.
#
# Brings up BOTH ends of a tray in one shot so follower-attach can be
# exercised over and over without depending on a human-provided join URL:
#
#   1. a SLICC LEADER on Chrome for Testing  (node-server --lead=<worker>)
#   2. an Electron FOLLOWER (default AEM Desktop) that --join's the leader's
#      freshly-minted tray and is driven to attach.
#
# Both ends load the overlay/UI from the SAME origin as the tray worker
# (SLICC_HOSTED_LEADER_ORIGIN == --lead == SLICC_TRAY_WORKER_BASE_URL ==
# $WORKER). That same-origin pin is REQUIRED today: the cloudflare-worker's
# /tray + /join responses carry no CORS headers, so a cross-origin overlay
# (e.g. wrangler :8787 UI + staging tray) fails follower attach with
# "Failed to fetch" (see the Coordinator findings note). When the worker
# grows CORS this rig still works unchanged.
#
# It also DISPATCHES `slicc:tray-join` into the follower overlay after boot.
# That is a temporary belt-and-braces step: the node-server `--join` flag
# already lands the join URL in /api/runtime-config.trayJoinUrl, but the
# thin-bridge overlay fetches runtime-config from its OWN (hosted) origin,
# not from node-server, so auto-attach-on-boot does not fire yet. Once that
# webapp fix lands the overlay auto-attaches first and the dispatch is a
# harmless no-op.
#
# SAFETY: launches WITHOUT --kill (node-server's internal --kill is
# bundle-wide and would tear down a concurrent same-app float, e.g. the
# swift implementor's AEM harness). It reaps STRICTLY port-scoped on its own
# four ports, never blanket-kills by app name, and refuses to relaunch the
# Electron app if another instance is already running (so it can never
# clobber someone else's AEM). On exit it kills only the node-server bridges
# it started and the Electron pid THIS run spawned (pid-diffed).
#
# Usage:
#   bash packages/dev-tools/tools/dev-tray-follower-attach.sh
#   bash packages/dev-tools/tools/dev-tray-follower-attach.sh /Applications/Slack.app
#   LEADER_ONLY=1 bash packages/dev-tools/tools/dev-tray-follower-attach.sh   # validate CfT leader only
#   WORKER=https://www.sliccy.ai bash packages/dev-tools/tools/dev-tray-follower-attach.sh
#
# Prereqs: npm run build  (dist/node-server/index.js). CfT installed via
#   npx puppeteer browsers install chrome  (or set CHROME_PATH).
#
# Verify a run: SLICC_CDP_PORT=$FOLLOWER_CDP node packages/dev-tools/tools/slicc-debug.mjs targets
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
NODE_ENTRY="${REPO_ROOT}/dist/node-server/index.js"

LEADER_PORT="${LEADER_PORT:-5780}"
LEADER_CDP="${LEADER_CDP:-9232}"
FOLLOWER_PORT="${FOLLOWER_PORT:-5790}"
FOLLOWER_CDP="${FOLLOWER_CDP:-9233}"
ELECTRON_APP="${1:-${ELECTRON_APP:-/Applications/AEM Desktop.app}}"
WORKER="${WORKER:-https://slicc-tray-hub-staging.minivelos.workers.dev}"
LEADER_ONLY="${LEADER_ONLY:-0}"

RUNDIR="$(mktemp -d "${TMPDIR:-/tmp}/slicc-tray-attach.XXXXXX")"

# ── validate build ───────────────────────────────────────────────────
if [ ! -f "$NODE_ENTRY" ]; then
  echo "❌  node-server build missing: $NODE_ENTRY  (run: npm run build)"; exit 1
fi

# ── resolve a Chrome for Testing binary (CfT) for the leader ─────────
resolve_cft() {
  if [ -n "${CHROME_PATH:-}" ] && [ -x "$CHROME_PATH" ]; then echo "$CHROME_PATH"; return 0; fi
  local cache="$HOME/.cache/puppeteer/chrome"
  [ -d "$cache" ] || return 1
  local best
  best="$(ls -1 "$cache" 2>/dev/null | grep -i '^mac' | sort -rV | head -1)" || true
  [ -n "$best" ] || return 1
  local exe
  for sub in chrome-mac-arm64 chrome-mac-x64; do
    exe="$cache/$best/$sub/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    [ -x "$exe" ] && { echo "$exe"; return 0; }
  done
  return 1
}
CFT="$(resolve_cft || true)"
if [ -z "$CFT" ]; then
  echo "❌  Chrome for Testing not found. Install it:"
  echo "    npx puppeteer browsers install chrome   (or set CHROME_PATH=...)"; exit 1
fi
echo "✔  CfT leader binary: $CFT"
echo "✔  node-server:       $NODE_ENTRY"
echo "✔  tray worker:       $WORKER"
[ "$LEADER_ONLY" = "1" ] || echo "✔  follower app:      $ELECTRON_APP"

# ── port preflight: ABORT if occupied, never auto-clobber ───────────
# Hard lesson: blindly reaping a port can kill an UNRELATED float (an
# earlier version of this rig TERM'd a live follower that happened to sit
# on the default port). So we refuse to touch an occupied port. Set
# REAP=1 ONLY when you know the port holds a stale run of THIS rig.
force_kill_port() {
  local port="$1" pids p
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  for p in $pids; do kill -TERM "$p" 2>/dev/null || true; done
  sleep 2
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  for p in $pids; do kill -KILL "$p" 2>/dev/null || true; done
}
ensure_free() {
  local port="$1" label="$2" pids
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  if [ "${REAP:-0}" = "1" ]; then
    echo "♻️   REAP=1: clearing :$port ($label) — pid(s) $(echo "$pids" | tr '\n' ' ')"
    force_kill_port "$port"; return 0
  fi
  echo "❌  :$port ($label) is in use by pid(s): $(echo "$pids" | tr '\n' ' ')"
  echo "    Refusing to clobber it (it may be an unrelated float). Free it, pass"
  echo "    different ports, or set REAP=1 if it's a stale run of THIS rig."
  exit 1
}
ensure_free "$LEADER_PORT" "leader serve"
ensure_free "$LEADER_CDP" "leader CDP"
if [ "$LEADER_ONLY" != "1" ]; then
  ensure_free "$FOLLOWER_PORT" "follower serve"
  ensure_free "$FOLLOWER_CDP" "follower CDP"
fi

# ── cleanup trap: kill ONLY what this run started ────────────────────
LEADER_PID=""; FOLLOWER_PID=""; SPAWNED_APP_PID=""
cleanup() {
  echo ""; echo "⏹  tearing down tray-follower-attach rig…"
  [ -n "$FOLLOWER_PID" ] && kill -TERM "$FOLLOWER_PID" 2>/dev/null || true
  [ -n "$LEADER_PID" ] && kill -TERM "$LEADER_PID" 2>/dev/null || true
  [ -n "$SPAWNED_APP_PID" ] && kill -TERM "$SPAWNED_APP_PID" 2>/dev/null || true
  sleep 1
  # Force-close only the CfT Chrome WE launched (its CDP port), then keep
  # logs around for inspection (rig dir is a throwaway mktemp anyway).
  force_kill_port "$LEADER_CDP"
  echo "    logs preserved in: $RUNDIR"
}
trap cleanup EXIT INT TERM

# ── 1. launch the CfT leader ─────────────────────────────────────────
echo ""; echo "🚀  launching CfT leader on :${LEADER_PORT} (CDP :${LEADER_CDP})…"
LEADER_TOKEN="${SLICC_BRIDGE_TOKEN:-$(uuidgen | tr '[:upper:]' '[:lower:]')}"
CHROME_PATH="$CFT" \
SLICC_BRIDGE_TOKEN="$LEADER_TOKEN" \
WORKER_BASE_URL="$WORKER" \
SLICC_TRAY_WORKER_BASE_URL="$WORKER" \
SLICC_CDP_LAUNCH_TIMEOUT_MS=30000 \
PORT="$LEADER_PORT" \
  node "$NODE_ENTRY" --lead="$WORKER" --cdp-port="$LEADER_CDP" > "$RUNDIR/leader.log" 2>&1 &
LEADER_PID=$!
echo "    leader pid=$LEADER_PID  log=$RUNDIR/leader.log"

# ── 2. discover the leader's freshly-minted tray join URL ────────────
echo "🔎  waiting for leader tray join URL (/api/tray-status)…"
JOIN_URL=""
for i in $(seq 1 30); do
  JOIN_URL="$(curl -s --max-time 3 "http://localhost:${LEADER_PORT}/api/tray-status" 2>/dev/null \
    | grep -oE '"joinUrl"[ ]*:[ ]*"[^"]+"' | head -1 | sed -E 's/.*:[ ]*"([^"]+)"/\1/')" || true
  [ -n "$JOIN_URL" ] && break
  sleep 2
done
if [ -z "$JOIN_URL" ]; then
  echo "❌  leader never produced a tray join URL. Last 25 log lines:"
  tail -25 "$RUNDIR/leader.log" 2>/dev/null | sed -E 's/(bridgeToken=)[^&" ]+/\1<redacted>/g' | sed 's/^/    /'
  exit 1
fi
echo "✔  leader join URL: ${JOIN_URL%.*}.<redacted>"

if [ "$LEADER_ONLY" = "1" ]; then
  echo ""; echo "✅  LEADER-ONLY: CfT leader is up with a live tray. Ctrl-C to tear down."
  wait "$LEADER_PID"; exit 0
fi

# ── 3. refuse to clobber an already-running instance of the app ──────
APP_LEAF="$(basename "$ELECTRON_APP")"   # e.g. "AEM Desktop.app"
APP_MATCH="${APP_LEAF}/Contents/MacOS"
pids_before="$(pgrep -f "$APP_MATCH" 2>/dev/null | grep -v dev-electron || true)"
if [ -n "$pids_before" ]; then
  echo "❌  ${APP_LEAF} is already running (pids: $(echo "$pids_before" | tr '\n' ' '))."
  echo "    Refusing to relaunch without --kill (bundle-wide kill would clobber a"
  echo "    concurrent same-app float). Quit that instance first, or run LEADER_ONLY=1."
  exit 1
fi

# ── 4. launch the Electron follower (no --kill), --join the leader ───
echo ""; echo "🚀  launching ${APP_LEAF} follower on :${FOLLOWER_PORT} (CDP :${FOLLOWER_CDP})…"
FOLLOWER_TOKEN="$(uuidgen | tr '[:upper:]' '[:lower:]')"
SLICC_HOSTED_LEADER_ORIGIN="$WORKER" \
WORKER_BASE_URL="$WORKER" \
SLICC_TRAY_WORKER_BASE_URL="$WORKER" \
SLICC_BRIDGE_TOKEN="$FOLLOWER_TOKEN" \
BRIDGE_DEV_ALLOWED_ORIGINS="$WORKER" \
SLICC_CDP_LAUNCH_TIMEOUT_MS=30000 \
PORT="$FOLLOWER_PORT" \
  node "$NODE_ENTRY" --electron --electron-app="$ELECTRON_APP" --join "$JOIN_URL" \
  --cdp-port="$FOLLOWER_CDP" > "$RUNDIR/follower.log" 2>&1 &
FOLLOWER_PID=$!
echo "    follower pid=$FOLLOWER_PID  log=$RUNDIR/follower.log"

# Track the app pid THIS run spawned so cleanup kills only it (pid-diff).
for i in $(seq 1 20); do
  pids_after="$(pgrep -f "$APP_MATCH" 2>/dev/null | grep -v dev-electron || true)"
  SPAWNED_APP_PID="$(comm -13 <(echo "$pids_before" | sort) <(echo "$pids_after" | sort) | head -1)" || true
  [ -n "$SPAWNED_APP_PID" ] && { echo "    spawned ${APP_LEAF} pid=$SPAWNED_APP_PID"; break; }
  sleep 1
done

# ── 5. drive the follower attach (auto-attach workaround, see header) ─
cat > "$RUNDIR/tray-join.mjs" <<'MJS'
const CDP = process.env.SLICC_CDP_PORT;
const JOIN = process.env.JOIN_URL;
const r = await fetch('http://127.0.0.1:' + CDP + '/json');
const targets = await r.json();
const t = targets.find((x) => /\/electron\?/.test(x.url) && /role=(leader|follower)/.test(x.url));
if (!t) { console.log('no overlay iframe target yet'); process.exit(0); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((res) => ws.addEventListener('open', res));
await send('Runtime.enable');
const expr = '(function(){try{window.dispatchEvent(new CustomEvent("slicc:tray-join",{detail:{joinUrl:' + JSON.stringify(JOIN) + '}}));return "dispatched";}catch(e){return "err:"+String(e);}})()';
const d = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log('slicc:tray-join =>', d.result && d.result.result && d.result.result.value);
ws.close();
MJS

echo "⏳  waiting for overlay to boot, then dispatching slicc:tray-join…"
sleep 16
SLICC_CDP_PORT="$FOLLOWER_CDP" JOIN_URL="$JOIN_URL" node "$RUNDIR/tray-join.mjs" || true

# ── 6. verify participantCount reaches 2 ─────────────────────────────
echo "🔬  verifying tray participantCount…"
OK=0
for i in $(seq 1 8); do
  PC="$(curl -s --max-time 6 -H 'Accept: application/json' "${JOIN_URL}?json=true" 2>/dev/null \
    | grep -oE '"participantCount"[ ]*:[ ]*[0-9]+' | grep -oE '[0-9]+$' || true)"
  echo "    poll $i: participantCount=${PC:-?}"
  if [ "${PC:-0}" -ge 2 ] 2>/dev/null; then OK=1; break; fi
  sleep 4
done
if [ "$OK" = "1" ]; then
  echo ""; echo "✅  FOLLOWER ATTACHED — participantCount=2 (leader + ${APP_LEAF})."
else
  echo ""; echo "⚠️   follower did not reach participantCount=2; inspect $RUNDIR/follower.log"
fi
echo "    Ctrl-C to tear down (kills only this run's bridges + spawned app)."
wait "$FOLLOWER_PID"
