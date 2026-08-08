# CLAUDE.md

This file covers the iOS follower app in `packages/ios-app/`.

## Scope

`packages/ios-app/SliccFollower/` is a native iOS SwiftUI app that connects to a SLICC leader over WebRTC and presents the leader's chat + sprinkles + (limited) federated CDP. It is **a follower only** — it does not host an agent runtime.

`packages/ios-app` is a Swift Package Manager project (`Package.swift`), not an npm workspace. It targets iOS 26.

## Layout

| Path                                                                                                | Purpose                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SliccFollower/App/SliccFollowerApp.swift`, `App/AppState.swift`                                    | App entry + central `@MainActor AppState`                                                                                                                                                                                                                                                                   |
| `SliccTrayFollower/Models/SyncProtocol.swift`                                                       | Partial `Codable` mirror of `packages/shared-ts/src/tray-sync-protocol.ts`                                                                                                                                                                                                                                  |
| `SliccFollower/Models/ScoopStatus.swift`                                                            | Scoop lifecycle and context-fullness presentation                                                                                                                                                                                                                                                           |
| `SliccTrayFollower/Models/{ChatMessage,TrayTypes,TrayChunkFraming}.swift`                           | Chat/signaling types and transport chunk reassembly                                                                                                                                                                                                                                                         |
| `SliccFollower/Sync/Keepalive.swift`                                                                | `DataChannelKeepalive` ping/pong actor                                                                                                                                                                                                                                                                      |
| `SliccFollower/Sync/TerminalClient.swift`                                                           | Single-flight `exec.*` client for the leader shell                                                                                                                                                                                                                                                          |
| `SliccFollower/Models/ICloudSessionList.swift`, `SliccFollower.entitlements`                        | iCloud tray-session discovery over `SliccTraySession` + KVS entitlement                                                                                                                                                                                                                                     |
| `SliccTrayFollower/Networking/{TraySignaling,TrayFollowerConnector,WebRTCManager}.swift`            | Signaling + WebRTC peer/data-channel setup                                                                                                                                                                                                                                                                  |
| `SliccTrayKit/FileProvider/`, `SliccFileProvider/`                                                  | Read/write Files.app provider for the leader VFS (kit logic + thin appex). Appex Info.plist must set `NSExtensionFileProviderSupportsEnumeration` or Files can register the domain while leaving `userEnabled=false` and hiding it from Browse → Locations.                                                 |
| `SliccFollower/CDP/CDPBridge.swift`, `CDPTarget.swift`                                              | Hosts WKWebViews as CDP targets the leader can drive                                                                                                                                                                                                                                                        |
| `SliccFollower/Views/ChatView.swift`, `MessageListView.swift`, `MarkdownText.swift`                 | Adaptive chat shell; `ChatPresentationState` owns compact/regular branch state. While a compact workbench overlay covers the conversation, the shell suppresses the chat toolbar (`toolbarSuppressed`); transcript http(s) links open in-app unless `openLinksInBuiltInBrowser` (Settings → Advanced) off   |
| `SliccFollower/Views/SprinkleWebView.swift`, `InlineSprinkleView.swift`, `SprinkleDetailView.swift` | Renders `.shtml`; intercepts bridge calls and stubs VFS APIs                                                                                                                                                                                                                                                |
| `SliccFollower/Views/DockModel.swift`, `DockRail.swift`, `WorkbenchHost.swift`, `LucideIcon.swift`  | Phone IA: 48pt dock rail; workbench overlays chat                                                                                                                                                                                                                                                           |
| `SliccFollower/Views/TerminalView.swift`, `TerminalViewModel.swift`                                 | Persistent libghostty surface                                                                                                                                                                                                                                                                               |
| `SliccFollower/Views/TabsCarouselView.swift`                                                        | Safari-shaped browser: two-column tab overview (local WKWebView tabs + remote preview cards as peers; tapping a remote card opens its URL locally); full-screen browsing with a bottom Liquid Glass address bar hides the rail + nav bar (`AppState.browserViewingTabId`); controls live in-content (#1916) |
| `SliccFollower/App/{InboundActions,AppGroupInbox,OpenInSliccIntents}.swift`, `SliccShareExtension/` | Inbound actions (#1918): `slicc://open\|prompt` (+`x-callback-url` form), `sliccy.ai/app/*` universal links, App Intents, and the share appex parking URLs in the `group.ai.sliccy.follower` inbox. One coordinator funnel; deep links confirm via card (fail-closed), intents are explicit                 |
| `SliccFollower/{Models,Views}/*Avatar*.swift`                                                       | Avatar geometry/motion, renderer, screenshot fixture                                                                                                                                                                                                                                                        |

