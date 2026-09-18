#!/usr/bin/env bash
























set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"



# shellcheck source=packages/dev-tools/tools/ios-sim-select.sh
source "$SCRIPT_DIR/ios-sim-select.sh"
# shellcheck source=packages/dev-tools/tools/ios-sim-prepare.sh
source "$SCRIPT_DIR/ios-sim-prepare.sh"

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




  COVERAGE_OBJECT_ARGS=()
  local framework_dir framework_binary framework_name
  for framework_dir in "$app_dir/Frameworks/"*.framework; do
    [[ -d "$framework_dir" ]] || continue
    framework_name="$(basename "$framework_dir" .framework)"
    framework_binary="$framework_dir/$framework_name"
    [[ -f "$framework_binary" ]] || continue
    COVERAGE_OBJECT_ARGS+=(-object "$framework_binary")
  done


  COVERAGE_ARCH_ARGS=(-arch "$(uname -m)")




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






PACKAGE_ROOT="$PWD"
COVERAGE_OBJECT_ARGS=()
COVERAGE_ARCH_ARGS=()
COVERAGE_IGNORE_REGEX='\.build/|Tests/'
COVERAGE_SOURCE_PATHS=("$PACKAGE_ROOT")



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



  prepare_ios_simulator "$UDID"

  echo "==> xcodebuild test -enableCodeCoverage YES ($PACKAGE_DIR, simulator $UDID)"
  mkdir -p .build/coverage
  set -o pipefail




  # shellcheck source=packages/dev-tools/tools/swift-coverage-runner-retry.sh
  source "$SCRIPT_DIR/swift-coverage-runner-retry.sh"
  XCODEBUILD_LOG=$(mktemp -t swift-coverage-xcodebuild)
  trap 'rm -f "$XCODEBUILD_LOG"' EXIT




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




  PROFDATA=$(find "$DERIVED_DATA/Build/ProfileData" -name "Coverage.profdata" -type f -exec stat -f '%m %N' {} + 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-)
  if [[ -z "$PROFDATA" ]]; then
    echo "::error::No Coverage.profdata produced by xcodebuild test"
    exit 1
  fi




  APP_DIR="$DERIVED_DATA/Build/Products/Debug-iphonesimulator/${TEST_BUNDLE_NAME}.app"
  BINARY="$APP_DIR/${TEST_BUNDLE_NAME}"
  if [[ -f "$APP_DIR/${TEST_BUNDLE_NAME}.debug.dylib" ]]; then
    BINARY="$APP_DIR/${TEST_BUNDLE_NAME}.debug.dylib"
  fi
  configure_xcode_coverage_scope "$PACKAGE_NAME" "$PACKAGE_ROOT" "$APP_DIR"
else
  echo "==> swift test --enable-code-coverage ($PACKAGE_DIR)"





  mkdir -p .build/coverage
  swift test --enable-code-coverage --xunit-output .build/coverage/test-timings.xunit.xml \
    2>&1 | tee .build/coverage/test-timings.log

  PROFDATA=$(find .build -name "default.profdata" -type f 2>/dev/null | head -1)
  if [[ -z "$PROFDATA" ]]; then
    echo "::error::No profdata produced by swift test"
    exit 1
  fi



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



REGION_COV=$(echo "$TOTAL_LINE" | awk '{ gsub("%",""); print $4 }')
FUNCTION_COV=$(echo "$TOTAL_LINE" | awk '{ gsub("%",""); print $7 }')
LINE_COV=$(echo "$TOTAL_LINE" | awk '{ gsub("%",""); print $10 }')

cmp_lt() {
  awk -v a="$1" -v b="$2" 'BEGIN { exit !(a + 0 < b + 0) }'
}




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



mkdir -p .build/coverage
"${COV_TOOL[@]}" export "$BINARY" \
  ${COVERAGE_OBJECT_ARGS[@]+"${COVERAGE_OBJECT_ARGS[@]}"} \
  ${COVERAGE_ARCH_ARGS[@]+"${COVERAGE_ARCH_ARGS[@]}"} \
  -instr-profile="$PROFDATA" \
  --ignore-filename-regex="$COVERAGE_IGNORE_REGEX" \
  -format=lcov \
  "${COVERAGE_SOURCE_PATHS[@]}" >.build/coverage/lcov.info 2>/dev/null || true

exit $FAIL
