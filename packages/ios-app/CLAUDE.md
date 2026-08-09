# CLAUDE.md

iOS follower app in `packages/ios-app/` — native iOS 26 SwiftUI SPM project (`Package.swift`), not an npm workspace. **Follower only**: connects to a SLICC leader over WebRTC (chat + sprinkles + limited federated CDP); no agent runtime. Deep reference: [`docs/ios-app-details.md`](../../docs/ios-app-details.md).

## Layout

- `SliccFollower/App/` — `SliccFollowerApp`, `@MainActor AppState`; inbound coordinator (`InboundActions`, `AppGroupInbox`, `OpenInSliccIntents`) + `SliccShareExtension/` funnel `slicc://open|prompt` (+`x-callback-url`), `sliccy.ai/app/*` universal links, App Intents, share URLs in `group.ai.sliccy.follower`. Deep links confirm via card (fail-closed).
- `SliccFollower/Models/` — `ScoopStatus`; `ICloudSessionList` + `SliccFollower.entitlements` (iCloud via `SliccTraySession` + KVS); `*Avatar*`.
- `SliccFollower/Sync/` — `Keepalive` (`DataChannelKeepalive`); `TerminalClient` (single-flight `exec.*`).
- `SliccFollower/CDP/` — `CDPBridge` + `CDPTarget` host WKWebViews as CDP targets.
- `SliccFollower/Views/` — `ChatView`/`MessageListView`/`MarkdownText` (`ChatPresentationState`; compact workbench sets `toolbarSuppressed`; http(s) links open in-app unless Settings → Advanced `openLinksInBuiltInBrowser` off); `SprinkleWebView`/`InlineSprinkleView`/`SprinkleDetailView` (`.shtml`); `DockModel`/`DockRail`/`WorkbenchHost`/`LucideIcon` (48pt rail); `TerminalView`/`TerminalViewModel`; `TabsCarouselView` (full-screen hides rail via `AppState.browserViewingTabId`).
- `SliccTrayFollower/` (`swift-trayfollower`, re-exported via `TrayFollowerExports.swift`) — `Models/SyncProtocol.swift` (partial `Codable` mirror of `packages/shared-ts/src/tray-sync-protocol.ts`), `Models/{ChatMessage,TrayTypes,TrayChunkFraming}.swift`, `Networking/{TraySignaling,TrayFollowerConnector,WebRTCManager}.swift`.
- `SliccTrayKit/FileProvider/` + `SliccFileProvider/` — Files.app provider for leader VFS. Appex Info.plist MUST set `NSExtensionFileProviderSupportsEnumeration` or Files hides the domain (`userEnabled=false`).

Plain SPM commands do nothing on a macOS host; build/test go through XcodeGen. **Xcode project generated from `project.yml`, not committed** — run `xcodegen generate` after clone and whenever sources change.

## Protocol Mirror Invariant

`SliccTrayFollower/Models/SyncProtocol.swift` mirrors a **subset** of `packages/shared-ts/src/tray-sync-protocol.ts`; the matrix in `docs/architecture.md` is source of truth. iOS-local:

- `preview.open` → `CDPBridge.handleTabOpen`, acks `tab.opened`.
- iOS never originates transcript export; those prompts decode to `.unknown` / `undecodable`.
- `capabilities.exec: true`; `handleExecMessage` accepts only `open [--universal|--x-callback] <url>`, scoped-approval gated, launched via `UIApplication.open` (`universalLinksOnly` for `--universal`). Raw paths reject traversal + encoded delimiters; hierarchical URLs must standardize unchanged. 1,024 IDs tombstoned; 128 failed retries FIFO.
- `--x-callback` nonces, JSON result shape, 16-param / 16-KiB caps: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#x-callback-exec).

`// MARK: -` boundaries are the anchors. Every variant needs a fixture + iOS expectation in `tray-sync-protocol-corpus.ts`, decoded by vitest + Swift. Order: (1) TS union, (2) Swift enum + `init(from:)` arm, (3) leader broadcast, (4) browser + iOS dispatch (`AppState.handleDataChannelMessage` is the only iOS switch), (5) corpus + tests, (6) architecture matrix. Skipping iOS fails `SyncProtocolCorpusTests` instead of `.unknown`.

## Follower on `AppState`

Lifecycle `connect`/`disconnect`/`dataChannelOpened`/`handleDisconnect`; `Keepalive` splits **stalled** vs **dead** (`lastError`=transport, `leaderError`=cone); dispatch via `handleDataChannelMessage`; leader VFS uses `FsClient` with `targetRuntimeId: "leader"` (leader-origin gets `ENOTSUP`); `hello` sends `exec: true` + device `motd`. Invariants: swipe arbitration freezes edge state at drag start and fails closed; `sprinkle.lick` is its own message (`sprinkle` not `FORWARDABLE_TO_LEADER`); `LickEvent` mirrors only `navigate` + `discovery` from `WKNavigationResponse` Link headers; user-only attachment chips, no web CTAs, `tool_ui` cleared by `tool_ui_done` / snapshot. Details: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#transcript-swipe-arbitration).

## iCloud Sessions

