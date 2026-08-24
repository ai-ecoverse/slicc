#!/usr/bin/env bash
# dev:standalone:fresh — launch the two-service standalone harness
# (wrangler UI + node-server thin-bridge) with a brand-new Chrome for
# Testing profile. Fails fast when its bridge port is occupied and uses an
# ephemeral profile so the session starts clean without disturbing concurrent
# harnesses. Set SLICC_FRESH_REAP=1 to explicitly reap the bridge holder.
#
# Usage:
#   npm run dev:standalone:fresh
#   PORT=5720 npm run dev:standalone:fresh   # override bridge port
#   CHROME_PATH="/Applications/Google Chrome Canary.app" npm run dev:standalone:fresh
#                                            # launch your own browser instead
#                                            # of Chrome for Testing
#
# Prerequisites:
#   - npm run build  (or at least webapp + node-server)
#   - npx playwright install chromium
set -euo pipefail

# Documented production bridge: valid when free, never eligible for automated reaping.
PRODUCTION_BRIDGE_PORT=5710

canonicalize_port() {
	local port="${1:-}"
	case "$port" in
	"" | *[!0-9]*) return 1 ;;
	0 | 0*) return 1 ;;
	esac
	[ "${#port}" -le 5 ] || return 1
	[ "$port" -le 65535 ] || return 1
	printf '%s\n' "$port"
}

is_protected_port() {
	case "${1:-}" in
	9222 | 9223) return 0 ;;
	*) return 1 ;;
	esac
}

bridge_port_guard_action() {
	local port="${1:-}" holders="${2:-}" force_reap="${3:-0}"
	if ! port="$(canonicalize_port "$port")"; then
		echo "invalid"
		return 0
	fi
	if is_protected_port "$port"; then
		echo "protected"
	elif [ -z "$holders" ]; then
		echo "proceed"
	elif [ "$force_reap" = "1" ] && [ "$port" = "$PRODUCTION_BRIDGE_PORT" ]; then
		echo "production-protected"
	elif [ "$force_reap" = "1" ]; then
		echo "reap"
	else
		echo "fail-fast"
	fi
}

reap_port() {
	local requested_port="$1" port label="$2" pids pid
	if ! port="$(canonicalize_port "$requested_port")"; then
		echo "❌  Refusing to reap invalid port: $requested_port" >&2
		return 1
	fi
	if is_protected_port "$port"; then
		echo "❌  Refusing to reap protected Chrome/Electron CDP port :$port" >&2
		return 1
	fi
	if [ "$port" = "$PRODUCTION_BRIDGE_PORT" ]; then
		echo "❌  Refusing to reap documented production bridge :$port. Choose a different port, or stop your own :$port process manually." >&2
		return 1
	fi
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

print_bridge_port_suggestions() {
	local requested_port="$1" port
	if ! port="$(canonicalize_port "$requested_port")"; then
		echo "    Choose a different unused bridge port." >&2
		return 0
	fi
	echo "    Re-run with a different unused port: PORT=<unused-port> npm run dev:standalone:fresh" >&2
	if [ "$port" = "$PRODUCTION_BRIDGE_PORT" ]; then
		echo "    Automated reaping of :$port is disabled; stop your own :$port process manually instead." >&2
	else
		echo "    Or explicitly opt into reaping the bridge holder: SLICC_FRESH_REAP=1 PORT=$port npm run dev:standalone:fresh" >&2
	fi
}

# Allow Vitest to source and exercise the guard and protected-port refusal
# without running browser discovery, builds, port checks, or harness processes.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
	return 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

BRIDGE_PORT_INPUT="${PORT:-5710}"
if ! BRIDGE_PORT="$(canonicalize_port "$BRIDGE_PORT_INPUT")"; then
	echo "❌  PORT must be one decimal port from 1 to 65535: $BRIDGE_PORT_INPUT" >&2
	exit 1
fi
WRANGLER_PORT="${WRANGLER_PORT:-8787}"

# ── 1. Guard the bridge port ─────────────────────────────────────────
if is_protected_port "$BRIDGE_PORT"; then
	echo "❌  Bridge port :$BRIDGE_PORT is reserved for Chrome/Electron CDP and cannot be reaped" >&2
	exit 1
fi

BRIDGE_HOLDERS="$(lsof -nP -iTCP:"$BRIDGE_PORT" -sTCP:LISTEN 2>/dev/null || true)"
case "$(bridge_port_guard_action "$BRIDGE_PORT" "$BRIDGE_HOLDERS" "${SLICC_FRESH_REAP:-0}")" in
proceed) ;;
reap) reap_port "$BRIDGE_PORT" "bridge" ;;
production-protected)
	echo "❌  Refusing to reap documented production bridge :$BRIDGE_PORT. Choose a different port, or stop your own :$BRIDGE_PORT process manually." >&2
	exit 1
	;;
