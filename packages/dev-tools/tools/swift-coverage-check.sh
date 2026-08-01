#!/usr/bin/env bash
# Run the package's test suite with coverage instrumentation and enforce minimum
# coverage thresholds against the resulting profdata. Designed to be invoked from
# CI for each Swift package; works on macOS (via `xcrun llvm-cov`) and falls back
# to a plain `llvm-cov` lookup on Linux.
#
# Usage:
#   swift-coverage-check.sh \
#     [--xcodebuild <scheme>] \
#     <package-dir> <test-bundle-name> \
#     [<line-threshold> <function-threshold> <region-threshold>]
#
# Default mode drives `swift test --enable-code-coverage`.
#
# `--xcodebuild <scheme>` drives `xcodebuild test -enableCodeCoverage YES` on an
# iOS simulator instead, for packages that cannot be tested from a macOS host at
# all (ios-app depends on an iOS-only WebRTC binary, so `swift test` cannot even
# link there). Both modes end in the same `llvm-cov report` over the instrumented
# binary, so the line/function/region numbers are directly comparable and the
# nightly ratchet needs no per-mode special-casing.
#
# When the three numeric thresholds are omitted, they are read from the
# repo-root coverage-thresholds.json (key: basename of <package-dir>),
# which is the single source of truth maintained by the coverage ratchet.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

XCODE_SCHEME=""
if [[ "${1:-}" == "--xcodebuild" ]]; then
  XCODE_SCHEME="${2:?scheme required after --xcodebuild}"
  shift 2
fi

PACKAGE_DIR="${1:?package directory required}"
TEST_BUNDLE_NAME="${2:?test bundle name required}"
PACKAGE_NAME="$(basename "$PACKAGE_DIR")"

read_floor() {
  node -e "const t=require('$REPO_ROOT/coverage-thresholds.json').swift['$PACKAGE_NAME']||{};process.stdout.write(String(t['$1']??''))"
}

LINE_THRESHOLD="${3:-$(read_floor lines)}"
FUNCTION_THRESHOLD="${4:-$(read_floor functions)}"
REGION_THRESHOLD="${5:-$(read_floor regions)}"

if [[ -z "$LINE_THRESHOLD" || -z "$FUNCTION_THRESHOLD" || -z "$REGION_THRESHOLD" ]]; then
  echo "::error::No Swift coverage floors for '$PACKAGE_NAME' (pass args or add to coverage-thresholds.json)"
  exit 1
fi

cd "$PACKAGE_DIR"

# Absolute path to the measured package; used as a positional SOURCES filter
# below so sibling packages pulled in as local path dependencies (whose sources
# get linked into this test bundle) are not counted against this package's
# coverage floor. Sibling packages with their own coverage jobs enforce their
# own floors independently.
PACKAGE_ROOT="$PWD"

# Both modes leave $PROFDATA and $BINARY pointing at the instrumented binary and
# its merged profile, which the shared llvm-cov reporting below consumes.
if [[ -n "$XCODE_SCHEME" ]]; then
  DERIVED_DATA=".build/xcodebuild"
  UDID=$(
    xcrun simctl list devices available --json |
      node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s).devices;const m=Object.values(d).flat().find(v=>v.isAvailable&&/iPhone/.test(v.name));process.stdout.write(m?m.udid:"")})'
  )
  if [[ -z "$UDID" ]]; then
    echo "::error::No available iPhone simulator (install one via 'xcodebuild -downloadPlatform iOS')"
    exit 1
  fi
  # Boot the simulator and block until it reports ready, instead of letting
  # `xcodebuild test` boot it lazily. A UI-test runner attaching to a
  # still-booting device dies with "Timed out while loading Accessibility",
  # which aborts the whole session before a single test runs — so
  # `-retry-tests-on-failure` cannot rescue it, as that retries failed tests,
  # not a runner that never initialized.
  echo "==> waiting for simulator $UDID to finish booting"
  xcrun simctl bootstatus "$UDID" -b ||
    echo "::warning::simctl bootstatus did not report a clean boot; continuing"

  echo "==> xcodebuild test -enableCodeCoverage YES ($PACKAGE_DIR, simulator $UDID)"
  # xcodebuild refuses to overwrite an existing result bundle, so a second local
  # run would fail before ever reaching the tests.
  mkdir -p .build/coverage
  rm -rf ".build/coverage/${PACKAGE_NAME}.xcresult"
  set -o pipefail
  xcodebuild test \
    -project "${XCODE_SCHEME}.xcodeproj" \
    -scheme "$XCODE_SCHEME" \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath "$DERIVED_DATA" \
    -resultBundlePath ".build/coverage/${PACKAGE_NAME}.xcresult" \
    -enableCodeCoverage YES \
    -parallel-testing-enabled YES \
    -retry-tests-on-failure \
    -test-iterations 2 \
    CODE_SIGNING_ALLOWED=NO

  # Newest wins. xcodebuild keys ProfileData by device UDID, so a machine that
  # has run the suite against more than one simulator keeps several — and an
  # arbitrary pick silently reports a stale run's numbers rather than this one's.
  PROFDATA=$(find "$DERIVED_DATA/Build/ProfileData" -name "Coverage.profdata" -type f -exec stat -f '%m %N' {} + 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-)
  if [[ -z "$PROFDATA" ]]; then
    echo "::error::No Coverage.profdata produced by xcodebuild test"
    exit 1
  fi
  # The app target (not the .xctest bundle) carries the code under test. Debug
  # builds split the app into a thin launcher stub plus a `.debug.dylib` holding
  # the actual code — and therefore the coverage mapping — so prefer the dylib
  # when it exists; llvm-cov reports "no coverage data found" against the stub.
  APP_DIR="$DERIVED_DATA/Build/Products/Debug-iphonesimulator/${TEST_BUNDLE_NAME}.app"
  BINARY="$APP_DIR/${TEST_BUNDLE_NAME}"
  if [[ -f "$APP_DIR/${TEST_BUNDLE_NAME}.debug.dylib" ]]; then
    BINARY="$APP_DIR/${TEST_BUNDLE_NAME}.debug.dylib"
  fi
