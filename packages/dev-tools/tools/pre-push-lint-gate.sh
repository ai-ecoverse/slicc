#!/usr/bin/env bash
set -euo pipefail









REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"


BIN="$REPO_ROOT/node_modules/.bin"
for bin in biome prettier knip jscpd; do
	if [ ! -x "$BIN/$bin" ]; then
		echo "pre-push-lint-gate: $bin not found in node_modules/.bin." >&2
		echo "Run 'npm ci' before pushing." >&2
		exit 2
	fi
done


tmp="$(mktemp -d)"
cleanup() {

	for pid in "${CHECK_PIDS[@]+${CHECK_PIDS[@]}}"; do
		kill "$pid" 2>/dev/null || true
	done
	wait 2>/dev/null || true
	rm -rf "$tmp"
}
trap cleanup EXIT INT TERM


if [ -t 1 ]; then
	R=$'\033[31m' G=$'\033[32m' Y=$'\033[33m' B=$'\033[1m' Z=$'\033[0m'
else
	R='' G='' Y='' B='' Z=''
fi



declare -a CHECK_NAMES=()
declare -a CHECK_PIDS=()

run_check() {
	local name="$1"
	shift
	CHECK_NAMES+=("$name")
	"$@" >"$tmp/$name.log" 2>&1 &
	CHECK_PIDS+=($!)
}




run_check "biome" "$BIN/biome" check .
run_check "prettier" "$BIN/prettier" --check .



run_check "custom-lints" bash -c '
  npm run lint:docs --silent &&
  npm run lint:no-comments --silent &&
  npm run lint:skills --silent -- --strict &&
  npm run lint:skill-router --silent &&
  npm run lint:no-innerhtml --silent &&
  npm run lint:no-ui-in-providers --silent &&
  npm run lint:layer-back-edges --silent &&
  npm run lint:patches --silent &&
  npm run lint:swift-pins --silent &&
  npm run lint:no-raw-chrome-runtime-id --silent &&
  npm run lint:hosted-origin --silent &&
  npm run lint:duplication --silent
'


run_check "boy-scout-debt" node packages/dev-tools/tools/check-touched-exemptions.mjs
run_check "manifest" bash packages/dev-tools/tools/check-manifest-justifications.sh


run_check "deadcode" "$BIN/knip" --include files,dependencies,devDependencies,unlisted,binaries,unresolved,duplicates --no-progress --reporter compact
run_check "deadcode-prod" "$BIN/knip" --production --include files --no-progress --reporter compact


failures=0
i=0
for pid in "${CHECK_PIDS[@]}"; do
	name="${CHECK_NAMES[$i]}"
	if wait "$pid"; then
		echo "${G}✓${Z} $name"
	else
		echo "${R}✗${Z} ${B}$name${Z}"

		sed 's/^/  │ /' "$tmp/$name.log"
		failures=$((failures + 1))
	fi
	i=$((i + 1))
done





name="autofix-drift"
if bash packages/dev-tools/tools/check-autofix-drift.sh >"$tmp/$name.log" 2>&1; then
	echo "${G}✓${Z} $name"
else
	echo "${R}✗${Z} ${B}$name${Z}"
	sed 's/^/  │ /' "$tmp/$name.log"
	failures=$((failures + 1))
fi
CHECK_NAMES+=("$name")


total=${#CHECK_NAMES[@]}

echo ""
if [ "$failures" -eq 0 ]; then
	echo "${G}All $total checks passed.${Z}"
else
	echo "${R}$failures of $total checks failed.${Z} Fix the issues above and push again."
	echo "${Y}Tip:${Z} use ${B}git push --no-verify${Z} to bypass this gate."
	exit 1
fi
