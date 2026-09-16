# shellcheck shell=bash
# Sourced by swift-coverage-check.sh and ios-sim-test.sh — the single home of
# "bring this simulator into a known state before `xcodebuild test`", so the
# coverage-gated leg and the matrix test legs cannot drift apart.
#
# Two steps, both load-bearing:
#
# 1. Boot and BLOCK until the device reports ready. A UI-test runner attaching
#    to a still-booting device dies with "Timed out while loading
#    Accessibility", which kills the session before a single test runs — so
#    `-retry-tests-on-failure` cannot rescue it (that retries failed tests, not
#    a runner that never initialized).
#
# 2. Erase the app containers, which is the ios-app bundle's only cross-run
#    isolation. Both bundles are explicitly serial (`-parallel-testing-enabled
#    NO`; simulator clones race the UI runner's install), so order-independence
#    plus a clean container is what stands in for it. A unit test runs INSIDE
#    the host app's process, which makes `UserDefaults.standard` there the
#    app's own persistent domain: anything a killed run left behind (a
#    cancelled job, a crash, the retry `-test-iterations` starts) is read by
#    the next run, because simulators here are long-lived — CI reuses its
#    runner image and a developer reuses one device for months.

# Every container an ios-app test run writes to: the app the unit bundle is
# hosted in and the XCUITest runner.
IOS_SIM_TEST_BUNDLE_IDS=(
  com.sliccy.follower
  com.sliccy.follower.uitests.xctrunner
)

# prepare_ios_simulator <udid>
prepare_ios_simulator() {
  local udid="$1"
  echo "==> waiting for simulator $udid to finish booting"
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b ||
    echo "::warning::simctl bootstatus did not report a clean boot; continuing"

  # Best-effort: `uninstall` fails when the app was never installed, which is
  # already the state this wants. xcodebuild reinstalls both bundles.
  local bundle_id
  for bundle_id in "${IOS_SIM_TEST_BUNDLE_IDS[@]}"; do
    echo "==> erasing $bundle_id container on $udid"
    xcrun simctl uninstall "$udid" "$bundle_id" >/dev/null 2>&1 || true
  done
}
