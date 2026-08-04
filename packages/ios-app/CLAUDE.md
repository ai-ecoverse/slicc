# CLAUDE.md

This file covers the iOS follower app in `packages/ios-app/`.

## Scope

`packages/ios-app/SliccFollower/` is a native iOS SwiftUI app (`SliccFollower`) that connects to a SLICC leader over WebRTC and presents the leader's chat + sprinkles + (limited) federated CDP. It is **a follower only** — it does not host an agent runtime.

`packages/ios-app` is a Swift Package Manager project (`Package.swift`), not an npm workspace. XcodeGen generates its Xcode project from `project.yml`.

## Layout

| Path                                                                                                | Purpose                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SliccFollower/App/SliccFollowerApp.swift`, `App/AppState.swift`                                    | App entry + central `@MainActor AppState`                                                                                                                                                                                                                   |
| `SliccTrayKit/Models/SyncProtocol.swift`                                                            | Partial `Codable` mirror of `packages/shared-ts/src/tray-sync-protocol.ts`                                                                                                                                                                                  |
| `SliccFollower/Models/ScoopStatus.swift`                                                            | Scoop lifecycle and context-fullness presentation                                                                                                                                                                                                           |
| `SliccTrayKit/Models/{ChatMessage,TrayTypes,TrayChunkFraming}.swift`                                | Chat/signaling types and transport chunk reassembly                                                                                                                                                                                                         |
| `SliccFollower/Sync/Keepalive.swift`                                                                | `DataChannelKeepalive` ping/pong actor                                                                                                                                                                                                                      |
| `SliccFollower/Sync/TerminalClient.swift`                                                           | Single-flight `exec.*` client for the leader shell                                                                                                                                                                                                          |
| `SliccFollower/Models/ICloudSessionList.swift`, `SliccFollower.entitlements`                        | iCloud tray-session discovery over `SliccTraySession` + KVS entitlement                                                                                                                                                                                     |
| `SliccTrayKit/Networking/{TraySignaling,TrayFollowerConnector,WebRTCManager}.swift`                 | Signaling + WebRTC peer/data-channel setup                                                                                                                                                                                                                  |
| `SliccTrayKit/FileProvider/`, `SliccFileProvider/`                                                  | Read/write Files.app provider for the leader VFS (kit logic + thin appex). Appex Info.plist must set `NSExtensionFileProviderSupportsEnumeration` or Files can register the domain while leaving `userEnabled=false` and hiding it from Browse → Locations. |
| `SliccFollower/CDP/CDPBridge.swift`, `CDPTarget.swift`                                              | Hosts WKWebViews as CDP targets the leader can drive                                                                                                                                                                                                        |
| `SliccFollower/Views/ChatView.swift`, `MessageListView.swift`, `MarkdownText.swift`                 | Adaptive chat shell; `ChatPresentationState` owns compact/regular branch state                                                                                                                                                                              |
| `SliccFollower/Views/SprinkleWebView.swift`, `InlineSprinkleView.swift`, `SprinkleDetailView.swift` | Renders `.shtml`; intercepts bridge calls and stubs VFS APIs                                                                                                                                                                                                |
| `SliccFollower/Views/DockModel.swift`, `DockRail.swift`, `WorkbenchHost.swift`, `LucideIcon.swift`  | Phone IA: 48pt dock rail; workbench overlays chat                                                                                                                                                                                                           |
| `SliccFollower/Views/TerminalView.swift`, `TerminalViewModel.swift`                                 | Persistent libghostty surface                                                                                                                                                                                                                               |
| `SliccFollower/Views/TabsCarouselView.swift`                                                        | Local CDP-target WKWebView carousel                                                                                                                                                                                                                         |
| `SliccFollower/{Models,Views}/*Avatar*.swift`                                                       | Avatar geometry/motion, renderer, screenshot fixture                                                                                                                                                                                                        |

Plain SPM commands do nothing useful on a macOS host. Build and test go through the XcodeGen project on a simulator (see "Test + coverage").

## Protocol Mirror Invariant

`SliccTrayKit/Models/SyncProtocol.swift` mirrors a **subset** of `packages/shared-ts/src/tray-sync-protocol.ts`. The matrix in `docs/architecture.md` is the cross-float source of truth. iOS-local facts:

- `preview.open` → `CDPBridge.handleTabOpen`, ack `tab.opened`.
- iOS never originates transcript export; those prompts decode to `.unknown` / `undecodable` in the corpus.
- All four `exec.*` messages are mirrored; terminal originates, leader requests get unsupported. `capabilities.exec` stays false (no OS shell).

Both union doc-comments state omissions; `// MARK: -` boundaries are the anchors.

**Mechanical enforcement:** every union variant needs a fixture + iOS expectation in `tray-sync-protocol-corpus.ts`, decoded by vitest and Swift. When changing the protocol: (1) TS union, (2) Swift enum **and** `init(from:)` arm, (3) leader broadcast, (4) browser + iOS follower dispatch (`AppState.handleDataChannelMessage` is the only iOS switch), (5) corpus + tests, (6) architecture matrix row. Skipping iOS fails `SyncProtocolCorpusTests` instead of silent `.unknown` drops.

## What this app supports vs the browser follower

Model TS follower features on `AppState`:

- Lifecycle: `connect` / `disconnect` / `dataChannelOpened` / `handleDisconnect`
- Health: `Keepalive` splits **stalled** vs **dead**; `lastError` is transport, `leaderError` is the cone's
- Dispatch: `handleDataChannelMessage`
- Sprinkles: refresh/fetch/lick/handle content (chunk reassembly + waiter dedup)
- Leader VFS: `FsClient` requests with `targetRuntimeId: "leader"`; leader-origin requests get `ENOTSUP` (not silence). Client owns deadline + reassembly.
- `hello` sends `exec: false` + device `motd`
- Multi-scoop buffers, model/thinking controls, agent events

### Transcript swipe arbitration

Nested horizontal transcript content owns a drag while it can still scroll in
that direction; scoop navigation or frozen dismissal takes over only at the edge
the drag pulls away from (right at leading, left at trailing). Freeze edge state
at drag start. Capture must tolerate either inner/outer callback order, and an
unknown context in a guarded region fails closed. Edge math uses the effective
viewport, including both 8pt expansions from negative horizontal padding.
On iOS 18+, each guarded scroller uses `UIGestureRecognizerRepresentable` to
resolve its own handoff; iOS 26 no longer makes a descendant SwiftUI gesture
simultaneous with an ancestor gesture. The parent handles ordinary content and
iOS 17 keeps the SwiftUI arbitration path.
Ordinary transcript navigation and vertical scrolling stay unchanged. Because
the target is iOS 17, use preference/geometry APIs, not iOS 18 scroll APIs.

### Licks

`sprinkle.lick` is its own message (`sprinkle` is not `FORWARDABLE_TO_LEADER`). `LickEvent` mirrors only `navigate` and `discovery`. `navigate` handoffs come from `WKNavigationResponse` Link headers (main frame only).

### Message rendering parity

- Attachment chips: thumbnail/glyph + filename on user messages only
- Error card omits web CTAs (no follower→leader equivalent)
- `tool_ui` is a read-only card by `requestId`; `tool_ui_done` / snapshot clear it

## iCloud Sessions

`AppState.sessionStore` is a read-only `TraySessionSyncStore` from **`packages/swift-traysession`** (launcher publishes; phone joins). `SettingsView` lists sessions by device; a tap joins via `connectToDiscoveredSession`. KVS id `S8LB56P782.ai.sliccy.trays` MUST match macOS. Unprovisioned builds degrade to an empty local cache; `SLICC_IOS_NO_ICLOUD=1` archives TestFlight without the entitlement. Never log `joinUrl` or put it in telemetry/accessibility ids.

## Frozen Sessions

`Models/FrozenSessions.swift` mirrors `transcript/frozen-archive-format.ts`. `FrozenSessionsView` lists past sessions; opening one swaps the transcript read-only. Hooks: `-uiTestFrozenFixture/Empty`.

## Push to Talk

Hold an empty composer to dictate a `user_message`. `PttController` + `Dictation` seam `SFSpeechRecognizer`. Release submits via `InputBar.submit(_:dictated:)`, not the composer binding. Dictated turns speak replies (`VoiceReply` / `DictationPriming`); typed turns stay silent. Hooks: `-uiTestSpeechPermission/Script`, `-uiTestPttStage`.

## Terminal

Libghostty `InMemoryTerminalSession` + `TerminalClient` exec against the leader shell (`hello.capabilities.exec`). One virtual shell per connection; Ctrl-C → `SIGINT` until `exec.response`. No interactive/incremental output.

## Agent Avatar

`SliccAgentAvatarView` / geometry parity with webcomponents. Scoop switcher uses a 20pt avatar; menu rows stay text. Tilt seams CoreMotion; reduce-motion and closed eyes center pupils. `-uiTestAvatarFixture` for screenshots.

## Build

```bash
cd packages/ios-app
xcodegen generate
xcodebuild build -project SliccFollower.xcodeproj -scheme SliccFollower \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO
swiftlint lint
```

## Test + coverage

The unit suite runs through `xcodebuild test` on a simulator. The shared coverage gate picks an iPhone from the runtime matching the simulator SDK, boots it, enables coverage and on-failure retries, and enforces the `ios-app` floors in `coverage-thresholds.json`. Do not pass `CODE_SIGNING_ALLOWED=NO` to simulator tests: XCTest needs the ad-hoc-signed app and test bundle. The unsigned override remains appropriate for the build-only command above.

```bash
./packages/dev-tools/tools/swift-coverage-check.sh \
  --xcodebuild SliccFollower packages/ios-app SliccFollower
```

Outputs land in `.build/coverage/` (`summary.json`, `lcov.info`, `ios-app.xcresult`). The gate passes `-only-testing:SliccFollowerTests`, disables parallel simulator clones (shared app-state isolation), and keeps `randomExecutionOrder`. Coverage combines `SliccFollower.debug.dylib` with every linked framework under `Frameworks/` (so `SliccTrayKit` stays measured). SwiftUI/CDP/AppState orchestration stays on the separate UI-test gate.

`SliccFileProvider/` is excluded: the appex never launches under unit tests, so its sources would vanish from the report rather than register as zero. Measured enumeration/read/error logic lives in `SliccTrayKit`; the appex stays a thin `NSFileProvider` adapter. Do not add the appex binary to coverage objects.

File Provider reads have an in-memory size ceiling: `readBinaryFile` materializes the complete base64 response and decoded `Data` before the appex writes its temporary file. There is no streaming path or fixed byte limit, so the effective ceiling is the appex process memory budget (on the order of a few hundred MB), and the practical raw-file limit is lower while both representations coexist. Treat very large leader VFS files as unsupported until reads stream to disk.

## Simulator QA path

Hand-running the app for exploratory QA is covered in [`docs/ios-simulator-qa.md`](../../docs/ios-simulator-qa.md).

## UI tests (`SliccFollowerUITests`)

A `bundle.ui-testing` target remains in the scheme, but the unit coverage gate excludes it. Run `-only-testing:SliccFollowerUITests` when UI changes, as a separate CI job. No test needs a leader: `-uiTestFixtureRoute YES` opens the leaderless **UI Fixture** route; `-uiTestSessionsFixture/Empty YES` seeds iCloud sessions in-memory; `-uiTestScoopStatusFixture` covers lifecycle/fill; `-uiTestReduceMotion` keeps the fullness cue static. `UITestHooks` is `#if DEBUG` only. The failure-state test dials `http://127.0.0.1:1/…` so `Connection Failed` arrives without DNS. `-uiTestCompletedTurn YES` feeds `message_start` + `content_done` + `status: ready` through the real dispatcher.

- Put accessibility identifiers on leaves (`message-<id>`). Container ids propagate; `.accessibilityElement(children: .contain)` does not fix that.
- Row ids alone are blind — also add a `variantMarkers` string only that renderer can emit.
- The transcript pins to the newest message; variant walks scroll bottom-to-top and must be bounded.
- A red CI job names the test, not the reason. Read XCTAssert text from the uploaded `test-timings-ios-app` xcresult via `xcrun xcresulttool get test-results tests`. Host death before XCTest connects is usually a runtime mismatch or `CODE_SIGNING_ALLOWED=NO` on the test build, not a flake.

## Linting

`packages/ios-app/.swiftlint.yml` inherits the repo-root rule set via `parent_config` and excludes `.build`/`SliccFollower.xcodeproj`. Only `error`-severity violations fail CI. `swiftlint --fix` rewrites every scanned file — run it on a clean tree.

The CI job ends with an informational Periphery dead-code scan (`|| true`). The app and test targets live in the XcodeGen project, not the SPM manifest, so the scan names the project, scheme, and target explicitly.

## Formatting

SwiftLint lints; `swift format` formats against the repo-root `.swift-format`. Use `npm run lint:swift:format` / `npm run format:swift` from the repo root, or:

```bash
swift format lint --strict --parallel --recursive SliccFollower Package.swift
swift format --in-place --parallel --recursive SliccFollower Package.swift
```

## TestFlight

Releases run `scripts/package-and-upload-testflight.sh` (secrets via `setup-testflight-secrets.sh`), path-gated by `release-native.mjs`. The script **soft-skips with exit 0** when `SLICC_SKIP_TESTFLIGHT=1`, an Apple secret is missing/`-`, or default Xcode is below 26. A green release is not proof an ipa shipped.

## Related Guides

- `packages/shared-ts/src/tray-sync-protocol.ts` — canonical protocol
- `packages/webapp/src/scoops/tray-leader-sync.ts` — leader broadcast/respond
- `packages/webapp/src/scoops/tray-follower-sync.ts` — browser follower
- `packages/webapp/src/ui/sprinkle-follower-controller.ts` — browser sprinkle renderer
- `docs/architecture.md` "Multi-Browser Sync (Tray) Architecture"
- `docs/ios-simulator-qa.md` — live-leader simulator QA