Plain SPM commands do nothing useful on a macOS host. Build and test go through the XcodeGen project on a simulator (see "Test + coverage"). **It is generated from `project.yml`, not committed** — `xcodegen generate` after cloning and whenever sources change; project-editor edits are overwritten. The `SliccTrayFollower/*` rows are in `swift-traysession`, re-exported via `TrayFollowerExports.swift`.

## Protocol Mirror Invariant

`SliccTrayFollower/Models/SyncProtocol.swift` (in `swift-traysession`) mirrors a **subset** of `packages/shared-ts/src/tray-sync-protocol.ts`. The matrix in `docs/architecture.md` is the cross-float source of truth. iOS-local facts:

- `preview.open` → `CDPBridge.handleTabOpen`, acks `tab.opened`.
- iOS never originates transcript export; those prompts decode to `.unknown` / `undecodable` in the corpus.
- `capabilities.exec: true`; `handleExecMessage` accepts only `open [--universal|--x-callback] <url>`, gated by scoped approval, then launches it via `UIApplication.open` (`universalLinksOnly` for `--universal`). Raw paths reject traversal and encoded delimiters; hierarchical URLs must standardize unchanged. 1,024 IDs tombstoned; 128 failed terminal deliveries retry FIFO.
- `--x-callback` replaces any supplied callback keys with app-owned nonce URLs. A correlated success/error/cancel emits one ordered `{status, parameters:[{name,value}]}` JSON line on stdout, then exit 0/1/130. Results are capped at 16 parameters and 16 KiB serialized JSON; overflow fails without truncation. Callback state is process-local, so a callback after app restoration is consumed silently and the leader owns its timeout.

Both union doc-comments state omissions; `// MARK: -` boundaries are the anchors.

**Mechanical enforcement:** every union variant needs a fixture + iOS expectation in `tray-sync-protocol-corpus.ts`, decoded by vitest and Swift. When changing the protocol: (1) TS union, (2) Swift enum **and** `init(from:)` arm, (3) leader broadcast, (4) browser + iOS dispatch (`AppState.handleDataChannelMessage` is the only iOS switch), (5) corpus + tests, (6) architecture matrix row. Skipping iOS fails `SyncProtocolCorpusTests` instead of dropping to `.unknown`.

## What this app supports vs the browser follower

Model TS follower features on `AppState`:

- Lifecycle: `connect` / `disconnect` / `dataChannelOpened` / `handleDisconnect`
- Health: `Keepalive` splits **stalled** vs **dead**; `lastError` is transport, `leaderError` is the cone's
- Dispatch: `handleDataChannelMessage`
- Sprinkles: refresh/fetch/lick/handle content (chunk reassembly + waiter dedup)
- Leader VFS: `FsClient` requests with `targetRuntimeId: "leader"`; leader-origin requests get `ENOTSUP` (not silence). Client owns deadline + reassembly.
- `hello` sends `exec: true` + device `motd`
- Multi-scoop buffers, model/thinking controls, agent events

### Transcript swipe arbitration

Nested horizontal content keeps a drag while it can scroll that way; scoop navigation or frozen dismissal takes over only at the departing edge. Freeze edge state at drag start, tolerate either callback order, fail closed for unknown guarded contexts. Edge math includes both 8pt negative-padding expansions. On iOS 18+, each guarded scroller uses `UIGestureRecognizerRepresentable` and snapshots its `UIScrollView` at touch-down; the parent handles ordinary content. Keep the iOS 17 fallback and preserve vertical scrolling.

### Licks