invalid)
	echo "❌  Refusing invalid bridge port: $BRIDGE_PORT" >&2
	exit 1
	;;
fail-fast)
	echo "❌  Bridge port :$BRIDGE_PORT is already in use:" >&2
	printf '%s\n' "$BRIDGE_HOLDERS" >&2
	print_bridge_port_suggestions "$BRIDGE_PORT"
	exit 1
	;;
esac

# Standalone node-server launches Chrome with requestedCdpPort = 0, so Chrome
# self-selects its CDP port and slicc-cdp greps that port from the harness log.
# Any process listening on :9222 is therefore foreign and must not be touched.

# ── 2. Resolve the browser binary ────────────────────────────────────
# Default: the newest Chrome for Testing from the Playwright cache, cloned
# under a labeled bundle for ⌘-Tab distinguishability. Override by exporting
# CHROME_PATH (a .app bundle or the inner binary) to launch your own browser
# (e.g. Google Chrome Canary); the labeled-clone step is skipped in that case.
CHROME_BIN=""
if [ -n "${CHROME_PATH:-}" ]; then
	case "$CHROME_PATH" in
	*.app) CHROME_BIN="$CHROME_PATH/Contents/MacOS/$(basename "${CHROME_PATH%.app}")" ;;
	*) CHROME_BIN="$CHROME_PATH" ;;
	esac
	if [ ! -x "$CHROME_BIN" ]; then
		echo "❌  CHROME_PATH set but no executable at: $CHROME_BIN"
		exit 1
	fi
	echo "✔  Using CHROME_PATH: $CHROME_BIN"
