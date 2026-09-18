# shellcheck shell=bash
























IOS_SIM_TEST_BUNDLE_IDS=(
  com.sliccy.follower
  com.sliccy.follower.uitests.xctrunner
)


prepare_ios_simulator() {
  local udid="$1"
  echo "==> waiting for simulator $udid to finish booting"
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b ||
    echo "::warning::simctl bootstatus did not report a clean boot; continuing"



  local bundle_id
  for bundle_id in "${IOS_SIM_TEST_BUNDLE_IDS[@]}"; do
    echo "==> erasing $bundle_id container on $udid"
    xcrun simctl uninstall "$udid" "$bundle_id" >/dev/null 2>&1 || true
  done
}
