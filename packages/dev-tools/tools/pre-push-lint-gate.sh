#!/usr/bin/env bash
set -euo pipefail

# Pre-push lint gate — mirrors the CI `lint` job locally so failures surface
# before the push, not after a red PR.  All independent checks run in parallel;
# the wall-clock cost is dominated by the two heaviest scanners (biome ≈2 s,
# prettier ≈6 s) rather than the serial sum of every step.
#
# Called from .husky/pre-push. Also exposed as `npm run verify`.
# Escape hatch: `git push --no-verify`.

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# ── dependency check ──────────────────────────────────────────────────────────
BIN="$REPO_ROOT/node_modules/.bin"
for bin in biome prettier knip; do
	if [ ! -x "$BIN/$bin" ]; then
		echo "pre-push-lint-gate: $bin not found in node_modules/.bin." >&2
		echo "Run 'npm ci' before pushing." >&2
		exit 2
	fi
done

# ── tmp dir for per-check logs ───────────────────────────────────────────────
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# ── palette (no-op when stdout is not a tty) ─────────────────────────────────
if [ -t 1 ]; then
	R=$'\033[31m' G=$'\033[32m' Y=$'\033[33m' B=$'\033[1m' Z=$'\033[0m'
else
	R='' G='' Y='' B='' Z=''
fi

# ── run_check NAME COMMAND… ──────────────────────────────────────────────────
# Runs COMMAND in the background, logs output, records exit code.
declare -a CHECK_NAMES=()
declare -a CHECK_PIDS=()

run_check() {
	local name="$1"
	shift
	CHECK_NAMES+=("$name")
	"$@" >"$tmp/$name.log" 2>&1 &
	CHECK_PIDS+=($!)
}

# ── launch all checks in parallel ────────────────────────────────────────────

# Heavy whole-repo scanners (pinned local binaries, no npx)
run_check "biome" "$BIN/biome" check .
run_check "prettier" "$BIN/prettier" --check .

# Lightweight custom lints — grouped into one sequential check to avoid
# spawning 8 separate npm processes for sub-second scripts.
run_check "custom-lints" bash -c '
  npm run lint:docs --silent &&
  npm run lint:skills --silent -- --strict &&
  npm run lint:skill-router --silent &&
  npm run lint:no-innerhtml --silent &&
  npm run lint:no-ui-in-providers --silent &&
  npm run lint:patches --silent &&
  npm run lint:no-raw-chrome-runtime-id --silent &&
  npm run lint:hosted-origin --silent
'

# CI-only steps (not in lint:ci)
run_check "complexity" node packages/dev-tools/tools/check-touched-exemptions.mjs
run_check "manifest" bash packages/dev-tools/tools/check-manifest-justifications.sh

# Dead-code detection (two independent knip passes, pinned local binary)
run_check "deadcode" "$BIN/knip" --include files,dependencies,devDependencies,unlisted,binaries,unresolved,duplicates --no-progress --reporter compact
run_check "deadcode-prod" "$BIN/knip" --production --include files --no-progress --reporter compact

# ── wait for all, collect results ────────────────────────────────────────────
failures=0
i=0
for pid in "${CHECK_PIDS[@]}"; do
	name="${CHECK_NAMES[$i]}"
	if wait "$pid"; then
		echo "${G}✓${Z} $name"
	else
		echo "${R}✗${Z} ${B}$name${Z}"
		# Show the failing output indented for quick scanning
		sed 's/^/  │ /' "$tmp/$name.log"
		failures=$((failures + 1))
	fi
	i=$((i + 1))
done

# ── summary ──────────────────────────────────────────────────────────────────
total=${#CHECK_NAMES[@]}

echo ""
if [ "$failures" -eq 0 ]; then
	echo "${G}All $total checks passed.${Z}"
else
	echo "${R}$failures of $total checks failed.${Z} Fix the issues above and push again."
	echo "${Y}Tip:${Z} use ${B}git push --no-verify${Z} to bypass this gate."
	exit 1
fi