else
	CFT=""
	PW_CACHE="${HOME}/Library/Caches/ms-playwright"
	if [ -d "$PW_CACHE" ]; then
		# Pick the newest chromium-* revision
		CFT=$(find "$PW_CACHE" -name "Google Chrome for Testing" -type f 2>/dev/null |
			sort -V | tail -1)
	fi
	if [ -z "$CFT" ]; then
		echo "❌  Chrome for Testing not found.  Run:  npx playwright install chromium"
		echo "    (or export CHROME_PATH to use another browser, e.g. Chrome Canary)"
		exit 1
	fi
	echo "✔  Chrome for Testing: $CFT"

	# Labeled bundle clone for ⌘-Tab distinguishability (macOS): clone the
	# resolved Chrome for Testing bundle under a distinct
	# CFBundleName/CFBundleIdentifier so this float shows up as its own named
	# entry ("SLICC-Node") in the macOS ⌘-Tab App Switcher instead of yet another
	# "Google Chrome for Testing".  node-server resolves CHROME_PATH's enclosing
	# .app and relaunches it via LaunchServices, so pointing CHROME_PATH at the
	# clone's inner binary yields the labeled bundle.  Falls back to the original
	# binary if cloning fails or no .app bundle can be resolved.
	CHROME_LABEL="${CHROME_LABEL:-SLICC-Node}"
	CHROME_BIN="$CFT"
	CFT_APP=""
	case "$CFT" in
	*.app/Contents/MacOS/*) CFT_APP="${CFT%.app/Contents/MacOS/*}.app" ;;
	esac
	if [ -n "$CFT_APP" ]; then
		if LABELED_APP="$(bash "$SCRIPT_DIR/clone-labeled-chrome.sh" "$CFT_APP" "$CHROME_LABEL")" &&
			[ -x "$LABELED_APP/Contents/MacOS/$(basename "$CFT")" ]; then
			CHROME_BIN="$LABELED_APP/Contents/MacOS/$(basename "$CFT")"
			echo "✔  Labeled bundle: $LABELED_APP (⌘-Tab: $CHROME_LABEL)"
		else
			echo "⚠️   Labeled-clone failed — launching unlabeled $CFT_APP"
		fi
	fi
fi

# ── 3. Create an ephemeral profile (no production profiles touched) ──
FRESH_PROFILE="$(mktemp -d)"
echo "✔  Fresh profile: $FRESH_PROFILE"

# ── 4. Wrangler config + leader UI build ─────────────────────────────
# The local wrangler serves the SPA but is NOT the real OAuth relay.
# Override GITHUB_CLIENT_ID → staging so the webapp picks up the correct
# client ID, and TRAY_WORKER_BASE_URL_OVERRIDE → staging relay so the
# runtime-config response points trayWorkerBaseUrl at the real relay
# (not at the wrangler's own localhost origin).
STAGING_WORKER="https://slicc-tray-hub-staging.minivelos.workers.dev"
STAGING_GH_CLIENT_ID="Ov23liUe1b3b6GDjPGz4"

# Build the leader UI (dist/ui) if missing — wrangler serves dist/ui via the
# ASSETS binding with SPA fallback; when dist/ui/index.html is absent every
# route 404s and the leader never loads. Build on demand (fast no-op when
# present), hard-failing if the build does not produce it.
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
# false-negative the readiness check; checking only that curl got a status line
# (non-000, non-empty) avoids that.
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
		if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then
			echo "❌  Wrangler exited before binding :${WRANGLER_PORT}"
			exit 1
		fi
		[ "$i" -eq 30 ] && {
			echo "❌  Wrangler failed to start"
			kill "$WRANGLER_PID" 2>/dev/null || true
			exit 1
		}
		sleep 1
	done
fi

# ── 5. Cleanup trap (kills ONLY our own processes) ───────────────────
# node-server closes the Chrome it launched on shutdown, so we SIGTERM/wait
# the server we foreground rather than blanket-killing Chrome by name (which
# would close a concurrent swift/extension/electron harness's windows too).
NODE_PID=""
cleanup() {
	echo ""
	echo "⏹  Shutting down…"
	if [ -n "$NODE_PID" ]; then
		kill -TERM "$NODE_PID" 2>/dev/null || true
		wait "$NODE_PID" 2>/dev/null || true
	fi
	[ "$STARTED_WRANGLER" -eq 1 ] && [ -n "$WRANGLER_PID" ] && kill "$WRANGLER_PID" 2>/dev/null || true
	rm -rf "$FRESH_PROFILE" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── 6. Start node-server thin-bridge ─────────────────────────────────
echo "🔗  Starting thin-bridge on :${BRIDGE_PORT}…"
echo ""
CHROME_PATH="$CHROME_BIN" \
	WORKER_BASE_URL="http://localhost:${WRANGLER_PORT}" \
	SLICC_TRAY_WORKER_BASE_URL="${SLICC_TRAY_WORKER_BASE_URL:-https://slicc-tray-hub-staging.minivelos.workers.dev}" \
	SLICC_CDP_LAUNCH_TIMEOUT_MS=30000 \
	BRIDGE_DEV_ALLOWED_ORIGINS="http://localhost:${WRANGLER_PORT}" \
	SLICC_USER_DATA_DIR="$FRESH_PROFILE" \
	PORT="$BRIDGE_PORT" \
	node "${REPO_ROOT}/dist/node-server/index.js" "$@" &
NODE_PID=$!

wait "$NODE_PID"
