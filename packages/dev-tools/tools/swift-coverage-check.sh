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
# Resolved before any `cd` below — BASH_SOURCE may be a relative path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Simulator selection is shared with ios-sim-test.sh (the non-coverage CI
# matrix legs) so the two paths cannot drift.
# shellcheck source=packages/dev-tools/tools/ios-sim-select.sh
source "$SCRIPT_DIR/ios-sim-select.sh"

select_iphone_for_sdk() {
  select_ios_sim_for_sdk "$1" iPhone
}

configure_xcode_coverage_scope() {
  local package_name="$1"
  local package_root="$2"
  local app_dir="$3"

  if [[ "$package_name" != "ios-app" ]]; then
    return 0
  fi

  # The iOS coverage job is unit-only; UI execution has its own gate. Measure
  # testable domain/transport code across the app and every linked framework,
  # so extracting another local kit cannot silently remove it from the profile.
  COVERAGE_OBJECT_ARGS=()
  local framework_dir framework_binary framework_name
  for framework_dir in "$app_dir/Frameworks/"*.framework; do
    [[ -d "$framework_dir" ]] || continue
    framework_name="$(basename "$framework_dir" .framework)"
    framework_binary="$framework_dir/$framework_name"
    [[ -f "$framework_binary" ]] || continue
    COVERAGE_OBJECT_ARGS+=(-object "$framework_binary")
  done
  # Linked vendor frameworks can be universal binaries; select the simulator's
  # host architecture so llvm-cov can inspect them alongside local frameworks.
  COVERAGE_ARCH_ARGS=(-arch "$(uname -m)")
  # The File Provider appex never launches in unit tests, so it has no coverage
  # mapping and its sources would silently vanish instead of registering zero.
  # Wave 2 enumeration/write-back therefore lives in measured SliccTrayKit;
  # SliccFileProvider remains a thin NSFileProvider adapter.
  COVERAGE_IGNORE_REGEX='\.build/|Tests/|SliccFileProvider/|SliccFollower/(Views|CDP)/|SliccFollower/App/(AppState|UITestHooks|SliccFollowerApp)\.swift$'
  COVERAGE_SOURCE_PATHS=("$package_root")
}

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

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
COVERAGE_OBJECT_ARGS=()
COVERAGE_ARCH_ARGS=()
COVERAGE_IGNORE_REGEX='\.build/|Tests/'
COVERAGE_SOURCE_PATHS=("$PACKAGE_ROOT")

# Both modes leave $PROFDATA and $BINARY pointing at the instrumented binary and
# its merged profile, which the shared llvm-cov reporting below consumes.
if [[ -n "$XCODE_SCHEME" ]]; then
  DERIVED_DATA=".build/xcodebuild"
  SDK_VERSION="$(xcrun --sdk iphonesimulator --show-sdk-version)"
  UDID="${SLICC_IOS_SIM_UDID:-}"
  if [[ -z "$UDID" ]]; then
    UDID=$(
      xcrun simctl list devices available --json |
        select_iphone_for_sdk "$SDK_VERSION"
    )
  fi
  if [[ -z "$UDID" ]]; then
    echo "::error::No available iPhone simulator matching the iOS $SDK_VERSION SDK (install one via 'xcodebuild -downloadPlatform iOS')"
    exit 1
  fi
  # Boot the simulator and block until it reports ready, instead of letting
  # `xcodebuild test` boot it lazily. A UI-test runner attaching to a
  # still-booting device dies with "Timed out while loading Accessibility",
  # which aborts the whole session before a single test runs — so
  # `-retry-tests-on-failure` cannot rescue it, as that retries failed tests,
  # not a runner that never initialized.
  echo "==> waiting for simulator $UDID to finish booting"
  xcrun simctl boot "$UDID" 2>/dev/null || true
  xcrun simctl bootstatus "$UDID" -b ||
    echo "::warning::simctl bootstatus did not report a clean boot; continuing"

  echo "==> xcodebuild test -enableCodeCoverage YES ($PACKAGE_DIR, simulator $UDID)"
  mkdir -p .build/coverage
  set -o pipefail

  # The pre-boot above shrinks but does not eliminate the window where the
  # UI-test runner dies at initialization on a loaded CI host — see the
  # sourced lib for why `-retry-tests-on-failure` cannot catch that.
  # shellcheck source=packages/dev-tools/tools/swift-coverage-runner-retry.sh
  source "$SCRIPT_DIR/swift-coverage-runner-retry.sh"
  XCODEBUILD_LOG=$(mktemp -t swift-coverage-xcodebuild)
  trap 'rm -f "$XCODEBUILD_LOG"' EXIT

  # The Xcode project is XcodeGen output and is not committed. CI generates it
  # in an earlier step; a local run on a fresh clone would otherwise fail deep
  # inside xcodebuild with "does not exist" rather than saying what to do.
  if [ ! -d "${XCODE_SCHEME}.xcodeproj" ]; then
    if command -v xcodegen >/dev/null 2>&1; then
      echo "generating ${XCODE_SCHEME}.xcodeproj from project.yml"
      xcodegen generate
    else
      echo "error: ${XCODE_SCHEME}.xcodeproj is missing and xcodegen is not installed." >&2
      echo "       brew install xcodegen && (cd $(pwd) && xcodegen generate)" >&2
      exit 1
    fi
  fi

  run_single_xcodebuild_attempt() {
    # xcodebuild refuses to overwrite an existing result bundle, so every
    # attempt (and a second local run) must clear it first.
    rm -rf ".build/coverage/${PACKAGE_NAME}.xcresult"
    xcodebuild test \
      -project "${XCODE_SCHEME}.xcodeproj" \
      -scheme "$XCODE_SCHEME" \
      -destination "platform=iOS Simulator,id=$UDID" \
      -derivedDataPath "$DERIVED_DATA" \
      -resultBundlePath ".build/coverage/${PACKAGE_NAME}.xcresult" \
      -enableCodeCoverage YES \
      -parallel-testing-enabled NO \
      -retry-tests-on-failure \
      -test-iterations 2 \
      "-only-testing:${TEST_BUNDLE_NAME}Tests"
  }
  run_with_runner_init_retry "$XCODEBUILD_LOG" run_single_xcodebuild_attempt

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
  configure_xcode_coverage_scope "$PACKAGE_NAME" "$PACKAGE_ROOT" "$APP_DIR"
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
    ${COVERAGE_OBJECT_ARGS[@]+"${COVERAGE_OBJECT_ARGS[@]}"} \
    ${COVERAGE_ARCH_ARGS[@]+"${COVERAGE_ARCH_ARGS[@]}"} \
    -instr-profile="$PROFDATA" \
    --ignore-filename-regex="$COVERAGE_IGNORE_REGEX" \
    "${COVERAGE_SOURCE_PATHS[@]}"
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
  ${COVERAGE_OBJECT_ARGS[@]+"${COVERAGE_OBJECT_ARGS[@]}"} \
  ${COVERAGE_ARCH_ARGS[@]+"${COVERAGE_ARCH_ARGS[@]}"} \
  -instr-profile="$PROFDATA" \
  --ignore-filename-regex="$COVERAGE_IGNORE_REGEX" \
  -format=lcov \
  "${COVERAGE_SOURCE_PATHS[@]}" >.build/coverage/lcov.info 2>/dev/null || true

exit $FAIL
