#!/usr/bin/env bash
# Run a SliccFollower test slice on a simulator WITHOUT the coverage gate —
# the non-canonical cells of the ios-app-tests CI matrix (iPhone on the beta
# SDK, the iPad regular-width regression). The canonical coverage-gated leg
# stays in swift-coverage-check.sh; this script shares its simulator
# selection (ios-sim-select.sh), its SLICC_IOS_SIM_UDID override, its
# pre-boot, and its runner-init retry (swift-coverage-runner-retry.sh) so
# the legs cannot drift.
#
# Usage:
#   ios-sim-test.sh --device <name-regex> --result-bundle <path> --only-testing <spec>
#                   [--skip-testing <spec>]...
#
#   --device        simulator name regex, e.g. iPhone or iPad
#   --result-bundle xcresult path relative to packages/ios-app
#   --only-testing  xcodebuild -only-testing spec
#   --skip-testing  xcodebuild -skip-testing spec; repeatable. Carves the
#                   handful of tests the runner cannot host out of an
#                   otherwise whole-bundle run (see
#                   packages/ios-app/ui-test-exclusions.json).
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
# Same override contract as swift-coverage-check.sh: a worktree-owned or
# CI-pinned simulator wins over discovery.
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

# Pre-boot: a UI-test runner attaching to a still-booting device dies with
# "Timed out while loading Accessibility" before a single test runs, which
# -retry-tests-on-failure cannot rescue.
echo "==> waiting for simulator $UDID to finish booting"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b ||
  echo "::warning::simctl bootstatus did not report a clean boot; continuing"

echo "==> xcodebuild test ($ONLY_TESTING, simulator $UDID)"
# `set -u` + bash 3.2 (what macOS ships) treats an empty array expansion as an
# unbound variable, so both uses go through the `${arr[@]+...}` guard.
if [[ -n "${SKIP_TESTING_ARGS[*]+x}" ]]; then
  echo "==> skipping: ${SKIP_TESTING_ARGS[*]}"
fi
set -o pipefail
XCODEBUILD_LOG=$(mktemp -t ios-sim-test-xcodebuild)
trap 'rm -f "$XCODEBUILD_LOG"' EXIT

run_single_xcodebuild_attempt() {
  # xcodebuild refuses to overwrite an existing result bundle.
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
