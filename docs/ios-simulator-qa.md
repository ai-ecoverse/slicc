# iOS Follower Simulator QA

Hand-running `packages/ios-app` (`SliccFollower`) in an iOS Simulator, for
exploratory checks the UI tests do not cover. For the automated suites and the
coverage gate, see [`packages/ios-app/CLAUDE.md`](../packages/ios-app/CLAUDE.md).

## Prerequisites

`brew install xcodegen`, plus a simulator runtime matching the Xcode SDK. If
`xcodebuild -showdestinations …` lists only `iOS <x> is not installed`, run
`xcodebuild -downloadPlatform iOS` (~8.5 GB, tens of minutes). Pick the newest
installed iPhone runtime: an older one can fail at launch with a missing
`libswiftWebKit.dylib`.

## Boot, build, install, launch

```bash
cd packages/ios-app
xcodegen generate
UDID=$(xcrun simctl list devices available --json \
  | jq -r '[.devices[][] | select(.isAvailable and (.name | test("iPhone")))] | first | .udid')
xcrun simctl boot "$UDID"; xcrun simctl bootstatus "$UDID" -b
open -a Simulator                                # optional: watch live
xcodebuild build -project SliccFollower.xcodeproj -scheme SliccFollower \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath .build/xcodebuild CODE_SIGNING_ALLOWED=NO
APP=.build/xcodebuild/Build/Products/Debug-iphonesimulator/SliccFollower.app
xcrun simctl uninstall "$UDID" com.sliccy.follower   # drop any stored joinUrl
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" com.sliccy.follower
xcrun simctl io "$UDID" screenshot /tmp/slicc-ios-launch.png
```

With no stored `joinUrl`, `ChatView.onAppear` opens the Settings sheet, so the
screenshot should show **Settings → Connection → Join URL** with
`Status: Disconnected`. The uninstall matters: a stored `joinUrl` boots the app
straight into the conversation and auto-connects.

## Driving an interaction without tapping

`simctl` cannot synthesize taps, but `UserDefaults` reads the argument domain,
so launch arguments seed `@AppStorage`-backed state — relaunch with
`-joinUrl "https://www.sliccy.ai/join/<token>"` to skip the Settings sheet and
drive the real connect path. The pill under the `SLICC` title is the only
signal: the pre-connect path emits no `os_log`, so a `log stream` on
`subsystem == "com.slicc.follower"` stays silent until a data channel opens.
`SliccFollowerUITests` already covers the sheet and the failure pill, so reach
for this only against a real leader — a synthetic token reaches the failure
state and no further, leaving chat, sprinkles, and the CDP carousel untested.

## Getting a real Join URL

Start a local leader (`npm run dev:standalone:fresh`, see
[`development.md`](development.md)), then use the avatar menu's
**Enable multi-browser sync**, or ask the agent to run `host` and report its
`join_url` — the URL the CLI follower takes too, see
[`packages/slicc-cli/README.md`](../packages/slicc-cli/README.md).
