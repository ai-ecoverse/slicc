#!/usr/bin/env bash
# Run `swift test --enable-code-coverage` and enforce minimum coverage
# thresholds against the resulting profdata. Designed to be invoked from
# CI for each Swift package; works on macOS (via `xcrun llvm-cov`) and
# falls back to a plain `llvm-cov` lookup on Linux.
#
# Usage:
#   swift-coverage-check.sh \
#     <package-dir> <test-bundle-name> \
#     <line-threshold> <function-threshold> <region-threshold>

set -euo pipefail

PACKAGE_DIR="${1:?package directory required}"
TEST_BUNDLE_NAME="${2:?test bundle name required}"
LINE_THRESHOLD="${3:?line threshold required}"
FUNCTION_THRESHOLD="${4:?function threshold required}"
REGION_THRESHOLD="${5:?region threshold required}"

cd "$PACKAGE_DIR"

echo "==> swift test --enable-code-coverage ($PACKAGE_DIR)"
swift test --enable-code-coverage

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
    --ignore-filename-regex='\.build/|Tests/'
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
  -format=lcov >.build/coverage/lcov.info 2>/dev/null || true

exit $FAIL