`AppState.sessionStore` uses **`packages/swift-traysession`**; launcher publishes, `SettingsView` joins. Liveness requires a connected leader. KVS `S8LB56P782.ai.sliccy.trays` MUST match macOS. Unprovisioned builds have no cache; `SLICC_IOS_NO_ICLOUD=1` omits iCloud. **Never expose `joinUrl`.** Attach loops after reconnect must follow `TRAY_SUPERSEDED` / `SupersedeRedirect`: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#icloud-tray-supersede-chain).

**Frozen sessions**: `FrozenSessions.swift` mirrors `transcript/frozen-archive-format.ts`; opens saved transcripts read-only. Hook: `-uiTestFrozenFixture/Empty`.

## Push to Talk

Hold empty composer to dictate (`PttController` + `Dictation`/`SFSpeechRecognizer`); release calls `InputBar.submit(_:dictated:)`. Only dictated replies speak: English uses Kokoro, others `AVSpeechSynthesizer`; typed turns silent. `AudioSessionCoordinator` solely owns `AVAudioSession`. Hooks: `-uiTestSpeechPermission/Script`, `-uiTestPttStage`. Kokoro pack (~83 MB, Wi-Fi consent; replies never provision): [`docs/ios-app-details.md`](../../docs/ios-app-details.md#local-kokoro-models). QA: [`docs/ios-simulator-qa.md`](../../docs/ios-simulator-qa.md).

## Terminal

`InMemoryTerminalSession` + `TerminalClient` exec against the leader shell (`hello.capabilities.exec`). One virtual shell per connection; Ctrl-C → `SIGINT` until `exec.response`.

## Agent Avatar

`SliccAgentAvatarView` mirrors the browser `<slicc-agent-avatar>`. Chat header is a 36pt row (scoop pill, avatar, session-controls cluster); the cluster is a shell overlay that must overlap the dock rail. Fullness = pupil size only, never ring/gauge/badge/text. Connection trouble replaces pupils + eye whites with 1pt TV static; a11y phrase carries label, lifecycle, fill, connection. Recoverable state stays in avatar/composer (no banner row); `.gaveUp` opens Settings. `-uiTestAvatarFixture light-static|dark-static` freezes noise. Details: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#agent-avatar-treatment).

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

Run `xcodebuild test` on a simulator. Coverage gate boots an iPhone matching the simulator SDK, retries infra failures, enforces `coverage-thresholds.json`. Override via worktree-owned `SLICC_IOS_SIM_UDID`. **Never pass `CODE_SIGNING_ALLOWED=NO` to tests** (XCTest needs ad-hoc signing).

```bash
./packages/dev-tools/tools/swift-coverage-check.sh \
  --xcodebuild SliccFollower packages/ios-app SliccFollower
```

Outputs in `.build/coverage/`. Gate runs only `SliccFollowerTests`, disables parallel clones, keeps random order. Coverage combines app dylib + linked frameworks so `SliccTrayKit` stays measured. Exclude `SliccFileProvider/` (appex not launched in unit tests); **never add the thin adapter binary as a coverage object**. File Provider reads are memory-bound (`readBinaryFile` holds full base64 + decoded `Data`); large VFS files unsupported until reads stream to disk.

## UI tests (`SliccFollowerUITests`)

`bundle.ui-testing` stays in the scheme; the unit gate excludes it. Run `-only-testing:SliccFollowerUITests` on UI changes as a separate CI job. **No test needs a leader**: `-uiTestFixtureRoute YES` opens the leaderless **UI Fixture**; `-uiTestSessionsFixture/Empty YES` seeds iCloud sessions; `-uiTestScoopStatusFixture` covers lifecycle/fill; `-uiTestReduceMotion` freezes pupil motion + noise; `-uiTestCompletedTurn YES` feeds a completed turn. `UITestHooks` is `#if DEBUG` only. Failure-state dials `http://127.0.0.1:1/…` so the avatar reaches `Connection Failed` without DNS. Details: [`docs/ios-app-details.md`](../../docs/ios-app-details.md#ui-test-details).

## Linting

`.swiftlint.yml` inherits repo-root via `parent_config`, excludes `.build`/`SliccFollower.xcodeproj`; only `error` severity fails CI. `swiftlint --fix` rewrites every scanned file (clean tree only). CI ends with informational Periphery scan (`|| true`) naming project/scheme/target. `swift format` uses repo-root `.swift-format`; run `npm run lint:swift:format` / `format:swift` from repo root (covers `SliccTrayKit`).

## TestFlight

Releases run `scripts/package-and-upload-testflight.sh` (secrets via `setup-testflight-secrets.sh`), path-gated by `release-native.mjs`. Script **soft-skips with exit 0** when `SLICC_SKIP_TESTFLIGHT=1`, an Apple secret is missing/`-`, or default Xcode < 26 (a green release is not proof an ipa shipped). Distribution: `scripts/testflight-distribute.mjs`; [`docs/ios-app-details.md`](../../docs/ios-app-details.md#testflight-distribute).

## Related

`packages/shared-ts/src/tray-sync-protocol.ts` (canonical), `packages/webapp/src/scoops/tray-leader-sync.ts`, `packages/webapp/src/scoops/tray-follower-sync.ts`, `packages/webapp/src/ui/sprinkle-follower-controller.ts`; `docs/architecture.md` "Multi-Browser Sync (Tray) Architecture"; `docs/ios-simulator-qa.md`; `docs/ios-app-details.md`.
