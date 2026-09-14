# shellcheck shell=bash














RUNNER_INIT_RE='failed to initialize for UI testing|Timed out while loading Accessibility|Application failed preflight checks'





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