`sprinkle.lick` is its own message (`sprinkle` is not `FORWARDABLE_TO_LEADER`). `LickEvent` mirrors only `navigate` and `discovery`. `navigate` handoffs come from `WKNavigationResponse` Link headers (main frame only).

### Message rendering parity

- Attachment chips: thumbnail/glyph + filename on user messages only
- Error card omits web CTAs (no follower→leader equivalent)
- `tool_ui` is a read-only card by `requestId`; `tool_ui_done` / snapshot clear it

## iCloud Sessions

`AppState.sessionStore` uses **`packages/swift-traysession`**; the launcher publishes and `SettingsView` joins. Liveness requires a connected leader. KVS `S8LB56P782.ai.sliccy.trays` MUST match macOS. Unprovisioned builds have no cache; `SLICC_IOS_NO_ICLOUD=1` omits iCloud. Never expose `joinUrl`.

iCloud keeps advertising the **old** tray after a leader reconnects, so `SessionReachability` and both attach loops must follow the `TRAY_SUPERSEDED` chain (`SupersedeRedirect`, which also moves the tray the connection owns) or a row reads live but cannot connect.

## Frozen Sessions

`FrozenSessions.swift` mirrors `transcript/frozen-archive-format.ts`; its view opens saved transcripts read-only. Hook: `-uiTestFrozenFixture/Empty`.

## Push to Talk

Hold an empty composer to dictate (`PttController` + `Dictation`/`SFSpeechRecognizer`); release calls `InputBar.submit(_:dictated:)`. Only matching dictated replies speak: English uses Kokoro, other paths use `AVSpeechSynthesizer`; typed turns stay silent. `AudioSessionCoordinator` solely owns `AVAudioSession`, serializes recording/playback, and restores the inherited category/rate. Hooks: `-uiTestSpeechPermission/Script`, `-uiTestPttStage`.

### Local Kokoro models

Settings downloads the anonymous, revision-pinned ~83 MB Hugging Face pack after
Wi-Fi consent with progress, cancel, retry, and removal; replies never provision.
Pack: nine CoreML stages, two vocabularies, `af_heart`. Marker/cache delete
together; weights are not committed. See
[`docs/ios-simulator-qa.md`](../../docs/ios-simulator-qa.md) for QA.

## Terminal

Libghostty `InMemoryTerminalSession` + `TerminalClient` exec against the leader shell (`hello.capabilities.exec`). One virtual shell per connection; Ctrl-C → `SIGINT` until `exec.response`. No interactive output.

## Agent Avatar

`SliccAgentAvatarView` shares its treatment with the browser `<slicc-agent-avatar>`. The chat header is one 36pt row: scoop pill leading, avatar centered, session-controls cluster trailing. The cluster is a shell overlay, not a toolbar item — the nav bar clips its own items and the cluster must overlap the dock rail. It tracks the chat toolbar: hidden under a compact workbench, kept in the regular split where the conversation stays visible. Menu rows stay text-only. Fullness is pupil size only — never a ring, gauge, badge, or text. Connection trouble outranks lifecycle and replaces pupils and eye whites with 1pt TV static; the a11y phrase still carries label, lifecycle, fill, and connection status. CoreMotion pupil movement is relative to the rolling 60-second average tilt and capped at one eye diameter per second; reduce-motion and closed eyes center pupils. `-uiTestAvatarFixture light-static|dark-static` freezes a noise frame.

No connection banner row: recoverable state stays in the avatar and composer placeholder so it cannot move message rows; terminal `.gaveUp` opens Settings.

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

Run unit tests through `xcodebuild test` on a simulator. The coverage gate boots an iPhone matching the simulator SDK, retries infra failures, and enforces `coverage-thresholds.json`. Override selection locally with a worktree-owned `SLICC_IOS_SIM_UDID`. Never pass `CODE_SIGNING_ALLOWED=NO` to tests: XCTest needs ad-hoc signing; use it only for the build above.

```bash
./packages/dev-tools/tools/swift-coverage-check.sh \
  --xcodebuild SliccFollower packages/ios-app SliccFollower
```

Outputs land in `.build/coverage/`. The gate runs only `SliccFollowerTests`, disables parallel clones for shared app-state isolation, and keeps random order. Coverage combines the app dylib with linked frameworks so `SliccTrayKit` stays measured; SwiftUI/CDP/AppState orchestration remains on the UI-test gate.