else
  echo "==> swift test --enable-code-coverage ($PACKAGE_DIR)"
  # Per-test durations, uploaded by CI so a slow or flaky test can be identified
  # without re-running the suite locally. SwiftPM only writes the XCTest xUnit
  # report in `--parallel` mode, which would change these suites' isolation, so
  # the teed console log ("Test Case '-[X testY]' passed (0.001 seconds)") is the
  # authoritative timing record and the xUnit file covers swift-testing suites.
  mkdir -p .build/coverage
  swift test --enable-code-coverage --xunit-output .build/coverage/test-timings.xunit.xml \
    2>&1 | tee .build/coverage/test-timings.log

  PROFDATA=$(find .build -name "default.profdata" -type f 2>/dev/null | head -1)
  if [[ -z "$PROFDATA" ]]; then
    echo "::error::No profdata produced by swift test"
    exit 1
  fi

  # Test bundle layout differs between Darwin (.xctest as a directory bundle)
  # and Linux (.xctest as a flat executable). Resolve the binary path once.
  TEST_BUNDLE=$(find .build -name "${TEST_BUNDLE_NAME}.xctest" 2>/dev/null | head -1)
  if [[ -z "$TEST_BUNDLE" ]]; then
    echo "::error::Test bundle ${TEST_BUNDLE_NAME}.xctest not found under .build/"
    exit 1
  fi
  if [[ -d "$TEST_BUNDLE" ]]; then
    BINARY="$TEST_BUNDLE/Contents/MacOS/${TEST_BUNDLE_NAME}"
  else
    BINARY="$TEST_BUNDLE"
  fi
fi

if [[ ! -x "$BINARY" && ! -f "$BINARY" ]]; then
  echo "::error::Test binary not found: $BINARY"
  exit 1
fi

if command -v xcrun >/dev/null 2>&1; then
  COV_TOOL=(xcrun llvm-cov)
else
  COV_TOOL=(llvm-cov)
fi

echo "==> ${COV_TOOL[*]} report $BINARY"
COVERAGE_OUTPUT=$(
  "${COV_TOOL[@]}" report "$BINARY" \
    -instr-profile="$PROFDATA" \
    --ignore-filename-regex='\.build/|Tests/' \
    "$PACKAGE_ROOT"
)
echo "$COVERAGE_OUTPUT"

TOTAL_LINE=$(echo "$COVERAGE_OUTPUT" | awk '$1 == "TOTAL" { print }')
if [[ -z "$TOTAL_LINE" ]]; then
  echo "::error::No TOTAL row in llvm-cov output"
  exit 1
fi

# llvm-cov report TOTAL row format:
#   TOTAL  regions  missed_regions  region_cover%  functions  missed_functions  function_cover%  lines  missed_lines  line_cover%  branches  missed_branches  branch_cover%
REGION_COV=$(echo "$TOTAL_LINE" | awk '{ gsub("%",""); print $4 }')
FUNCTION_COV=$(echo "$TOTAL_LINE" | awk '{ gsub("%",""); print $7 }')
LINE_COV=$(echo "$TOTAL_LINE" | awk '{ gsub("%",""); print $10 }')

cmp_lt() {
  awk -v a="$1" -v b="$2" 'BEGIN { exit !(a + 0 < b + 0) }'
}

# Emit measured percentages for the coverage ratchet. Written before the
# threshold comparison so the ratchet can read actuals even if this run is
# below floor (which would also fail CI separately).
mkdir -p .build/coverage
printf '{"lines":%s,"functions":%s,"regions":%s}\n' \
  "$LINE_COV" "$FUNCTION_COV" "$REGION_COV" >.build/coverage/summary.json

echo
echo "Coverage summary:"
printf "  Lines:     %6s%%  (floor %s%%)\n" "$LINE_COV" "$LINE_THRESHOLD"
printf "  Functions: %6s%%  (floor %s%%)\n" "$FUNCTION_COV" "$FUNCTION_THRESHOLD"
printf "  Regions:   %6s%%  (floor %s%%)\n" "$REGION_COV" "$REGION_THRESHOLD"

FAIL=0
if cmp_lt "$LINE_COV" "$LINE_THRESHOLD"; then
  echo "::error::Line coverage ${LINE_COV}% is below threshold ${LINE_THRESHOLD}%"
  FAIL=1
fi
if cmp_lt "$FUNCTION_COV" "$FUNCTION_THRESHOLD"; then
  echo "::error::Function coverage ${FUNCTION_COV}% is below threshold ${FUNCTION_THRESHOLD}%"
  FAIL=1
fi
if cmp_lt "$REGION_COV" "$REGION_THRESHOLD"; then
  echo "::error::Region coverage ${REGION_COV}% is below threshold ${REGION_THRESHOLD}%"
  FAIL=1
fi

# Emit lcov so CI can attach it as an artifact (best-effort; not all
# llvm-cov builds support `export -format=lcov`).
mkdir -p .build/coverage
"${COV_TOOL[@]}" export "$BINARY" \
  -instr-profile="$PROFDATA" \
  --ignore-filename-regex='\.build/|Tests/' \
  -format=lcov \
  "$PACKAGE_ROOT" >.build/coverage/lcov.info 2>/dev/null || true

exit $FAIL
