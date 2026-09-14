# shellcheck shell=bash








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
