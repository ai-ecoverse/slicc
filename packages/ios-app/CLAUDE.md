# CLAUDE.md

iOS follower app in `packages/ios-app/` — native iOS 26 SwiftUI SPM project (`Package.swift`), not an npm workspace. **Follower only**: connects to a SLICC leader over WebRTC (chat + sprinkles + limited federated CDP), no agent runtime. Deep reference: [`docs`](../../docs/ios-app-details.md).

Plain SPM commands do nothing — build/test go through XcodeGen. **The Xcode project is generated from `project.yml`, not committed**: `xcodegen generate` after clone and whenever sources change.

## Layout

- `SliccFollower/App/` — `SliccFollowerApp` (+ `SliccAppDelegate` for APNs), `@MainActor AppState` (`AppState+SudoApproval` = Face ID gate + push); the inbound coordinator + `SliccShareExtension/` funnel `slicc://open|prompt` (+`x-callback-url`), `sliccy.ai/app/*` universal links, App Intents + share URLs via `group.ai.sliccy.follower`. Deep links confirm via card (fail-closed). App Intents entities & schemas (`SliccConversationEntity` cold off the snapshot): [`docs`](../../docs/ios-app-details.md#app-intents-entities-and-schemas).
- `SliccFollower/Models/` — `ScoopStatus`; `UnitRole` (read-only rule, below); `ICloudSessionList` + `.entitlements`; `*Avatar*`.
- `SliccFollower/Notifications/` — `NotificationCoordinator`: `UNUserNotificationCenter` delegate, categories `SLICC_TURN_END` / `SLICC_SUDO_REQUEST` (mirror hub `apns.ts`), local fallbacks + lock-screen Deny.
- `SliccFollower/Sync/` — `Keepalive`; `TerminalClient` (single-flight `exec.*`); `ConnectionSettle` (`ConnectionHealth` + `ConnectionSettler` = blip hold behind `settledConnection`). `SliccFollower/CDP/` — `CDPBridge` + `CDPTarget` host WKWebViews as CDP targets.
- `SliccFollower/Views/` — chat (compact workbench sets `toolbarSuppressed`; http(s) links open in-app unless `openLinksInBuiltInBrowser` off), sprinkles (`.shtml`), dock (48pt rail), `TerminalView`, `TabsCarouselView` (full-screen hides rail via `browserViewingTabId`), `ToolProgressChrome`. Invariants:
  - **Read-only scoop** — a scoop transcript renders no `InputBar` and its `tool_ui` never mounts a card. Rule lives ONCE in `Models/UnitRole.swift` (`UnitRole.isReadOnly`), via `selectedUnitIsReadOnly`: [`docs`](../../docs/ios-app-details.md#read-only-scoop-view)
  - **Transcript rendering** — short actions paint through `Views/TranscriptText.swift` (`UITextView`); `FileMentionResolver` confirms with ONE leader `stat`, never walks; the reading column caps **per row** (`readableTranscriptColumn()`), never around the `LazyVStack`. [`docs`](../../docs/ios-app-details.md#transcript-short-actions)
- `SliccTrayFollower/` (`swift-trayfollower`, via `TrayFollowerExports.swift`) — sync/networking; `Models/SyncProtocol.swift` is a partial `Codable` mirror of `tray-sync-protocol.ts` (below).
- `SliccWidgets/` — **Cones & Scoops** widget extension (`com.sliccy.follower.widgets`, incl. lock-screen/StandBy); pixels from **`packages/swift-widgetkit`** (`SliccWidgetKit`). A widget holds no tray connection, so the app captures a `WidgetSnapshot` into `group.ai.sliccy.follower` (`App/AppState+WidgetSnapshot.swift`) reading **settled** health; label is name or HOST, **never the join URL**. [`docs/widgets.md`](../../docs/widgets.md).
- `SliccTrayKit/FileProvider/` + `SliccFileProvider/` — Files.app provider for leader VFS (logic in **`packages/swift-traykit`**/`SliccTrayVFS`, via `TrayVFSExports.swift`). Appex Info.plist MUST set `NSExtensionFileProviderSupportsEnumeration` or Files hides the domain.

## App Icon

`Icon-Tinted` (in `AppIcon.appiconset`) is **hand-authored, not a desaturation** and must span the full luminance range (iOS masks luminance onto the tint). Master, `min`/`stddev` re-check: [`docs`](../../docs/ios-app-details.md#app-icon).

## Protocol Mirror Invariant

`SliccTrayFollower/Models/SyncProtocol.swift` mirrors a **subset** of `packages/shared-ts/src/tray-sync-protocol.ts`; the `docs/architecture.md` matrix is canonical. iOS-local:

- `preview.open` → `CDPBridge.handleTabOpen`, acks `tab.opened`. iOS never originates transcript export (prompts decode `.unknown`/`undecodable`).
- `sudo.approve.request` / `.cancel` → `SudoApprovalController` (SliccTrayKit/Sudo): Allow/Always gate on `LAContext` `.deviceOwnerAuthentication`, Deny never does; `hello` advertises `sudoApproval`/`biometric`, `push.register` carries the APNs token. [`docs`](../../docs/ios-app-details.md#sudo-approval-and-push)
- `capabilities.exec: true`; `handleExecMessage` accepts only `open [--universal|--x-callback] <url>`, scoped-approval gated. Validation, tombstoning, nonces/caps: [`docs`](../../docs/ios-app-details.md#exec-capability)

Adding a variant is a fixed six-step order: [`docs`](../../docs/ios-app-details.md#protocol-variant-checklist)

## Follower on `AppState`

`Keepalive` splits **stalled** vs **dead** (`lastError`=transport, `leaderError`=cone); dispatch via `handleDataChannelMessage` (the only iOS switch). Swipe arbitration freezes edge state at drag start, fails closed. Settle, VFS, lick, `tool_ui`, swipe: [`docs`](../../docs/ios-app-details.md#follower-state-invariants).

## iCloud Sessions

`AppState.sessionStore` uses **`packages/swift-traysession`**; launcher publishes, `SettingsView` joins. Liveness needs a connected leader. KVS `S8LB56P782.ai.sliccy.trays` MUST match macOS; `SLICC_IOS_NO_ICLOUD=1` omits iCloud. **Never expose `joinUrl`.** Reconnect attach loops must follow `TRAY_SUPERSEDED`/`SupersedeRedirect`: [`docs`](../../docs/ios-app-details.md#icloud-tray-supersede-chain).

**Recent joins**: `RecentJoinStore` records + syncs on `dataChannelOpened` (never at dial time); `SettingsView` shows label-or-`displayHost`, **never the join URL** (hooks `-uiTestRecentJoinsFixture/Empty`): [`docs`](../../docs/ios-app-details.md#recent-joins). **Frozen sessions**: `FrozenSessions.swift` mirrors `transcript/frozen-archive-format.ts`, opening saved transcripts read-only (`-uiTestFrozenFixture/Empty`).

## Push to Talk

Hold empty composer to dictate; only dictated replies speak (typed turns silent). `AudioSessionCoordinator` solely owns `AVAudioSession`. Mechanism + hooks: [`docs`](../../docs/ios-app-details.md#push-to-talk); Kokoro pack (~83 MB, Wi-Fi consent): [`docs`](../../docs/ios-app-details.md#local-kokoro-models).

## Terminal

`InMemoryTerminalSession` + `TerminalClient` exec against the leader shell (`hello.capabilities.exec`), one shell per connection. [`docs`](../../docs/ios-app-details.md#terminal)

## Agent Avatar

`SliccAgentAvatarView` mirrors the browser `<slicc-agent-avatar>`; fullness = pupil size only, recoverable state stays in avatar/composer (no banner row). Chrome, expression kit, fixtures: [`docs`](../../docs/ios-app-details.md#agent-avatar-chrome). Two invariants:

- The widget holds a **static** copy of this geometry + expression grammar in `packages/swift-widgetkit` (`UnitAvatarGeometry`/`UnitAvatarFace`); parity is pinned by `UnitAvatarGeometryTests` against `SliccAgentAvatarGeometryTests` here — a ratio change here means changing it there. [`docs/widgets.md`](../../docs/widgets.md#the-avatar).
- Trouble surfaces only after `ConnectionSettler.holdDuration` (recovery lands at once), and **no connection state may reach the composer's first-responder layer** (not `.disabled`, `allowsHitTesting`, or anything mounted above the editor). Only sending is gated; a regression test must stage a blip that heals.

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

Run `xcodebuild test` on a simulator. The coverage gate boots a matching iPhone, retries infra failures, enforces `coverage-thresholds.json` (`SliccFollowerTests` only); override with `SLICC_IOS_SIM_UDID`. **Never pass `CODE_SIGNING_ALLOWED=NO` to tests** (XCTest needs ad-hoc signing).

```bash
./packages/dev-tools/tools/swift-coverage-check.sh \
  --xcodebuild SliccFollower packages/ios-app SliccFollower
```

Object selection, `SliccFileProvider/` exclusion: [`docs`](../../docs/ios-app-details.md#coverage-gate-details).

## UI tests (`SliccFollowerUITests`)

`bundle.ui-testing` stays in the scheme; the unit gate excludes it. No test needs a leader — every fixture runs off a `#if DEBUG` launch-argument hook. **CI runs the whole bundle** (both `ios-app-tests` GA cells) minus `ui-test-exclusions.json`; leaving CI takes an entry there with a reason (`npm run lint:ios-ui-tests` rejects stale). Hooks + rules: [`docs`](../../docs/ios-app-details.md#ui-test-details).

## Linting

SwiftLint + `swift format` inherit repo-root configs; only `error` severity fails CI. `npm run lint:swift:format`/`format:swift` from repo root. [`docs`](../../docs/ios-app-details.md#linting-details).

## TestFlight

Releases run `scripts/package-and-upload-testflight.sh` (secrets via `setup-testflight-secrets.sh`), path-gated by `release-native.mjs`. It **soft-skips with exit 0** when `SLICC_SKIP_TESTFLIGHT=1`, an Apple secret is missing/`-`, or default Xcode < 26 — green is no proof an ipa shipped. Distribution: [`docs`](../../docs/ios-app-details.md#testflight-distribute).

## Related

`packages/shared-ts/src/tray-sync-protocol.ts` (canonical), `packages/webapp/src/scoops/{tray-leader-sync,tray-follower-sync}.ts`, `packages/webapp/src/ui/sprinkle-follower-controller.ts`; `docs/architecture.md` "Multi-Browser Sync (Tray)"; [`docs`](../../docs/ios-simulator-qa.md).
