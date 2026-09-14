#!/usr/bin/env bash



















set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEVICE_REGEX=""
RESULT_BUNDLE=""
ONLY_TESTING=""
SKIP_TESTING_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) DEVICE_REGEX="$2"; shift 2 ;;
    --result-bundle) RESULT_BUNDLE="$2"; shift 2 ;;
    --only-testing) ONLY_TESTING="$2"; shift 2 ;;
    --skip-testing) SKIP_TESTING_ARGS+=("-skip-testing:$2"); shift 2 ;;
    *) echo "error: unknown argument $1" >&2; exit 2 ;;
  esac
done
for required in DEVICE_REGEX RESULT_BUNDLE ONLY_TESTING; do
  if [[ -z "${!required}" ]]; then
    echo "error: missing --$(echo "$required" | tr 'A-Z_' 'a-z-' | sed 's/-regex$//;s/-bundle$/-bundle/')" >&2
    exit 2
  fi
done

# shellcheck source=packages/dev-tools/tools/ios-sim-select.sh
source "$SCRIPT_DIR/ios-sim-select.sh"
# shellcheck source=packages/dev-tools/tools/swift-coverage-runner-retry.sh
source "$SCRIPT_DIR/swift-coverage-runner-retry.sh"

cd "$REPO_ROOT/packages/ios-app"

SDK_VERSION="$(xcrun --sdk iphonesimulator --show-sdk-version)"


UDID="${SLICC_IOS_SIM_UDID:-}"
if [[ -z "$UDID" ]]; then
  UDID=$(
    xcrun simctl list devices available --json |
      select_ios_sim_for_sdk "$SDK_VERSION" "$DEVICE_REGEX"
  )
fi
if [[ -z "$UDID" ]]; then
  echo "::error::No available simulator matching /$DEVICE_REGEX/ for the iOS $SDK_VERSION SDK"
  exit 1
fi




echo "==> waiting for simulator $UDID to finish booting"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b ||
  echo "::warning::simctl bootstatus did not report a clean boot; continuing"

echo "==> xcodebuild test ($ONLY_TESTING, simulator $UDID)"


if [[ -n "${SKIP_TESTING_ARGS[*]+x}" ]]; then
  echo "==> skipping: ${SKIP_TESTING_ARGS[*]}"
fi
set -o pipefail
XCODEBUILD_LOG=$(mktemp -t ios-sim-test-xcodebuild)
trap 'rm -f "$XCODEBUILD_LOG"' EXIT

run_single_xcodebuild_attempt() {

  rm -rf "$RESULT_BUNDLE"
  xcodebuild test \
    -project SliccFollower.xcodeproj \
    -scheme SliccFollower \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath .build/xcodebuild \
    -resultBundlePath "$RESULT_BUNDLE" \
    -parallel-testing-enabled NO \
    -retry-tests-on-failure \
    -test-iterations 2 \
    "-only-testing:$ONLY_TESTING" \
    ${SKIP_TESTING_ARGS[@]+"${SKIP_TESTING_ARGS[@]}"}
}
run_with_runner_init_retry "$XCODEBUILD_LOG" run_single_xcodebuild_attempt
