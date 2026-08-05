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
# Pick an iPhone from the newest installed iOS runtime. simctl's JSON dict
# order is unspecified, so sort runtimes by version instead of taking `first` —
# an older runtime can fail at launch (see Prerequisites).
UDID=$(xcrun simctl list devices available --json \
  | jq -r '[.devices | to_entries[]
      | select(.key | test("SimRuntime\\.iOS"))
      | {ver: (.key | capture("iOS-(?<v>[0-9-]+)").v | split("-") | map(tonumber)),
         devs: [.value[] | select(.isAvailable and (.name | test("iPhone")))]}
      | select(.devs | length > 0)]
    | sort_by(.ver) | last | .devs | first | .udid')
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

## Kokoro model download and speech

Start from the fresh install above; the model flow must not reuse a developer
pack or an earlier Hub cache.

1. In **Settings → Speech**, tap **Enable high-quality English voice**. Verify
   that the consent sheet identifies the anonymous, Wi-Fi-only, approximately
   83 MB download. Cancel once, then accept it.
2. During transfer, verify that progress and **Cancel Download** are visible.
   Cancel once and confirm that the pinned revision directory is removed before
   retrying.
3. Accept again and wait for **Installed · about 83 MB**. A complete pack has
   nine `.mlmodelc` bundles, `vocab_index.json`, `g2p_vocab.json`,
   `voices/af_heart.json`, and `.provisioned` at the revision root.
4. Connect to a real leader, dictate an English turn, and verify that the reply
   is spoken. Include the word “real” and listen for `/ɹˈIl/`; logs or a
   successful model load are not substitutes for an auditory check.
5. Tap **Remove Download**. The UI must return to not-installed and the revision
   directory must be absent. With no cache and networking unavailable, another
   dictated reply must still use the system voice without attempting a model
   download.

Inspect the managed pack without relying on UI state:

```bash
DATA=$(xcrun simctl get_app_container "$UDID" com.sliccy.follower data)
ROOT="$DATA/Library/Application Support/KokoroModels"
find "$ROOT" -maxdepth 3 -print
du -sk "$ROOT"
```

The managed Hub cache is colocated under the revision, so peak on-disk usage can
be close to twice the displayed network payload. Removal deletes both the flat
runtime files and that cache. Save screenshots and any captured WAV under a
gitignored `.qa/` directory. `simctl` does not expose simulator speaker audio;
if nobody listened to the output, record that limitation instead of claiming
pronunciation passed.

## Driving an interaction without tapping

`simctl` cannot synthesize taps, but `UserDefaults` reads the argument domain,
so launch arguments seed `@AppStorage`-backed state — relaunch with
`-joinUrl "https://www.sliccy.ai/join/<token>"` to skip the Settings sheet and
drive the real connect path. The pill under the `SLICC` title is the only
signal: the pre-connect path emits no `os_log`, so a `log stream` on
`subsystem == "com.slicc.follower"` stays silent until a data channel opens.
`SliccFollowerUITests` already covers the sheet and the failure pill, so reach
for this only against a real leader — a synthetic token reaches the failure
state and no further, leaving chat, sprinkles, and the browser surface untested.

## Getting a real Join URL

Start a local leader (`npm run dev:standalone:fresh`, see
[`development.md`](development.md)), then use the avatar menu's
**Enable multi-browser sync**, or ask the agent to run `host` and report its
`join_url` — the URL the CLI follower takes too, see
[`packages/slicc-cli/README.md`](../packages/slicc-cli/README.md).
