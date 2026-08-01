# shellcheck shell=bash
# Sourced by swift-coverage-check.sh; unit-tested by
# swift-coverage-runner-retry.test.mjs.
#
# A UI-test runner that dies at initialization ("Timed out while loading
# Accessibility", "failed to initialize for UI testing", or SpringBoard
# refusing the launch with Busy / "Application failed preflight checks" —
# deliberately NOT the generic "Failed to install or launch the test
# runner" wrapper, which also wraps permanent failures like a bad bundle
# or signature)
# aborts the xcodebuild session before a single test runs, so
# `-retry-tests-on-failure` never sees it — that flag retries failed tests,
# not a runner that never started. This guard retries exactly those
# infrastructure signatures, once. A genuine test failure does not match and
# fails on the first attempt, preserving its exit status.
RUNNER_INIT_RE='failed to initialize for UI testing|Timed out while loading Accessibility|Application failed preflight checks'

# run_with_runner_init_retry <logfile> <cmd...>
# Runs <cmd...> (stdout+stderr teed to <logfile>) up to twice. Returns 0 on
# the first success; retries once iff the first failure's log matches
# RUNNER_INIT_RE; otherwise returns the failing attempt's exit status.
run_with_runner_init_retry() {
  local log="$1"
  shift
  local attempt rc
  for attempt in 1 2; do
    rc=0
    "$@" 2>&1 | tee "$log" || rc=$?
    if [[ $rc -eq 0 ]]; then
      return 0
    fi
    if [[ $attempt -eq 1 ]] && grep -qE "$RUNNER_INIT_RE" "$log"; then
      echo "::warning::UI-test runner failed to initialize (simulator infrastructure, not a test failure); re-running xcodebuild test once"
      continue
    fi
    return "$rc"
  done
}