Exclude `SliccFileProvider/` from coverage: the appex does not launch in unit tests, and its measured enumeration/read/error logic lives in `SliccTrayKit`. Never add the thin adapter binary as a coverage object.

File Provider reads are memory-bound: `readBinaryFile` holds the full base64 response and decoded `Data` before writing. Treat very large leader VFS files as unsupported until reads stream to disk.

## UI tests (`SliccFollowerUITests`)

A `bundle.ui-testing` target remains in the scheme, but the unit coverage gate excludes it. Run `-only-testing:SliccFollowerUITests` when UI changes, as a separate CI job. No test needs a leader: `-uiTestFixtureRoute YES` opens the leaderless **UI Fixture** route; `-uiTestSessionsFixture/Empty YES` seeds iCloud sessions in-memory; `-uiTestScoopStatusFixture` covers lifecycle/fill; `-uiTestReduceMotion` freezes pupil motion and static noise. `UITestHooks` is `#if DEBUG` only. The failure-state test dials `http://127.0.0.1:1/…` so the avatar reaches `Connection Failed` without DNS. `-uiTestCompletedTurn YES` feeds a full completed turn through the real dispatcher.

Regular-width browser tabs claim the whole iPad window; returning to the overview restores the split. CI runs this enter/exit regression in the `ios-app-tests` matrix (iPad cells).

- Put accessibility identifiers on leaves (`message-<id>`). Container ids propagate; `.accessibilityElement(children: .contain)` does not fix it.
- Row ids alone are blind — also add a `variantMarkers` string only that renderer can emit.
- The transcript pins to the newest message; variant walks scroll bottom-to-top and must be bounded.
- A red CI job names the test, not the reason. Read XCTAssert text from the uploaded `test-timings-ios-app-<ios>-<device>` xcresult via `xcrun xcresulttool get test-results tests`. Host death before XCTest connects is usually a runtime mismatch or `CODE_SIGNING_ALLOWED=NO`, not flake.

## Linting

`.swiftlint.yml` inherits the repo-root rule set via `parent_config` and excludes `.build`/`SliccFollower.xcodeproj`. Only `error`-severity violations fail CI. `swiftlint --fix` rewrites every scanned file — run it on a clean tree.

The CI job ends with an informational Periphery dead-code scan (`|| true`). App and test targets live in the XcodeGen project, not the SPM manifest, so the scan names project, scheme, and target explicitly.

SwiftLint lints; `swift format` formats against the repo-root `.swift-format` — run `npm run lint:swift:format` / `format:swift` from the repo root (they cover `SliccTrayKit` too).

## TestFlight

Releases run `scripts/package-and-upload-testflight.sh` (secrets via `setup-testflight-secrets.sh`), path-gated by `release-native.mjs`. The script **soft-skips with exit 0** when `SLICC_SKIP_TESTFLIGHT=1`, an Apple secret is missing/`-`, or default Xcode is below 26. A green release is not proof an ipa shipped. It generates the project (after those gates), then patches the pbxproj to codesign.

After upload, `scripts/testflight-distribute.mjs` (gated on `SLICC_TF_EXTERNAL_GROUP`; unset = upload-only) waits for processing, sets What to Test notes (appending `SLICC_TF_DEMO_JOIN_URL`), submits Beta App Review, and attaches the build to that group. **Submission and attach are independent** — only a `fatal` submit aborts; `deferred` (review quota) warns and still attaches, so the build ships once review clears. Tests: `testflight-distribute.test.mjs`.

## Related Guides

- `packages/shared-ts/src/tray-sync-protocol.ts` — canonical protocol
- `packages/webapp/src/scoops/tray-leader-sync.ts` — leader broadcast/respond
- `packages/webapp/src/scoops/tray-follower-sync.ts` — browser follower
- `packages/webapp/src/ui/sprinkle-follower-controller.ts` — browser sprinkle renderer
- `docs/architecture.md` "Multi-Browser Sync (Tray) Architecture"
- `docs/ios-simulator-qa.md` — live-leader simulator QA
