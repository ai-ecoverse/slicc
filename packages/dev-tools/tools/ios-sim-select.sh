# shellcheck shell=bash
# Sourced by swift-coverage-check.sh and ios-sim-test.sh — the single home
# of the simulator-selection JSON parse, so the coverage-gated leg and the
# matrix test legs cannot drift apart in how they pick a device.

# select_ios_sim_for_sdk <sdk-version> <name-regex>
# Reads `xcrun simctl list devices available --json` on stdin and prints the
# UDID of the first available device whose name matches <name-regex> in the
# runtime matching <sdk-version>, or nothing when none matches.
select_ios_sim_for_sdk() {
  local sdk_version="$1"
  local name_regex="$2"
  IOS_SIMULATOR_RUNTIME_KEY="com.apple.CoreSimulator.SimRuntime.iOS-${sdk_version//./-}" \
    IOS_SIMULATOR_NAME_REGEX="$name_regex" node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk).on("end", () => {
      const devices = JSON.parse(input).devices?.[process.env.IOS_SIMULATOR_RUNTIME_KEY] ?? [];
      const nameRe = new RegExp(process.env.IOS_SIMULATOR_NAME_REGEX);
      const device = devices.find(device => device.isAvailable && nameRe.test(device.name));
      process.stdout.write(device?.udid ?? "");
    });
  '
}
